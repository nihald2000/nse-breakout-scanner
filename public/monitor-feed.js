// monitor-feed.js - the pure parts of the Trade Monitor (no DOM, no network), so they can be tested.
//
//   * batchSectors : split every F&O sector into /api/calls requests that each stay inside that route's own caps, so the
//                    Monitor can read ALL F&O stocks instead of only the eight hottest sectors
//   * mergeCalls   : put those replies back together as if they were one
//   * sipItems     : the live Stocks in Play (opening range breakout) plans and fills as Monitor items
//   * planAlerts   : which items are new since the last poll, who is allowed to notify, and when to send one summary
//                    notification instead of a burst
//
// Nothing here decides a trade. An alert only says "this appeared", with the levels the rule computed.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MonitorFeed = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var CAPS = { maxSectors: 8, maxSymbols: 100, perSector: 40 }; // mirrors api/calls.js (MAX_SECTORS, MAX_SYMBOLS, MAX_PER_SECTOR)
  var DEFAULT_PREFS = { index: true, sip: true, ctx: true, weak: true };
  var TIER = { strong: 0, moderate: 1, weak: 2 };
  var MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

  function finite(v) {
    return typeof v === "number" && isFinite(v);
  }

  // "24-Oct-2026 10:05 IST" -> epoch ms, or null.
  function asOfMs(text) {
    var m = String(text || "").match(/^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}) IST$/);
    if (!m || MONTHS[m[2]] == null) return null;
    return Date.UTC(+m[3], MONTHS[m[2]], +m[1], +m[4], +m[5]) - 330 * 60000;
  }

  // Sectors (from /api/sectors: {sector, n, pct}) -> batches of sector names, hottest first. Every sector with at least
  // one F&O stock is included; a batch holds at most maxSectors names and maxSymbols stocks (each sector counts for at
  // most perSector of them, the route's own per-sector cap).
  function batchSectors(sectors, caps) {
    var c = Object.assign({}, CAPS, caps || {});
    var list = (sectors || [])
      .filter(function (s) { return s && s.sector && finite(s.n) && s.n >= 1; })
      .slice()
      .sort(function (a, b) {
        var pa = finite(a.pct) ? Math.abs(a.pct) : -1;
        var pb = finite(b.pct) ? Math.abs(b.pct) : -1;
        return pb - pa || (a.sector < b.sector ? -1 : 1);
      });
    var batches = [];
    var cur = null;
    var count = 0;
    list.forEach(function (s) {
      var size = Math.min(s.n, c.perSector);
      if (!cur || cur.length >= c.maxSectors || count + size > c.maxSymbols) {
        cur = [];
        count = 0;
        batches.push(cur);
      }
      cur.push(s.sector);
      count += size;
    });
    return batches;
  }

  function sum(list, pick) {
    return list.reduce(function (t, x) {
      var v = pick(x);
      return t + (finite(v) ? v : 0);
    }, 0);
  }

  // parts: [{ data: /api/calls reply or null, optionsSkipped: bool }]. Returns { meta, signals } or null if every part failed.
  function mergeCalls(parts) {
    var ok = (parts || []).filter(function (p) { return p && p.data && Array.isArray(p.data.signals); });
    if (!ok.length) return null;
    var seen = {};
    var signals = [];
    ok.forEach(function (p) {
      p.data.signals.forEach(function (r) {
        if (!r || !r.sym || seen[r.sym]) return;
        seen[r.sym] = true;
        signals.push(p.optionsSkipped ? Object.assign({}, r, { optionSkipped: true }) : r);
      });
    });
    signals.sort(function (a, b) {
      var ta = a.read && a.read.trend;
      var tb = b.read && b.read.trend;
      return (TIER[ta && ta.tier] == null ? 3 : TIER[ta.tier]) - (TIER[tb && tb.tier] == null ? 3 : TIER[tb.tier]) ||
        (tb ? tb.agree || 0 : 0) - (ta ? ta.agree || 0 : 0) ||
        (tb ? tb.helpers || 0 : 0) - (ta ? ta.helpers || 0 : 0) ||
        (finite(b.rvol) ? b.rvol : -1) - (finite(a.rvol) ? a.rvol : -1);
    });
    var metas = ok.map(function (p) { return p.data.meta || {}; });
    var asOfs = metas.map(function (m) { return m.asOf; }).filter(function (t) { return asOfMs(t) != null; });
    asOfs.sort(function (a, b) { return asOfMs(b) - asOfMs(a); });
    var tier = function (t) { return signals.filter(function (r) { return r.read && r.read.trend && r.read.trend.tier === t; }).length; };
    return {
      meta: {
        tf: metas[0].tf || null,
        marketOpen: metas.some(function (m) { return m.marketOpen; }),
        asOf: asOfs[0] || null,
        wanted: sum(metas, function (m) { return m.wanted; }),
        loaded: sum(metas, function (m) { return m.loaded; }),
        failed: sum(metas, function (m) { return m.failed; }),
        truncated: metas.some(function (m) { return m.truncated; }),
        signals: signals.length,
        strong: tier("strong"),
        moderate: tier("moderate"),
        weak: tier("weak"),
        option: {
          loaded: sum(metas, function (m) { return m.option && m.option.loaded; }),
          failed: sum(metas, function (m) { return m.option && m.option.failed; })
        },
        batches: ok.length,
        batchesFailed: parts.length - ok.length
      },
      signals: signals
    };
  }

  // Live Stocks in Play items: a plan waiting for its stop order to be touched (PENDING) or a trade that fired (OPEN).
  // `fresh` is the page's verdict on the feed (market open and the data not stale); without it nothing is a live item.
  function sipItems(sip, fresh) {
    if (!fresh || !sip || !Array.isArray(sip.calls)) return [];
    return sip.calls
      .filter(function (c) { return c && (c.status === "PENDING" || c.status === "OPEN") && c.inPlay !== false; })
      .map(function (c) { return { kind: "sip", row: c, side: c.side === "long" ? "up" : "down", fresh: true }; });
  }

  function idOf(c, day) {
    if (c.kind === "index") return "ix|" + day + "|" + c.ix.index + "|" + c.row.strategy + "|" + c.row.action;
    if (c.kind === "sip") return "sip|" + day + "|" + c.row.sym + "|" + c.row.side;
    return "stk|" + day + "|" + c.row.sym + "|" + c.side;
  }

  // The "already told you" keys for an item in its current state. The LAST key decides whether this is news. A Stocks in
  // Play call has two moments: the plan (PENDING) and the fill (OPEN). Seeing it first as OPEN marks both as told, so a
  // late-opened page gets one alert for the fill and never a stale "plan" after it.
  function alertKeys(c, day) {
    var base = day + "|" + idOf(c, day);
    if (c.kind === "sip") return c.row.status === "OPEN" ? [base + "|plan", base + "|fill"] : [base + "|plan"];
    return [base];
  }

  function withDefaults(prefs) {
    return Object.assign({}, DEFAULT_PREFS, prefs || {});
  }

  function allowed(c, prefs) {
    var p = withDefaults(prefs);
    if (c.kind === "index") return !!p.index;
    if (c.kind === "sip") return !!p.sip;
    var tier = c.row && c.row.read && c.row.read.trend && c.row.read.trend.tier;
    return !!p.ctx && (tier !== "weak" || !!p.weak);
  }

  function label(c) {
    if (c.kind === "index") return "index trigger";
    if (c.kind === "sip") return c.row.status === "OPEN" ? "ORB trigger" : "ORB plan";
    return "stock watch";
  }

  // items: current Monitor items of ONE source. o: { day, seen (mutated), enabled, prefs, maxEach }.
  // Returns { individual: [items to notify one by one], summary: null | { count, text } }.
  // Index triggers always go out one by one. Stock items go out one by one up to maxEach, then as a single summary.
  function planAlerts(items, o) {
    var day = o.day;
    var seen = o.seen;
    var maxEach = o.maxEach == null ? 5 : o.maxEach;
    Object.keys(seen).forEach(function (k) {
      if (k.indexOf(day + "|") !== 0) delete seen[k]; // yesterday's keys are of no further use
    });
    var fresh = [];
    items.forEach(function (c) {
      var keys = alertKeys(c, day);
      var news = !seen[keys[keys.length - 1]];
      keys.forEach(function (k) { seen[k] = true; });
      if (news && o.enabled && allowed(c, o.prefs)) fresh.push(c);
    });
    var idx = fresh.filter(function (c) { return c.kind === "index"; });
    var rest = fresh.filter(function (c) { return c.kind !== "index"; });
    if (rest.length <= maxEach) return { individual: idx.concat(rest), summary: null };
    return { individual: idx, summary: { count: rest.length, text: summaryText(rest) } };
  }

  function summaryText(items) {
    var counts = {};
    var order = [];
    items.forEach(function (c) {
      var l = label(c);
      if (!counts[l]) order.push(l);
      counts[l] = (counts[l] || 0) + 1;
    });
    return items.length + " new alerts: " + order.map(function (l) { return counts[l] + " " + l + (counts[l] > 1 ? "s" : ""); }).join(", ") + ". Open the Trade Monitor to see each with its levels. No order was placed.";
  }

  function fmt(v) {
    return finite(v) ? v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "–";
  }
  function hhmm(mm) {
    if (!finite(mm)) return "–";
    return String(Math.floor(mm / 60)).padStart(2, "0") + ":" + String(mm % 60).padStart(2, "0");
  }

  function sipTitle(c) {
    return (c.row.side === "long" ? "BUY CE" : "BUY PE") + " · " + c.row.sym + " · ORB " + (c.row.status === "OPEN" ? "triggered" : "plan");
  }

  function sipBody(c) {
    var r = c.row;
    var parts = [];
    if (r.status === "OPEN") {
      parts.push("Triggered " + hhmm(r.entryMM) + " · entry " + fmt(r.entry) + " · stop " + fmt(r.stop) + (finite(r.r) ? " · " + (r.r >= 0 ? "+" : "−") + Math.abs(r.r).toFixed(2) + "R now" : ""));
    } else {
      parts.push((r.side === "long" ? "Buy-stop" : "Sell-stop") + " at " + fmt(r.level) + " · stop loss " + fmt(r.plannedStop));
    }
    parts.push((finite(r.rvol) ? r.rvol.toFixed(1) : "?") + (r.rankBy === "range" ? "× normal first-candle range (not volume)" : "× normal first-candle volume") + (finite(r.rank) ? " (#" + r.rank + ")" : ""));
    if (r.cautions && r.cautions.length) parts.push(r.cautions.length + " caution" + (r.cautions.length > 1 ? "s" : ""));
    parts.push("Underlying levels; no order was placed.");
    return parts.join(" · ");
  }

  return {
    CAPS: CAPS,
    DEFAULT_PREFS: DEFAULT_PREFS,
    asOfMs: asOfMs,
    batchSectors: batchSectors,
    mergeCalls: mergeCalls,
    sipItems: sipItems,
    idOf: idOf,
    alertKeys: alertKeys,
    allowed: allowed,
    withDefaults: withDefaults,
    planAlerts: planAlerts,
    summaryText: summaryText,
    sipTitle: sipTitle,
    sipBody: sipBody
  };
});
