// lib/orbstudy.js and /api/orbstudy on synthetic bars. Each test builds the path by hand so the expected outcome is known.
const test = require("node:test");
const assert = require("node:assert/strict");
const common = require("../lib/common");
const S = require("../lib/orbstudy");
const sip = require("../lib/sip");

const stamp = (date, mm) => Date.parse(date + "T00:00:00Z") / 1000 + (mm - 330) * 60;
const dateN = (n) => new Date(Date.UTC(2026, 8, 1) + n * 864e5).toISOString().slice(0, 10);

// 17 earlier sessions (first candle vol 1000, range 2 -> ATR 2) then one test session `over` describes: mm -> [o,hi,lo,cl].
function series(firstTest, over = {}, opts = {}) {
  const out = [];
  const push = (d, mm, o, hi, lo, cl, vol) => out.push({ t: stamp(d, mm), d, mm, o, hi, lo, cl, vol });
  const priorVol = opts.priorVol == null ? 1000 : opts.priorVol;
  for (let n = 0; n < 17; n++) {
    push(dateN(n), 555, 101, 102, 100, 101, priorVol);
    for (let mm = 560; mm < 930; mm += 5) push(dateN(n), mm, 101, 101, 101, 101, 100);
  }
  const d = dateN(17);
  push(d, 555, firstTest[0], firstTest[1], firstTest[2], firstTest[3], firstTest[4]);
  for (let mm = 560; mm < 930; mm += 5) {
    const b = over[mm] || [101.5, 101.5, 101.5, 101.5];
    push(d, mm, b[0], b[1], b[2], b[3], 100);
  }
  return out;
}
const FIRST_UP = [100, 102, 99.5, 101.5, 3000]; // bullish, level 102, 3x volume
// The earlier sessions have open == close on their first candle (a doji), so only the hand-built last day is a candidate.
const cand = (bars, mode) => { const l = S.candidates("AAA", bars, mode).cands; return l[l.length - 1]; };

test("candidates: rvol, side, level and risk come only from earlier data; thin history and dojis are skipped", () => {
  const c = cand(series(FIRST_UP));
  assert.equal(c.metric, 3);
  assert.equal(c.sg, 1);
  assert.ok(Math.abs(c.riskDist - 0.2) < 1e-9);
  // changing what happens LATER in the test day cannot change the candidate
  const c2 = cand(series(FIRST_UP, { 600: [101.5, 110, 90, 95] }));
  assert.equal(c2.metric, c.metric);
  assert.equal(c2.sg, c.sg);
  // a later day's volume does not leak into an earlier day's baseline: only 17 priors exist, the day itself is excluded
  const doji = S.candidates("AAA", series([100, 102, 99, 100, 3000]));
  assert.equal(doji.cands.length, 0);
  assert.equal(doji.skips["doji first candle"], 3, "the two earlier testable days are dojis too, plus the test day");
  const thin = S.candidates("AAA", series(FIRST_UP).filter((b) => b.d >= dateN(10)));
  assert.equal(thin.cands.length, 0);
  assert.match(Object.keys(thin.skips).join(), /15 earlier/);
});

test("candidates: a feed with zero 09:15 volume is reported, and the range fallback still works", () => {
  const zero = series([100, 102, 99.5, 101.5, 0], {}, { priorVol: 0 });
  const r = S.candidates("AAA", zero);
  assert.equal(r.cands.length, 0);
  assert.equal(r.skips["first-candle volume history missing"], 3, "every testable day is skipped for the same reason");
  const rg = S.candidates("AAA", zero, "range");
  assert.equal(rg.cands.length, 1);
  assert.equal(rg.cands[0].metric, 2.5 / 2, "first-candle range 2.5 vs a normal range of 2");
});

test("simulate (with): target first, stop first, both in one candle, entry-candle adverse, timeout", () => {
  // entry at 102 on the 09:20 bar (open 101.8 below the level, so it fills at the level)
  const base = { 560: [101.8, 102.3, 101.7, 102.2] };
  // target +2% = 104.04 reached later, stop -1% = 100.98 never
  let t = S.simulate(cand(series(FIRST_UP, { ...base, 600: [102.2, 104.5, 102.1, 104.4] })), "with");
  assert.equal(t.entry, 102);
  assert.equal(t.entryClose, 565);
  assert.equal(t.cells["1/2"].res, "T");
  assert.ok(Math.abs(t.cells["1/2"].pct - 2) < 1e-9);
  assert.equal(t.cells["1/2"].mm, 605 - 0, "hit in the 10:00 candle, known at its close");
  // both reachable in the same candle: stop first
  t = S.simulate(cand(series(FIRST_UP, { ...base, 600: [102.2, 104.5, 100.5, 102] })), "with");
  assert.equal(t.cells["1/2"].res, "S");
  // the entry candle itself dipped through the stop: counted as stopped even though the dip may predate the fill
  t = S.simulate(cand(series(FIRST_UP, { 560: [101.8, 102.3, 100.5, 102.2] })), "with");
  assert.equal(t.cells["1/2"].res, "S");
  // nothing reached by 15:15: closed at the 15:15 open
  t = S.simulate(cand(series(FIRST_UP, { ...base, 915: [102.4, 102.4, 102.4, 102.4] })), "with");
  assert.equal(t.cells["1/2"].res, "X");
  assert.ok(Math.abs(t.cells["1/2"].pct - ((102.4 - 102) * 100) / 102) < 1e-9);
  // never touched: no trade
  assert.equal(S.simulate(cand(series(FIRST_UP)), "with"), null);
});

test("simulate (against): the control trades the opposite side of the first candle", () => {
  // first candle is bullish (level 102) but price breaks DOWN through the first low 99.5 and keeps falling
  const over = { 560: [99.6, 99.7, 99.4, 99.45] };
  for (let mm = 565; mm < 600; mm += 5) over[mm] = [99.4, 99.45, 99.35, 99.4]; // stays low, never back near 101.5
  over[600] = [99.4, 99.45, 96.9, 97];
  for (let mm = 605; mm < 930; mm += 5) over[mm] = [97, 97.1, 96.9, 97];
  const c = cand(series(FIRST_UP, over));
  assert.equal(S.simulate(c, "with"), null, "the bullish level 102 is never touched");
  const a = S.simulate(c, "against");
  assert.ok(a, "the short side fills");
  assert.equal(a.entry, 99.5, "the candle opened above the short level and fell through it: filled at the level");
  assert.equal(a.cells["1/2"].res, "T", "it keeps falling past -2%");
  // a candle that opens below the level fills at its open
  const gapDown = S.simulate(cand(series(FIRST_UP, { 560: [99.0, 99.2, 98.8, 99.1] })), "against");
  assert.equal(gapDown.entry, 99.0);
});

test("simulate agrees with lib/sip evaluate on the entry price and candle", () => {
  const over = { 560: [101.8, 102.3, 101.7, 102.2], 565: [102.2, 102.4, 102.0, 102.3] };
  const bars = series(FIRST_UP, over);
  const c = cand(bars);
  const t = S.simulate(c, "with");
  const end = stamp(dateN(17), 930) + 1;
  const ev = sip.evaluate("AAA", bars, end);
  assert.equal(ev.ok, true);
  assert.equal(t.entry, ev.call.entry);
  assert.equal(t.entryClose, ev.call.entryMM);
  // gap through the level
  const gap = series(FIRST_UP, { 560: [102.6, 102.9, 102.5, 102.8] });
  const g = S.simulate(cand(gap), "with");
  assert.equal(g.entry, sip.evaluate("AAA", gap, end).call.entry);
  assert.equal(g.entry, 102.6);
});

test("buildTrades ranks each day by the metric and simulates only in-play names", () => {
  const mk = (sym, vol, over) => ({ sym, bars: series([100, 102, 99.5, 101.5, vol], over) });
  const base = { 560: [101.8, 102.3, 101.7, 102.2] };
  const all = [];
  for (const [sym, vol] of [["HIGH", 5000], ["MID", 2000], ["LOW", 500]]) all.push(...S.candidates(sym, mk(sym, vol, base).bars).cands);
  const built = S.buildTrades(all, { topN: 2 });
  assert.equal(built.inPlay, 2, "0.5x is not in play");
  const last = built.trades.filter((t) => t.dir === "with" && t.d === dateN(17));
  assert.deepEqual(last.map((t) => [t.sym, t.rank]), [["HIGH", 1], ["MID", 2]]);
  assert.equal(built.inPlayTopN, 2);
  assert.ok(built.trades.some((t) => t.dir === "against" || t.dir === "with"));
});

test("summarise: counts, headline cells, buckets; intervals are deterministic and need enough days", () => {
  // 12 days x 1 name, alternating a winner and a loser on the headline cell (stop 0.75, target 1.5)
  const all = [];
  for (let n = 0; n < 12; n++) {
    const d = dateN(17 + n);
    const win = n % 2 === 0;
    const bars = series(FIRST_UP, { 560: [101.8, 102.3, 101.7, 102.2], 600: win ? [102.2, 104, 102.1, 103.9] : [102.2, 102.3, 100.9, 101] });
    const c = cand(bars);
    all.push({ ...c, d });
  }
  const built = S.buildTrades(all, { topN: 10 });
  const out = S.summarise(built, { topN: 10 });
  const h = out.headline[0];
  assert.equal(h.with.n, 12);
  assert.equal(h.with.pTarget, 0.5);
  assert.ok(h.with.ciPTarget && h.with.ciPTarget[0] <= 0.5 && h.with.ciPTarget[1] >= 0.5);
  assert.deepEqual(h.with.ciPTarget, S.summarise(built, { topN: 10 }).headline[0].with.ciPTarget, "same seed, same interval");
  assert.equal(out.counts.sessionsTested, 12);
  assert.equal(out.counts.triggerRateTopN, 1);
  assert.equal(out.timing.find((b) => b.group === "09:20-09:35").n, 12);
  assert.equal(S.bootstrapDays(built.trades.slice(0, 2), () => 0.5, 50, 1), null, "too few days: no interval");
  assert.equal(out.stability.daysWithTrades, 12);
});

test("premiumModel: a bigger favourable move gives a bigger gain; the move needed rises with the target gain", () => {
  for (const r of S.premiumModel()) {
    const g = r.gainPctAtMove;
    assert.ok(g[1] > g[0.75] && g[2] > g[1] && g[3.5] > g[2.5]);
    assert.ok(r.lossPctAtMinus[1.5] < r.lossPctAtMinus[0.5] && r.lossPctAtMinus[0.5] < 0);
    assert.ok(r.moveNeededForGain[20] < r.moveNeededForGain[35] && r.moveNeededForGain[35] < r.moveNeededForGain[50]);
  }
});

// ----- the API with the universe and Yahoo stubbed -----
const DATA = { AAA: series(FIRST_UP, { 560: [101.8, 102.3, 101.7, 102.2], 600: [102.2, 104.5, 102.1, 104.4] }), ZERO: series([100, 102, 99.5, 101.5, 0], {}, { priorVol: 0 }) };
common.getUniverse = async () => ["AAA", "ZERO", "FAIL"].map((sym) => ({ sym, industry: "X" }));
common.yahooChart = async (sym) => {
  const s = sym.replace(/\.NS$/, "");
  if (!DATA[s]) throw new Error("HTTP 500 for https://query1.finance.yahoo.com/secret");
  const bs = DATA[s];
  return {
    meta: { gmtoffset: 19800 },
    timestamp: bs.map((b) => b.t),
    indicators: { quote: [{ open: bs.map((b) => b.o), high: bs.map((b) => b.hi), low: bs.map((b) => b.lo), close: bs.map((b) => b.cl), volume: bs.map((b) => b.vol) }] },
  };
};
const handler = require("../api/orbstudy");
async function get(query) {
  const res = { code: null, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  await handler({ query }, res);
  return res;
}

test("/api/orbstudy: returns the study, counts failed fetches and zero-volume 09:15 candles, never leaks a URL", async () => {
  const r = await get({});
  assert.equal(r.code, 200);
  const q = r.body.meta.quality;
  assert.equal(q.universe, 3);
  assert.equal(q.failedFetches, 1);
  assert.equal(q.candidateStockSessions, 1, "AAA has one usable session; ZERO has none");
  assert.ok(q.first0915BarsWithZeroOrMissingVolume > 0, "the zero-volume feed is visible");
  assert.equal(q.skipReasons["first-candle volume history missing"], 3);
  assert.ok(r.body.study.headline.length === 4);
  assert.ok(r.body.optionModel.length === 6);
  assert.ok(r.body.meta.limits.length >= 4);
  assert.ok(!JSON.stringify(r.body).includes("secret"));
  const rg = await get({ rank: "range" });
  assert.equal(rg.body.meta.quality.candidateStockSessions, 2, "the range fallback can rank the zero-volume feed too");
  const dbg = await get({ debug: "1" });
  assert.equal(dbg.body.note, "debug only");
});
