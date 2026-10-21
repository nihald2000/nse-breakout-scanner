"use strict";
// engine.js - faithful replay of the Live Calls read (api/sectorstocks.js computeRows + lib/sector.js).
//
// What is REUSED, not re-implemented: every pure helper behind the checks (vwapSeries, vwapTrend,
// lineState, swingStructure, orStats, adxRead, volSpike, intradayRvol, rangeVsNormal, candlePatterns,
// trendVerdict) is imported from ../../lib/sector, and bars are parsed with the same parseIdx the API uses.
// What is MIRRORED: the assembly in computeRows (which checks are pushed, in which order). harness_check.js
// asserts the mirror equals the real computeRows() on sampled stock-bars, so a future drift is caught.
//
// Known, documented differences from production (never hidden):
//   D1 live uses ltp (regularMarketPrice) for the VWAP-position check; the replay uses the last CLOSED 5m close.
//   D2 live `today` / rangeVsNormal include the still-forming bar; the replay only ever sees closed bars.
//   D3 live asks Yahoo for range=5d (5m) and range=1mo (15m) at the moment of the call. The replay rebuilds those
//      windows (last 5 sessions; bars from the same calendar day one month earlier) from a 60-day cache.

const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
const sector = require(path.join(ROOT, "lib", "sector"));
const fixes = require("./fixes");
const { ema } = require(path.join(ROOT, "lib", "indicators"));
const { parseIdx } = require(path.join(ROOT, "api", "indices"))._internals;

const OPEN_MM = 555; // 09:15
const CLOSE_MM = 930; // 15:30
const LAST_DECISION_CLOSE_MM = 15 * 60 + 15; // a decision bar must close by 15:15 so >= 15 min remain
const FULL_5M = 72; // of 75; fewer = short/holey stock-day
const FULL_15M = 24; // of 25

// ---------- dates -------------------------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, "0");
function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Same day-of-month one calendar month earlier (clamped), the best model of Yahoo's range=1mo.
function monthBack(iso) {
  const [y, m, dd] = iso.split("-").map(Number);
  let yy = y;
  let mm = m - 1;
  if (mm < 1) {
    mm = 12;
    yy--;
  }
  const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return `${yy}-${pad(mm)}-${pad(Math.min(dd, dim))}`;
}

// ---------- bar hygiene -------------------------------------------------------------------------------------
// Returns { bars, stats, meta }. IST sessions only (09:15-15:30). Missing data is dropped, never zero-filled.
function cleanBars(raw) {
  const p = parseIdx(raw);
  const stats = { parsed: p.bars.length, outOfSession: 0, duplicate: 0, badPrice: 0, zeroVol: 0, nonIST: (p.meta && p.meta.gmtoffset != null && p.meta.gmtoffset !== 19800) ? 1 : 0 };
  const sorted = p.bars.slice().sort((a, b) => a.t - b.t);
  const out = [];
  let lastT = -1;
  for (const b of sorted) {
    if (b.mm < OPEN_MM || b.mm >= CLOSE_MM) {
      stats.outOfSession++;
      continue;
    }
    if (b.t === lastT) {
      stats.duplicate++;
      continue;
    }
    if (!(b.cl > 0) || !(b.hi >= b.lo) || !(b.lo > 0)) {
      stats.badPrice++;
      continue;
    }
    lastT = b.t;
    if (!(b.vol > 0)) stats.zeroVol++;
    out.push(b);
  }
  return { bars: out, stats, meta: p.meta };
}

function indexDays(bars) {
  const ord = new Int32Array(bars.length);
  const starts = [];
  const dates = [];
  let prev = null;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].d !== prev) {
      starts.push(i);
      dates.push(bars[i].d);
      prev = bars[i].d;
    }
    ord[i] = dates.length - 1;
  }
  const ends = starts.map((s, k) => (k + 1 < starts.length ? starts[k + 1] - 1 : bars.length - 1));
  return { ord, starts, ends, dates, ordOf: new Map(dates.map((d, k) => [d, k])) };
}

// Wilder ATR over a bar array (needs hi/lo/cl). null until 14 true ranges exist.
function atrSeries(bars, p = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length <= p) return out;
  const tr = (i) => Math.max(bars[i].hi - bars[i].lo, Math.abs(bars[i].hi - bars[i - 1].cl), Math.abs(bars[i].lo - bars[i - 1].cl));
  let a = 0;
  for (let i = 1; i <= p; i++) a += tr(i);
  a /= p;
  out[p] = a;
  for (let i = p + 1; i < bars.length; i++) {
    a = (a * (p - 1) + tr(i)) / p;
    out[i] = a;
  }
  return out;
}

// bars: oldest-first. First index with bars[i].t >= x (or length).
function lowerBoundT(t, x) {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------- per-stock preparation ---------------------------------------------------------------------------
// raws: { "5m", "15m", "60m", "1d" } raw Yahoo `result` objects (60m/1d optional).
function prepStock(sym, raws, industry) {
  const st = { sym, industry: industry || sector.OTHER, ok: false, why: null, hygiene: {} };
  if (!raws["5m"] || !raws["15m"]) {
    st.why = "missing 5m/15m file";
    return st;
  }
  const c5 = cleanBars(raws["5m"]);
  const c15 = cleanBars(raws["15m"]);
  st.hygiene = { "5m": c5.stats, "15m": c15.stats };
  st.b5 = c5.bars;
  st.b15 = c15.bars;
  st.idx5 = indexDays(st.b5);
  st.idx15 = indexDays(st.b15);
  if (st.idx5.dates.length < 12 || st.idx15.dates.length < 12) {
    st.why = `short history (${st.idx5.dates.length} sessions of 5m, ${st.idx15.dates.length} of 15m)`;
    return st;
  }
  st.t5 = Float64Array.from(st.b5, (b) => b.t);
  st.o5 = Float64Array.from(st.b5, (b) => b.o);
  st.h5 = Float64Array.from(st.b5, (b) => b.hi);
  st.l5 = Float64Array.from(st.b5, (b) => b.lo);
  st.c5 = Float64Array.from(st.b5, (b) => b.cl);
  st.atr15 = atrSeries(st.b15);
  // 60m: EMA(20) of closed 60m closes -> higher-timeframe regime (known only after each 60m bar closes)
  st.b60 = raws["60m"] ? cleanBars(raws["60m"]).bars : [];
  const e60 = st.b60.length ? ema(st.b60.map((b) => b.cl), 20) : [];
  st.e60 = e60;
  st.t60 = Float64Array.from(st.b60, (b) => b.t + 3600); // close time of each 60m bar
  // daily: SMA(20) of completed daily closes
  st.bd = raws["1d"] ? parseIdx(raws["1d"]).bars : [];
  st.ok = true;
  return st;
}

// sign of (last completed daily close - SMA20) using sessions strictly before `iso`; 0 when unknown.
function dailyTrendSign(bd, iso) {
  let n = bd.length;
  while (n > 0 && bd[n - 1].d >= iso) n--;
  if (n < 20) return 0;
  let s = 0;
  for (let i = n - 20; i < n; i++) s += bd[i].cl;
  const sma = s / 20;
  return bd[n - 1].cl > sma ? 1 : bd[n - 1].cl < sma ? -1 : 0;
}

function hourTrendSign(st, T, px) {
  if (!st.b60.length) return 0;
  const k = lowerBoundT(st.t60, T + 1) - 1; // last 60m bar whose close time <= T
  if (k < 20) return 0;
  return px > st.e60[k] ? 1 : px < st.e60[k] ? -1 : 0;
}

// First *traded* 5m volume vs the same clock slot on the previous 14 sessions. Prior sessions only.
// Yahoo's 09:15 bar is almost always a zero-volume opening print (1,175 of 1,200 stock-days in a
// 20-stock check), so using that bar would make the ORB "stock in play" filter always null. We use
// the first bar with volume > 0 (normally 09:20) and compare it with the same slot on prior days.
function openRvolAt(st, o5) {
  const bars = st.b5;
  const idx = st.idx5;
  let cur = null;
  for (let j = idx.starts[o5]; j <= idx.ends[o5]; j++) {
    if (bars[j].vol > 0) { cur = bars[j]; break; }
  }
  if (!cur) return null;
  const mm = cur.mm;
  const vols = [];
  for (let k = o5 - 1; k >= 0 && k >= o5 - 14; k--) {
    for (let j = idx.starts[k]; j <= idx.ends[k]; j++) {
      if (bars[j].mm === mm && bars[j].vol > 0) { vols.push(bars[j].vol); break; }
    }
  }
  if (vols.length < 5) return null;
  const avg = vols.reduce((s, x) => s + x, 0) / vols.length;
  return avg > 0 ? cur.vol / avg : null;
}

// ---------- the read: a mirror of computeRows' per-stock assembly -------------------------------------------
// w5: closed 5m bars (last 5 sessions up to now), w15: closed tf bars (the "1mo" window), ltp, tfStep (seconds).
// Returns the same `read` object computeRows builds, plus the six check slots (1 up, -1 down, 0 none).
function assemble(w5, w15, ltp, fix) {
  const F = fix || {};
  if (!w5.length) return null;
  const liveISO = w5[w5.length - 1].d;
  let s0 = w5.length - 1;
  while (s0 > 0 && w5[s0 - 1].d === liveISO) s0--;
  const today = w5.slice(s0);
  if (today.length < 3) return null;
  const prev = s0 > 0 ? w5[s0 - 1] : null; // last bar of the previous session (live: reverse().find(d < liveISO))
  if (!prev || !(ltp > 0)) return null;
  const pchg = ((ltp - prev.cl) / prev.cl) * 100;
  const closed5 = today;

  const prevMap = new Map();
  for (let i = 0; i < s0; i++) {
    const b = w5[i];
    let arr = prevMap.get(b.d);
    if (!arr) prevMap.set(b.d, (arr = []));
    arr.push(b);
  }
  const rvol = sector.intradayRvol(today, prevMap);
  const turn = today.reduce((s, b) => s + (b.vol > 0 ? b.vol * b.cl : 0), 0);
  const vw = closed5.length && closed5.some((b) => b.vol > 0)
    ? (F.vwap ? fixes.vwapSeries(closed5) : sector.vwapSeries(closed5))
    : null;
  const vwapNow = vw ? vw[vw.length - 1] : null;

  let lines = { ok: false, why: "no data for this timeframe" };
  if (w15.length) lines = sector.lineState(w15);

  const read = {};
  read.vwapTrend = sector.vwapTrend(vw);
  read.structure = sector.swingStructure(closed5);
  read.or = F.or ? fixes.orStats(closed5) : sector.orStats(closed5);
  read.patterns = sector.candlePatterns(closed5);
  read.volSpike = F.vol ? fixes.volSpike(closed5, prevMap) : sector.volSpike(closed5, prevMap);
  read.adx = sector.adxRead(w15);
  read.range = w15.length ? (F.range ? fixes.rangeVsNormal(w15) : sector.rangeVsNormal(w15)) : null;

  const checks = [];
  if (vwapNow != null) checks.push(ltp > vwapNow ? "up" : ltp < vwapNow ? "down" : null);
  if (read.vwapTrend && read.vwapTrend.dir !== "flat") checks.push(read.vwapTrend.dir);
  if (lines.ok) {
    if (/above both/.test(lines.pos)) checks.push("up");
    else if (/below both/.test(lines.pos)) checks.push("down");
  }
  if (read.structure && read.structure.dir) checks.push(read.structure.dir);
  if (read.or) checks.push(read.or.pos);
  if (read.adx && read.adx.v >= 18 && read.adx.dir) checks.push(read.adx.dir);
  read.lean = {
    up: checks.filter((c) => c === "up").length,
    down: checks.filter((c) => c === "down").length,
    total: checks.filter((c) => c === "up" || c === "down").length,
  };
  read.trend = sector.trendVerdict(read);

  // The six slots with fixed positions (the live array skips absent checks; counts are identical).
  const sg = (v) => (v === "up" ? 1 : v === "down" ? -1 : 0);
  const slot = [
    vwapNow != null ? (ltp > vwapNow ? 1 : ltp < vwapNow ? -1 : 0) : 0,
    read.vwapTrend && read.vwapTrend.dir !== "flat" ? sg(read.vwapTrend.dir) : 0,
    lines.ok ? (/above both/.test(lines.pos) ? 1 : /below both/.test(lines.pos) ? -1 : 0) : 0,
    read.structure && read.structure.dir ? sg(read.structure.dir) : 0,
    read.or ? sg(read.or.pos) : 0,
    read.adx && read.adx.v >= 18 && read.adx.dir ? sg(read.adx.dir) : 0,
  ];
  return { read, slot, rvol, turn, vwapNow, vwapDistPct: vwapNow ? ((ltp - vwapNow) / vwapNow) * 100 : null, lines, pchg, prevClose: prev.cl };
}

// ---------- decision builder --------------------------------------------------------------------------------
// ctx: { calendar:Set(full-session dates), mode:"live"|"extended", minPriorExtended, corp:Map(sym->[iso]),
//        delivPrev:(sym, iso)=>number|null, mktTrend:(iso)=>sign }
// Returns { decisions, skipped:{reason:count}, evalDates:Set }
function buildDecisions(st, ctx) {
  const out = [];
  const skipped = {};
  const skip = (r) => (skipped[r] = (skipped[r] || 0) + 1);
  const { idx5, idx15, b5, b15 } = st;
  const first15 = b15[0].d;
  const corp = (ctx.corp && ctx.corp.get(st.sym)) || [];
  for (let o15 = 0; o15 < idx15.dates.length; o15++) {
    const D = idx15.dates[o15];
    if (ctx.dateFrom && D < ctx.dateFrom) continue;
    if (!ctx.calendar.has(D)) {
      skip("day:not a full market session (holiday/half-day/partial)");
      continue;
    }
    const o5 = idx5.ordOf.get(D);
    const n5 = o5 == null ? 0 : idx5.ends[o5] - idx5.starts[o5] + 1;
    const n15 = idx15.ends[o15] - idx15.starts[o15] + 1;
    if (n5 < FULL_5M || n15 < FULL_15M) {
      skip("day:stock-day has too few bars (missing = skip, never zero)");
      continue;
    }
    const mb = monthBack(D);
    let s15 = idx15.starts[o15];
    while (s15 > 0 && b15[s15 - 1].d >= mb) s15--;
    const priorSessions = o15 - idx15.ord[s15];
    if (ctx.mode === "live") {
      if (first15 > mb) {
        skip("day:history shorter than the live 1mo window");
        continue;
      }
    } else if (priorSessions < (ctx.minPriorExtended || 10)) {
      skip("day:fewer prior sessions than the extended minimum");
      continue;
    }
    if (o5 < 4) {
      skip("day:fewer than 4 prior 5m sessions");
      continue;
    }
    if (corp.some((c) => c >= mb && c <= D)) {
      skip("day:corporate-action break inside the 1mo window");
      continue;
    }
    const startOrd5 = Math.max(0, o5 - 4);
    const first5Bar = b5[idx5.starts[o5]];
    const first15Raw = b15[idx15.starts[o15]];
    const first5 = first5Bar && first5Bar.mm === OPEN_MM ? first5Bar : null;
    const first15Bar = first15Raw && first15Raw.mm === OPEN_MM ? first15Raw : null;
    const openRvol = openRvolAt(st, o5);
    const dTrend = dailyTrendSign(st.bd, D);
    const mTrend = ctx.mktTrend ? ctx.mktTrend(D) : 0;
    const deliv = ctx.delivPrev ? ctx.delivPrev(st.sym, D) : null;
    for (let i = idx15.starts[o15]; i <= idx15.ends[o15]; i++) {
      const bar = b15[i];
      if (bar.mm + 15 > LAST_DECISION_CLOSE_MM) break;
      const T = bar.t + 900;
      // last closed 5m bar must be the 3rd 5m bar of this 15m bar (no hole)
      const j5 = lowerBoundT(st.t5, T - 300);
      if (j5 >= st.t5.length || st.t5[j5] !== T - 300) {
        skip("bar:missing 5m bar at the decision time");
        continue;
      }
      const w5 = b5.slice(idx5.starts[startOrd5], j5 + 1);
      const w15 = b15.slice(s15, i + 1);
      const ltp = b5[j5].cl;
      const rd = assemble(w5, w15, ltp, ctx.fix);
      if (!rd) {
        skip("bar:read unavailable");
        continue;
      }
      const tr = rd.read.trend;
      const j0 = j5 + 1;
      const hasPath = j0 <= idx5.ends[o5] && st.t5[j0] === T;
      const pats = rd.read.patterns || [];
      const lastDir = pats.find((p) => p.dir);
      const orr = rd.read.or;
      const ret3 = i >= 3 && b15[i - 3].cl > 0 ? ((bar.cl / b15[i - 3].cl) - 1) * 100 : null;
      out.push({
        sym: st.sym,
        ind: st.industry,
        d: D,
        T,
        tm: bar.mm + 15,
        i15: i,
        j0: hasPath ? j0 : -1,
        end5: idx5.ends[o5],
        e: bar.cl,
        px: ltp,
        slot: rd.slot,
        up: rd.read.lean.up,
        dn: rd.read.lean.down,
        tot: rd.read.lean.total,
        side: tr && tr.side ? (tr.side === "up" ? 1 : -1) : 0,
        tier: tr ? (tr.tier === "strong" ? 3 : tr.tier === "moderate" ? 2 : tr.tier === "weak" ? 1 : 0) : 0,
        agree: tr ? tr.agree : 0,
        helpers: tr && tr.helpers != null ? tr.helpers : null,
        adxV: rd.read.adx ? rd.read.adx.v : null,
        adxDir: rd.read.adx && rd.read.adx.dir ? (rd.read.adx.dir === "up" ? 1 : -1) : 0,
        structDir: rd.read.structure && rd.read.structure.dir ? (rd.read.structure.dir === "up" ? 1 : -1) : 0,
        vsOn: rd.read.volSpike ? 1 : 0,
        rangeRatio: rd.read.range ? rd.read.range.ratio : null,
        // Current opening-range side (the name is kept for existing reports).
        orFirst: orr ? (orr.pos === "up" ? 1 : orr.pos === "down" ? -1 : 0) : 0,
        rvol: rd.rvol,
        turn: rd.turn,
        openRvol,
        or5Hi: first5 ? first5.hi : null,
        or5Lo: first5 ? first5.lo : null,
        or5Dir: first5 ? (first5.cl > first5.o ? 1 : first5.cl < first5.o ? -1 : 0) : 0,
        or15Hi: first15Bar ? first15Bar.hi : null,
        or15Lo: first15Bar ? first15Bar.lo : null,
        or15Dir: first15Bar ? (first15Bar.cl > first15Bar.o ? 1 : first15Bar.cl < first15Bar.o ? -1 : 0) : 0,
        ret3,
        pchg: rd.pchg,
        vwapDist: rd.vwapDistPct,
        vwap: rd.vwapNow,
        patUp: pats.some((p) => p.dir === "up") ? 1 : 0,
        patDn: pats.some((p) => p.dir === "down") ? 1 : 0,
        patLast: lastDir ? (lastDir.dir === "up" ? 1 : -1) : 0,
        kijun: rd.lines.ok ? rd.lines.kijun : null,
        atrPct: st.atr15[i] != null ? (st.atr15[i] / bar.cl) * 100 : null,
        deliv,
        dTrend,
        hTrend: hourTrendSign(st, T, ltp),
        mTrend,
      });
    }
  }
  return { decisions: out, skipped };
}

// ---------- outcomes ----------------------------------------------------------------------------------------
const RES = { TARGET: 0, STOP: 1, BOTH: 2, TIMEOUT: 3, OPEN: 4, NA: 5 };
const RES_NAME = ["target", "stop", "both", "timeout", "open", "n/a"];
const BARRIERS = [
  { id: "fixed 0.5/0.5", kind: "F", t: 0.5, s: 0.5 },
  { id: "fixed 1.0/0.5", kind: "F", t: 1.0, s: 0.5 },
  { id: "fixed 0.5/1.0", kind: "F", t: 0.5, s: 1.0 },
  { id: "fixed 1.0/1.0", kind: "F", t: 1.0, s: 1.0 },
  { id: "ATR 0.5x/1.0x", kind: "A", tm: 0.5, sm: 1.0 },
  { id: "ATR 0.5x/0.5x", kind: "A", tm: 0.5, sm: 0.5 },
  { id: "ATR 1.0x/1.0x", kind: "A", tm: 1.0, sm: 1.0 },
  { id: "Kijun stop 1:1", kind: "K", cap: null },
  { id: "Kijun stop capped 0.5% 1:1", kind: "K", cap: 0.5 },
];
const HORIZONS = [3, 6, 12]; // 15m bars -> 45m / 90m / 3h
const ENTRIES = ["close", "next5m"];
const NB = BARRIERS.length;
const NH = HORIZONS.length;
const NE = ENTRIES.length;
const NC = NB * NH * NE;
const cIndex = (b, h, e) => (b * NH + h) * NE + e;
function cParts(c) {
  const e = c % NE;
  const h = Math.floor(c / NE) % NH;
  const b = Math.floor(c / (NE * NH));
  return { b, h, e };
}
const isOneToOne = (b) => b.kind === "F" ? b.t === b.s : b.kind === "A" ? b.tm === b.sm : true; // Kijun barriers are 1:1 by construction

// One path walk. Side +1 long / -1 short. Returns [res, grossPct, stopPct].
// target/stop are % distances from e. `both` and `stop` are charged -stopPct (conservative: never a win).
function walk(side, e, tgtPct, stopPct, j0, jEnd, st) {
  const tgt = e * (1 + (side * tgtPct) / 100);
  const stp = e * (1 - (side * stopPct) / 100);
  const { h5, l5, c5 } = st;
  for (let j = j0; j <= jEnd; j++) {
    const hT = side > 0 ? h5[j] >= tgt : l5[j] <= tgt;
    const hS = side > 0 ? l5[j] <= stp : h5[j] >= stp;
    if (hT && hS) return [RES.BOTH, -stopPct];
    if (hS) return [RES.STOP, -stopPct];
    if (hT) return [RES.TARGET, tgtPct];
  }
  return null; // unresolved: caller decides timeout vs open
}

// Computes outcome tables for every decision, both sides, every configuration.
// Layout: index = (di * 2 + sideIdx) * NC + c   (sideIdx 0 = long, 1 = short)
function computeOutcomes(decisions, stockBySym) {
  const N = decisions.length;
  const res = new Int8Array(N * 2 * NC).fill(RES.NA);
  const ret = new Float32Array(N * 2 * NC);
  const stp = new Float32Array(N * 2 * NC);
  const mfe = new Float32Array(N * 2 * NE * NH);
  const mae = new Float32Array(N * 2 * NE * NH);
  for (let di = 0; di < N; di++) {
    const d = decisions[di];
    if (d.j0 < 0) continue;
    const st = stockBySym.get(d.sym);
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? 1 : -1;
      for (let en = 0; en < NE; en++) {
        const e = en === 0 ? d.e : st.o5[d.j0];
        for (let h = 0; h < NH; h++) {
          const nb = HORIZONS[h] * 3;
          const jEnd = Math.min(d.j0 + nb - 1, d.end5);
          const truncated = d.j0 + nb - 1 > d.end5;
          // excursions over the whole horizon window (not cut by barriers)
          let f = 0;
          let a = 0;
          for (let j = d.j0; j <= jEnd; j++) {
            const fav = side > 0 ? (st.h5[j] - e) / e : (e - st.l5[j]) / e;
            const adv = side > 0 ? (e - st.l5[j]) / e : (st.h5[j] - e) / e;
            if (fav > f) f = fav;
            if (adv > a) a = adv;
          }
          const mi = ((di * 2 + s) * NE + en) * NH + h;
          mfe[mi] = f * 100;
          mae[mi] = a * 100;
          const endRet = ((st.c5[jEnd] - e) / e) * 100 * side;
          for (let b = 0; b < NB; b++) {
            const B = BARRIERS[b];
            let T;
            let S;
            if (B.kind === "F") {
              T = B.t;
              S = B.s;
            } else if (B.kind === "A") {
              if (d.atrPct == null) continue;
              T = B.tm * d.atrPct;
              S = B.sm * d.atrPct;
            } else {
              if (d.kijun == null) continue;
              const dist = side > 0 ? ((e - d.kijun) / e) * 100 : ((d.kijun - e) / e) * 100;
              if (!(dist > 0)) continue; // Kijun is on the wrong side of price: no valid stop
              S = B.cap != null ? Math.min(dist, B.cap) : dist;
              T = S;
            }
            const k = (di * 2 + s) * NC + cIndex(b, h, en);
            stp[k] = S;
            const r = walk(side, e, T, S, d.j0, jEnd, st);
            if (r) {
              res[k] = r[0];
              ret[k] = r[1];
            } else {
              res[k] = truncated ? RES.OPEN : RES.TIMEOUT;
              ret[k] = endRet;
            }
          }
        }
      }
    }
  }
  return { res, ret, stp, mfe, mae, N };
}

module.exports = {
  OPEN_MM, CLOSE_MM, FULL_5M, FULL_15M, addDays, monthBack, cleanBars, indexDays, atrSeries, lowerBoundT,
  prepStock, dailyTrendSign, hourTrendSign, openRvolAt, assemble, buildDecisions, computeOutcomes, walk,
  RES, RES_NAME, BARRIERS, HORIZONS, ENTRIES, NB, NH, NE, NC, cIndex, cParts, isOneToOne,
};
