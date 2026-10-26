// sip-overlay.js - draws the Stocks in Play opening-range-breakout call (lib/sip.js, served by /api/sip) on any stock chart
// made with chart-lite.js: the stop-order level, the stop loss, the fill and exit markers, and a one-line status chip.
//
//   NseSip.attach(handle, "RELIANCE", { bars })   // handle = NseChart.create(...); bars = the chart's own bars
//
// Everything here is a view of what the API computed. It adds no signal maths, never places an order and never hides a
// chart when the feed is down (the chip says the overlay is unavailable). The pure part (overlay, snapMM, describe) is
// separate from the browser part so it can be tested without a DOM.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(root);
  else root.NseSip = factory(root);
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var TEAL = "#2dd4bf"; // the stop order's price
  var ORANGE = "#fb923c"; // the stop loss
  var TTL_MS = 45000; // same as the API's own cache window

  function finite(v) {
    return typeof v === "number" && isFinite(v);
  }

  function hhmm(mm) {
    if (!finite(mm)) return "–";
    var h = Math.floor(mm / 60);
    var m = mm % 60;
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  function signedR(r) {
    if (!finite(r)) return "";
    return (r >= 0 ? "+" : "−") + Math.abs(r).toFixed(2) + "R";
  }

  // The chart bar a clock time falls into: the last bar starting at or before `mm`. Returns null when the chart has not
  // reached that time yet (its last bar ended before it) or starts after it, so a marker is never parked on the wrong bar.
  function snapMM(bars, mm) {
    if (!finite(mm)) return null;
    var starts = [];
    (bars || []).forEach(function (b) {
      if (b && finite(b.mm)) starts.push(b.mm);
    });
    if (!starts.length) return null;
    starts.sort(function (a, b) { return a - b; });
    var step = 0;
    for (var i = 1; i < starts.length; i++) {
      var d = starts[i] - starts[i - 1];
      if (d > 0 && (step === 0 || d < step)) step = d;
    }
    if (!step) step = 5;
    var pick = null;
    for (var j = 0; j < starts.length; j++) if (starts[j] <= mm) pick = starts[j];
    if (pick == null) return null;
    return mm >= pick + step ? null : pick;
  }

  // One-line state of the call for the chart header and the page text.
  function describe(call, skip) {
    if (!call) return { text: skip ? "ORB: no call — " + skip : "ORB: no call", side: "flat" };
    var ce = call.side === "long";
    var bits = ["ORB " + (ce ? "CE" : "PE"), finite(call.rvol) ? call.rvol.toFixed(1) + (call.rankBy === "range" ? "× range" : "× vol") : null];
    if (finite(call.rank)) bits.push("#" + call.rank);
    var st = call.status;
    if (st === "PENDING") bits.push("stop order not touched yet");
    else if (st === "OPEN") bits.push("triggered " + hhmm(call.entryMM) + (finite(call.r) ? " · " + signedR(call.r) : ""));
    else if (st === "STOPPED") bits.push("stopped " + signedR(call.r));
    else if (st === "EXITED") bits.push("flat " + signedR(call.r));
    else if (st === "NOT TRIGGERED") bits.push("never triggered");
    if (call.inPlay === false) bits.push("not in play");
    return { text: bits.filter(Boolean).join(" · "), side: ce ? "up" : "down" };
  }

  // Lines and markers for one call. `bars` are the chart's own bars (any timeframe); marker times snap onto them.
  function overlay(call, bars, skip) {
    var note = describe(call, skip);
    var out = { levels: [], markers: [], note: note };
    if (!call) return out;
    var ce = call.side === "long";
    if (finite(call.level)) out.levels.push({ price: call.level, title: "ORB " + (ce ? "CE" : "PE") + " IN", color: TEAL });
    var stop = finite(call.stop) ? call.stop : call.plannedStop;
    if (finite(stop)) out.levels.push({ price: stop, title: finite(call.stop) ? "ORB SL" : "ORB SL plan", color: ORANGE, dashed: true });
    if (finite(call.entry) && finite(call.level) && Math.abs(call.entry - call.level) > 0.005) {
      out.levels.push({ price: call.entry, title: "ORB FILL", color: "#dbe6ff", dashed: true });
    }
    if (finite(call.entry) && finite(call.entryMM)) {
      // entryMM is the end of the candle that touched the level, so that candle started five minutes earlier.
      var at = snapMM(bars, call.entryMM - 5);
      if (at != null) out.markers.push({ mm: at, position: ce ? "belowBar" : "aboveBar", color: TEAL, shape: ce ? "arrowUp" : "arrowDown", text: "ORB IN" });
    }
    if (finite(call.exit) && finite(call.exitMM)) {
      // A stop-out is stamped with the end of its candle; the 15:15 flat with the start of the candle it fills at.
      var t = call.status === "STOPPED" ? call.exitMM - 5 : call.exitMM;
      var lastBar = (bars || []).reduce(function (m, b) { return b && finite(b.mm) && b.mm > m ? b.mm : m; }, -1);
      var ex = snapMM(bars, call.status === "EXITED" ? Math.min(t, lastBar) : t);
      if (ex != null) {
        out.markers.push({
          mm: ex,
          position: ce ? "aboveBar" : "belowBar",
          color: finite(call.r) && call.r >= 0 ? "#22c55e" : "#ef4444",
          shape: "circle",
          text: (call.status === "STOPPED" ? "ORB SL " : "ORB OUT ") + signedR(call.r)
        });
      }
    }
    return out;
  }

  // Browser part: a small cached client. `deps` lets a test swap fetch, the clock and the chart's time mapping.
  function client(deps) {
    deps = deps || {};
    var doFetch = deps.fetch || function (url) {
      return root.fetch(url).then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
          return d;
        });
      });
    };
    var now = deps.now || function () { return Date.now(); };
    var toTime = deps.sessionTime || function (mm) { return root.NseChart ? root.NseChart.sessionTime(mm) : null; };
    var cache = Object.create(null); // SYM -> { at, p }

    // Resolves to { call, skip, bars, meta } or { error }; it never rejects, so a chart is never held up by this overlay.
    function load(sym, needBars) {
      var key = String(sym || "").toUpperCase();
      if (!key) return Promise.resolve({ error: "no symbol" });
      var hit = cache[key];
      if (hit && now() - hit.at < TTL_MS) {
        if (!needBars) return hit.p;
        var cached = hit.p;
        return cached.then(function (res) { return res && res.bars ? res : fetchOne(key); });
      }
      return fetchOne(key);
    }
    function fetchOne(key) {
      var p = Promise.resolve()
        .then(function () { return doFetch("/api/sip?sym=" + encodeURIComponent(key)); })
        .then(function (d) { return { call: d.call || null, skip: d.skip || null, bars: d.bars || [], meta: d.meta || null }; })
        .catch(function (e) {
          delete cache[key];
          return { error: (e && e.message) || "unavailable" };
        });
      cache[key] = { at: now(), p: p };
      return p;
    }

    // A page that already holds the full list can pass its calls in, so the charts do not ask again.
    function seed(calls, meta) {
      (calls || []).forEach(function (c) {
        if (!c || !c.sym) return;
        cache[String(c.sym).toUpperCase()] = { at: now(), p: Promise.resolve({ call: c, skip: null, bars: null, meta: meta || null }) };
      });
    }

    function paint(handle, res, bars) {
      if (!res || res.error) {
        handle.note("ORB overlay unavailable", "flat");
        return;
      }
      var ov = overlay(res.call, bars && bars.length ? bars : res.bars, res.skip);
      handle.addLevels(ov.levels);
      handle.setMarkers(ov.markers.map(function (m) {
        return { time: toTime(m.mm), position: m.position, color: m.color, shape: m.shape, text: m.text };
      }));
      handle.note(ov.note.text, ov.note.side);
    }

    // Draw the overlay on a chart that exists already. Safe to call on an empty-chart handle and after the chart was
    // replaced (it checks the handle is still the live one when the answer arrives).
    function attach(handle, sym, o) {
      o = o || {};
      if (!handle || typeof handle.addLevels !== "function") return Promise.resolve(null);
      return load(sym).then(function (res) {
        if (typeof handle.alive === "function" && !handle.alive()) return res;
        paint(handle, res, o.bars);
        return res;
      });
    }

    return { load: load, seed: seed, attach: attach, _cache: cache };
  }

  var api = { overlay: overlay, snapMM: snapMM, describe: describe, client: client, hhmm: hhmm, signedR: signedR };
  // The default client for a browser page.
  if (root && root.document) {
    var shared = client();
    api.load = shared.load;
    api.seed = shared.seed;
    api.attach = shared.attach;
  }
  return api;
});
