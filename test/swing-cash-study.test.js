const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../research/swing-cash-2026-10-21/run-study");

const bars = (items) => items.map(([date, o, hi, lo, cl]) => ({ date, o, hi, lo, cl, vol: 1000 }));

test("daily OHLC is adjusted by Yahoo adjusted-close ratio without inventing bars", () => {
  const ts = Math.floor(Date.UTC(2024, 0, 2) / 1000);
  const out = S.cleanDaily({
    meta: { gmtoffset: 19800 },
    timestamp: [ts, ts + 86400],
    indicators: {
      quote: [{ open: [100, null], high: [110, null], low: [90, null], close: [100, null], volume: [1000, 0] }],
      adjclose: [{ adjclose: [95, null] }]
    }
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].o, 95);
  assert.equal(out[0].hi, 104.5);
  assert.equal(out[0].lo, 85.5);
  assert.equal(out[0].cl, 95);
});

test("cash swing signal enters at next session open and takes 2R target", () => {
  const data = bars([
    ["2026-01-01", 101, 103, 99, 102],
    ["2026-01-02", 100, 101, 99.5, 100.5],
    ["2026-01-05", 100.5, 102.5, 100, 102]
  ]);
  const t = S.simulate(data, 0, 2);
  assert.equal(t.entryDate, "2026-01-02");
  assert.equal(t.entry, 100);
  assert.equal(t.stop, 99);
  assert.equal(t.target, 102);
  assert.equal(t.outcome, "target");
  assert.equal(t.exitDate, "2026-01-05");
});

test("same-day stop and target ambiguity is charged as a stop", () => {
  const data = bars([
    ["2026-01-01", 101, 103, 99, 102],
    ["2026-01-02", 100, 102.5, 98.5, 101],
    ["2026-01-05", 101, 102, 100, 101]
  ]);
  const t = S.simulate(data, 0, 2);
  assert.equal(t.outcome, "both-stop");
  assert.equal(t.netR, -1.1);
});

test("stops narrower than 0.5% or wider than 8% are excluded", () => {
  const tight = bars([["2026-01-01", 100.2, 100.5, 99.7, 100.2], ["2026-01-02", 100, 101, 99, 100], ["2026-01-05", 100, 101, 99, 100]]);
  const wide = bars([["2026-01-01", 110, 112, 90, 111], ["2026-01-02", 100, 101, 99, 100], ["2026-01-05", 100, 101, 99, 100]]);
  assert.equal(S.simulate(tight, 0, 2), null);
  assert.equal(S.simulate(wide, 0, 2), null);
});

test("uptrend contexts require only information available at the signal close", () => {
  assert.equal(S.contextPass("shape_only", false, false), true);
  assert.equal(S.contextPass("stock_uptrend", true, false), true);
  assert.equal(S.contextPass("stock_uptrend", false, true), false);
  assert.equal(S.contextPass("market_uptrend", false, true), true);
  assert.equal(S.contextPass("both_uptrends", true, false), false);
  assert.equal(S.contextPass("both_uptrends", true, true), true);
});

test("SMA20 pullback reclaim requires an uptrend, three prior touches, and a bullish close", () => {
  const data = bars([
    ["2026-01-01", 100, 102, 98, 101],
    ["2026-01-02", 101, 103, 99, 102],
    ["2026-01-05", 102, 104, 100, 103],
    ["2026-01-06", 103, 105, 101, 104]
  ]);
  const averages = [99, 100, 101, 102];
  assert.equal(S.isPullbackReclaim(data, 3, averages, true), true);
  assert.equal(S.isPullbackReclaim(data, 3, averages, false), false);
  const noTouch = [97, 98, 99, 102];
  assert.equal(S.isPullbackReclaim(data, 3, noTouch, true), false);
});

test("non-overlap rule prevents a second entry before the first trade exits", () => {
  const base = { sym: "ABC", pattern: "hammer", context: "shape_only", horizon: 5 };
  const out = S.nonOverlapping([
    { ...base, signalDate: "2026-01-01", exitDate: "2026-01-08" },
    { ...base, signalDate: "2026-01-05", exitDate: "2026-01-12" },
    { ...base, signalDate: "2026-01-09", exitDate: "2026-01-16" }
  ]);
  assert.deepEqual(out.map((x) => x.signalDate), ["2026-01-01", "2026-01-09"]);
});
