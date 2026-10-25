const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../public/monitor-feed");

test("every F&O sector is read, hottest first, in batches that respect the calls route's caps", () => {
  const sectors = [];
  for (let i = 0; i < 20; i++) sectors.push({ sector: "S" + i, n: 12, pct: (i % 2 ? -1 : 1) * i * 0.1 });
  sectors.push({ sector: "Solo", n: 1, pct: 0.05 }, { sector: "NoPct", n: 3, pct: NaN }, { sector: "Empty", n: 0, pct: 3 });
  const batches = F.batchSectors(sectors);
  const flat = batches.flat();
  assert.equal(flat.length, 22, "nothing dropped except the empty group; a one-stock group and one without a % still count");
  assert.equal(new Set(flat).size, 22, "no sector twice");
  assert.ok(!flat.includes("Empty"));
  assert.equal(flat[0], "S19", "the biggest absolute move first");
  assert.equal(flat[flat.length - 1], "NoPct", "a sector without a % goes last");
  const size = (b) => b.reduce((t, name) => t + Math.min(sectors.find((s) => s.sector === name).n, F.CAPS.perSector), 0);
  for (const b of batches) {
    assert.ok(b.length <= F.CAPS.maxSectors, "at most 8 sectors per request");
    assert.ok(size(b) <= F.CAPS.maxSymbols, "at most 100 stocks per request");
  }
  assert.deepEqual(F.batchSectors([]), []);
  assert.deepEqual(F.batchSectors(null), []);
});

test("a big sector counts for the route's per-sector cap, not its full size", () => {
  const batches = F.batchSectors([{ sector: "Big", n: 90, pct: 2 }, { sector: "A", n: 30, pct: 1 }, { sector: "B", n: 30, pct: 0.5 }, { sector: "C", n: 30, pct: 0.4 }]);
  assert.deepEqual(batches, [["Big", "A", "B"], ["C"]], "40 + 30 + 30 = 100 fits; the next 30 starts a new request");
});

const sig = (sym, tier, agree, extra = {}) => ({ sym, rvol: 1, read: { trend: { side: "up", tier, agree, helpers: 0 } }, ...extra });
const metaOf = (asOf, extra = {}) => ({ tf: "15m", marketOpen: true, asOf, wanted: 10, loaded: 9, failed: 1, truncated: false, option: { loaded: 2, failed: 1 }, ...extra });

test("batched replies merge into one board with the same order and honest totals", () => {
  const a = { meta: metaOf("24-Oct-2026 10:00 IST"), signals: [sig("A1", "moderate", 4), sig("A2", "weak", 3)] };
  const b = { meta: metaOf("24-Oct-2026 10:04 IST", { truncated: true, option: undefined }), signals: [sig("B1", "strong", 5), sig("A1", "strong", 6)] };
  const m = F.mergeCalls([{ data: a }, { data: b, optionsSkipped: true }, { data: null }]);
  assert.deepEqual(m.signals.map((s) => s.sym), ["B1", "A1", "A2"], "strong first; a stock seen twice is kept once (the first reply's copy)");
  assert.equal(m.signals[0].optionSkipped, true, "rows from a batch fetched without option quotes say so");
  assert.equal(m.signals[1].optionSkipped, undefined);
  assert.equal(m.meta.asOf, "24-Oct-2026 10:04 IST", "the newest feed time");
  assert.equal(m.meta.wanted, 20);
  assert.equal(m.meta.failed, 2);
  assert.equal(m.meta.truncated, true);
  assert.deepEqual([m.meta.strong, m.meta.moderate, m.meta.weak], [1, 1, 1]);
  assert.deepEqual(m.meta.option, { loaded: 2, failed: 1 });
  assert.equal(m.meta.batches, 2);
  assert.equal(m.meta.batchesFailed, 1);
  assert.equal(F.mergeCalls([{ data: null }, null]), null);
});

test("asOfMs reads the feed's IST stamp and refuses anything else", () => {
  assert.equal(F.asOfMs("24-Oct-2026 10:00 IST"), Date.UTC(2026, 9, 24, 4, 30));
  assert.equal(F.asOfMs("nonsense"), null);
  assert.equal(F.asOfMs(null), null);
  assert.equal(F.asOfMs("24-Zzz-2026 10:00 IST"), null);
});

const call = (sym, status, extra = {}) => ({ sym, side: "long", status, inPlay: true, rank: 1, rvol: 3.04, level: 102, plannedStop: 101.8, entry: null, entryMM: null, stop: null, r: null, cautions: [], ...extra });

test("only live plans and fills become Monitor items, and only while the feed is fresh", () => {
  const sip = { calls: [call("A", "PENDING"), call("B", "OPEN", { side: "short" }), call("C", "STOPPED"), call("D", "EXITED"), call("E", "NOT TRIGGERED"), call("F", "PENDING", { inPlay: false })] };
  const items = F.sipItems(sip, true);
  assert.deepEqual(items.map((i) => [i.row.sym, i.side]), [["A", "up"], ["B", "down"]]);
  assert.deepEqual(F.sipItems(sip, false), [], "a stale or closed-market feed lists nothing as live");
  assert.deepEqual(F.sipItems(null, true), []);
});

const sipItem = (sym, status, extra) => ({ kind: "sip", row: call(sym, status, extra), side: "up", fresh: true });
const stkItem = (sym, tier) => ({ kind: "stock", row: { sym, read: { trend: { tier } } }, side: "up" });
const ixItem = (name) => ({ kind: "index", ix: { index: name }, row: { strategy: "orb_break", action: "BUY CE" }, side: "up" });
const DAY = "2026-10-24";

test("a new plan alerts once, its fill alerts once more, and a late-opened page alerts only for the fill", () => {
  const seen = {};
  const run = (items, enabled = true) => F.planAlerts(items, { day: DAY, seen, enabled, maxEach: 5 });
  assert.deepEqual(run([sipItem("A", "PENDING")]).individual.map((c) => c.row.sym), ["A"]);
  assert.deepEqual(run([sipItem("A", "PENDING")]).individual, [], "same plan, no repeat");
  const fill = run([sipItem("A", "OPEN", { entryMM: 610, entry: 102, stop: 101.8 })]);
  assert.equal(fill.individual.length, 1, "the fill is news");
  assert.deepEqual(run([sipItem("A", "OPEN")]).individual, []);
  assert.equal(run([sipItem("Z", "OPEN")]).individual.length, 1, "first seen already open: one alert, for the fill");
  assert.deepEqual(run([sipItem("Z", "PENDING")]).individual, [], "and no stale plan alert afterwards");
});

test("the baseline poll marks everything as seen without notifying", () => {
  const seen = {};
  const base = F.planAlerts([sipItem("A", "PENDING"), ixItem("NIFTY")], { day: DAY, seen, enabled: false });
  assert.deepEqual(base.individual, []);
  assert.equal(base.summary, null);
  assert.equal(F.planAlerts([sipItem("A", "PENDING"), ixItem("NIFTY")], { day: DAY, seen, enabled: true }).individual.length, 0, "already seen");
  assert.equal(F.planAlerts([sipItem("B", "PENDING")], { day: DAY, seen, enabled: true }).individual.length, 1);
});

test("a burst of stock alerts becomes one summary; index triggers always go out on their own", () => {
  const seen = {};
  const many = [];
  for (let i = 0; i < 9; i++) many.push(sipItem("S" + i, "PENDING"));
  many.push(sipItem("S9", "OPEN"), stkItem("W1", "strong"));
  const plan = F.planAlerts(many.concat([ixItem("NIFTY")]), { day: DAY, seen, enabled: true, maxEach: 5 });
  assert.deepEqual(plan.individual.map((c) => c.kind), ["index"]);
  assert.equal(plan.summary.count, 11);
  assert.match(plan.summary.text, /^11 new alerts: 9 ORB plans, 1 ORB trigger, 1 stock watch\./);
  assert.match(plan.summary.text, /No order was placed/);
  const few = F.planAlerts([sipItem("N1", "PENDING"), sipItem("N2", "PENDING")], { day: DAY, seen, enabled: true, maxEach: 5 });
  assert.equal(few.individual.length, 2);
  assert.equal(few.summary, null);
});

test("preferences switch each kind off; weak watches are their own switch", () => {
  const run = (prefs) => F.planAlerts([sipItem("A", "PENDING"), ixItem("NIFTY"), stkItem("S", "strong"), stkItem("W", "weak")], { day: DAY, seen: {}, enabled: true, prefs, maxEach: 10 })
    .individual.map((c) => (c.kind === "stock" ? c.row.sym : c.kind));
  assert.deepEqual(run(undefined).sort(), ["S", "W", "index", "sip"], "everything is on by default");
  assert.deepEqual(run({ weak: false }).sort(), ["S", "index", "sip"]);
  assert.deepEqual(run({ sip: false, ctx: false }).sort(), ["index"]);
  assert.deepEqual(run({ index: false }).sort(), ["S", "W", "sip"]);
});

test("yesterday's keys are dropped so the saved list does not grow forever", () => {
  const seen = { "2026-10-23|stk|2026-10-23|OLD|up": true, [DAY + "|stk|" + DAY + "|KEEP|up"]: true };
  F.planAlerts([], { day: DAY, seen, enabled: false });
  assert.deepEqual(Object.keys(seen), [DAY + "|stk|" + DAY + "|KEEP|up"]);
});

test("notification text states the levels, the volume and that nothing was ordered", () => {
  const plan = { kind: "sip", row: call("RELIANCE", "PENDING", { cautions: ["a", "b"] }) };
  assert.equal(F.sipTitle(plan), "BUY CE · RELIANCE · ORB plan");
  assert.match(F.sipBody(plan), /^Buy-stop at 102\.00 · stop loss 101\.80 · 3\.0× normal first-candle volume \(#1\) · 2 cautions · Underlying levels; no order was placed\.$/);
  const fill = { kind: "sip", row: call("TCS", "OPEN", { side: "short", entry: 3500, stop: 3510.5, entryMM: 610, r: -0.4, rank: null }) };
  assert.equal(F.sipTitle(fill), "BUY PE · TCS · ORB triggered");
  assert.match(F.sipBody(fill), /^Triggered 10:10 · entry 3,500\.00 · stop 3,510\.50 · −0\.40R now · 3\.0× normal first-candle volume · Underlying/);
});
