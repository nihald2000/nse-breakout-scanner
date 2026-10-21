"use strict";
// orb5m.js - a closer replay of the published ORB design than the 15m decision grid.
//
// Rule: use the first 5m bar (09:15) as the opening range and its close-vs-open direction.
// Scan subsequent 5m bars; the first close beyond the range triggers an entry at the NEXT
// 5m open. Stop = 1 x ATR(14) on 5m bars at the trigger close. No target: exit at the last
// closed 5m bar of the day. One trade per stock per day. Optional "top 20 by first traded-5m
// RVOL" filter. This is still an adaptation: the paper scans every 5m and enters at the
// breakout level, while our entries are next-open and the stop uses 5m ATR.

const A = require("./analysis");

function atr5At(bars, j) {
  if (j < 14) return null;
  let sum = 0;
  for (let k = j - 13; k <= j; k++) {
    const b = bars[k];
    const p = bars[k - 1];
    if (!b || !p) return null;
    const tr = Math.max(b.hi - b.lo, Math.abs(b.hi - p.cl), Math.abs(b.lo - p.cl));
    if (!(tr >= 0)) return null;
    sum += tr;
  }
  return sum / 14;
}

function top20ByDay(dec) {
  const byDay = new Map();
  for (const d of dec) {
    if (d.openRvol == null) continue;
    let m = byDay.get(d.d);
    if (!m) byDay.set(d.d, (m = new Map()));
    const prev = m.get(d.sym);
    if (prev == null || d.openRvol > prev) m.set(d.sym, d.openRvol);
  }
  const out = new Map();
  for (const [day, m] of byDay) {
    const top = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20).map(([s]) => s);
    out.set(day, new Set(top));
  }
  return out;
}

function orb5mStats(ds, dec, opts) {
  const cost = opts.cost == null ? 0.05 : opts.cost;
  const split = opts.split || 0;
  const nDays = opts.nDays;
  const dates = [...new Set(dec.map((d) => d.d))].sort();
  const dayIdx = new Map(dates.map((d, i) => [d, i]));
  const tested = new Set(dec.map((d) => d.sym + "|" + d.d));
  const top20 = top20ByDay(dec);
  const perDay = Array.from({ length: nDays }, () => ({ s: 0, n: 0 }));
  const stopByDay = Array.from({ length: nDays }, () => 0);
  let events = 0;
  let stopped = 0;
  let missing = 0;

  for (const st of ds.stocks) {
    const bars = st.b5;
    const idx = st.idx5;
    if (!bars || !idx) continue;
    for (let o = 0; o < idx.dates.length; o++) {
      const D = idx.dates[o];
      const di = dayIdx.get(D);
      if (di == null) continue;
      if (!tested.has(st.sym + "|" + D)) continue;
      if (opts.top20Only) {
        const set = top20.get(D);
        if (!set || !set.has(st.sym)) continue;
      }
      const s = idx.starts[o];
      const e = idx.ends[o];
      if (s == null || e == null || e - s < 15) continue;
      let f = s;
      if (opts.firstTraded) {
        while (f < e && !(bars[f].vol > 0)) f++;
      }
      if (e - f < 15) continue;
      const first = bars[f];
      if (!first || first.mm < 555) continue;
      const dir = first.cl > first.o ? 1 : first.cl < first.o ? -1 : 0;
      if (!dir) continue;
      let j = -1;
      for (let k = f + 1; k < e; k++) {
        const b = bars[k];
        if (dir > 0 && b.cl > first.hi) { j = k; break; }
        if (dir < 0 && b.cl < first.lo) { j = k; break; }
      }
      if (j < 0 || j + 1 > e) continue;
      const entry = bars[j + 1].o;
      const atr = atr5At(bars, j);
      if (!(entry > 0) || !(atr > 0)) { missing++; continue; }
      const stop = dir > 0 ? entry - atr : entry + atr;
      let exit = null;
      let hitStop = false;
      for (let k = j + 1; k <= e; k++) {
        const b = bars[k];
        if (dir > 0 && b.lo <= stop) { exit = stop; hitStop = true; break; }
        if (dir < 0 && b.hi >= stop) { exit = stop; hitStop = true; break; }
      }
      if (hitStop) { stopped++; stopByDay[di]++; }
      if (exit == null) {
        const last = bars[e];
        exit = last && last.cl;
      }
      if (!(exit > 0)) { missing++; continue; }
      const gross = dir > 0 ? (exit / entry - 1) * 100 : (1 - exit / entry) * 100;
      perDay[di].s += gross - 2 * cost;
      perDay[di].n++;
      events++;
    }
  }
  const val = A.clusterFast(perDay.slice(split, nDays));
  const all = A.clusterFast(perDay.slice(0, nDays));
  const valN = perDay.slice(split, nDays).reduce((a, x) => a + x.n, 0);
  const valStops = stopByDay.slice(split, nDays).reduce((a, b) => a + b, 0);
  return {
    events, dec: events, missing,
    val: { n: valN, days: val.G, netExp: val.mean, netLo: val.ci[0], netHi: val.ci[1], netP1: val.p1, stopRate: valN > 0 ? valStops / valN : null },
    all: { n: events, days: all.G, netExp: all.mean, netLo: all.ci[0], netHi: all.ci[1], netP1: all.p1, stopRate: events > 0 ? stopped / events : null },
  };
}

module.exports = { atr5At, top20ByDay, orb5mStats };
