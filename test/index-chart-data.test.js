const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../public/index-chart-data");

const bar = (mm, t, cl, vwap) => ({ mm, t, o: cl - 2, hi: cl + 2, lo: cl - 3, cl, vwap });

test("a live session plots only bars whose five-minute window has finished", () => {
  const now = 1000;
  const bars = [
    bar(555, now - 600, 100, 100.2),
    bar(560, now - 300, 101, 100.6),
    bar(565, now - 60, 102, 101.1)
  ];
  const out = D.sessionBars({ live: true, nowSec: now, bars, vwap: bars.map((b) => b.vwap) });
  assert.deepEqual(out.map((b) => b.mm), [555, 560]);
  assert.deepEqual(out.map((b) => b.vwap), [100.2, 100.6]);
  assert.equal(out[0].o, 98);
  assert.equal(out[0].hi, 102);
  assert.equal(out[0].lo, 97);
});

test("a completed session keeps every bar and aligns its own VWAP", () => {
  const bars = [bar(560, 1, 101, 100.6), bar(555, 0, 100, 100.2)];
  const out = D.sessionBars({ live: false, nowSec: 9999, bars, vwap: [100.6, 100.2] });
  assert.deepEqual(out.map((b) => b.mm), [555, 560]);
  assert.deepEqual(out.map((b) => b.vwap), [100.2, 100.6]);
});

test("missing or malformed values are skipped, not filled with zero", () => {
  const out = D.sessionBars({
    live: false,
    bars: [
      bar(555, 0, 100, undefined),
      { mm: null, cl: 101 },
      { mm: 565, cl: 102 },
      null
    ],
    vwap: [null, 1, 2, 3]
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].mm, 555);
  assert.equal(out[0].vwap, undefined);
  assert.equal(out[1].mm, 565);
  assert.equal(out[1].o, undefined);
});

test("signal markers sit on the trigger candle and levels stop at the later exit", () => {
  const bars = [bar(555, 0, 100), bar(560, 300, 101), bar(565, 600, 102), bar(570, 900, 103)];
  const signals = [{
    strategy: "orb_break",
    side: "long",
    entryMM: 565,
    entry: 102,
    sl: 100,
    t1: 104,
    t2: 106,
    x1: { exitMM: 570 },
    x2: { exitMM: 580 }
  }];
  const out = D.signalOverlays(signals, bars);
  assert.deepEqual(out.markers, [{ mm: 560, side: "long", strategy: "orb_break" }]);
  assert.deepEqual(out.levels, [
    { fromMM: 565, toMM: 570, price: 100, kind: "sl" },
    { fromMM: 565, toMM: 570, price: 104, kind: "t1" },
    { fromMM: 565, toMM: 570, price: 106, kind: "t2" }
  ]);
});

test("an open signal runs to the last closed bar, and off-chart signals are ignored", () => {
  const bars = [bar(555, 0, 100), bar(560, 300, 101), bar(565, 600, 102)];
  const out = D.signalOverlays([
    { strategy: "ichi", side: "short", entryMM: 565, entry: 102, sl: 103, t1: 99, t2: 98, x1: { exitMM: null }, x2: { exitMM: null } },
    { strategy: "vwap_reclaim", side: "long", entryMM: 900, entry: 102, sl: 100, t1: 104, t2: 105 }
  ], bars);
  assert.deepEqual(out.markers, [{ mm: 560, side: "short", strategy: "ichi" }]);
  assert.deepEqual(out.levels.map((l) => [l.kind, l.fromMM, l.toMM]), [
    ["sl", 565, 565],
    ["t1", 565, 565],
    ["t2", 565, 565]
  ]);
});
