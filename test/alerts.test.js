// lib/alerts.js: which events the Stocks in Play calls produce. Synthetic calls only, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const { eventsFor, ALERT } = require("../lib/alerts");

const S = "2026-10-26";
function call(over) {
  return {
    sym: "AAA", session: S, side: "long", action: "BUY CE", status: "PENDING", rvol: 3, rank: 1, inPlay: true, inTopN: true,
    level: 100, plannedStop: 99, riskPerShare: 1, entry: null, entryMM: null, stop: null, exit: null, exitMM: null, r: null,
    ltp: 98, ltpMM: 600, ambiguous: false, cautions: [], ...over,
  };
}
const ctx = (over) => ({ marketOpen: true, fresh: true, sessionDate: S, nowMM: 600, ...over });
const kinds = (ev) => ev.map((e) => e.kind + (e.sym ? ":" + e.sym : ""));

test("no events when the market is closed, the data is stale, or the session is not today's", () => {
  const calls = [call({})];
  assert.deepEqual(eventsFor(calls, ctx({ marketOpen: false })), []);
  assert.deepEqual(eventsFor(calls, ctx({ fresh: false })), []);
  assert.deepEqual(eventsFor([call({ session: "2026-10-23" })], ctx()), [], "last session's calls are not alerted");
  assert.deepEqual(eventsFor(null, ctx()), []);
});

test("shortlist: one event listing only in-play names ranked inside the watch size", () => {
  const calls = [];
  for (let i = 1; i <= 12; i++) calls.push(call({ sym: "S" + i, rank: i, ltp: 90 }));
  calls.push(call({ sym: "WEAK", rank: 13, inPlay: false, ltp: 90 }));
  const ev = eventsFor(calls, ctx());
  const sl = ev.filter((e) => e.kind === "shortlist");
  assert.equal(sl.length, 1);
  assert.equal(sl[0].id, `${S}:shortlist`);
  assert.match(sl[0].text, /1\. S1 · BUY CE above 100\.00 · stop 99\.00 · 3\.0x volume/);
  assert.doesNotMatch(sl[0].text, /S11|S12|WEAK/);
  assert.equal(ev.length, 1, "far from the level: no building events");
  // not before 09:20 and not after 11:30
  assert.equal(eventsFor(calls, ctx({ nowMM: 555 })).length, 0);
  assert.equal(eventsFor(calls, ctx({ nowMM: ALERT.shortlistUntilMM + 1 })).filter((e) => e.kind === "shortlist").length, 0);
});

test("shortlist wording for a short call uses 'below' and BUY PE", () => {
  const ev = eventsFor([call({ side: "short", action: "BUY PE", level: 100, plannedStop: 101, ltp: 105 })], ctx());
  assert.match(ev[0].text, /BUY PE below 100\.00 · stop 101\.00/);
});

test("building: within a quarter of the stop distance of the level, and only while PENDING", () => {
  assert.deepEqual(kinds(eventsFor([call({ ltp: 99.7 })], ctx())), ["shortlist"], "0.3 away with a stop distance of 1 is outside 0.25");
  const near = eventsFor([call({ ltp: 99.8 })], ctx());
  assert.deepEqual(kinds(near), ["shortlist", "building:AAA"].sort((a, b) => (a === "building:AAA" ? 1 : -1)));
  const b = near.find((e) => e.kind === "building");
  assert.equal(b.id, `${S}:AAA:building`);
  assert.equal(b.atMM, 600);
  assert.match(b.text, /Order level 100\.00 \(above\); last close 99\.80, 0\.20 away/);
  // a short call mirrors it
  const sh = eventsFor([call({ side: "short", action: "BUY PE", level: 100, plannedStop: 101, ltp: 100.2 })], ctx());
  assert.ok(sh.some((e) => e.kind === "building"));
  // price already past the level but the closed candles still say PENDING: still building (lag)
  assert.ok(eventsFor([call({ ltp: 100.3 })], ctx()).some((e) => e.kind === "building"));
  // after 14:30 nothing new is building
  assert.ok(!eventsFor([call({ ltp: 99.9 })], ctx({ nowMM: ALERT.entryUntilMM + 5 })).some((e) => e.kind === "building"));
});

test("triggered: carries the fill, the stop and the chase limit; too-late fills say skip", () => {
  const open = call({ status: "OPEN", entry: 100, entryMM: 605, stop: 99, r: 0.2, ltp: 100.2, ltpMM: 610 });
  const t = eventsFor([open], ctx({ nowMM: 611 })).find((e) => e.kind === "triggered");
  assert.equal(t.id, `${S}:AAA:triggered`);
  assert.equal(t.atMM, 605);
  assert.equal(t.priority, "high");
  assert.match(t.text, /fill 100\.00/);
  assert.match(t.text, /Stop loss 99\.00/);
  assert.match(t.text, /Chase limit 100\.50: enter only while the share is at or below it/);
  const late = eventsFor([call({ status: "OPEN", entry: 100, entryMM: 605, stop: 99, r: 0.8, ltp: 100.8, ltpMM: 640 })], ctx({ nowMM: 641 })).find((e) => e.kind === "triggered");
  assert.match(late.text, /TOO LATE/);
  // short side: limit is below the fill
  const sh = eventsFor([call({ side: "short", action: "BUY PE", level: 100, status: "OPEN", entry: 100, entryMM: 605, stop: 101, r: 0.1, ltp: 99.9, ltpMM: 610 })], ctx({ nowMM: 611 })).find((e) => e.kind === "triggered");
  assert.match(sh.text, /Chase limit 99\.50: enter only while the share is at or above it/);
  // an entry after the late cutoff is not announced
  const lateEntry = eventsFor([call({ status: "OPEN", entry: 100, entryMM: 880, stop: 99, r: 0, ltp: 100, ltpMM: 880 })], ctx({ nowMM: 885 }));
  assert.ok(!lateEntry.some((e) => e.kind === "triggered"));
});

test("oneR, stopped and flat reminders", () => {
  const up = eventsFor([call({ status: "OPEN", entry: 100, entryMM: 605, stop: 99, r: 1.2, ltp: 101.2, ltpMM: 700 })], ctx({ nowMM: 701 }));
  assert.ok(up.some((e) => e.kind === "oneR" && /move your stop to cost/.test(e.text)));
  assert.ok(!up.some((e) => e.kind === "flat"));
  const flat = eventsFor([call({ status: "OPEN", entry: 100, entryMM: 605, stop: 99, r: 0.4, ltp: 100.4, ltpMM: 905 })], ctx({ nowMM: 911 }));
  assert.ok(flat.some((e) => e.kind === "flat" && e.atMM === ALERT.flatMM));
  const stop = eventsFor([call({ status: "STOPPED", entry: 100, entryMM: 605, stop: 99, exit: 99, exitMM: 620, r: -1, ltp: 99, ltpMM: 620 })], ctx({ nowMM: 621 })).find((e) => e.kind === "stopped");
  assert.equal(stop.id, `${S}:AAA:stopped`);
  assert.equal(stop.atMM, 620);
  assert.match(stop.text, /-1\.00R/);
  // a call that never triggered and a finished one raise nothing beyond the shortlist
  assert.deepEqual(kinds(eventsFor([call({ status: "EXITED", entry: 100, entryMM: 605, exit: 101, exitMM: 930, r: 1, ltp: 101, ltpMM: 930 })], ctx({ nowMM: 650 }))), ["shortlist"]);
});

test("ordering: the actionable events come first and ids are unique and stable across calls", () => {
  const calls = [
    call({ sym: "B", rank: 2, ltp: 99.9 }),
    call({ sym: "A", rank: 1, status: "OPEN", entry: 100, entryMM: 605, stop: 99, r: 0.1, ltp: 100.1, ltpMM: 610 }),
  ];
  const a = eventsFor(calls, ctx({ nowMM: 611 }));
  const b = eventsFor(calls, ctx({ nowMM: 612 }));
  assert.deepEqual(a.map((e) => e.id), b.map((e) => e.id));
  assert.equal(new Set(a.map((e) => e.id)).size, a.length);
  assert.equal(a[0].kind, "triggered");
  assert.equal(a[a.length - 1].kind, "building");
});
