// lib/candlebacktest.js - replay of the Sector Scope intraday read, candle by candle, on
// CLOSED 15-minute bars. Pure functions, no network.
//
// At every bar i the read is rebuilt from bars[0..i] only (no look-ahead), the verdict is the
// same one the page shows (checks -> lean -> trendVerdict), and a signal is recorded when the
// verdict's SIDE changes. The entry is the close of the signalling candle; the outcome is what
// the underlying did over the next h closed candles of the SAME session (never across the
// overnight gap): did +target% or -stop% come first, plus the best/worst excursion either way.
//
// Honest limits, stated here and on the page:
//   * Underlying moves only - no option premium, no spread, no costs, no slippage.
//   * If ONE candle touches both the target and the stop the order is unknowable; the row
//     says "both" instead of guessing a winner.
//   * This is a fact-check of the read over a small in-sample window, not proof of an edge.
//   * The live read computes VWAP/patterns/opening range on 5m bars; here everything is
//     computed on the 15m series (the frame the user actually sees), so values can differ.

const {
  vwapSeries,
  lineState,
  swingStructure,
  vwapTrend,
  volSpike,
  adxRead,
  rangeVsNormal,
  patternAt,
  trendVerdict,
} = require("./sector");

const OR_END = 570;      // 09:30 IST - the first 15m bar IS the opening range
const VWAP_LOOK = 4;     // 4 x 15m = 1 hour, same span as the live 12 x 5m slope
const STRUCT_BUCKET = 2; // 2 x 15m = 30 minutes, same span as the live 6 x 5m swings

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
function clampNum(v, dflt, lo, hi) {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
}

// Opening range on 15m bars: the 09:15-09:30 candle's high/low, and where the LAST
// closed bar sits relative to it. Current state, not the first break of the day -
// the live read uses the same rule (CODE_REVIEW finding 1).
function openingRange(day) {
  const first = day.find((b) => b.mm != null && b.mm < OR_END);
  if (!first || !(first.hi > first.lo)) return null;
  const hi = first.hi;
  const lo = first.lo;
  const last = day[day.length - 1];
  let pos = null;
  if (last) {
    if (last.cl > hi) pos = "up";
    else if (last.cl < lo) pos = "down";
  }
  return { hi, lo, pos, mm: last ? last.mm : null };
}

// The read as it stood at the last bar of `today`, using `slice` (all history up to that bar)
// for the line/ADX continuity and `prevMap` (earlier sessions) for the volume-slot baseline.
function verdictAt(slice, today, prevMap) {
  const b = today[today.length - 1];
  const vw = vwapSeries(today);
  const hasVol = today.some((x) => x.vol > 0);
  const vwapNow = hasVol ? vw[vw.length - 1] : null;
  const vtrend = vwapTrend(vw, VWAP_LOOK);
  const lines = lineState(slice);
  const structure = swingStructure(today, STRUCT_BUCKET);
  const or = openingRange(today);
  const adx = adxRead(slice);
  const vs = volSpike(today, prevMap);
  const range = rangeVsNormal(slice);
  const read = { vwapTrend: vtrend, structure, or, adx, volSpike: vs, range };
  // Same check list, same order, as api/sectorstocks.js
  const checks = [];
  if (vwapNow != null) checks.push(b.cl > vwapNow ? "up" : b.cl < vwapNow ? "down" : null);
  if (vtrend && vtrend.dir !== "flat") checks.push(vtrend.dir);
  if (lines.ok) {
    if (/above both/.test(lines.pos)) checks.push("up");
    else if (/below both/.test(lines.pos)) checks.push("down");
  }
  if (structure && structure.dir) checks.push(structure.dir);
  if (or) checks.push(or.pos);
  if (adx && adx.v >= 18 && adx.dir) checks.push(adx.dir);
  read.lean = {
    up: checks.filter((c) => c === "up").length,
    down: checks.filter((c) => c === "down").length,
    total: checks.filter((c) => c === "up" || c === "down").length,
  };
  read.trend = trendVerdict(read);
  read.patterns = patternAt(today, today.length - 1).map((p) => p.name);
  return read;
}

function dirMove(cl, entry, side) {
  return r2(((cl - entry) / entry) * 100 * (side === "up" ? 1 : -1));
}

// What the underlying did after the signal bar j. Same session only, at most h closed candles.
// result: target | stop | both (touched inside one candle, order unknowable) | timeout | open.
function measureOutcome(dayBars, j, side, entry, h, target, stop) {
  const fut = dayBars.slice(j + 1, j + 1 + h);
  if (!fut.length) return { result: "open", fav: null, adv: null, move: null, bars: 0 };
  let fav = 0;
  let adv = 0;
  for (let k = 0; k < fut.length; k++) {
    const b = fut[k];
    const f = side === "up" ? ((b.hi - entry) / entry) * 100 : ((entry - b.lo) / entry) * 100;
    const a = side === "up" ? ((entry - b.lo) / entry) * 100 : ((b.hi - entry) / entry) * 100;
    if (f > fav) fav = f;
    if (a > adv) adv = a;
    const hitT = f >= target;
    const hitS = a >= stop;
    if (hitT && hitS) return { result: "both", fav: r2(fav), adv: r2(adv), move: dirMove(b.cl, entry, side), bars: k + 1 };
    if (hitS) return { result: "stop", fav: r2(fav), adv: r2(adv), move: dirMove(b.cl, entry, side), bars: k + 1 };
    if (hitT) return { result: "target", fav: r2(fav), adv: r2(adv), move: dirMove(b.cl, entry, side), bars: k + 1 };
  }
  return { result: "timeout", fav: r2(fav), adv: r2(adv), move: dirMove(fut[fut.length - 1].cl, entry, side), bars: fut.length };
}

function dayGroups(bars) {
  const days = [];
  const idx = new Map();
  for (let i = 0; i < bars.length; i++) {
    const d = bars[i].d;
    if (!idx.has(d)) {
      idx.set(d, days.length);
      days.push([]);
    }
    days[idx.get(d)].push({ b: bars[i], i });
  }
  return days;
}

// bars: oldest first, CLOSED 15m bars only ({ d, mm, t, o, hi, lo, cl, vol }).
// opts: h (1..6), target %, stop %, warmup bars, maxEvents.
// Returns { events, days, truncated }. Events carry no sym - the caller adds it.
function replayRead(bars, opts = {}) {
  const h = Math.round(clampNum(opts.h, 3, 1, 6));
  const target = clampNum(opts.target, 0.5, 0.05, 20);
  const stop = clampNum(opts.stop, 0.5, 0.05, 20);
  const warmup = Math.round(clampNum(opts.warmup, 45, 30, 400));
  const maxEvents = Math.round(clampNum(opts.maxEvents, 1200, 1, 5000));
  const days = dayGroups(bars);
  const events = [];
  let truncated = false;
  for (let di = 0; di < days.length && !truncated; di++) {
    const d = days[di];
    const prevMap = new Map();
    for (let k = 0; k < di; k++) prevMap.set(days[k][0].b.d, days[k].map((x) => x.b));
    const dayBars = d.map((x) => x.b);
    let prevSide = null; // resets each session: every day is judged as its own read
    for (let j = 0; j < d.length; j++) {
      const i = d[j].i;
      if (i + 1 < warmup) continue;
      const read = verdictAt(bars.slice(0, i + 1), dayBars.slice(0, j + 1), prevMap);
      const trend = read.trend;
      const side = trend && trend.side ? trend.side : null;
      if (side && side !== prevSide) {
        const entry = dayBars[j].cl;
        const out = measureOutcome(dayBars, j, side, entry, h, target, stop);
        events.push({
          d: dayBars[j].d,
          mm: dayBars[j].mm,
          side,
          tier: trend.tier,
          agree: trend.agree,
          total: trend.total,
          helpers: trend.helpers,
          entry: r2(entry),
          pat: read.patterns.slice(0, 2),
          ...out,
        });
        if (events.length >= maxEvents) {
          truncated = true;
          break;
        }
      }
      prevSide = side;
    }
  }
  return { events, days: days.length, truncated };
}

module.exports = { replayRead, openingRange, verdictAt, measureOutcome };
module.exports._internals = { clampNum, dayGroups, dirMove };
