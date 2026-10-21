// Tests for lib/candlebacktest.js - the candle replay behind the journal backtest panel.
// Pure data only: synthetic bars, no network.

const test = require("node:test");
const assert = require("node:assert");
const CB = require("../lib/candlebacktest");

function bar(d, mm, o, hi, lo, cl, vol) {
  return { d, mm, t: 0, o, hi, lo, cl, vol };
}

// A steady drifting session (25 x 15m bars, 09:15 to 15:15).
function daySeries(d, startPx, drift, vol = 1000) {
  const out = [];
  let px = startPx;
  for (let k = 0; k < 25; k++) {
    const o = px;
    const cl = Math.round(px * (1 + drift) * 100) / 100;
    const hi = Math.round(Math.max(o, cl) * 1.001 * 100) / 100;
    const lo = Math.round(Math.min(o, cl) * 0.999 * 100) / 100;
    out.push(bar(d, 555 + 15 * k, o, hi, lo, cl, vol));
    px = cl;
  }
  return out;
}

// 6 drifting sessions: enough history for Kijun (26), ADX (40) and the volume-slot baseline (3 days).
function history(drift) {
  const days = [];
  let px = 100;
  for (let n = 0; n < 6; n++) {
    const d = `2026-10-${String(5 + n).padStart(2, "0")}`;
    const day = daySeries(d, px, drift);
    days.push(day);
    px = day[day.length - 1].cl;
  }
  return days.reduce((a, b) => a.concat(b), []);
}

test("measureOutcome: target first, stop first, both in one candle, timeout, no room", () => {
  const entry = 100;
  const mk = (o, hi, lo, cl) => bar("2026-10-10", 600, o, hi, lo, cl, 100);
  // +0.5% before -0.5%
  let day = [mk(100, 100.2, 99.9, 100), mk(100, 100.7, 99.8, 100.6)];
  assert.equal(CB.measureOutcome(day, 0, "up", entry, 3, 0.5, 0.5).result, "target");
  // -0.5% before +0.5%
  day = [mk(100, 100.2, 99.9, 100), mk(100, 100.2, 99.4, 99.5)];
  assert.equal(CB.measureOutcome(day, 0, "up", entry, 3, 0.5, 0.5).result, "stop");
  // both inside the same candle: unknowable, must not be called a win
  day = [mk(100, 100.2, 99.9, 100), mk(100, 100.9, 99.4, 100.1)];
  assert.equal(CB.measureOutcome(day, 0, "up", entry, 3, 0.5, 0.5).result, "both");
  // never reaches either barrier
  day = [mk(100, 100.2, 99.9, 100), mk(100, 100.2, 99.8, 100.1)];
  assert.equal(CB.measureOutcome(day, 0, "up", entry, 3, 0.5, 0.5).result, "timeout");
  // signal on the last candle of the day: nothing left to measure
  day = [mk(100, 100.1, 99.9, 100)];
  assert.equal(CB.measureOutcome(day, 0, "up", entry, 3, 0.5, 0.5).result, "open");
  // down side mirrors the arithmetic
  day = [mk(100, 100.1, 99.9, 100), mk(100, 100.1, 99.4, 99.5)];
  assert.equal(CB.measureOutcome(day, 0, "down", entry, 3, 0.5, 0.5).result, "target");
});

test("openingRange: first candle high/low and the current side", () => {
  const day = [
    bar("2026-10-10", 555, 100, 101, 99, 100.5, 10),
    bar("2026-10-10", 570, 100.5, 100.8, 99.5, 100.2, 10),
    bar("2026-10-10", 585, 100.2, 101.6, 100.1, 101.4, 10),
    bar("2026-10-10", 600, 101.4, 101.5, 98.8, 98.9, 10),
  ];
  const or = CB.openingRange(day);
  assert.equal(or.hi, 101);
  assert.equal(or.lo, 99);
  assert.equal(or.pos, "down"); // last close 98.9 is below the range
  assert.equal(or.mm, 600);
  const up = CB.openingRange(day.slice(0, 3));
  assert.equal(up.pos, "up"); // last close 101.4 is above the range
  assert.equal(CB.openingRange([day[0]]).pos, null); // last close back inside
});

test("replayRead: signals use next-bar opens, fire on side changes only, and agree with drift", () => {
  const bars = history(0.004); // steady up drift
  const r = CB.replayRead(bars, { h: 3, target: 0.5, stop: 0.5, warmup: 45 });
  assert.ok(r.events.length > 0, "expected signals in a trending series");
  for (const e of r.events) {
    assert.equal(e.side, "up");
    assert.ok(["strong", "moderate", "weak"].includes(e.tier));
    assert.ok(["target", "stop", "both", "timeout", "open"].includes(e.result));
    // The fill is the next bar's open, available only after the signal bar closes.
    const fill = bars.find((x) => x.d === e.d && x.mm === e.entryMM);
    assert.ok(fill, "entry bar exists");
    assert.equal(e.entry, Math.round(fill.o * 100) / 100);
    assert.ok(e.entryMM > e.mm, "entry follows the signal candle");
  }
  // one signal per side change, not one per bar
  const byDay = new Map();
  for (const e of r.events) {
    const prev = byDay.get(e.d);
    if (prev) assert.notEqual(prev, e.side, "consecutive signals must alternate sides");
    byDay.set(e.d, e.side);
  }
});

test("replayRead: no look-ahead - truncating the future cannot change earlier signals", () => {
  const bars = history(0.004);
  const full = CB.replayRead(bars, { h: 3, target: 0.5, stop: 0.5, warmup: 45 });
  const cut = CB.replayRead(bars.slice(0, bars.length - 30), { h: 3, target: 0.5, stop: 0.5, warmup: 45 });
  assert.ok(cut.events.length > 0);
  for (const ce of cut.events) {
    const fe = full.events.find((x) => x.d === ce.d && x.mm === ce.mm);
    assert.ok(fe, `signal ${ce.d} ${ce.mm} also exists in the full run`);
    assert.equal(fe.side, ce.side);
    assert.equal(fe.tier, ce.tier);
    assert.equal(fe.entry, ce.entry);
    assert.equal(fe.entryMM, ce.entryMM);
    assert.equal(fe.total, ce.total);
  }
});

test("replayRead: clamps and empty input", () => {
  const bars = history(-0.004); // steady down drift
  const r = CB.replayRead(bars, { h: 99, target: 999, stop: 999, warmup: 45, maxEvents: 50 });
  assert.ok(r.events.length <= 50);
  for (const e of r.events) assert.equal(e.side, "down");
  assert.equal(CB.replayRead([], {}).events.length, 0);
});
