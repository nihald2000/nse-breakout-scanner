"use strict";
// Tests for the research-only fixed helpers. These used to prove the intended
// difference from the live helpers; the live helpers now use the same rules, so
// they assert parity. They do not claim an edge.

const test = require("node:test");
const assert = require("node:assert/strict");
const sector = require("../../lib/sector");
const fixes = require("./fixes");

test("vwapSeries carries the last VWAP through a zero-volume bar", () => {
  const bars = [
    { hi: 101, lo: 99, cl: 100, vol: 100 },
    { hi: 104, lo: 102, cl: 103, vol: 0 },
    { hi: 101, lo: 99, cl: 100, vol: 100 },
  ];
  const live = sector.vwapSeries(bars);
  const fixed = fixes.vwapSeries(bars);
  assert.deepEqual(live, fixed);
  assert.equal(live[1], 100);
  assert.equal(live[2], 100);
});

test("orStats reports the current side and clears when price is back inside", () => {
  const bars = [
    { mm: 555, hi: 110, lo: 100, cl: 105 },
    { mm: 560, hi: 109, lo: 101, cl: 104 },
    { mm: 565, hi: 108, lo: 102, cl: 103 },
    { mm: 570, hi: 113, lo: 109, cl: 112 }, // first break up
    { mm: 575, hi: 108, lo: 103, cl: 105 }, // back inside
  ];
  const live = sector.orStats(bars);
  const fixed = fixes.orStats(bars);
  assert.equal(live.pos, null); // back inside: no side now
  assert.equal(live.mm, 575);
  assert.equal(fixed.brokeUp, null);
  assert.equal(fixed.brokeDown, null);

  bars.push({ mm: 585, hi: 100, lo: 95, cl: 96 });
  assert.equal(sector.orStats(bars).pos, "down");
  assert.equal(fixes.orStats(bars).brokeDown, 585);
});

test("volSpike only looks at the latest closed bar, not the day's maximum", () => {
  const prev = new Map([
    ["d1", [{ mm: 555, vol: 100 }, { mm: 560, vol: 100 }]],
    ["d2", [{ mm: 555, vol: 100 }, { mm: 560, vol: 100 }]],
    ["d3", [{ mm: 555, vol: 100 }, { mm: 560, vol: 100 }]],
  ]);
  const day = [{ mm: 555, vol: 500 }, { mm: 560, vol: 110 }];
  assert.equal(sector.volSpike(day, prev), null); // early spike is not a helper now
  assert.equal(fixes.volSpike(day, prev), null);

  day[1].vol = 300;
  assert.deepEqual(sector.volSpike(day, prev), fixes.volSpike(day, prev));
  assert.equal(fixes.volSpike(day, prev).mm, 560);
  assert.equal(fixes.volSpike(day, prev).mult, 3);
});

test("rangeVsNormal compares today with the same clock window on prior days", () => {
  const bars = [];
  for (let d = 1; d <= 6; d++) {
    const iso = `2026-01-0${d}`;
    bars.push({ d: iso, mm: 555, hi: 101, lo: 99, cl: 100 });
    bars.push({ d: iso, mm: 570, hi: 110, lo: 90, cl: 100 });
  }
  bars.push({ d: "2026-01-07", mm: 555, hi: 101, lo: 99, cl: 100 });
  const live = sector.rangeVsNormal(bars);
  const fixed = fixes.rangeVsNormal(bars);
  assert.equal(live.ratio, 1);
  assert.equal(fixed.ratio, 1);
});
