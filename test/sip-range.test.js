// The range-ranking fallback: used when Yahoo's 09:15 volume history is unusable, never mixed with volume in one list.
const test = require("node:test");
const assert = require("node:assert/strict");
const common = require("../lib/common");

const stamp = (date, mm) => Date.parse(date + "T00:00:00Z") / 1000 + (mm - 330) * 60;
const dateN = (n) => new Date(Date.UTC(2026, 8, 1) + n * 864e5).toISOString().slice(0, 10);
const TODAY = "2026-10-21"; // a Wednesday
const NOW = stamp(TODAY, 600);

// 16 earlier sessions (first candle range 2, volume `priorVol`), then today's first candle [100, 102.5, 99.5, 102.2] (range 3).
function bars(priorVol, firstVol) {
  const out = [];
  const push = (d, mm, o, hi, lo, cl, vol) => out.push({ t: stamp(d, mm), d, mm, o, hi, lo, cl, vol });
  for (let n = 0; n < 16; n++) {
    push(dateN(n), 555, 101, 102, 100, 101, priorVol);
    for (let mm = 560; mm < 930; mm += 5) push(dateN(n), mm, 101, 101, 101, 101, 100);
  }
  push(TODAY, 555, 100, 102.5, 99.5, 102.2, firstVol);
  push(TODAY, 560, 102.2, 102.4, 102, 102.3, 100);
  return out;
}
const raw = (bs) => ({
  meta: { gmtoffset: 19800, regularMarketPrice: 102.3, regularMarketTime: stamp(TODAY, 595) },
  timestamp: bs.map((b) => b.t),
  indicators: { quote: [{ open: bs.map((b) => b.o), high: bs.map((b) => b.hi), low: bs.map((b) => b.lo), close: bs.map((b) => b.cl), volume: bs.map((b) => b.vol) }] },
});
let feed = "zero"; // "zero": history volume 0 (Yahoo's real behaviour); "good": a normal volume history
common.getUniverse = async () => ["AAA", "BBB"].map((sym) => ({ sym, industry: "X" }));
common.yahooChart = async () => raw(feed === "zero" ? bars(0, 5000) : bars(1000, 3000));
const realNow = Date.now;
Date.now = () => NOW * 1000;
test.after(() => {
  Date.now = realNow;
});

const { evaluate } = require("../lib/sip");
const handler = require("../api/sip");
async function get(query) {
  const res = { code: null, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  await handler({ query }, res);
  return res;
}

test("evaluate: rankBy range ranks by the first candle's range and says so; volume mode still skips a zero-volume history", () => {
  const bs = bars(0, 5000);
  const vol = evaluate("AAA", bs, NOW);
  assert.equal(vol.ok, false);
  assert.match(vol.skip, /first-candle volume history missing/);
  const r = evaluate("AAA", bs, NOW, { rankBy: "range" });
  assert.equal(r.ok, true);
  assert.equal(r.call.rankBy, "range");
  assert.ok(Math.abs(r.call.rvol - 3 / 2) < 1e-9, "first-candle range 3 vs a normal 2");
  assert.ok(r.call.cautions.some((c) => /NOT by volume/.test(c)));
  const normal = evaluate("AAA", bars(1000, 3000), NOW);
  assert.equal(normal.call.rankBy, "volume");
  assert.equal(normal.call.rvol, 3);
});

test("/api/sip auto: falls back to range for the whole list when the volume history is missing, and labels it", async () => {
  feed = "zero";
  const r = await get({});
  assert.equal(r.code, 200);
  assert.equal(r.body.meta.rankBy, "range");
  assert.match(r.body.meta.rankNote, /not volume/i);
  assert.equal(r.body.calls.length, 2);
  assert.ok(r.body.calls.every((c) => c.rankBy === "range"));
  assert.equal(r.body.meta.marketOpen, true, "the session date is known, so the market is reported live");
  const forced = await get({ rank: "volume" });
  assert.equal(forced.body.calls.length, 0, "rank=volume never silently switches");
  assert.equal(forced.body.meta.rankBy, "volume");
  assert.equal(forced.body.meta.skipped["first-candle volume history missing"], 2);
});

test("/api/sip auto: keeps the paper's volume rule when the volume history is usable", async () => {
  feed = "good";
  const r = await get({});
  assert.equal(r.body.meta.rankBy, "volume");
  assert.equal(r.body.meta.rankNote, null);
  assert.ok(r.body.calls.every((c) => c.rankBy === "volume" && c.rvol === 3));
});

test("with nothing evaluated the session date and 'live' still follow the newest bar", async () => {
  feed = "zero";
  const r = await get({ rank: "volume" });
  assert.equal(r.body.calls.length, 0);
  assert.equal(r.body.meta.sessionDate, TODAY);
  assert.equal(r.body.meta.marketOpen, true);
});

test("the shortlist alert names the range rule when that is what ranked the list", () => {
  const { eventsFor } = require("../lib/alerts");
  const c = { sym: "AAA", session: TODAY, side: "long", action: "BUY CE", status: "PENDING", rvol: 1.5, rank: 1, inPlay: true, level: 102.5, plannedStop: 102.3, riskPerShare: 0.2, ltp: 102, ltpMM: 600, rankBy: "range", cautions: [] };
  const ev = eventsFor([c], { marketOpen: true, fresh: true, sessionDate: TODAY, nowMM: 600, rankBy: "range" });
  const sl = ev.find((e) => e.kind === "shortlist");
  assert.match(sl.text, /RANGE vs normal/);
  assert.match(sl.text, /1\.5x range/);
  const vol = eventsFor([{ ...c, rankBy: "volume" }], { marketOpen: true, fresh: true, sessionDate: TODAY, nowMM: 600, rankBy: "volume" }).find((e) => e.kind === "shortlist");
  assert.match(vol.text, /09:15 volume vs normal/);
});
