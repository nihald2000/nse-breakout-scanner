// /api/sip end to end with the universe, Yahoo and the clock stubbed (node --test runs each file in its own process).
const test = require("node:test");
const assert = require("node:assert/strict");
const common = require("../lib/common");

const stamp = (date, mm) => Date.parse(date + "T00:00:00Z") / 1000 + (mm - 330) * 60;
const dateN = (n) => new Date(Date.UTC(2026, 8, 1) + n * 864e5).toISOString().slice(0, 10);
const TODAY = "2026-10-21"; // a Wednesday
const NOW = stamp(TODAY, 600); // 10:00 IST

// 16 earlier sessions: first candle volume 1000, daily range 2 (ATR 2), then today's first candle and a few more.
function bars(first, rest) {
  const out = [];
  const push = (d, mm, o, hi, lo, cl, vol) => out.push({ t: stamp(d, mm), d, mm, o, hi, lo, cl, vol });
  for (let n = 0; n < 16; n++) {
    push(dateN(n), 555, 101, 102, 100, 101, 1000);
    for (let mm = 560; mm < 930; mm += 5) push(dateN(n), mm, 101, 101, 101, 101, 100);
  }
  push(TODAY, 555, first[0], first[1], first[2], first[3], first[4]);
  for (const [mm, o, hi, lo, cl] of rest) push(TODAY, mm, o, hi, lo, cl, 100);
  return out;
}
const raw = (bs) => ({
  meta: { gmtoffset: 19800, regularMarketPrice: bs[bs.length - 1].cl, regularMarketTime: stamp(TODAY, 595) },
  timestamp: bs.map((b) => b.t),
  indicators: { quote: [{ open: bs.map((b) => b.o), high: bs.map((b) => b.hi), low: bs.map((b) => b.lo), close: bs.map((b) => b.cl), volume: bs.map((b) => b.vol) }] },
});

const QUIET = [[560, 101.5, 101.9, 101, 101.6]]; // long names that have not touched 102 yet
const DATA = {
  AAA: bars([100, 102, 99.5, 101.5, 3000], QUIET), // long, 3x
  BBB: bars([100, 100.5, 98, 98.5, 5000], [[560, 98.4, 98.6, 98.1, 98.2], [565, 98.2, 98.15, 97.7, 97.8]]), // short, 5x, filled
  CCC: bars([100, 102, 99.5, 101.5, 500], QUIET), // 0.5x: not in play
  DDD: bars([100, 102, 99, 100, 3000], QUIET), // doji
};
const universe = ["AAA", "BBB", "CCC", "DDD", "FAIL"].map((sym) => ({ sym, industry: sym === "AAA" ? "Banks" : "IT" }));
let universeFails = false; // the handler captures getUniverse when it loads, so the stub itself is switchable
common.getUniverse = async () => {
  if (universeFails) throw new Error("HTTP 429 for https://nsearchives.nseindia.com/secret");
  return universe;
};
common.yahooChart = async (sym) => {
  const s = sym.replace(/\.NS$/, "");
  if (s === "FLAKY") throw new Error("HTTP 500 for https://query1.finance.yahoo.com/secret");
  if (!DATA[s]) throw new Error("HTTP 404");
  return raw(DATA[s]);
};
const realNow = Date.now;
Date.now = () => NOW * 1000;
test.after(() => {
  Date.now = realNow;
});

const handler = require("../api/sip");
async function get(query = {}) {
  const headers = {};
  const res = {
    code: null,
    body: null,
    setHeader(k, v) {
      headers[k] = v;
    },
    status(c) {
      this.code = c;
      return this;
    },
    json(o) {
      this.body = o;
      return this;
    },
  };
  await handler({ query }, res);
  return { res, headers };
}

test("lists every in-play call ranked by relative volume, with the filter's counts", async () => {
  const { res, headers } = await get();
  assert.equal(res.code, 200);
  const syms = res.body.calls.map((c) => c.sym);
  assert.deepEqual(syms, ["BBB", "AAA"], "5x then 3x; the 0.5x name, the doji and the failed fetch are not calls");
  assert.deepEqual(res.body.calls.map((c) => c.rank), [1, 2]);
  assert.equal(res.body.calls[0].action, "BUY PE");
  assert.equal(res.body.calls[0].status, "OPEN");
  assert.equal(res.body.calls[1].status, "PENDING");
  assert.equal(res.body.calls[1].industry, "Banks");
  const m = res.body.meta;
  assert.equal(m.universe, 5);
  assert.equal(m.evaluated, 3, "AAA, BBB and CCC");
  assert.equal(m.failed, 1);
  assert.deepEqual(m.skipped, { "doji first candle": 1 });
  assert.equal(m.inPlay, 2);
  assert.equal(m.listed, 2);
  assert.equal(m.inTopN, 2);
  assert.deepEqual(m.byStatus, { OPEN: 1, PENDING: 1 });
  assert.match(headers["Cache-Control"], /s-maxage=45/);
});

test("minRvol=0 also lists the below-threshold name, flagged and outside the top N", async () => {
  const { res } = await get({ minRvol: "0" });
  const c = res.body.calls.find((x) => x.sym === "CCC");
  assert.ok(c, "CCC is listed");
  assert.equal(c.inPlay, false);
  assert.equal(c.inTopN, false);
  assert.ok(c.cautions.some((x) => /under the paper's 1\.0x threshold/.test(x)));
  assert.equal(res.body.meta.minRvol, 0);
  assert.equal(res.body.meta.inPlay, 2, "inPlay still counts only names at 1.0x or more");
  assert.equal((await get({ minRvol: "not-a-number" })).res.body.meta.minRvol, 1, "bad input falls back to the paper's 1.0x");
  assert.equal((await get({ minRvol: "999" })).res.body.meta.minRvol, 50, "clamped");
});

test("session and market state follow the data's own date, not the wall clock", async () => {
  const live = (await get()).res.body.meta;
  assert.equal(live.sessionDate, TODAY);
  assert.equal(live.showingLastSession, false);
  assert.equal(live.marketOpen, true);
  Date.now = () => stamp("2026-10-22", 600) * 1000; // next morning (or a holiday): the newest data is still 21-Oct
  const next = (await get()).res.body.meta;
  Date.now = () => NOW * 1000;
  assert.equal(next.sessionDate, TODAY);
  assert.equal(next.showingLastSession, true);
  assert.equal(next.marketOpen, false);
});

test("the notes keep the paper's caveats in front of the reader", async () => {
  const notes = (await get()).res.body.meta.notes.join(" ");
  assert.match(notes, /US-equity study/);
  assert.match(notes, /not been tested on NSE/);
  assert.match(notes, /not trading advice/);
});

test("a failed universe load is a clean 502 with no upstream detail", async () => {
  universeFails = true;
  const { res } = await get();
  universeFails = false;
  assert.equal(res.code, 502);
  assert.equal(res.body.detail, undefined);
  assert.doesNotMatch(JSON.stringify(res.body), /nseindia|429/);
});

test("?sym= answers for one stock: its call, unranked, with the session's closed bars", async () => {
  const { res, headers } = await get({ sym: "aaa" });
  assert.equal(res.code, 200);
  const c = res.body.call;
  assert.equal(c.sym, "AAA");
  assert.equal(c.status, "PENDING");
  assert.equal(c.rank, null, "not ranked against the others");
  assert.equal(c.inTopN, null);
  assert.equal(c.inPlay, true);
  assert.equal(res.body.skip, null);
  assert.deepEqual(res.body.bars.map((b) => b.mm), [555, 560], "today's closed 5m bars, ready to draw");
  assert.equal(res.body.meta.sessionDate, TODAY);
  assert.equal(res.body.meta.marketOpen, true);
  assert.equal(res.body.meta.sym, "AAA");
  assert.match(headers["Cache-Control"], /s-maxage=45/);
});

test("?sym= says why a stock has no call, and flags one under the threshold", async () => {
  const doji = (await get({ sym: "DDD" })).res.body;
  assert.equal(doji.call, null);
  assert.equal(doji.skip, "doji first candle");
  assert.deepEqual(doji.bars, []);
  const weak = (await get({ sym: "CCC" })).res.body.call;
  assert.equal(weak.inPlay, false);
  assert.ok(weak.cautions.some((x) => /under the paper's 1\.0x threshold/.test(x)));
});

test("?sym= rejects odd input and never leaks upstream detail", async () => {
  assert.equal((await get({ sym: "A B;C" })).res.code, 400);
  assert.equal((await get({ sym: "X".repeat(40) })).res.code, 400);
  assert.equal((await get({ sym: "ZZZ" })).res.code, 404);
  const flaky = await get({ sym: "FLAKY" });
  assert.equal(flaky.res.code, 502);
  assert.doesNotMatch(JSON.stringify(flaky.res.body), /yahoo|secret|500/);
  assert.equal(flaky.headers["Cache-Control"], "no-store");
});
