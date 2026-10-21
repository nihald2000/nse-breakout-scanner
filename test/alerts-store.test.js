const test = require("node:test");
const assert = require("node:assert/strict");

// A tiny localStorage stand-in. The module reads the global at call time, so
// setting it before the first call is enough.
const mem = new Map();
global.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); }
};

const store = require("../public/alerts-store");

const setup = {
  strategy: "chart_retest",
  label: "ORB retest (chart setup)",
  side: "short",
  action: "BUY PE",
  state: "LIVE SETUP",
  entryMM: 680,
  entry: 22917.55,
  sl: 22989.25,
  t1: 22845.85,
  t2: 22774.15,
  riskPct: 0.31,
  rr: "1:2",
  outcome: "OPEN",
  r: null,
  exitMM: null,
  fresh: true,
  vixWarning: true,
  note: "test setup"
};
const meta = { date: "2026-10-21", index: "NIFTY", name: "NIFTY 50" };

test("a chart trigger is stored once and updated in place", () => {
  mem.clear();
  const first = store.upsert(setup, meta);
  assert.equal(first.created, true);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].entry, 22917.55);

  const second = store.upsert({ ...setup, outcome: "T2", r: 2, exitMM: 735, fresh: false }, meta);
  assert.equal(second.created, false);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].outcome, "T2");
  assert.equal(store.list()[0].r, 2);
  assert.equal(store.list()[0].entry, 22917.55); // levels are immutable after the trigger
  assert.equal(store.list()[0].liveAtLog, true); // a later refresh cannot rewrite how it was logged
});

test("alerts are newest first and can be removed", () => {
  mem.clear();
  store.upsert({ ...setup, entryMM: 600, entry: 23000, side: "long", action: "BUY CE" }, { ...meta, date: "2026-10-20" });
  store.upsert(setup, meta);
  const rows = store.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, "2026-10-21");
  store.remove(rows[0].id);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].date, "2026-10-20");
});

test("incomplete setups are not written", () => {
  mem.clear();
  const r = store.upsert({ strategy: "chart_retest", side: "short", entry: null, sl: null, entryMM: null }, meta);
  assert.equal(r.created, false);
  assert.equal(store.list().length, 0);
  const invalid = store.upsert({ ...setup, action: "NO TRADE", t1: null, t2: null }, meta);
  assert.equal(invalid.created, false);
  assert.equal(store.list().length, 0);
});
