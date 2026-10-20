"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { zigzag, findImpulses, analyseElliott } = require("../lib/elliott");

// ---------------- six-pivot windows, without building a market ----------------
let seq = 0;
function pv(type, price) {
  const i = seq++;
  return { type, price, i, t: i * 300, d: "2026-01-01", mm: 555, confirmedAt: i + 1 };
}
function windowOf(prices, startType) {
  seq = 0;
  const other = startType === "low" ? "high" : "low";
  return prices.map((p, i) => pv(i % 2 === 0 ? startType : other, p));
}

test("findImpulses accepts a textbook up impulse and its down mirror", () => {
  const up = findImpulses(windowOf([100, 110, 104, 125, 115, 130], "low"));
  assert.equal(up.length, 1);
  assert.deepEqual([up[0].dir, up[0].valid, up[0].rulesPassed], ["up", true, 4]);
  assert.deepEqual(up[0].waves, { w1: 10, w2: 6, w3: 21, w4: 10, w5: 15 });
  assert.equal(up[0].guidelines.w5BeyondW3, true);

  const down = findImpulses(windowOf([200, 180, 190, 160, 172, 150], "high"));
  assert.equal(down.length, 1);
  assert.deepEqual([down[0].dir, down[0].valid], ["down", true]);
  assert.deepEqual(down[0].waves, { w1: 20, w2: 10, w3: 30, w4: 12, w5: 22 });
});

test("findImpulses rejects a full wave-2 retrace", () => {
  const c = findImpulses(windowOf([100, 110, 100, 125, 115, 130], "low"))[0];
  assert.equal(c.valid, false);
  assert.equal(c.rules.w2NotFullRetrace, false);
});

test("findImpulses rejects wave 4 entering wave 1 territory", () => {
  const c = findImpulses(windowOf([100, 110, 104, 125, 109, 130], "low"))[0];
  assert.equal(c.valid, false);
  assert.equal(c.rules.w4NoW1Overlap, false);
});

test("findImpulses rejects a wave 3 that is the shortest of 1, 3 and 5", () => {
  const c = findImpulses(windowOf([100, 120, 115, 121, 120.5, 135.5], "low"))[0];
  assert.equal(c.valid, false);
  assert.equal(c.rules.w3NotShortest, false);
});

test("a truncated fifth is allowed but flagged as a guideline", () => {
  const c = findImpulses(windowOf([100, 110, 104, 125, 115, 122], "low"))[0];
  assert.equal(c.valid, true);
  assert.equal(c.guidelines.w5BeyondW3, false);
});

test("findImpulses needs six alternating pivots", () => {
  assert.deepEqual(findImpulses([]), []);
  assert.deepEqual(findImpulses(windowOf([100, 110, 104, 125, 115], "low")), []);
  const wrong = windowOf([100, 110, 104, 125, 115, 130], "low");
  wrong[3].type = "low"; // break the alternation
  assert.deepEqual(findImpulses(wrong), []);
});

// ---------------- ZigZag on a bar path ----------------
function pathBars(path) {
  return path.map((p, i) => ({
    t: 1_760_000_000 + i * 300,
    d: "2026-01-01",
    mm: 555 + i * 5,
    o: p,
    hi: p,
    lo: p,
    cl: p,
    vol: 1,
  }));
}

const IMPULSE_PATH = [100, 100, 100, 110, 104, 125, 115, 130, 126];

test("zigzag confirms pivots only after the reversal threshold", () => {
  const bars = pathBars(IMPULSE_PATH);
  const z = zigzag(bars, { pct: 2 });
  assert.deepEqual(z.pivots.map((p) => [p.type, p.price]), [
    ["low", 100], ["high", 110], ["low", 104], ["high", 125], ["low", 115], ["high", 130],
  ]);
  assert.equal(z.pivots[5].confirmedAt, 8); // confirmed by the 126 bar
  assert.deepEqual([z.pending.type, z.pending.price], ["low", 126]);
});

test("zigzag does not use a pivot before its confirming bar", () => {
  const bars = pathBars(IMPULSE_PATH);
  const cut = zigzag(bars.slice(0, 8), { pct: 2 });
  assert.equal(cut.pivots.some((p) => p.price === 130), false);
  assert.deepEqual([cut.pending.type, cut.pending.price], ["high", 130]);
});

test("zigzag seeds the first leg at its own pivot, not at an earlier extreme", () => {
  // 100 -> 95.1 does not trigger the 5% down leg (95.0 would), then 99.9
  // triggers the up leg from 95.1. The 100 high predates that low.
  const z = zigzag(pathBars([100, 100, 95.1, 99.9]), { pct: 5 });
  assert.equal(z.pivots.length, 1);
  assert.deepEqual([z.pivots[0].type, z.pivots[0].price, z.pivots[0].i], ["low", 95.1, 2]);
  assert.equal(z.pending.type, "high");
  assert.equal(z.pending.i, 3);
  assert.ok(z.pending.i > z.pivots[0].i);
});

test("zigzag returns nothing when the path never reverses by the threshold", () => {
  const z = zigzag(pathBars([100, 101, 102, 103]), { pct: 5 });
  assert.deepEqual(z.pivots, []);
  assert.equal(z.pending, null);
  assert.deepEqual(zigzag([]).pivots, []);
  assert.deepEqual(zigzag(pathBars([100])).pivots, []);
});

test("analyseElliott finds the completed impulse and describes the current close", () => {
  const a = analyseElliott(pathBars(IMPULSE_PATH), { pct: 2 });
  assert.equal(a.ok, true);
  assert.equal(a.pct, 2);
  assert.equal(a.valid.length, 1);
  assert.equal(a.latest.dir, "up");
  assert.equal(a.latest.end.price, 130);
  assert.equal(a.position.close, 126);
  assert.ok(Math.abs(a.position.sinceEndPct + 3.0769) < 0.001);
  assert.ok(Math.abs(a.position.retracePctOfImpulse - 13.3333) < 0.001);
  assert.equal(a.position.beyondEnd, false);
  assert.ok(a.notes.some((n) => /not a forecast/.test(n)));
});

test("analyseElliott describes a down impulse without flipping the sign", () => {
  const a = analyseElliott(pathBars([200, 200, 180, 190, 160, 172, 150, 155, 145]), { pct: 2 });
  assert.equal(a.latest.dir, "down");
  assert.equal(a.latest.end.price, 150);
  assert.ok(Math.abs(a.position.sinceEndPct - 3.3333) < 0.001); // close below the end
  assert.equal(a.position.retracePctOfImpulse, 0);
  assert.equal(a.position.beyondEnd, true);
});

test("analyseElliott on too little history is honest about it", () => {
  const a = analyseElliott([], { pct: 2 });
  assert.equal(a.ok, false);
  assert.equal(a.latest, null);
  assert.equal(a.position, null);
  assert.ok(a.notes.length >= 3);
});
