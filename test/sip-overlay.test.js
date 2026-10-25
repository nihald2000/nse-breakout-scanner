const test = require("node:test");
const assert = require("node:assert/strict");
const O = require("../public/sip-overlay");
const { evaluate } = require("../lib/sip");

const bars15 = [555, 570, 585, 600, 615].map((mm) => ({ mm }));
const bars5 = [555, 560, 565, 570].map((mm) => ({ mm }));

test("snapMM puts a time on the chart bar that contains it, and refuses a bar the chart has not reached", () => {
  assert.equal(O.snapMM(bars15, 605), 600, "a 10:05 touch sits on the 10:00 fifteen-minute bar");
  assert.equal(O.snapMM(bars15, 600), 600);
  assert.equal(O.snapMM(bars15, 629), 615, "still inside the last bar");
  assert.equal(O.snapMM(bars15, 630), null, "the chart's last bar ended at 10:30; nothing is drawn after it");
  assert.equal(O.snapMM(bars15, 540), null, "before the first bar");
  assert.equal(O.snapMM(bars5, 568), 565);
  assert.equal(O.snapMM([], 600), null);
  assert.equal(O.snapMM(bars5, null), null);
});

const longPending = { sym: "AAA", side: "long", action: "BUY CE", status: "PENDING", rvol: 3.04, rank: 2, inPlay: true, level: 102, plannedStop: 101.8, entry: null, entryMM: null, stop: null, exit: null, exitMM: null, r: null, cautions: [] };

test("a pending call draws its stop order and the planned stop, and no markers", () => {
  const ov = O.overlay(longPending, bars5);
  assert.deepEqual(ov.levels.map((l) => [l.title, l.price]), [["ORB CE IN", 102], ["ORB SL plan", 101.8]]);
  assert.deepEqual(ov.markers, []);
  assert.equal(ov.note.side, "up");
  assert.match(ov.note.text, /ORB CE .* 3\.0× vol .* #2 .* stop order not touched yet/);
});

test("a filled short marks the entry above the bar, shows a gap fill, and scores the open trade", () => {
  const call = { sym: "BBB", side: "short", action: "BUY PE", status: "OPEN", rvol: 5, rank: 1, inPlay: true, level: 98, plannedStop: 98.2, entry: 97.9, entryMM: 575, stop: 98.1, exit: null, exitMM: null, r: 0.5, cautions: [] };
  const ov = O.overlay(call, bars5);
  assert.deepEqual(ov.levels.map((l) => l.title), ["ORB PE IN", "ORB SL", "ORB FILL"], "the stop is the real one once filled; the fill is shown because it gapped through the level");
  assert.equal(ov.levels[1].price, 98.1);
  assert.deepEqual(ov.markers.map((m) => [m.mm, m.position, m.shape, m.text]), [[570, "aboveBar", "arrowDown", "ORB IN"]]);
  assert.match(ov.note.text, /triggered 09:35 .* \+0\.50R/);
  assert.equal(ov.note.side, "down");
});

test("a stop-out and the 15:15 flat each land on the bar they happened in", () => {
  const stopped = { ...longPending, status: "STOPPED", entry: 102, entryMM: 605, stop: 101.8, exit: 101.8, exitMM: 620, r: -1 };
  const a = O.overlay(stopped, bars15);
  assert.deepEqual(a.markers.map((m) => [m.mm, m.text, m.color]), [[600, "ORB IN", "#2dd4bf"], [615, "ORB SL −1.00R", "#ef4444"]]);
  // stopped inside the 09:55 five-minute candle: its end (10:00) is stamped as the exit time, but the stop happened on the
  // 09:45 fifteen-minute bar, not the 10:00 one
  const edge = O.overlay({ ...stopped, entryMM: 595, exitMM: 600 }, bars15);
  assert.deepEqual(edge.markers.map((m) => m.mm), [585, 585]);
  const day = [555, 570, 585, 900, 915].map((mm) => ({ mm }));
  const flat = { ...longPending, status: "EXITED", entry: 102, entryMM: 575, stop: 101.8, exit: 103, exitMM: 915, r: 5 };
  const b = O.overlay(flat, day);
  assert.deepEqual(b.markers.map((m) => [m.mm, m.position, m.color]), [[570, "belowBar", "#2dd4bf"], [915, "aboveBar", "#22c55e"]]);
  assert.match(b.note.text, /flat \+5\.00R/);
});

test("markers the chart cannot hold yet are left out rather than parked on the wrong bar", () => {
  const filled = { ...longPending, status: "OPEN", entry: 102, entryMM: 700, stop: 101.8, r: 0.2 };
  assert.deepEqual(O.overlay(filled, bars15).markers, [], "the touch is after the chart's last closed bar");
});

test("no call, below-threshold and never-triggered states read honestly", () => {
  assert.deepEqual(O.overlay(null, bars5, "doji first candle"), { levels: [], markers: [], note: { text: "ORB: no call — doji first candle", side: "flat" } });
  assert.match(O.describe({ ...longPending, inPlay: false, rank: null }).text, /not in play/);
  assert.match(O.describe({ ...longPending, status: "NOT TRIGGERED" }).text, /never triggered/);
});

// ---- the overlay against a call that came out of the real rule ----
const stamp = (date, mm) => Date.parse(date + "T00:00:00Z") / 1000 + (mm - 330) * 60;
const dateN = (n) => new Date(Date.UTC(2026, 8, 1) + n * 864e5).toISOString().slice(0, 10);
function market(first, rest) {
  const out = [];
  const push = (d, mm, o, hi, lo, cl, vol) => out.push({ t: stamp(d, mm), d, mm, o, hi, lo, cl, vol });
  for (let n = 0; n < 16; n++) {
    push(dateN(n), 555, 101, 102, 100, 101, 1000);
    for (let mm = 560; mm < 930; mm += 5) push(dateN(n), mm, 101, 101, 101, 101, 100);
  }
  const T = "2026-10-21";
  push(T, 555, ...first);
  for (const [mm, o, hi, lo, cl] of rest) push(T, mm, o, hi, lo, cl, 100);
  return { bars: out, now: stamp(T, 620), T };
}

test("a real long that fired and ran draws entry, stop and an open-trade chip on the chart's own bars", () => {
  const m = market([100, 102, 99.5, 101.5, 3000], [[560, 101.5, 101.9, 101, 101.6], [565, 102, 102.4, 101.95, 102.2], [570, 102.2, 102.6, 102.1, 102.5]]);
  const out = evaluate("AAA", m.bars, m.now);
  assert.equal(out.ok, true);
  const ov = O.overlay(out.call, [555, 560, 565, 570, 575, 580, 585, 590, 595, 600, 605, 610, 615].map((mm) => ({ mm })));
  assert.equal(out.call.status, "OPEN");
  assert.deepEqual(ov.markers.map((m2) => [m2.mm, m2.text]), [[565, "ORB IN"]]);
  assert.equal(ov.levels[0].price, 102);
  assert.ok(Math.abs(ov.levels[1].price - out.call.stop) < 1e-9);
});

// ---- the cached client ----
function fakeHandle() {
  const h = { dead: false, levels: [], marks: null, noteText: null };
  h.alive = () => !h.dead;
  h.addLevels = (l) => h.levels.push(...l);
  h.setMarkers = (m) => { h.marks = m; };
  h.note = (t, s) => { h.noteText = [t, s]; };
  return h;
}
const okReply = { call: longPending, skip: null, bars: [{ mm: 555 }, { mm: 560 }], meta: {} };

test("the client asks once per symbol inside the cache window, then again after it", async () => {
  let clock = 0;
  const urls = [];
  const c = O.client({ fetch: async (u) => { urls.push(u); return okReply; }, now: () => clock, sessionTime: (mm) => 1000 + mm });
  const h1 = fakeHandle();
  const h2 = fakeHandle();
  await c.attach(h1, "aaa", { bars: bars5 });
  await c.attach(h2, "AAA", { bars: bars5 });
  assert.deepEqual(urls, ["/api/sip?sym=AAA"]);
  assert.deepEqual(h1.levels.map((l) => l.title), ["ORB CE IN", "ORB SL plan"]);
  assert.deepEqual(h2.noteText[1], "up");
  clock = 46000;
  await c.attach(fakeHandle(), "AAA", { bars: bars5 });
  assert.equal(urls.length, 2);
});

test("a failed or slow answer never breaks the chart, and a replaced chart is left alone", async () => {
  const bad = O.client({ fetch: async () => { throw new Error("HTTP 502"); } });
  const h = fakeHandle();
  const res = await bad.attach(h, "AAA", {});
  assert.ok(res.error);
  assert.deepEqual(h.noteText, ["ORB overlay unavailable", "flat"]);
  assert.equal(h.levels.length, 0);
  await bad.attach(fakeHandle(), "AAA", {}); // a failure is not cached: this asks again
  const calls = [];
  const slow = O.client({ fetch: async (u) => { calls.push(u); return okReply; } });
  const gone = fakeHandle();
  const p = slow.attach(gone, "AAA", { bars: bars5 });
  gone.dead = true; // the page re-drew the chart before the answer came back
  await p;
  assert.deepEqual(gone.levels, []);
  assert.equal(gone.noteText, null);
  assert.equal(await slow.attach({}, "AAA", {}), null, "a handle with no overlay surface is ignored");
});

test("seeded calls skip the network; asking for bars fetches them once", async () => {
  const urls = [];
  const c = O.client({ fetch: async (u) => { urls.push(u); return okReply; }, now: () => 0, sessionTime: (mm) => mm });
  c.seed([longPending]);
  const h = fakeHandle();
  await c.attach(h, "AAA", { bars: bars5 });
  assert.deepEqual(urls, [], "the list already held it");
  assert.equal(h.levels.length, 2);
  const withBars = await c.load("AAA", true);
  assert.equal(withBars.bars.length, 2);
  assert.deepEqual(urls, ["/api/sip?sym=AAA"]);
  await c.load("AAA", true);
  assert.equal(urls.length, 1, "now cached with bars");
});
