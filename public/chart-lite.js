// chart-lite.js - a small, dependency-free wrapper around TradingView's
// Lightweight Charts (Apache-2.0, vendored in /vendor). It keeps the NSE
// pages framework-free while giving them the same interactive chart engine
// OpenTerminal uses: candles, volume, crosshair OHLC, zoom/pan and overlay lines.
//
// Intraday bars only. The time axis is a session clock: every bar's `mm`
// (minutes after IST midnight) is mapped onto a fixed UTC day, and formatters
// render UTC. No date is invented for a bar and no timezone conversion is done.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NseChart = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var GLOBAL = typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this);
  var BASE_TS = Date.UTC(2000, 0, 3) / 1000; // a Monday, used only as an x-axis anchor

  function finite(v) {
    return typeof v === "number" && isFinite(v);
  }

  function sessionTime(mm) {
    if (!finite(mm)) return null;
    return BASE_TS + Math.round(mm * 60);
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function clock(ts) {
    if (!finite(ts)) return "";
    var d = new Date(ts * 1000);
    return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
  }

  // Closed candles -> Lightweight Charts data. Missing open/low/high fall back
  // to the close exactly as the old canvas did; no value is manufactured.
  function candleData(bars) {
    var out = [];
    (bars || []).forEach(function (b) {
      if (!b || !finite(b.mm) || !finite(b.cl)) return;
      var t = sessionTime(b.mm);
      if (t == null) return;
      out.push({
        time: t,
        open: finite(b.o) ? b.o : b.cl,
        high: finite(b.hi) ? b.hi : b.cl,
        low: finite(b.lo) ? b.lo : b.cl,
        close: b.cl,
        _mm: b.mm,
        _vol: finite(b.vol) ? b.vol : null
      });
    });
    out.sort(function (a, b) { return a.time - b.time; });
    return out;
  }

  function lineData(bars, key) {
    var out = [];
    (bars || []).forEach(function (b) {
      if (!b || !finite(b.mm) || !finite(b[key])) return;
      var t = sessionTime(b.mm);
      if (t == null) return;
      out.push({ time: t, value: b[key] });
    });
    out.sort(function (a, b) { return a.time - b.time; });
    return out;
  }

  function volumeData(bars) {
    var out = [];
    (bars || []).forEach(function (b) {
      if (!b || !finite(b.mm) || !finite(b.vol) || b.vol <= 0) return;
      var t = sessionTime(b.mm);
      if (t == null) return;
      out.push({
        time: t,
        value: b.vol,
        color: b.cl >= (finite(b.o) ? b.o : b.cl) ? "rgba(34,197,94,.38)" : "rgba(239,68,68,.38)"
      });
    });
    out.sort(function (a, b) { return a.time - b.time; });
    return out;
  }

  function fmtNum(v, digits) {
    if (!finite(v)) return "\u2013";
    var d = digits == null ? 2 : digits;
    return v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fmtVol(v) {
    if (!finite(v)) return "\u2013";
    if (v >= 1e7) return (v / 1e7).toFixed(2) + " Cr";
    if (v >= 1e5) return (v / 1e5).toFixed(1) + " L";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
    return String(Math.round(v));
  }

  function trendBadge(read) {
    var tv = read && read.trend;
    if (!tv || !tv.side) return { text: "no CE/PE lean \u2014 two-way", side: "flat" };
    return {
      text: (tv.side === "up" ? "CE" : "PE") + " lean \u00b7 " +
        (tv.tier === "strong" ? "one-sided" : tv.tier === "moderate" ? "building" : "weak") +
        " \u00b7 " + tv.agree + "/" + tv.total + " checks",
      side: tv.side
    };
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function destroy(host) {
    if (!host || !host._nseChart) return;
    try { host._nseChart.destroy(); } catch (e) { /* already torn down */ }
    host._nseChart = null;
  }

  function destroyAll(rootEl) {
    if (!rootEl || !rootEl.querySelectorAll) return;
    var nodes = rootEl.querySelectorAll(".nsechart-host");
    for (var i = 0; i < nodes.length; i++) destroy(nodes[i]);
  }

  function create(host, opts) {
    if (!host) throw new Error("NseChart.create needs a container element.");
    var lib = GLOBAL.LightweightCharts;
    if (!lib) throw new Error("LightweightCharts is not loaded.");
    opts = opts || {};
    destroy(host);
    host.textContent = "";
    host.classList.add("nsechart-host");

    var bars = opts.bars || [];
    var candles = candleData(bars);
    var box = el("div", "nsechart");
    host.appendChild(box);

    var head = el("div", "nsechart-head");
    var badge = trendBadge(opts.read);
    var b = el("span", "nsechart-badge " + (badge.side || "flat"), badge.text);
    head.appendChild(b);
    var tf = el("span", "nsechart-meta", (opts.timeframe || "15m") + " closed");
    head.appendChild(tf);
    box.appendChild(head);

    var stage = el("div", "nsechart-stage");
    box.appendChild(stage);

    if (candles.length < 2) {
      stage.appendChild(el("div", "nsechart-empty", opts.empty || "not enough closed candles yet"));
      var emptyHandle = {
        destroy: function () {
          try { chart.remove(); } catch (e) { /* not created */ }
          host.textContent = "";
          host._nseChart = null;
        }
      };
      var chart = null;
      host._nseChart = emptyHandle;
      return emptyHandle;
    }

    var legend = el("div", "nsechart-legend");
    stage.appendChild(legend);

    var canvasHost = el("div", "nsechart-canvas");
    stage.appendChild(canvasHost);

    var startW = Math.max(300, canvasHost.clientWidth || host.clientWidth || 300);
    var startH = Math.max(180, canvasHost.clientHeight || host.clientHeight || 180);
    var chart = lib.createChart(canvasHost, {
      autoSize: false,
      width: startW,
      height: startH,
      layout: {
        background: { color: "#0e1628" },
        textColor: "#8a97b8",
        fontSize: 10,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        attributionLogo: false
      },
      grid: {
        vertLines: { color: "#16223c" },
        horzLines: { color: "#16223c" }
      },
      crosshair: {
        mode: lib.CrosshairMode.Normal,
        vertLine: { color: "#3a4a70", style: lib.LineStyle.Dashed, labelBackgroundColor: "#1d2c52" },
        horzLine: { color: "#3a4a70", style: lib.LineStyle.Dashed, labelBackgroundColor: "#1d2c52" }
      },
      rightPriceScale: {
        borderColor: "#1b2742",
        scaleMargins: { top: 0.08, bottom: 0.24 }
      },
      timeScale: {
        borderColor: "#1b2742",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
        tickMarkFormatter: function (time) { return clock(time); }
      },
      localization: {
        timeFormatter: function (time) { return clock(time); },
        priceFormatter: function (price) { return fmtNum(price, 2); }
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true }
    });

    var candleSeries = chart.addSeries(lib.CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 }
    });
    candleSeries.setData(candles);

    var volumes = volumeData(bars);
    if (volumes.length) {
      var volSeries = chart.addSeries(lib.HistogramSeries, {
        priceScaleId: "vol",
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false
      });
      volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volSeries.setData(volumes);
    }

    var lineSpecs = opts.lines || [];
    lineSpecs.forEach(function (spec) {
      var data = lineData(bars, spec.key);
      if (data.length < 2) return;
      chart.addSeries(lib.LineSeries, {
        color: spec.color,
        lineWidth: 1,
        lineStyle: spec.dashed ? lib.LineStyle.Dashed : lib.LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false
      }).setData(data);
    });

    var lo = Infinity;
    var hi = -Infinity;
    candles.forEach(function (c) {
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    });
    function inRange(v) { return finite(v) && v >= lo && v <= hi; }

    if (finite(opts.prevClose)) {
      candleSeries.createPriceLine({
        price: opts.prevClose,
        color: "#7c89a8",
        lineWidth: 1,
        lineStyle: lib.LineStyle.Dashed,
        axisLabelVisible: true,
        title: "prev"
      });
    }
    if (opts.or && inRange(opts.or.hi) && inRange(opts.or.lo)) {
      [
        { price: opts.or.hi, title: "OR hi" },
        { price: opts.or.lo, title: "OR lo" }
      ].forEach(function (line) {
        candleSeries.createPriceLine({
          price: line.price,
          color: "#3b82f6",
          lineWidth: 1,
          lineStyle: lib.LineStyle.Dashed,
          axisLabelVisible: true,
          title: line.title
        });
      });
    }

    var byTime = new Map();
    candles.forEach(function (c) { byTime.set(c.time, c); });
    var last = candles[candles.length - 1];

    function renderLegend(c) {
      legend.textContent = "";
      if (!c) return;
      function item(label, value, cls) {
        var span = el("span", "nsechart-legitem" + (cls ? " " + cls : ""));
        span.appendChild(el("b", null, label));
        span.appendChild(document.createTextNode(" " + value));
        legend.appendChild(span);
      }
      item("O", fmtNum(c.open, 2));
      item("H", fmtNum(c.high, 2), "up");
      item("L", fmtNum(c.low, 2), "down");
      item("C", fmtNum(c.close, 2), c.close >= c.open ? "up" : "down");
      if (c._vol != null) item("Vol", fmtVol(c._vol));
      lineSpecs.forEach(function (spec) {
        var raw = null;
        for (var i = 0; i < bars.length; i++) {
          if (finite(bars[i].mm) && sessionTime(bars[i].mm) === c.time && finite(bars[i][spec.key])) {
            raw = bars[i][spec.key];
            break;
          }
        }
        if (raw != null) item(spec.label || spec.key, fmtNum(raw, 2), "trendline");
      });
    }

    chart.subscribeCrosshairMove(function (param) {
      var c = param && param.time != null ? byTime.get(param.time) : null;
      renderLegend(c || last);
    });
    canvasHost.addEventListener("mouseleave", function () { renderLegend(last); });
    renderLegend(last);

    // Lightweight Charts defaults to a 300x150 canvas when it is built in a
    // pane that has not been laid out yet. Size it from the real container and
    // keep it in step with that container; this is also the fix for blank
    // charts after a panel is re-opened or the window changes size.
    var lastW = 0;
    var lastH = 0;
    function relayout() {
      var w = canvasHost.clientWidth;
      var h = canvasHost.clientHeight;
      if (w <= 0 || h <= 0) return;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      chart.resize(w, h);
      // A width change keeps the old bar spacing, which can hide most of the
      // session (especially when a phone is rotated or a panel is resized).
      chart.timeScale().fitContent();
    }
    relayout();
    var ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(relayout);
      ro.observe(canvasHost);
    } else {
      window.addEventListener("resize", relayout);
    }

    var handle = {
      chart: chart,
      series: candleSeries,
      destroy: function () {
        if (ro) ro.disconnect(); else window.removeEventListener("resize", relayout);
        try { chart.remove(); } catch (e) { /* already removed */ }
        host.textContent = "";
        host._nseChart = null;
      }
    };
    host._nseChart = handle;
    return handle;
  }

  return {
    create: create,
    destroy: destroy,
    destroyAll: destroyAll,
    trendBadge: trendBadge,
    sessionTime: sessionTime,
    clock: clock,
    candleData: candleData,
    lineData: lineData,
    volumeData: volumeData,
    fmtVol: fmtVol,
    BASE_TS: BASE_TS
  };
});
