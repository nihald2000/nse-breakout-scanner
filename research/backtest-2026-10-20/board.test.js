"use strict";
// Tests for the research-only board replay and the literature-inspired rule definitions.
// They prove selection arithmetic; they do not claim an edge.

const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("./board");
const E = require("./engine");
const RS = require("./research_strategies");

function mk(sym, ind, side, pchg, turn, tier = 3, tm = 570, day = "2026-01-02") {
  return { sym, ind, side, pchg, turn, tier, agree: 4, helpers: 2, rvol: 2, j0: 1, d: day, tm };
}

test("sector % is turnover-weighted and a one-stock sector is not eligible", () => {
  const dec = [
    mk("A1", "Banks", 1, 1, 100),
    mk("A2", "Banks", 1, 3, 300),
    mk("B1", "Power", 1, 5, 100),
  ];
  const rows = B.sectorRowsForGroup(dec, [0, 1, 2]);
  const banks = rows.find((r) => r.sector === "Banks");
  const power = rows.find((r) => r.sector === "Power");
  assert.equal(banks.pct, 2.5);
  assert.equal(banks.n, 2);
  assert.equal(power.n, 1);
  assert.equal(power.pct, 5);
  B.annotateCurrentSectors(dec);
  assert.equal(dec[0].secEligible, true);
  assert.equal(dec[2].secEligible, false);
  assert.equal(dec[0].secRankAbs, 1); // |2.5| beats the ineligible one-stock sector
});

test("uncapped board lists every eligible strong/moderate row; row cap trims after the live sort", () => {
  const dec = [
    mk("A1", "Banks", 1, 2, 100),
    mk("A2", "Banks", 1, 1, 100),
    mk("B1", "Power", -1, -3, 100),
    mk("B2", "Power", -1, -1, 100),
  ];
  B.annotateCurrentSectors(dec);
  const all = B.boardEvents(dec, { sectorK: Infinity, rowCap: 0, maxPerSector: Infinity, maxSymbols: Infinity });
  assert.equal(all.evD.length, 4);
  const capped = B.boardEvents(dec, { sectorK: Infinity, rowCap: 2, maxPerSector: Infinity, maxSymbols: Infinity });
  assert.equal(capped.evD.length, 2);
  // Power is the hottest sector by absolute move, so both of its rows sort first.
  assert.deepEqual(capped.evS, [1, 1]);
});

test("sector cap and side alignment filter rows independently", () => {
  const dec = [
    mk("A1", "Banks", 1, 2, 100),
    mk("A2", "Banks", 1, 1, 100),
    mk("B1", "Power", 1, -3, 100), // counter-sector CE read inside a down sector
    mk("B2", "Power", -1, -1, 100),
  ];
  B.annotateCurrentSectors(dec);
  const one = B.boardEvents(dec, { sectorK: 1, rowCap: 0, maxPerSector: Infinity, maxSymbols: Infinity });
  assert.equal(one.evD.length, 2);
  assert.deepEqual(one.evS, [0, 1]); // B1 counter-sector CE + B2 PE; both listed without alignment
  const aligned = B.boardEvents(dec, { sectorK: 1, rowCap: 0, maxPerSector: Infinity, maxSymbols: Infinity, align: true });
  assert.equal(aligned.evD.length, 1);
  assert.deepEqual(aligned.evS, [1]); // only B2 is on the down-sector side
});

test("API scan caps are applied before row selection and the uncapped run removes them", () => {
  const dec = [
    mk("A1", "Banks", 1, 2, 100),
    mk("A2", "Banks", 1, 1, 100),
    mk("B1", "Power", -1, -3, 100),
    mk("B2", "Power", -1, -1, 100),
  ];
  B.annotateCurrentSectors(dec);
  const order = new Map([["A1", 0], ["A2", 1], ["B1", 2], ["B2", 3]]);
  const capped = B.boardEvents(dec, { sectorK: 1, rowCap: 0, maxPerSector: 1, maxSymbols: 1 }, order);
  assert.equal(capped.evD.length, 1);
  const uncapped = B.boardEvents(dec, { sectorK: 1, rowCap: 0, maxPerSector: Infinity, maxSymbols: Infinity }, order);
  assert.equal(uncapped.evD.length, 2);
});

test("sector-first row order puts the hottest sector ahead of a stronger tier elsewhere", () => {
  const dec = [
    mk("A1", "Banks", 1, 2, 100, 3),
    mk("A2", "Banks", 1, 1, 100, 2),
    mk("B1", "Power", -1, -3, 100, 2),
    mk("B2", "Power", -1, -2, 100, 2),
  ];
  B.annotateCurrentSectors(dec);
  const byTier = B.boardEvents(dec, { sectorK: Infinity, rowCap: 1, maxPerSector: Infinity, maxSymbols: Infinity });
  assert.deepEqual(byTier.evS, [0]); // Banks A1 has tier 3
  const bySector = B.boardEvents(dec, { sectorK: Infinity, rowCap: 1, maxPerSector: Infinity, maxSymbols: Infinity, sortMode: "sector" });
  assert.deepEqual(bySector.evS, [1]); // Power is the hottest sector by |%|
});

test("prior-session sector momentum uses only daily bars before the decision date", () => {
  const bars = [
    { d: "2026-01-01", cl: 100, vol: 10 },
    { d: "2026-01-02", cl: 110, vol: 10 },
    { d: "2026-01-03", cl: 121, vol: 10 },
  ];
  const ds = {
    stocks: [
      { sym: "A1", industry: "Banks", bd: bars },
      { sym: "A2", industry: "Banks", bd: bars },
    ],
    meta: { universe: [{ sym: "A1" }, { sym: "A2" }] },
  };
  const dec = [
    { sym: "A1", ind: "Banks", d: "2026-01-03", tm: 570 },
    { sym: "A2", ind: "Banks", d: "2026-01-03", tm: 570 },
  ];
  const hist = B.precomputeSectorDaily(dec, ds);
  B.annotateSectorHistory(dec, hist);
  assert.equal(Math.round(dec[0].secRet1 * 1e9) / 1e9, 10);
  assert.equal(dec[0].secRank1Up, 1);
  assert.equal(dec[0].secRank1Down, 1);
  assert.equal(dec[0].secHistoryN, 2);
});

test("ORB, VWAP and mean-reversion rules are fixed and directional", () => {
  const strat = (id) => RS.buildResearchStrategies().find((s) => s.id === id);
  const orb = strat("ORB5");
  assert.equal(orb.side({ or5Hi: 100, or5Lo: 90, or5Dir: 1, px: 101 }), 1);
  assert.equal(orb.side({ or5Hi: 100, or5Lo: 90, or5Dir: -1, px: 89 }), -1);
  assert.equal(orb.side({ or5Hi: 100, or5Lo: 90, or5Dir: 1, px: 95 }), 0);
  const orbR = strat("ORB5_RVOL");
  assert.equal(orbR.side({ or5Hi: 100, or5Lo: 90, or5Dir: 1, px: 101, openRvol: 2 }), 1);
  assert.equal(orbR.side({ or5Hi: 100, or5Lo: 90, or5Dir: 1, px: 101, openRvol: 1 }), 0);
  const vw = strat("VWAP_TREND");
  assert.equal(vw.side({ slot: [1, 1] }), 1);
  assert.equal(vw.side({ slot: [-1, -1] }), -1);
  assert.equal(vw.side({ slot: [1, -1] }), 0);
  const mr = strat("MEANREV_45M");
  assert.equal(mr.side({ ret3: 1.2 }), -1);
  assert.equal(mr.side({ ret3: -1.2 }), 1);
  assert.equal(mr.side({ ret3: 0.2 }), 0);
});

test("first-traded-bar RVOL skips Yahoo's zero-volume 09:15 print", () => {
  const bars = [];
  const starts = [];
  const ends = [];
  for (let d = 0; d < 7; d++) {
    starts.push(bars.length);
    bars.push({ d: "d" + d, mm: 555, o: 100, hi: 101, lo: 99, cl: 100, vol: 0 });
    bars.push({ d: "d" + d, mm: 560, o: 100, hi: 101, lo: 99, cl: 100, vol: d === 6 ? 200 : 100 });
    ends.push(bars.length - 1);
  }
  const st = { b5: bars, idx5: { starts, ends } };
  assert.equal(E.openRvolAt(st, 6), 2);
});
