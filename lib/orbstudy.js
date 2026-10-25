// lib/orbstudy.js - a historical study of the Stocks in Play opening range breakout (lib/sip.js) on 5-minute bars.
// Pure functions: no network, no clock. api/orbstudy.js feeds it Yahoo bars. It reports what happened; it is not a signal.
//
// Per stock and session the study uses ONLY information available before the trade:
//   * relative volume of the 09:15 candle vs the same candle on the previous 14 full sessions (same rule as lib/sip.js)
//   * direction from the first candle's colour, entry level = its high (long) or low (short)
//   * the entry is the first later candle that touches the level (gap through the level fills at the open)
//   * ranking across stocks uses the same day's first candles only
// Trade outcome, for a grid of fixed underlying stops and targets (% of the entry price):
//   * stop is checked first inside any candle where stop and target are both reachable (pessimistic)
//   * the entry candle's own adverse extreme counts against the trade even if it happened before the fill (pessimistic)
//   * a trade that reaches neither is closed at the 15:15 open (the rule's flat time)
//   * costs: 0.05% of price per side on the underlying, the same assumption lib/sip.js uses (options cost more)
// A control: the same entry rule on the OPPOSITE side of the first candle ("against"), so the result can be compared with
// a trade that ignores the first candle's colour.
//
// What this cannot do: use real option prices (none are available historically), look beyond the sample's sessions,
// remove survivorship (it uses today's F&O list), or tell a regime from an edge. Intervals resample whole sessions.

const { SIP, bySession, daily, atrOf } = require("./sip");
const BSM = require("./bs");

const STUDY = {
  stops: [0.5, 0.75, 1, 1.5], // fixed underlying stop, % of the entry price
  targets: [1, 1.5, 2, 2.5, 3.5], // fixed underlying target, % of the entry price
  headline: [
    [0.75, 1.5],
    [0.75, 2.5],
    [1, 2],
    [1, 3.5],
  ],
  costPerSidePct: SIP.costPerSidePct,
  buckets: [
    { key: "09:20-09:35", from: 560, to: 575 },
    { key: "09:35-10:00", from: 575, to: 600 },
    { key: "10:00-11:00", from: 600, to: 660 },
    { key: "11:00-13:00", from: 660, to: 780 },
    { key: "13:00-15:15", from: 780, to: 916 },
  ],
  bootstrap: 400,
  seed: 20261025,
  dayCompleteMM: 905, // a session counts only if it has a bar at or after this minute
};

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const isFull = (s) => s.bars.length >= SIP.fullSessionBars && s.bars[0].mm === SIP.firstBarMM;
const finiteBar = (b) => b && Number.isFinite(b.o) && Number.isFinite(b.hi) && Number.isFinite(b.lo) && Number.isFinite(b.cl);

function median(a) {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// mulberry32: a small deterministic generator so the intervals do not change between runs.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Stage A: one stock -> its candidate stock-sessions (no cross-stock information yet).
// mode "volume": rank metric = first-candle volume / mean of the same candle over 14 prior full sessions (the rule).
// mode "range" : rank metric = first-candle high-low / mean of the same over 14 prior full sessions (a fallback for a feed
//                without a usable 09:15 volume; it is a different rule and is labelled as such in the reply).
function candidates(sym, rawBars, mode = "volume") {
  const skips = {};
  const skip = (k) => {
    skips[k] = (skips[k] || 0) + 1;
  };
  const out = [];
  const closed = (rawBars || []).filter(finiteBar);
  const sessions = bySession(closed);
  for (let k = 1; k < sessions.length; k++) {
    const s = sessions[k];
    if (!isFull(s) || s.bars[s.bars.length - 1].mm < STUDY.dayCompleteMM) {
      skip("incomplete session");
      continue;
    }
    const prior = sessions.slice(0, k).filter(isFull);
    if (prior.length < SIP.minHistory) {
      skip("needs 15 earlier full sessions");
      continue;
    }
    const first = s.bars[0];
    const recent = prior.slice(-SIP.baselineDays);
    let metric;
    if (mode === "range") {
      const base = recent.map((p) => p.bars[0].hi - p.bars[0].lo).filter((v) => v > 0);
      if (base.length < SIP.minBaselineDays) {
        skip("range baseline missing");
        continue;
      }
      metric = (first.hi - first.lo) / mean(base);
    } else {
      const base = recent.map((p) => p.bars[0].vol).filter((v) => Number.isFinite(v) && v > 0);
      if (base.length < SIP.minBaselineDays) {
        skip("first-candle volume history missing");
        continue;
      }
      if (!(first.vol > 0)) {
        skip("first candle has no volume");
        continue;
      }
      metric = first.vol / mean(base);
    }
    if (!(first.cl !== first.o)) {
      skip("doji first candle");
      continue;
    }
    const atr = atrOf(prior.slice(-(SIP.atrDays + 1)).map(daily), SIP.atrDays);
    if (!(atr > 0)) {
      skip("ATR unavailable");
      continue;
    }
    out.push({ sym, d: s.d, metric, first, riskDist: SIP.stopAtrFrac * atr, atr, bars: s.bars, sg: first.cl > first.o ? 1 : -1 });
  }
  return { cands: out, skips };
}

// ---------------------------------------------------------------------------------------------------------------
// Stage B: simulate one trade. sg = +1 long (buy-stop at `level`), -1 short.
function enter(bars, sg, level) {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.mm < SIP.firstBarEndMM) continue;
    if (b.mm >= SIP.exitMM) return null;
    if (sg > 0 ? b.hi >= level : b.lo <= level) {
      const entry = sg > 0 ? Math.max(level, b.o) : Math.min(level, b.o);
      return { i, entry, entryClose: b.mm + 5 };
    }
  }
  return null;
}

// Outcome for one (stopPx, targetPx or null) pair over the bars from the entry candle on.
function runCell(bars, i0, sg, entry, stopPx, targetPx, flatPx) {
  for (let i = i0; i < bars.length; i++) {
    const b = bars[i];
    if (b.mm >= SIP.exitMM) break;
    const hitStop = sg > 0 ? b.lo <= stopPx : b.hi >= stopPx;
    if (hitStop) {
      const fill = sg > 0 ? Math.min(b.o, stopPx) : Math.max(b.o, stopPx);
      return { res: "S", pct: (sg * (fill - entry) * 100) / entry, mm: b.mm + 5 };
    }
    if (targetPx != null && (sg > 0 ? b.hi >= targetPx : b.lo <= targetPx)) return { res: "T", pct: (sg * (targetPx - entry) * 100) / entry, mm: b.mm + 5 };
  }
  return { res: "X", pct: (sg * (flatPx - entry) * 100) / entry, mm: SIP.exitMM };
}

function simulate(c, dir) {
  const sg = dir === "with" ? c.sg : -c.sg;
  const level = sg > 0 ? c.first.hi : c.first.lo;
  const e = enter(c.bars, sg, level);
  if (!e) return null;
  const bars = c.bars;
  const flatBar = bars.find((b) => b.mm >= SIP.exitMM);
  const flatPx = flatBar ? flatBar.o : bars[bars.length - 1].cl;
  let mfe = 0;
  let mae = 0;
  let mfeMM = e.entryClose;
  for (let i = e.i; i < bars.length && bars[i].mm < SIP.exitMM; i++) {
    const fav = (sg * ((sg > 0 ? bars[i].hi : bars[i].lo) - e.entry) * 100) / e.entry;
    const adv = (sg * ((sg > 0 ? bars[i].lo : bars[i].hi) - e.entry) * 100) / e.entry;
    if (fav > mfe) {
      mfe = fav;
      mfeMM = bars[i].mm + 5;
    }
    if (adv < mae) mae = adv;
  }
  const cells = {};
  for (const s of STUDY.stops) {
    const stopPx = e.entry * (1 - (sg * s) / 100);
    for (const m of STUDY.targets) cells[s + "/" + m] = runCell(bars, e.i, sg, e.entry, stopPx, e.entry * (1 + (sg * m) / 100), flatPx);
  }
  // The paper's rule: stop at 10% of the 14-day ATR, no target, flat at 15:15.
  const paper = runCell(bars, e.i, sg, e.entry, e.entry - sg * c.riskDist, null, flatPx);
  const riskPct = (c.riskDist / e.entry) * 100;
  const paperR = paper.pct / riskPct - (2 * STUDY.costPerSidePct) / riskPct;
  return { entry: e.entry, entryClose: e.entryClose, mfe, mae, mfeMM, closePct: (sg * (flatPx - e.entry) * 100) / e.entry, cells, paperR, paperRes: paper.res, riskPct };
}

// All trades for a set of stocks' candidates: rank per day by the metric, simulate "with" for in-play names (metric >= 1)
// and the "against" control for the same names.
function buildTrades(allCands, opts = {}) {
  const topN = Number.isFinite(opts.topN) ? opts.topN : 10;
  const byDay = new Map();
  for (const c of allCands) {
    if (!byDay.has(c.d)) byDay.set(c.d, []);
    byDay.get(c.d).push(c);
  }
  const trades = [];
  let inPlay = 0;
  let inPlayTopN = 0;
  let daysSeen = 0;
  const days = [...byDay.keys()].sort();
  days.forEach((d, di) => {
    daysSeen++;
    const list = byDay
      .get(d)
      .filter((c) => c.metric >= SIP.minRvol)
      .sort((a, b) => b.metric - a.metric || (a.sym < b.sym ? -1 : 1));
    list.forEach((c, i) => {
      inPlay++;
      if (i < topN) inPlayTopN++;
      for (const dir of ["with", "against"]) {
        const t = simulate(c, dir);
        if (t) trades.push({ d, di, sym: c.sym, dir, rank: i + 1, metric: c.metric, side: (dir === "with" ? c.sg : -c.sg) > 0 ? "long" : "short", ...t });
      }
    });
  });
  return { trades, inPlay, inPlayTopN, days: daysSeen, topN };
}

// ---------------------------------------------------------------------------------------------------------------
// Aggregation
function cellStats(trades, key, s) {
  const cost = (2 * STUDY.costPerSidePct) / s;
  const n = trades.length;
  if (!n) return { n: 0 };
  let t = 0;
  let st = 0;
  let x = 0;
  const rs = [];
  const mins = [];
  for (const tr of trades) {
    const c = tr.cells[key];
    if (c.res === "T") {
      t++;
      mins.push(c.mm - tr.entryClose);
    } else if (c.res === "S") st++;
    else x++;
    rs.push(c.pct / s - cost);
  }
  return { n, pTarget: t / n, pStop: st / n, pTimeout: x / n, meanRNet: mean(rs), medMinToTarget: mins.length ? median(mins) : null };
}

function bootstrapDays(trades, statFn, B, seed) {
  const days = [...new Set(trades.map((t) => t.di))];
  if (days.length < 5) return null;
  const by = new Map(days.map((d) => [d, []]));
  for (const t of trades) by.get(t.di).push(t);
  const r = rng(seed);
  const vals = [];
  for (let b = 0; b < B; b++) {
    const pick = [];
    for (let k = 0; k < days.length; k++) {
      const arr = by.get(days[Math.floor(r() * days.length)]);
      for (const t of arr) pick.push(t);
    }
    const v = statFn(pick);
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  if (vals.length < B * 0.9) return null;
  return [vals[Math.floor(vals.length * 0.025)], vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.975))]];
}

const pTarget = (key) => (tr) => (tr.length ? tr.filter((t) => t.cells[key].res === "T").length / tr.length : NaN);
const meanR = (key, s) => (tr) => cellStats(tr, key, s).meanRNet;

function grid(trades) {
  const out = [];
  for (const s of STUDY.stops) for (const m of STUDY.targets) out.push({ stop: s, target: m, ...cellStats(trades, s + "/" + m, s) });
  return out;
}

function bucketOf(mm) {
  const b = STUDY.buckets.find((x) => mm >= x.from && mm < x.to);
  return b ? b.key : null;
}

function breakdown(trades, keyFn, order, stop, target) {
  const key = stop + "/" + target;
  return order.map((k) => {
    const sub = trades.filter((t) => keyFn(t) === k);
    return { group: k, ...cellStats(sub, key, stop) };
  });
}

function summarise(built, opts = {}) {
  const topN = opts.topN || built.topN || 10;
  const all = built.trades;
  const withT = all.filter((t) => t.dir === "with" && t.rank <= topN);
  const againstT = all.filter((t) => t.dir === "against" && t.rank <= topN);
  const [hs, hm] = STUDY.headline[0];
  const headline = STUDY.headline.map(([s, m]) => {
    const k = s + "/" + m;
    const w = cellStats(withT, k, s);
    const a = cellStats(againstT, k, s);
    return {
      stop: s,
      target: m,
      with: { ...w, ciPTarget: bootstrapDays(withT, pTarget(k), STUDY.bootstrap, STUDY.seed), ciMeanRNet: bootstrapDays(withT, meanR(k, s), STUDY.bootstrap, STUDY.seed + 1) },
      against: { ...a, ciPTarget: bootstrapDays(againstT, pTarget(k), STUDY.bootstrap, STUDY.seed + 2) },
    };
  });
  const firstDays = [...new Set(withT.map((t) => t.di))].sort((a, b) => a - b);
  const half = firstDays[Math.floor(firstDays.length / 2)];
  const k0 = hs + "/" + hm;
  const perDay = new Map();
  for (const t of withT) {
    if (!perDay.has(t.di)) perDay.set(t.di, []);
    perDay.get(t.di).push(t);
  }
  const dayR = [...perDay.values()].map((arr) => cellStats(arr, k0, hs).meanRNet);
  const ranks = (t) => (t.rank <= 5 ? "top 5" : t.rank <= 10 ? "6-10" : t.rank <= 20 ? "11-20" : "21+");
  const mBucket = (t) => (t.metric < 2 ? "1-2x" : t.metric < 4 ? "2-4x" : "4x+");
  const inTop = all.filter((t) => t.dir === "with");
  return {
    counts: {
      sessionsTested: built.days,
      inPlayStockSessions: built.inPlay,
      withTrades: all.filter((t) => t.dir === "with").length,
      withTradesTopN: withT.length,
      againstTradesTopN: againstT.length,
      inPlayTopN: built.inPlayTopN,
      triggerRateTopN: built.inPlayTopN ? withT.length / built.inPlayTopN : null,
    },
    headline,
    grid: { with: grid(withT), against: grid(againstT) },
    timing: breakdown(withT, (t) => bucketOf(t.entryClose), STUDY.buckets.map((b) => b.key), hs, hm),
    timingWide: breakdown(withT, (t) => bucketOf(t.entryClose), STUDY.buckets.map((b) => b.key), 0.75, 2.5),
    byRank: breakdown(inTop, ranks, ["top 5", "6-10", "11-20", "21+"], hs, hm),
    byMetric: breakdown(withT, mBucket, ["1-2x", "2-4x", "4x+"], hs, hm),
    bySide: breakdown(withT, (t) => t.side, ["long", "short"], hs, hm),
    stability: {
      firstHalf: cellStats(withT.filter((t) => t.di < half), k0, hs),
      secondHalf: cellStats(withT.filter((t) => t.di >= half), k0, hs),
      daysWithTrades: dayR.length,
      daysPositiveMeanR: dayR.filter((v) => v > 0).length,
      worstDayMeanR: dayR.length ? Math.min(...dayR) : null,
      bestDayMeanR: dayR.length ? Math.max(...dayR) : null,
    },
    excursion: {
      // unconstrained: how far a triggered breakout ran before 15:15, ignoring any stop
      mfeMedianPct: median(withT.map((t) => t.mfe)),
      mfeP25: quantile(withT.map((t) => t.mfe), 0.25),
      mfeP75: quantile(withT.map((t) => t.mfe), 0.75),
      shareMfeAtLeast: Object.fromEntries([1, 1.5, 2, 2.5, 3.5].map((x) => [x, withT.length ? withT.filter((t) => t.mfe >= x).length / withT.length : null])),
      closeMedianPct: median(withT.map((t) => t.closePct)),
      shareCloseInProfit: withT.length ? withT.filter((t) => t.closePct > 0).length / withT.length : null,
    },
    paperRule: {
      n: withT.length,
      meanRNet: mean(withT.map((t) => t.paperR)),
      shareStopped: withT.length ? withT.filter((t) => t.paperRes === "S").length / withT.length : null,
      shareWinnersAtClose: withT.length ? withT.filter((t) => t.paperRes !== "S" && t.paperR > 0).length / withT.length : null,
      ciMeanRNet: bootstrapDays(withT, (tr) => mean(tr.map((t) => t.paperR)), STUDY.bootstrap, STUDY.seed + 3),
      medianRiskPct: median(withT.map((t) => t.riskPct)),
    },
  };
}

function quantile(a, q) {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

// ---------------------------------------------------------------------------------------------------------------
// What an underlying move means for an at-the-money option's price. A Black-Scholes MODEL (flat IV, held fixed, European,
// r = 6.5%, no dividend, no spread): there is no historical option price data behind it. Hold time is 60 minutes of decay.
function premiumModel() {
  const S = 100;
  const rows = [];
  for (const iv of [0.25, 0.35, 0.45]) {
    for (const dte of [7, 25]) {
      const T = dte / 365;
      const p0 = BSM.price(S, S, T, BSM.BS.r, iv, "call");
      const T1 = T - 60 / BSM.BS.minutesPerYear;
      const gain = (movePct) => (BSM.price(S * (1 + movePct / 100), S, T1, BSM.BS.r, iv, "call") / p0 - 1) * 100;
      const need = (g) => {
        let lo = 0;
        let hi = 25;
        for (let k = 0; k < 60; k++) {
          const mid = (lo + hi) / 2;
          if (gain(mid) < g) lo = mid;
          else hi = mid;
        }
        return (lo + hi) / 2;
      };
      rows.push({
        ivPct: iv * 100,
        dte,
        premiumPctOfSpot: (p0 / S) * 100,
        gainPctAtMove: Object.fromEntries([0.75, 1, 1.5, 2, 2.5, 3.5].map((m) => [m, gain(m)])),
        lossPctAtMinus: Object.fromEntries([0.5, 0.75, 1, 1.5].map((m) => [m, gain(-m)])),
        moveNeededForGain: { 20: need(20), 35: need(35), 50: need(50) },
      });
    }
  }
  return rows;
}

module.exports = { STUDY, candidates, simulate, enter, buildTrades, summarise, cellStats, bootstrapDays, premiumModel, rng, median, quantile };
