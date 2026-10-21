"use strict";
// Research-only fixed variants of four helpers used by the Live Calls read.
// Nothing in lib/ or api/ imports this file. The fixes are switches for the
// backtest, so the live behaviour stays untouched until a fix is validated.

// 1. VWAP on zero-volume bars: carry the last valid VWAP forward instead of
//    jumping to that bar's typical price. A leading zero-volume bar has no
//    prior VWAP to carry, so it falls back to its typical price (same as live).
function vwapSeries(bars) {
  let sp = 0;
  let sv = 0;
  let last = null;
  return bars.map((b) => {
    const tp = (b.hi + b.lo + b.cl) / 3;
    if (b.vol > 0) {
      sp += tp * b.vol;
      sv += b.vol;
      last = sp / sv;
      return last;
    }
    return last != null ? last : tp;
  });
}

// 2. Opening-range break: the check is the CURRENT state, not the first break
//    of the day. If the latest closed bar is back inside the range, there is no
//    break; if it is beyond the other side, the side flips.
function orStats(bars) {
  const or = bars.filter((b) => b.mm >= 555 && b.mm < 570);
  if (or.length < 3) return null;
  const hi = Math.max(...or.map((b) => b.hi));
  const lo = Math.min(...or.map((b) => b.lo));
  let brokeUp = null;
  let brokeDown = null;
  const last = bars.length ? bars[bars.length - 1] : null;
  if (last && last.mm >= 570) {
    if (last.cl > hi) brokeUp = last.mm;
    else if (last.cl < lo) brokeDown = last.mm;
  }
  const pos = brokeUp != null ? "up" : brokeDown != null ? "down" : null;
  // pos/mm are what the live read uses now; brokeUp/brokeDown are kept for the
  // historical single-fix comparison in fixed/.
  return { hi, lo, pos, mm: last ? last.mm : null, brokeUp, brokeDown };
}

// 3. Volume spike: only the latest closed 5m bar is compared with its same
//    clock slot on earlier sessions. An earlier spike is no longer a helper
//    for the rest of the day.
function volSpike(day, prevMap) {
  if (!day.length) return null;
  const b = day[day.length - 1];
  const byMM = new Map();
  for (const bars of prevMap.values()) {
    for (const x of bars) {
      if (x.mm !== b.mm) continue;
      if (!byMM.has(x.mm)) byMM.set(x.mm, []);
      byMM.get(x.mm).push(x.vol);
    }
  }
  const arr = byMM.get(b.mm);
  if (!arr || arr.length < 3) return null;
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  if (!(mean > 0)) return null;
  const mult = b.vol / mean;
  return mult >= 1.8 ? { mm: b.mm, mult } : null;
}

// 4. Range vs normal: compare today's range-so-far with each prior session's
//    range over the SAME clock window. This removes the part-day vs full-day
//    bias that made the ratio rise simply because the session aged.
function rangeVsNormal(tfBars) {
  if (!tfBars || !tfBars.length) return null;
  const byDay = new Map();
  for (const b of tfBars) {
    if (!byDay.has(b.d)) byDay.set(b.d, []);
    byDay.get(b.d).push(b);
  }
  const days = [...byDay.values()];
  if (days.length < 6) return null;
  const lastBars = days[days.length - 1];
  const cutoff = lastBars[lastBars.length - 1].mm;
  const rangeAt = (bars) => {
    let hi = -Infinity;
    let lo = Infinity;
    for (const b of bars) {
      if (b.mm > cutoff) continue;
      if (b.hi > hi) hi = b.hi;
      if (b.lo < lo) lo = b.lo;
    }
    return hi >= lo ? hi - lo : null;
  };
  const today = rangeAt(lastBars);
  const prev = days.slice(-21, -1).map(rangeAt).filter((x) => x != null);
  if (today == null || prev.length < 3) return null;
  const avg = prev.reduce((s, x) => s + x, 0) / prev.length;
  return { today, avg, ratio: avg > 0 ? today / avg : null, windowMm: cutoff };
}

module.exports = { vwapSeries, orStats, volSpike, rangeVsNormal };
