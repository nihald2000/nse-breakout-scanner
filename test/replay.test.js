const test = require("node:test");
const assert = require("node:assert/strict");
const { fillAtNextOpen, walk } = require("../lib/replay");
const { _internals: I } = require("../api/indices");

const signalBar = { t: 1000, d: "2026-10-21", mm: 570, o: 100, hi: 106, lo: 99, cl: 105 };
const signal = { side: "long", sl: 95, t1: 110, t2: 115 };
const fillBar = (o, patch = {}) => ({ t: 1300, d: "2026-10-21", mm: 575, o, hi: o, lo: o, cl: o, ...patch });

test("closed-candle replay fills at the next same-session bar open and keeps published levels", () => {
  const fill = fillAtNextOpen(signal, signalBar, fillBar(106), 11);
  assert.equal(fill.ok, true);
  assert.equal(fill.entry, 106);
  assert.equal(fill.entryMM, 575);
  assert.equal(fill.signalMM, 570);
  assert.equal(fill.riskPct, (11 / 106) * 100);
  assert.equal(fill.rr1, 4 / 11);
});

test("next-bar gaps through the stop or T1 are skipped instead of counted", () => {
  assert.match(fillAtNextOpen(signal, signalBar, fillBar(94), 1).reason, /gapped through the stop/);
  assert.match(fillAtNextOpen(signal, signalBar, fillBar(111), 1).reason, /already reached T1/);
});

test("late, missing, cross-session, and over-risk fills are skipped", () => {
  assert.match(fillAtNextOpen(signal, signalBar, null, 1).reason, /no same-session next bar/);
  assert.match(fillAtNextOpen(signal, signalBar, { ...fillBar(106), d: "2026-10-22" }, 1).reason, /no same-session next bar/);
  assert.match(fillAtNextOpen(signal, signalBar, { ...fillBar(106), mm: 870 }, 1).reason, /after the entry cutoff/);
  assert.match(fillAtNextOpen(signal, signalBar, fillBar(106), 5).reason, /stop wider than the rule limit/);
});

test("the entry bar is included and simultaneous stop/target is scored stop-first", () => {
  const fill = fillAtNextOpen(signal, signalBar, fillBar(106), 11);
  const result = walk({ ...signal, entry: fill.entry, side: signal.side }, [fillBar(106, { hi: 112, lo: 94 })], signal.t1);
  assert.equal(result.outcome, "SL");
  assert.equal(result.r, -1);
});

test("elevated India VIX is informational and does not suppress a valid rule trigger", () => {
  const stamp = (date, mm) => Date.parse(date + "T00:00:00Z") / 1000 + (mm - 330) * 60;
  const make = (date, mm, o, hi, lo, cl) => ({ t: stamp(date, mm), d: date, mm, o, hi, lo, cl, vol: 0 });
  const bars = [
    ...["2026-10-19", "2026-10-20"].flatMap((date) => [
      make(date, 555, 100, 101, 99, 100),
      make(date, 560, 100, 100.8, 99.2, 100),
      make(date, 565, 100, 100.8, 99.2, 100),
    ]),
    make("2026-10-21", 555, 100, 101, 99, 100),
    make("2026-10-21", 560, 100, 100.8, 99.2, 100),
    make("2026-10-21", 565, 100, 100.8, 99.2, 100),
    make("2026-10-21", 570, 101.7, 102.5, 101.6, 102.2),
  ];
  const ix = I.INDICES.find((x) => x.key === "NIFTY");
  const result = I.analyse(ix, { p5: { bars, meta: { regularMarketPrice: 102.2 } } }, {
    nowSec: stamp("2026-10-21", 576),
    todayISO: "2026-10-21",
    marketOpen: true,
    expiry: { NIFTY: false },
    vix: { ok: true, value: 20, p60: 10, n: 60, elevated: true },
    skipSwing: true,
    skipMaxPain: true,
  });
  const call = result.rows.find((r) => r.strategy === "orb_break");
  assert.equal(call.action, "BUY CE");
  assert.equal(call.blockedBy, null);
  assert.ok(call.checks.some((x) => x.info && /option-cost caution only/.test(x.text)));
  assert.ok(call.tags.includes("VIX elevated"));
});
