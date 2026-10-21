"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const O5 = require("./orb5m");

function flatBar(mm, px) {
  return { mm, o: px, hi: px + 0.4, lo: px - 0.4, cl: px + 0.2 };
}

test("5m ORB enters the first close beyond the 09:15 range and holds to the close", () => {
  const bars = [];
  bars.push({ mm: 555, o: 100, hi: 101, lo: 99, cl: 100.5 });
  for (let k = 1; k < 15; k++) bars.push(flatBar(555 + k * 5, 100.2));
  bars.push({ mm: 630, o: 100.5, hi: 102, lo: 100.4, cl: 101.5 });
  bars.push({ mm: 635, o: 101.6, hi: 102.2, lo: 101.4, cl: 102 });
  for (let k = 0; k < 4; k++) bars.push(flatBar(640 + k * 5, 103 + k));
  const st = { sym: "AAA", b5: bars, idx5: { dates: ["2026-01-02"], starts: [0], ends: [bars.length - 1] } };
  const dec = [{ sym: "AAA", d: "2026-01-02", openRvol: 2 }];
  const out = O5.orb5mStats({ stocks: [st] }, dec, { split: 0, nDays: 1, cost: 0.05 });
  assert.equal(out.events, 1);
  assert.equal(out.val.n, 1);
  assert.equal(out.val.stopRate, 0);
  assert.ok(out.val.netExp > 0);
});

test("first-traded 5m ORB skips Yahoo's zero-volume 09:15 opening print", () => {
  const bars = [];
  bars.push({ mm: 555, o: 100, hi: 105, lo: 95, cl: 100.5, vol: 0 });
  bars.push({ mm: 560, o: 100, hi: 101, lo: 99, cl: 100.5, vol: 100 });
  for (let k = 2; k < 15; k++) bars.push(flatBar(555 + k * 5, 100.2));
  bars.push({ mm: 630, o: 100.5, hi: 102, lo: 100.4, cl: 101.5 });
  for (let k = 0; k < 5; k++) bars.push(flatBar(635 + k * 5, 102.5 + k * 0.2));
  const st = { sym: "AAA", b5: bars, idx5: { dates: ["2026-01-02"], starts: [0], ends: [bars.length - 1] } };
  const dec = [{ sym: "AAA", d: "2026-01-02", openRvol: 2 }];
  const auction = O5.orb5mStats({ stocks: [st] }, dec, { split: 0, nDays: 1, cost: 0.05 });
  assert.equal(auction.events, 0);
  const traded = O5.orb5mStats({ stocks: [st] }, dec, { split: 0, nDays: 1, cost: 0.05, firstTraded: true });
  assert.equal(traded.events, 1);
});

test("5m ORB takes one trade per stock/day, not every re-cross", () => {
  const bars = [];
  bars.push({ mm: 555, o: 100, hi: 101, lo: 99, cl: 100.5 });
  for (let k = 1; k < 15; k++) bars.push(flatBar(555 + k * 5, 100.2));
  bars.push({ mm: 630, o: 100.5, hi: 102, lo: 100.4, cl: 101.5 });
  bars.push({ mm: 635, o: 101.6, hi: 101.8, lo: 100.0, cl: 100.2 });
  bars.push({ mm: 640, o: 100.3, hi: 102.4, lo: 100.2, cl: 102.2 });
  for (let k = 0; k < 3; k++) bars.push(flatBar(645 + k * 5, 102.5));
  const st = { sym: "AAA", b5: bars, idx5: { dates: ["2026-01-02"], starts: [0], ends: [bars.length - 1] } };
  const dec = [{ sym: "AAA", d: "2026-01-02", openRvol: 2 }];
  const out = O5.orb5mStats({ stocks: [st] }, dec, { split: 0, nDays: 1, cost: 0.05 });
  assert.equal(out.events, 1);
});
