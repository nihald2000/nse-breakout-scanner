// Listing policy: a call whose trigger fired is LISTED; filters of the tested ruleset are cautions, not hiding.
// Strict mode (?strict=1, and always the Backtest replay) keeps the old blocking behaviour.
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../lib/rules_core");
const calls = require("../api/calls");
const { replayDay } = require("../lib/replay");
const { _internals: I } = require("../api/indices");

const ix = I.INDICES.find((x) => x.key === "NIFTY");
const stamp = (date, mm) => Date.parse(date + "T00:00:00Z") / 1000 + (mm - 330) * 60;
const bar = (date, mm, o, hi, lo, cl) => ({ t: stamp(date, mm), d: date, mm, o, hi, lo, cl, vol: 0 });
const PRIOR = ["2026-10-22", "2026-10-23"].flatMap((date) => [bar(date, 555, 100, 101, 99, 100), bar(date, 560, 100, 100.8, 99.2, 100), bar(date, 565, 100, 100.8, 99.2, 100)]);

function run(bars, price, nowMM, date, extra = {}) {
  return I.analyse(ix, { p5: { bars, meta: { regularMarketPrice: price } } }, {
    nowSec: stamp(date, nowMM),
    todayISO: date,
    marketOpen: true,
    expiry: { NIFTY: false },
    vix: null,
    skipSwing: true,
    skipMaxPain: true,
    ...extra,
  });
}
const row = (out, id) => out.rows.find((r) => r.strategy === id);

// ---------------------------------------------------------------- settle()
test("settle: a failed soft check is a caution and the call is still listed", () => {
  const r = core.res("orb_break", "TRIGGERED", "WAIT", { side: "long" });
  core.settle(r, {}, [{ ok: false, text: "passing statement", caution: "what to watch out for" }]);
  assert.equal(r.action, "BUY CE");
  assert.deepEqual(r.cautions, ["what to watch out for"]);
  assert.equal(r.checks.length, 1, "the failed check still appears in the checks list");
});

test("settle: strict mode turns the same failed soft check into NO TRADE", () => {
  const r = core.res("orb_break", "TRIGGERED", "WAIT", { side: "long" });
  core.settle(r, { strict: true }, [{ ok: false, text: "passing statement", caution: "what to watch out for" }]);
  assert.equal(r.action, "NO TRADE");
  assert.equal(r.note, "passing statement");
  assert.deepEqual(r.cautions, []);
});

test("settle: a stop on the wrong side always blocks, strict or not", () => {
  for (const ctx of [{}, { strict: true }]) {
    const r = core.res("orb_break", "TRIGGERED", "WAIT", { side: "short" });
    core.settle(r, ctx, [core.stopSideCheck(-1)]);
    assert.equal(r.action, "NO TRADE");
  }
  const ok = core.res("orb_break", "TRIGGERED", "WAIT", { side: "short" });
  core.settle(ok, {}, [core.stopSideCheck(1)]);
  assert.equal(ok.action, "BUY PE");
});

test("settle: info checks never caution", () => {
  const r = core.res("orb_break", "TRIGGERED", "WAIT", { side: "long" });
  core.settle(r, {}, [{ ok: false, info: true, text: "just information" }]);
  assert.equal(r.action, "BUY CE");
  assert.deepEqual(r.cautions, []);
});

// ---------------------------------------------------------------- ORB through analyse()
const CLEAN = [...PRIOR, bar("2026-10-26", 555, 100, 101, 99, 100), bar("2026-10-26", 560, 100, 100.8, 99.2, 100), bar("2026-10-26", 565, 100, 100.8, 99.2, 100), bar("2026-10-26", 570, 101.7, 102.5, 101.6, 102.2)];

test("a clean ORB trigger is listed with no cautions", () => {
  const c = row(run(CLEAN, 102.2, 576, "2026-10-26"), "orb_break");
  assert.equal(c.action, "BUY CE");
  assert.deepEqual(c.cautions, []);
});

test("expiry day: listed with a caution by default, NO TRADE when strict", () => {
  const live = row(run(CLEAN, 102.2, 576, "2026-10-26", { expiry: { NIFTY: true } }), "orb_break");
  assert.equal(live.action, "BUY CE");
  assert.ok(live.cautions.some((c) => /Expiry day/.test(c)), live.cautions.join("|"));
  const strict = row(run(CLEAN, 102.2, 576, "2026-10-26", { expiry: { NIFTY: true }, strict: true }), "orb_break");
  assert.equal(strict.action, "NO TRADE");
});

// Opening range 96-104 is 4x the typical 2% width: outside the 0.5x-3x band.
const WIDE = [
  ...PRIOR,
  bar("2026-10-26", 555, 100, 104, 96, 100),
  bar("2026-10-26", 560, 100, 103, 97, 100),
  bar("2026-10-26", 565, 100, 103, 97, 100),
  bar("2026-10-26", 570, 105, 106.5, 105.5, 106),
];

test("ORB size band: an out-of-band range is a caution by default and blocks (blockedBy size) when strict", () => {
  const live = row(run(WIDE, 106, 576, "2026-10-26"), "orb_break");
  assert.equal(live.action, "BUY CE");
  assert.equal(live.blockedBy, null);
  assert.equal(live.sizeHint, "skip");
  assert.ok(live.cautions.some((c) => /typical width/.test(c)), live.cautions.join("|"));
  const strict = row(run(WIDE, 106, 576, "2026-10-26", { strict: true }), "orb_break");
  assert.equal(strict.action, "NO TRADE");
  assert.equal(strict.blockedBy, "size");
});

// Close above the top edge at 09:35, then below the bottom edge at 09:40: both edges have broken.
const CHOP = [
  ...PRIOR,
  bar("2026-10-26", 555, 100, 101, 99, 100),
  bar("2026-10-26", 560, 100, 100.8, 99.2, 100),
  bar("2026-10-26", 565, 100, 100.8, 99.2, 100),
  bar("2026-10-26", 570, 100.5, 101.8, 100.4, 101.5),
  bar("2026-10-26", 575, 98.9, 98.9, 98.3, 98.5),
];

test("both edges broken: strict stands aside; otherwise the edge that broke last is followed, with a caution", () => {
  const strict = row(run(CHOP, 98.5, 581, "2026-10-26", { strict: true }), "orb_break");
  assert.equal(strict.state, "CHOPPY: BOTH EDGES BROKEN");
  assert.equal(strict.action, "NO TRADE");

  const live = row(run(CHOP, 98.5, 581, "2026-10-26"), "orb_break");
  assert.equal(live.side, "short", "the later break (below the range) is the current direction");
  assert.equal(live.action, "BUY PE");
  assert.ok(live.cautions.some((c) => /Both edges/.test(c)), live.cautions.join("|"));
});

// ---------------------------------------------------------------- the replay must stay strict
test("the Backtest replay stays strict: an expiry-day trigger that the live list shows is not counted as a trade", () => {
  // 2026-10-27 is a Tuesday and not a listed holiday, so it is NIFTY's weekly expiry.
  const date = "2026-10-27";
  const bars = [...PRIOR, bar(date, 555, 100, 101, 99, 100), bar(date, 560, 100, 100.8, 99.2, 100), bar(date, 565, 100, 100.8, 99.2, 100), bar(date, 570, 101.7, 102.5, 101.6, 102.2), bar(date, 575, 102.2, 102.6, 102.0, 102.4)];
  const live = row(run(bars.slice(0, -1), 102.2, 576, date, { expiry: { NIFTY: true } }), "orb_break");
  assert.equal(live.action, "BUY CE", "the live list shows it");
  const replay = replayDay(ix, { p5: { bars, meta: {} }, p15: null, p1h: null }, date, null, {});
  assert.equal(replay.expiry, true);
  assert.equal(replay.signals.length, 0, "the strict replay does not take an expiry-day trade");
});

// ---------------------------------------------------------------- stock side: nothing is dropped
const stock = (sym, tier, agree, extra = {}) => ({ sym, rvol: 1, read: { trend: { side: "up", tier, agree, total: 6, helpers: 0, ...extra } } });

test("selectSignals lists weak reads too, ranked strong, moderate, then weak", () => {
  const rows = [
    stock("W1", "weak", 3),
    stock("S1", "strong", 5),
    stock("M1", "moderate", 4),
    stock("W2", "weak", 4),
    { sym: "MIXED", rvol: 2, read: { trend: { side: null, tier: "none", agree: 0, total: 6 } } },
    { sym: "NOREAD", rvol: 2, read: null },
  ];
  const { leaning, signals } = calls._internals.selectSignals(rows);
  assert.equal(leaning.length, 4);
  assert.deepEqual(signals.map((r) => r.sym), ["S1", "M1", "W2", "W1"]);
});

test("selectSignals breaks ties by agreeing checks, context helpers, then running volume", () => {
  const rows = [stock("LOWVOL", "moderate", 4, { helpers: 2 }), stock("HELP", "moderate", 4, { helpers: 3 }), stock("HIVOL", "moderate", 4, { helpers: 2 })];
  rows[0].rvol = 0.8;
  rows[2].rvol = 2.5;
  const { signals } = calls._internals.selectSignals(rows);
  assert.deepEqual(signals.map((r) => r.sym), ["HELP", "HIVOL", "LOWVOL"]);
  assert.deepEqual(calls._internals.selectSignals([]).signals, []);
  assert.deepEqual(calls._internals.selectSignals(null).signals, []);
});

// ---------------------------------------------------------------- invariant over synthetic sessions (all rules, with volume)
// For ANY market: a call is a strict BUY exactly when it is a listed BUY with no cautions. That is what "cautions
// capture precisely what strict mode blocks" means, and it covers the ORB, Ichimoku and VWAP rule paths.
const { lowerBound } = require("../lib/replay");

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function aggregate(bars, keyOf) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const key = b.d + "|" + keyOf(b);
    if (!cur || cur.key !== key) {
      cur = { key, t: b.t, d: b.d, mm: b.mm, o: b.o, hi: b.hi, lo: b.lo, cl: b.cl, vol: b.vol };
      out.push(cur);
    } else {
      cur.hi = Math.max(cur.hi, b.hi);
      cur.lo = Math.min(cur.lo, b.lo);
      cur.cl = b.cl;
      cur.vol += b.vol;
    }
  }
  return out.map(({ key, ...r }) => r);
}

function market(seed, dates) {
  const rnd = prng(seed);
  const b5 = [];
  let px = 24000;
  for (const date of dates) {
    const drift = (rnd() - 0.5) * 0.012; // +-0.6% over the day: trending days make breakouts and pullbacks
    px *= 1 + (rnd() - 0.5) * 0.004; // overnight gap
    for (let mm = 555; mm < 930; mm += 5) {
      const o = px;
      const cl = o * (1 + drift / 75 + (rnd() - 0.5) * 0.0014);
      const hi = Math.max(o, cl) * (1 + rnd() * 0.0006);
      const lo = Math.min(o, cl) * (1 - rnd() * 0.0006);
      b5.push({ t: stamp(date, mm), d: date, mm, o, hi, lo, cl, vol: Math.round(1000 * (0.5 + rnd() * (rnd() < 0.1 ? 6 : 1.5))) });
      px = cl;
    }
  }
  return { b5, b15: aggregate(b5, (b) => Math.floor((b.mm - 555) / 15)), b1h: aggregate(b5, (b) => Math.floor((b.mm - 555) / 60)) };
}

test("invariant: a strict BUY is exactly a listed BUY with no cautions (ORB, Ichimoku and VWAP paths, with volume)", () => {
  const dates = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19"];
  const tally = { steps: 0, strictBuy: 0, cautioned: 0, byStrategy: {} };
  for (let seed = 1; seed <= 12; seed++) {
    const { b5, b15, b1h } = market(seed, dates);
    for (const iso of dates.slice(2)) {
      const expiry = { NIFTY: core.isExpiryDay(ix, iso) };
      const first = b5.findIndex((b) => b.d === iso);
      for (let k = first; k < b5.length && b5[k].d === iso; k++) {
        const b = b5[k];
        if (b.mm < 570 || b.mm >= 870) continue;
        const nowSec = b.t + 300;
        const j15 = lowerBound(b15, nowSec);
        const j1h = lowerBound(b1h, nowSec);
        const view = { p5: { bars: b5.slice(Math.max(0, k + 1 - 374), k + 1), meta: {} }, p15: { bars: b15.slice(Math.max(0, j15 - 400), j15), meta: {} }, p1h: { bars: b1h.slice(Math.max(0, j1h - 600), j1h), meta: {} } };
        const base = { nowSec, todayISO: iso, marketOpen: true, expiry, vix: null, skipSwing: true, skipMaxPain: true };
        const strict = I.analyse(ix, view, { ...base, strict: true });
        const live = I.analyse(ix, view, { ...base, strict: false });
        assert.equal(strict.rows.length, live.rows.length);
        tally.steps++;
        for (let i = 0; i < live.rows.length; i++) {
          const s = strict.rows[i];
          const l = live.rows[i];
          assert.equal(s.strategy, l.strategy);
          const sBuy = /^BUY/.test(s.action);
          const lBuy = /^BUY/.test(l.action);
          const lClean = lBuy && l.cautions.length === 0;
          assert.equal(sBuy, lClean, `${iso} ${b.mm} ${l.strategy}: strict=${s.action}/${s.state} listed=${l.action}/${l.state} cautions=${JSON.stringify(l.cautions)}`);
          if (sBuy) {
            assert.equal(l.action, s.action);
            assert.equal(l.sl, s.sl);
            assert.equal(l.t1, s.t1);
          }
          if (lBuy && !lClean) tally.cautioned++;
          if (sBuy) tally.strictBuy++;
          if (lBuy) tally.byStrategy[l.strategy] = (tally.byStrategy[l.strategy] || 0) + 1;
        }
      }
    }
  }
  // Not vacuous: the run must have produced both clean strict calls and cautioned ones.
  assert.ok(tally.steps > 500, `steps ${tally.steps}`);
  assert.ok(tally.strictBuy > 0, "no strict BUY was produced; the generator needs tuning: " + JSON.stringify(tally));
  assert.ok(tally.cautioned > 0, "no cautioned call was produced; the generator needs tuning: " + JSON.stringify(tally));
});
