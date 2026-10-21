// index-chart-data.js - pure data preparation for the Index Options chart.
// The API returns the latest (possibly still forming) 5-minute bar. The chart
// only plots closed bars: a bar is closed when its 5-minute window has ended.
// This keeps the chart on the same no-look-ahead footing as the signals.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.IndexChartData = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var BAR_SEC = 300;

  function finite(v) {
    return typeof v === "number" && isFinite(v);
  }

  // Align the index VWAP/session-average array with the bars that are kept.
  // Missing values stay missing; no value is carried forward or invented.
  function sessionBars(d) {
    var all = (d && d.bars) || [];
    var vwap = (d && d.vwap) || [];
    var live = !!(d && d.live);
    var nowSec = d && d.nowSec;
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      if (!b || !finite(b.mm) || !finite(b.cl)) continue;
      if (live && finite(nowSec) && finite(b.t) && b.t + BAR_SEC > nowSec) continue;
      var row = { t: b.t, mm: b.mm, o: b.o, hi: b.hi, lo: b.lo, cl: b.cl };
      if (finite(b.vol)) row.vol = b.vol;
      if (finite(vwap[i])) row.vwap = vwap[i];
      out.push(row);
    }
    out.sort(function (a, b) { return a.mm - b.mm; });
    return out;
  }

  function exitMM(s, lastMM) {
    var a = s && s.x1 && finite(s.x1.exitMM) ? s.x1.exitMM : null;
    var b = s && s.x2 && finite(s.x2.exitMM) ? s.x2.exitMM : null;
    var end = a == null ? b : b == null ? a : Math.max(a, b);
    if (end == null) end = lastMM;
    return end == null ? null : Math.min(end, lastMM);
  }

  // The trigger marker sits on the bar whose close produced the signal. Entry
  // and risk levels start on the next bar, where the replay fills at its open.
  // These are annotations only; this function never changes the signal/levels.
  function signalOverlays(signals, bars) {
    var list = bars || [];
    var at = {};
    list.forEach(function (b) { if (finite(b.mm)) at[b.mm] = true; });
    var lastMM = list.length ? list[list.length - 1].mm : null;
    var markers = [];
    var levels = [];
    (signals || []).forEach(function (s) {
      if (!s || !finite(s.entryMM) || !finite(s.entry)) return;
      var triggerMM = s.entryMM - 5;
      if (!at[triggerMM]) triggerMM = s.entryMM;
      if (!at[triggerMM]) return;
      markers.push({
        mm: triggerMM,
        side: s.side === "long" ? "long" : "short",
        strategy: s.strategy
      });
      var end = exitMM(s, lastMM);
      if (end == null || end <= triggerMM) return;
      ["sl", "t1", "t2"].forEach(function (kind) {
        if (!finite(s[kind])) return;
        levels.push({ fromMM: s.entryMM, toMM: end, price: s[kind], kind: kind });
      });
    });
    markers.sort(function (a, b) { return a.mm - b.mm; });
    return { markers: markers, levels: levels };
  }

  return {
    BAR_SEC: BAR_SEC,
    sessionBars: sessionBars,
    signalOverlays: signalOverlays
  };
});
