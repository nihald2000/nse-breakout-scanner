// Stocks-in-Play opening range breakout (lib/sip.js): the paper's rule, one behaviour per test.
const test = require("node:test");
const assert = require("node:assert/strict");
const { SIP, evaluate, rankCalls } = require("../lib/sip");

const stamp = (date, mm) => Date.parse(date + "T00:00:00Z") / 1000 + (mm - 330) * 60;
const bar = (d, mm, o, hi, lo, cl, vol = 100) => ({ t: stamp(d, mm), d, mm, o, hi, lo, cl, vol });
const dateN = (n) => new Date(Date.UTC(2026, 8, 1) + n * 864e5).toISOString().slice(0, 10);
const TODAY = "2026-10-21";

// One full earlier session: a first candle that sets the day's range (hi/lo) and closes at `cl`, then flat bars.
function session(d, { hi = 102, lo = 100, cl = 101, firstVol = 1000 } = {}) {
  const out = [bar(d, 555, cl, hi, lo, cl, firstVol)];
  for (let mm = 560; mm < 930; mm += 5) out.push(bar(d, mm, cl, cl, cl, cl, 100));
  return out;
}
// n earlier sessions: daily range 2, close 101, first-candle volume 1000 => ATR 2 (risk 0.2), baseline volume 1000.
const history = (n = 16, o = {}) => Array.from({ length: n }, (_, i) => session(dateN(i), o)).flat();

// Today: first candle then more candles [mm, o, hi, lo, cl]; `now` = just after the last candle closes.
function day(first, rest = [], prior = history()) {
  const bars = [...prior, bar(TODAY, 555, ...first.slice(0, 4), first[4]), ...rest.map(([mm, o, hi, lo, cl]) => bar(TODAY, mm, o, hi, lo, cl))];
  const lastMM = rest.length ? rest[rest.length - 1][0] : 555;
  return { bars, now: stamp(TODAY, lastMM + 5) };
}
const LONG_FIRST = [100, 102, 99.5, 101.5, 3000]; // bullish, high 102 (the buy stop), 3x normal volume
const SHORT_FIRST = [100, 100.5, 98, 98.5, 3000]; // bearish, low 98 (the sell stop)
const run = (first, rest, prior, opts) => {
  const { bars, now } = day(first, rest, prior);
  return evaluate("TEST", bars, now, opts);
};
const call = (first, rest, prior, opts) => {
  const r = run(first, rest, prior, opts);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.call;
};

test("the first candle sets rvol, direction, the stop-entry level and a 10%-of-ATR stop distance", () => {
  const c = call(LONG_FIRST, [[560, 101.5, 101.9, 101, 101.6]]);
  assert.equal(c.side, "long");
  assert.equal(c.action, "BUY CE");
  assert.equal(c.rvol, 3);
  assert.equal(c.level, 102);
  assert.equal(c.atr, 2);
  assert.ok(Math.abs(c.riskPerShare - 0.2) < 1e-12);
  assert.ok(Math.abs(c.plannedStop - 101.8) < 1e-12);
  assert.equal(c.status, "PENDING", "level not touched yet: a stop order is waiting");
  assert.equal(c.entry, null);
  assert.equal(c.r, null);
});

test("a bearish first candle is short only, with the sell stop at its low", () => {
  const c = call(SHORT_FIRST, [[560, 98.4, 98.6, 98.1, 98.2]]);
  assert.equal(c.side, "short");
  assert.equal(c.action, "BUY PE");
  assert.equal(c.level, 98);
  assert.ok(Math.abs(c.plannedStop - 98.2) < 1e-12);
  assert.equal(c.status, "PENDING");
});

test("touching the level fills the stop order; the call is OPEN and marked in R", () => {
  const c = call(LONG_FIRST, [[560, 101.5, 101.9, 101, 101.6], [565, 101.9, 102.3, 101.85, 102.2]]);
  assert.equal(c.status, "OPEN");
  assert.equal(c.entry, 102);
  assert.equal(c.entryMM, 570, "the candle that touched it closes at 09:30");
  assert.ok(Math.abs(c.stop - 101.8) < 1e-12);
  assert.ok(Math.abs(c.r - 1) < 1e-9, "last close 102.2 is +1R on a 0.2 stop");
  const s = call(SHORT_FIRST, [[565, 98.2, 98.15, 97.7, 97.8]]);
  assert.equal(s.status, "OPEN");
  assert.equal(s.entry, 98);
  assert.ok(Math.abs(s.r - 1) < 1e-9);
});

test("a gap through the level fills at the open, not at the level", () => {
  const c = call(LONG_FIRST, [[560, 102.4, 102.6, 102.3, 102.5]]);
  assert.equal(c.status, "OPEN");
  assert.equal(c.entry, 102.4);
  assert.ok(Math.abs(c.stop - 102.2) < 1e-12, "the stop loss is 10% ATR from the actual entry");
  assert.ok(Math.abs(c.r - 0.5) < 1e-9);
});

test("the stop loss ends the trade at the stop price, or at the open when the candle gaps through it", () => {
  const touch = [[560, 101.5, 101.9, 101, 101.6], [565, 101.9, 102.3, 101.85, 102.2]];
  const stopped = call(LONG_FIRST, [...touch, [570, 102.2, 102.4, 101.7, 101.75]]);
  assert.equal(stopped.status, "STOPPED");
  assert.ok(Math.abs(stopped.exit - 101.8) < 1e-12);
  assert.ok(Math.abs(stopped.r + 1) < 1e-9);
  assert.equal(stopped.exitMM, 575);
  const gapped = call(LONG_FIRST, [...touch, [570, 101.5, 101.6, 101.3, 101.4]]);
  assert.equal(gapped.exit, 101.5);
  assert.ok(Math.abs(gapped.r + 2.5) < 1e-9, "a gap through the stop costs more than 1R");
});

test("entry and stop inside one candle are scored as a stop-out and flagged", () => {
  const c = call(LONG_FIRST, [[560, 101.9, 102.3, 101.7, 102.0]]);
  assert.equal(c.status, "STOPPED");
  assert.equal(c.ambiguous, true);
  assert.ok(Math.abs(c.r + 1) < 1e-9);
  assert.ok(c.cautions.some((x) => /one candle/.test(x)));
});

test("there is no target: a winner is held to the 15:15 exit and marked at that candle's open", () => {
  const flat = [];
  for (let mm = 560; mm < 915; mm += 5) flat.push([mm, 102.5, 102.6, 102.4, 102.5]);
  flat[0] = [560, 101.9, 102.3, 101.85, 102.2]; // touches 102 on the first later candle
  const c = call(LONG_FIRST, [...flat, [915, 103, 103.1, 102.9, 103]]);
  assert.equal(c.status, "EXITED");
  assert.equal(c.exit, 103);
  assert.equal(c.exitMM, 915);
  assert.ok(Math.abs(c.r - 5) < 1e-9, "(103 - 102) / 0.2");
});

test("a level that is never touched is NOT TRIGGERED once the session is over, PENDING before", () => {
  const below = [];
  for (let mm = 560; mm < 930; mm += 5) below.push([mm, 101.5, 101.8, 101.2, 101.5]);
  assert.equal(call(LONG_FIRST, below).status, "NOT TRIGGERED");
  assert.equal(call(LONG_FIRST, below.slice(0, 20)).status, "PENDING");
});

test("before the first candle closes, the previous session is what is evaluated, and the call says so", () => {
  const prev = dateN(40);
  const prior = [...history(), ...session(prev, { hi: 102, lo: 100, cl: 101 }).map((b, i) => (i === 0 ? { ...b, o: 100, cl: 101.5, hi: 102, lo: 99.5, vol: 2000 } : b))];
  const { bars } = day(LONG_FIRST, [], prior);
  const r = evaluate("T", bars, stamp(TODAY, 559)); // 09:15 candle of TODAY has not closed yet
  assert.equal(r.ok, true);
  assert.equal(r.call.session, prev);
  assert.equal(r.call.status, "NOT TRIGGERED", "that session is over and never touched its level");
});

test("only finished candles count: a touch inside the forming candle is not yet a fill", () => {
  const { bars } = day(LONG_FIRST, [[560, 101.5, 101.9, 101, 101.6], [565, 101.9, 102.3, 101.85, 102.2]]);
  const r = evaluate("TEST", bars, stamp(TODAY, 568)); // 09:25 candle still forming at 09:28
  assert.equal(r.call.status, "PENDING");
  assert.equal(evaluate("TEST", bars, stamp(TODAY, 570)).call.status, "OPEN");
});

test("skips, with the reason: doji, missing 09:15 candle, short history, no volume history", () => {
  assert.match(run([100, 102, 99, 100, 3000]).skip, /doji/);
  const noFirst = [...history(), bar(TODAY, 560, 101, 102, 100.5, 101.5), bar(TODAY, 565, 101.5, 102, 101, 101.2)];
  assert.match(evaluate("T", noFirst, stamp(TODAY, 570)).skip, /no 09:15 candle in the latest session/);
  assert.match(run(LONG_FIRST, [], history(14)).skip, /needs 15 earlier full sessions \(have 14\)/);
  assert.match(run(LONG_FIRST, [], history(16, { firstVol: 0 })).skip, /volume history missing/);
  assert.match(evaluate("T", [], stamp(TODAY, 600)).skip, /no closed candles/);
});

test("baseline = the last 14 first candles and ATR = the last 14 true ranges; half sessions are ignored", () => {
  // Three old sessions with a huge range and volume, then 15 normal ones, plus a one-hour half session in between.
  const old = Array.from({ length: 3 }, (_, i) => session(dateN(i), { hi: 130, lo: 70, cl: 100, firstVol: 100000 })).flat();
  const normal = Array.from({ length: 15 }, (_, i) => session(dateN(10 + i))).flat();
  const half = [bar(dateN(30), 1080, 101, 101, 101, 101, 5), bar(dateN(30), 1085, 101, 140, 60, 101, 5)];
  const c = call(LONG_FIRST, [], [...old, ...normal, ...half]);
  assert.equal(c.rvol, 3);
  assert.equal(c.atr, 2);
});

test("a wide-ATR stock has a small cost in R; a tight stop carries a cost caution", () => {
  const tight = call(LONG_FIRST, [[560, 101.5, 101.9, 101, 101.6]]);
  assert.ok(Math.abs(tight.riskPct - (0.2 / 102) * 100) < 1e-9);
  assert.ok(Math.abs(tight.costR - 0.1 / tight.riskPct) < 1e-9);
  assert.ok(tight.cautions.some((x) => /stop is only 0\.20% of price/.test(x)), tight.cautions.join("|"));
  const wide = call([99, 101, 98.5, 100.5, 3000], [[560, 100.6, 100.9, 100.1, 100.4]], history(16, { hi: 110, lo: 90, cl: 100 }));
  assert.equal(wide.atr, 20);
  assert.ok(wide.riskPct > 1.9);
  assert.ok(wide.costR < 0.06);
  assert.deepEqual(wide.cautions, []);
});

test("cautions: a huge overnight gap (possible corporate action) and a late trigger", () => {
  const gap = call([130, 132, 129, 131, 3000], [[560, 131, 131.5, 130.5, 131]]);
  assert.ok(gap.cautions.some((x) => /corporate action/.test(x)));
  const rest = [];
  for (let mm = 560; mm < 870; mm += 5) rest.push([mm, 101.5, 101.6, 101.4, 101.5]);
  rest.push([870, 101.9, 102.3, 101.85, 102.2]);
  const late = call(LONG_FIRST, rest);
  assert.equal(late.status, "OPEN");
  assert.ok(late.cautions.some((x) => /after 14:30/.test(x)));
});

test("rankCalls: rank by relative volume, drop names under 1.0x unless the filter is off, mark the top N", () => {
  const mk = (sym, rvol) => ({ sym, rvol, cautions: [] });
  const calls = [mk("LOW", 0.5), mk("B", 3), mk("A", 3), mk("TOP", 7), mk("MID", 1.2)];
  const ranked = rankCalls(calls);
  assert.deepEqual(ranked.map((c) => c.sym), ["TOP", "A", "B", "MID"], "ties break by symbol");
  assert.deepEqual(ranked.map((c) => c.rank), [1, 2, 3, 4]);
  assert.deepEqual(rankCalls(calls, { topN: 2 }).map((c) => c.inTopN), [true, true, false, false]);
  const all = rankCalls(calls, { minRvol: 0 });
  assert.equal(all.length, 5);
  const low = all.find((c) => c.sym === "LOW");
  assert.equal(low.inPlay, false);
  assert.equal(low.inTopN, false);
  assert.ok(low.cautions.some((x) => /under the paper's 1\.0x threshold/.test(x)));
  assert.equal(SIP.minRvol, 1);
  assert.equal(SIP.topN, 20);
});
