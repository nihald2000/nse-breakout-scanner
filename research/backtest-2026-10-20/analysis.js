"use strict";
// analysis.js - strategy definitions (what is tested), event selection, aggregation and cell statistics.

const E = require("./engine");
const S = require("./stats");
const { NC, NE, NH, NB, BARRIERS, HORIZONS, ENTRIES, cIndex, cParts, RES } = E;

// ---------------------------------------------------------------------------------------------------------
// Strategies. A strategy maps a decision to a side: +1 long (CE read), -1 short (PE read), 0 no signal.
// Thresholds for the add-on filters are FIXED IN ADVANCE (never tuned on the sample).
// ---------------------------------------------------------------------------------------------------------
const CHECK_NAMES = ["VWAP position", "VWAP slope (12 x 5m)", "Ichimoku above/below both lines", "30m structure", "Opening-range break", "ADX(14) >= 18 DI side"];

// Lean rule on a subset of the six slots (skip = index left out, -1 = none): same rule as trendVerdict's side gate.
function leanSide(slot, skip) {
  let up = 0;
  let dn = 0;
  for (let k = 0; k < slot.length; k++) {
    if (k === skip) continue;
    if (slot[k] === 1) up++;
    else if (slot[k] === -1) dn++;
  }
  const tot = up + dn;
  const agree = Math.max(up, dn);
  const side = up > dn ? 1 : dn > up ? -1 : 0;
  if (!side || agree < 3 || agree / Math.max(tot, 1) < 0.6) return 0;
  return side;
}

const RVOL_MIN = 1.5; // add-on filter threshold, fixed in advance
const DAYCHG_MIN = 0.5; // % - standalone day-change strategy threshold, fixed in advance

function buildStrategies(ctx) {
  const sm = (d) => (d.tier >= 2 ? d.side : 0);
  const rand = (i) => {
    let t = (Math.imul(i + 1, 0x9e3779b1) >>> 0) ^ 0x85ebca6b;
    t = Math.imul(t ^ (t >>> 15), 0x2c1b3c6d);
    t = Math.imul(t ^ (t >>> 12), 0x297a2d39);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
  const L = [];
  const add = (id, group, label, side) => L.push({ id, group, label, side });
  add("LEAN_ANY", "tier", "Lean rule, any tier (side if agree>=3 and >=60%)", (d) => d.side);
  add("TIER_STRONG", "tier", "Tier strong", (d) => (d.tier === 3 ? d.side : 0));
  add("TIER_MODERATE", "tier", "Tier moderate", (d) => (d.tier === 2 ? d.side : 0));
  add("TIER_WEAK", "tier", "Tier weak (hidden on the board)", (d) => (d.tier === 1 ? d.side : 0));
  add("STRONG_MODERATE", "tier", "Strong + moderate (what Live Calls lists)", sm);
  CHECK_NAMES.forEach((nm, k) => add("ONLY_" + k, "single", "Check alone: " + nm, (d) => d.slot[k]));
  CHECK_NAMES.forEach((nm, k) => add("LOO_" + k, "leave-one-out", "Lean rule without: " + nm, (d) => leanSide(d.slot, k)));
  add("SM_PATTERN", "add-on", "Strong+moderate AND a candle pattern on-side", (d) => (sm(d) === 1 ? (d.patUp ? 1 : 0) : sm(d) === -1 ? (d.patDn ? -1 : 0) : 0));
  add("SM_RVOL", "add-on", `Strong+moderate AND running RVOL >= ${RVOL_MIN}`, (d) => (d.rvol != null && d.rvol >= RVOL_MIN ? sm(d) : 0));
  add("SM_DELIV", "add-on", "Strong+moderate AND prior-day delivery % above that day's median", (d) => {
    const med = ctx.delivMedian && ctx.delivMedian.get(d.d);
    return d.deliv != null && med != null && d.deliv > med ? sm(d) : 0;
  });
  add("SM_DAYCHG", "add-on", "Strong+moderate AND day change on the same side", (d) => (sm(d) !== 0 && Math.sign(d.pchg) === sm(d) ? sm(d) : 0));
  add("SM_DAILY", "regime", "Strong+moderate WITH the daily trend (close vs SMA20, prior day)", (d) => (sm(d) !== 0 && d.dTrend === sm(d) ? sm(d) : 0));
  add("SM_60M", "regime", "Strong+moderate WITH the 60m trend (close vs EMA20)", (d) => (sm(d) !== 0 && d.hTrend === sm(d) ? sm(d) : 0));
  add("SM_MKT", "regime", "Strong+moderate WITH the Nifty daily trend", (d) => (sm(d) !== 0 && d.mTrend === sm(d) ? sm(d) : 0));
  add("PAT_ONLY", "standalone", "Candle pattern alone (latest directional pattern)", (d) => d.patLast);
  add("DAYCHG_ONLY", "standalone", `Day change alone (|chg| >= ${DAYCHG_MIN}%)`, (d) => (Math.abs(d.pchg) >= DAYCHG_MIN ? Math.sign(d.pchg) : 0));
  add("BASE_LONG", "baseline", "Baseline: always long", () => 1);
  add("BASE_SHORT", "baseline", "Baseline: always short", () => -1);
  add("BASE_RANDOM", "baseline", "Baseline: random side (seeded)", (d, i) => (rand(i) < 0.5 ? 1 : -1));
  add("INVERSE_SM", "baseline", "Inverse of strong+moderate (opposite side)", (d) => -sm(d));
  return L;
}

// events for a strategy: arrays of decision index and side index (0 long, 1 short)
function selectEvents(dec, strat, mode) {
  const evD = [];
  const evS = [];
  let prevKey = null;
  let prevSide = 0;
  for (let i = 0; i < dec.length; i++) {
    const d = dec[i];
    if (d.j0 < 0) continue; // no path after the decision: nothing to measure
    const key = d.sym + "|" + d.d;
    if (key !== prevKey) {
      prevKey = key;
      prevSide = 0;
    }
    const side = strat.side(d, i);
    if (side && (mode === "every" || side !== prevSide)) {
      evD.push(i);
      evS.push(side > 0 ? 0 : 1);
    }
    prevSide = side;
  }
  return { evD, evS };
}

// ---------------------------------------------------------------------------------------------------------
// Aggregation: per (config, day) counters
// ---------------------------------------------------------------------------------------------------------
const F = 11; // n, tgt, stp, both, tmo, opn, grossSum, stopSum, mfeSum, maeSum, na

function aggregate(O, dayOrd, nDays, evD, evS, cs) {
  const acc = new Float64Array(cs.length * nDays * F);
  const parts = cs.map(cParts);
  for (let q = 0; q < evD.length; q++) {
    const di = evD[q];
    const s = evS[q];
    const day = dayOrd[di];
    const base = (di * 2 + s) * NC;
    for (let ci = 0; ci < cs.length; ci++) {
      const k = base + cs[ci];
      const code = O.res[k];
      const o = (ci * nDays + day) * F;
      if (code === RES.NA) {
        acc[o + 10]++;
        continue;
      }
      acc[o]++;
      acc[o + 1 + code]++;
      acc[o + 6] += O.ret[k];
      acc[o + 7] += O.stp[k];
      const mi = ((di * 2 + s) * NE + parts[ci].e) * NH + parts[ci].h;
      acc[o + 8] += O.mfe[mi];
      acc[o + 9] += O.mae[mi];
    }
  }
  return { acc, cs, nDays };
}

const tqCache = new Map();
function tq(df) {
  if (!tqCache.has(df)) tqCache.set(df, S.tQuant(0.975, df));
  return tqCache.get(df);
}
function clusterFast(perDay) {
  // same as S.clusterRatio but with the t quantile cached by df (the grid has thousands of cells)
  const cl = perDay.filter((x) => x.n > 0);
  const G = cl.length;
  let Ssum = 0;
  let N = 0;
  for (const x of cl) {
    Ssum += x.s;
    N += x.n;
  }
  if (!(N > 0) || G < 2) return { mean: N > 0 ? Ssum / N : null, se: null, t: null, p1: null, ci: [null, null], G };
  const mean = Ssum / N;
  let ss = 0;
  for (const x of cl) ss += (x.s - mean * x.n) ** 2;
  const se = Math.sqrt((G / (G - 1)) * ss) / N;
  if (!(se > 0)) return { mean, se: 0, t: null, p1: null, ci: [mean, mean], G };
  const t = mean / se;
  const q = tq(G - 1);
  return { mean, se, t, p1: 1 - S.tCdf(t, G - 1), ci: [mean - q * se, mean + q * se], G };
}

// Statistics for configuration index ci of an aggregate, days [d0, d1). cost = % per side.
function cellStats(A, ci, d0, d1, cost) {
  const { acc, nDays } = A;
  const c = A.cs[ci];
  let n = 0;
  let tgt = 0;
  let stp = 0;
  let both = 0;
  let tmo = 0;
  let opn = 0;
  let gross = 0;
  let stopSum = 0;
  let mfe = 0;
  let mae = 0;
  let na = 0;
  const perHit = [];
  const perNet = [];
  const perGross = [];
  const rt = 2 * cost;
  for (let day = d0; day < d1; day++) {
    const o = (ci * nDays + day) * F;
    const dn = acc[o];
    n += dn;
    tgt += acc[o + 1];
    stp += acc[o + 2];
    both += acc[o + 3];
    tmo += acc[o + 4];
    opn += acc[o + 5];
    gross += acc[o + 6];
    stopSum += acc[o + 7];
    mfe += acc[o + 8];
    mae += acc[o + 9];
    na += acc[o + 10];
    perHit.push({ s: acc[o + 1], n: acc[o + 1] + acc[o + 2] });
    perNet.push({ s: acc[o + 6] - dn * rt, n: dn });
    perGross.push({ s: acc[o + 6], n: dn });
  }
  const dec = tgt + stp;
  const w = S.wilson(tgt, dec);
  const ch = clusterFast(perHit);
  const cn = clusterFast(perNet);
  const cg = clusterFast(perGross);
  const { b } = cParts(c);
  const B = BARRIERS[b];
  const avgStop = n > 0 ? stopSum / n : null;
  const avgTgt = B.kind === "F" ? B.t : B.kind === "A" ? (avgStop * B.tm) / B.sm : avgStop; // K: 1:1
  const breakEven = avgStop != null && avgTgt != null ? (avgStop + rt) / (avgTgt + avgStop) : null; // hit rate (of decidable) needed to net zero
  return {
    n, dec, tgt, stp, both, tmo, opn, na,
    hit: dec > 0 ? tgt / dec : null,
    wLo: w.lo, wHi: w.hi,
    clLo: ch.ci[0] == null ? null : Math.max(0, ch.ci[0]), clHi: ch.ci[1] == null ? null : Math.min(1, ch.ci[1]),
    hitCons: n > 0 ? tgt / (tgt + stp + both) : null,
    grossExp: n > 0 ? gross / n : null,
    grossP1: cg.p1,
    netExp: n > 0 ? gross / n - rt : null,
    netLo: cn.ci[0], netHi: cn.ci[1], netT: cn.t, netP1: cn.p1,
    avgStop, avgTgt, breakEven,
    expR: avgStop > 0 ? (gross / n - rt) / avgStop : null,
    mfe: n > 0 ? mfe / n : null,
    mae: n > 0 ? mae / n : null,
    days: cn.G,
    perHit,
  };
}

const MIN_DEC = 100; // decidable signals required before a cell may be called meaningful

module.exports = {
  CHECK_NAMES, leanSide, buildStrategies, selectEvents, aggregate, cellStats, clusterFast, MIN_DEC, RVOL_MIN, DAYCHG_MIN, F,
};
