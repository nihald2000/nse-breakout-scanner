const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../public/chart-lite");

test("chart time axis is a session clock, not a made-up date", () => {
  assert.equal(C.clock(C.sessionTime(555)), "09:15");
  assert.equal(C.clock(C.sessionTime(930)), "15:30");
  assert.equal(C.sessionTime(600) - C.sessionTime(555), 45 * 60);
  assert.equal(C.sessionTime(null), null);
});

test("closed candles keep OHLC and use the close only when a field is missing", () => {
  const out = C.candleData([
    { mm: 570, o: 101, hi: 103, lo: 100, cl: 102, vol: 900 },
    { mm: 555, o: 100, hi: 101, lo: 99, cl: 100.5, vol: 500 },
    { mm: null, o: 1, cl: 2 },
    { mm: 585, cl: 104.5 }
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((b) => b._mm), [555, 570, 585]);
  assert.equal(out[2].open, 104.5);
  assert.equal(out[2].high, 104.5);
  assert.equal(out[2].low, 104.5);
  assert.equal(out[2].close, 104.5);
});

test("indicator lines are sparse and never invent a value", () => {
  const out = C.lineData([
    { mm: 555, t9: null },
    { mm: 570, t9: 101.25 },
    { mm: 585, t9: "n/a" }
  ], "t9");
  assert.deepEqual(out, [{ time: C.sessionTime(570), value: 101.25 }]);
});

test("volume bars carry the up/down colour of their candle", () => {
  const out = C.volumeData([
    { mm: 555, o: 100, cl: 101, vol: 2000 },
    { mm: 570, o: 101, cl: 100, vol: 1000 },
    { mm: 585, o: 100, cl: 100, vol: 0 }
  ]);
  assert.equal(out.length, 2);
  assert.match(out[0].color, /34,197,94/);
  assert.match(out[1].color, /239,68,68/);
});

test("the chart badge mirrors the read tier and side", () => {
  assert.deepEqual(
    C.trendBadge({ trend: { side: "up", tier: "strong", agree: 4, total: 5 } }),
    { text: "CE lean · one-sided · 4/5 checks", side: "up" }
  );
  assert.deepEqual(
    C.trendBadge({ trend: { side: null } }),
    { text: "no CE/PE lean — two-way", side: "flat" }
  );
});
