// alerts-store.js - browser-local log of the chart setup alerts.
// This is deliberately separate from bs-journal-v1 (paper option trades):
// these are underlying index levels, not option premiums, so mixing them into
// the premium statistics would be wrong. The Journal page shows both.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AlertsStore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var KEY = "bs-chart-alerts-v1";

  function finite(v) {
    return typeof v === "number" && isFinite(v);
  }

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      var a = raw ? JSON.parse(raw) : [];
      return Array.isArray(a) ? a.filter(function (x) { return x && x.id; }) : [];
    } catch (e) {
      return [];
    }
  }

  function write(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      return false;
    }
  }

  function idFor(setup, meta) {
    return [meta.date || "", meta.index || "", setup.strategy || "chart_retest", setup.entryMM, setup.side || ""].join("|");
  }

  // Store one row per index/date/setup/side/trigger time. A later refresh
  // updates the outcome and state but never changes the original levels.
  function upsert(setup, meta) {
    if (!setup || !finite(setup.entry) || !finite(setup.sl) || !finite(setup.t1) || !finite(setup.t2) || !finite(setup.entryMM) || !setup.side || setup.action === "NO TRADE") {
      return { created: false, alert: null };
    }
    var list = read();
    var id = idFor(setup, meta);
    var found = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { found = list[i]; break; }
    }
    var row = {
      id: id,
      date: meta.date || "",
      index: meta.index || "",
      name: meta.name || "",
      strategy: setup.strategy || "chart_retest",
      label: setup.label || "Chart setup",
      side: setup.side,
      action: setup.action || "",
      state: setup.state || "",
      entryMM: setup.entryMM,
      entry: setup.entry,
      sl: setup.sl,
      t1: setup.t1,
      t2: setup.t2,
      riskPct: setup.riskPct,
      rr: setup.rr || "1:2",
      outcome: setup.outcome || null,
      r: finite(setup.r) ? setup.r : null,
      exitMM: finite(setup.exitMM) ? setup.exitMM : null,
      fresh: !!setup.fresh,
      liveAtLog: found ? !!found.liveAtLog : !!setup.fresh,
      vixWarning: !!setup.vixWarning,
      note: setup.note || "",
      createdAt: found ? found.createdAt : Date.now(),
      updatedAt: Date.now()
    };
    if (found) {
      for (var k in row) if (Object.prototype.hasOwnProperty.call(row, k)) found[k] = row[k];
      found.createdAt = row.createdAt;
      write(list);
      return { created: false, alert: found };
    }
    list.push(row);
    write(list);
    return { created: true, alert: row };
  }

  function list() {
    return read().slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.entryMM || 0) - (a.entryMM || 0);
    });
  }

  function remove(id) {
    write(read().filter(function (x) { return x.id !== id; }));
  }

  function clear() {
    write([]);
  }

  return {
    KEY: KEY,
    read: read,
    write: write,
    upsert: upsert,
    list: list,
    remove: remove,
    clear: clear
  };
});
