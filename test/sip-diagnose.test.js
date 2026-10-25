// diagnose(): shows how the first-candle volume baseline was read, so a feed that sends 0 for the 09:15 volume is visible.
const test = require("node:test");
const assert = require("node:assert/strict");
const { diagnose, evaluate } = require("../lib/sip");

const stamp = (date, mm) => Date.parse(date + "T00:00:00Z") / 1000 + (mm - 330) * 60;
const dateN = (n) => new Date(Date.UTC(2026, 8, 1) + n * 864e5).toISOString().slice(0, 10);

function series(firstVol) {
  const out = [];
  const push = (d, mm, vol) => out.push({ t: stamp(d, mm), d, mm, o: 101, hi: 102, lo: 100, cl: 101, vol });
  for (let n = 0; n < 17; n++) {
    push(dateN(n), 555, firstVol);
    for (let mm = 560; mm < 930; mm += 5) push(dateN(n), mm, 100);
  }
  return out;
}
const NOW = stamp(dateN(17), 600);

test("diagnose: a feed with zero 09:15 volume is reported as zero-volume first candles", () => {
  const bars = series(0);
  const d = diagnose(bars, NOW);
  assert.equal(d.priorFullSessions, 16);
  assert.equal(d.baselineSessions, 14);
  assert.equal(d.baselineWithVolume, 0);
  assert.equal(d.zeroVolumeFirstCandles, 14);
  assert.equal(d.sessions.length, 16);
  assert.equal(d.sessions[0].firstVol, 0);
  assert.equal(d.sessions[0].full, true);
  // and the rule skips it for exactly that reason
  const out = evaluate("X", bars.concat([{ t: stamp(dateN(17), 555), d: dateN(17), mm: 555, o: 100, hi: 102, lo: 99, cl: 101, vol: 500 }]), NOW);
  assert.equal(out.ok, false);
  assert.match(out.skip, /first-candle volume history missing/);
});

test("diagnose: a normal feed has a usable baseline", () => {
  const d = diagnose(series(1000), NOW);
  assert.equal(d.baselineWithVolume, 14);
  assert.equal(d.zeroVolumeFirstCandles, 0);
});

test("diagnose: empty or short input does not throw", () => {
  assert.equal(diagnose([], NOW).sessions.length, 0);
  assert.equal(diagnose(null, NOW).priorFullSessions, 0);
});
