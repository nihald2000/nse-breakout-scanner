"use strict";
// run_research2.js - the second research pass:
//   (1) replay the Live Calls selection layer with each cap removed, one at a time;
//   (2) test data-compatible hypotheses from the intraday/industry-momentum literature.
//
// Offline only. Reads the cached data directory, writes only under --out, and does not touch
// lib/ or api/. Decisions use closed 5m/15m bars and the same outcome engine as run_backtest.js.

const fs = require("fs");
const path = require("path");
const E = require("./engine");
const A = require("./analysis");
const S = require("./stats");
const B = require("./board");
const RS = require("./research_strategies");
const O5 = require("./orb5m");
const { loadDataset } = require("./loader");
const { NC, BARRIERS, HORIZONS, ENTRIES, cParts, cIndex, RES } = E;

const ALL_FIXES = { or: true, vol: true, range: true, vwap: true };
const P1 = cIndex(0, 1, 1); // 0.5/0.5, 90m, next-5m-open
const P2 = cIndex(3, 1, 1); // 1.0/1.0, 90m, next-5m-open

const cfgName = (c) => {
  const { b, h, e } = cParts(c);
  return `${BARRIERS[b].id}; ${HORIZONS[h]} bars (${HORIZONS[h] * 15}m); entry ${ENTRIES[e] === "close" ? "bar close" : "next 5m open"}`;
};

const BOARD_VARIANTS = [
  { id: "BOARD_LIVE_DEFAULT", label: "Current default: 6 sectors, API scan caps, 20 rows", cfg: { sectorK: 6, maxPerSector: 40, maxSymbols: 100, rowCap: 20, align: false, mode: "abs" } },
  { id: "BOARD_LIVE_8", label: "8-sector maximum, API scan caps, 20 rows", cfg: { sectorK: 8, maxPerSector: 40, maxSymbols: 100, rowCap: 20, align: false, mode: "abs" } },
  { id: "BOARD_NO_ROW_CAP", label: "8 sectors, API scan caps, every row (no 20-row cap)", cfg: { sectorK: 8, maxPerSector: 40, maxSymbols: 100, rowCap: 0, align: false, mode: "abs" } },
  { id: "BOARD_NO_SECTOR_CAP", label: "Every eligible sector, no scan caps, 20 rows", cfg: { sectorK: Infinity, maxPerSector: Infinity, maxSymbols: Infinity, rowCap: 20, align: false, mode: "abs" } },
  { id: "BOARD_UNCAPPED", label: "Every eligible sector, every strong/moderate row, no caps", cfg: { sectorK: Infinity, maxPerSector: Infinity, maxSymbols: Infinity, rowCap: 0, align: false, mode: "abs" } },
  { id: "BOARD_UNCAPPED_ALIGNED", label: "No caps, CE only in up sectors / PE only in down sectors", cfg: { sectorK: Infinity, maxPerSector: Infinity, maxSymbols: Infinity, rowCap: 0, align: true, mode: "abs" } },
  { id: "BOARD_TOP8_ALIGNED", label: "8 sectors, API scan caps, no row cap, sector-side aligned", cfg: { sectorK: 8, maxPerSector: 40, maxSymbols: 100, rowCap: 0, align: true, mode: "abs" } },
  { id: "BOARD_TOPBOTTOM3", label: "Top 3 up + bottom 3 down sectors, no row cap, aligned", cfg: { sectorK: 6, upK: 3, downK: 3, maxPerSector: 40, maxSymbols: 100, rowCap: 0, align: true, mode: "updown" } },
  { id: "BOARD_SECTOR_FIRST", label: "Every sector, no caps, rows ordered by sector hotness first", cfg: { sectorK: Infinity, maxPerSector: Infinity, maxSymbols: Infinity, rowCap: 0, align: false, mode: "abs", sortMode: "sector" } },
  { id: "BOARD_SECTOR_FIRST_ALIGNED", label: "Every sector, no caps, sector-first order, CE/PE aligned to sector side", cfg: { sectorK: Infinity, maxPerSector: Infinity, maxSymbols: Infinity, rowCap: 0, align: true, mode: "abs", sortMode: "sector" } },
  { id: "BOARD_SECTOR_FIRST_20", label: "Every sector, no scan caps, sector-first order, 20 rows", cfg: { sectorK: Infinity, maxPerSector: Infinity, maxSymbols: Infinity, rowCap: 20, align: false, mode: "abs", sortMode: "sector" } },
];

function f1(v) { return v == null ? "–" : (Math.round(v * 10) / 10).toFixed(1); }
function f2(v) { return v == null ? "–" : (Math.round(v * 100) / 100).toFixed(2); }
function fp(v) { return v == null ? "–" : v < 0.001 ? "<0.001" : v.toFixed(3); }
function esc(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function md(head, rows) {
  const L = ["| " + head.join(" | ") + " |", "|" + head.map(() => "---").join("|") + "|"];
  for (const r of rows) L.push("| " + r.join(" | ") + " |");
  return L.join("\n");
}
function cellRow(label, s) {
  return [
    label,
    `${s.n}/${s.dec}`,
    s.dec >= A.MIN_DEC ? f1(s.hit * 100) : "insufficient n",
    s.breakEven == null ? "–" : f1(s.breakEven * 100),
    `${f2(s.netExp)} (${f2(s.netLo)} to ${f2(s.netHi)})`,
    fp(s.netP1),
  ];
}
function strip(s) {
  return {
    n: s.n, dec: s.dec, tgt: s.tgt, stp: s.stp, both: s.both, tmo: s.tmo, opn: s.opn,
    hit: s.hit, clLo: s.clLo, clHi: s.clHi, breakEven: s.breakEven,
    grossExp: s.grossExp, netExp: s.netExp, netLo: s.netLo, netHi: s.netHi,
    netT: s.netT, netP1: s.netP1, avgStop: s.avgStop, days: s.days,
  };
}

// The paper's exit is "hold to the close, stop at 1 ATR, no target". The main grid cannot
// express that (it only has 45/90/180m barriers), so this is a separate, explicitly-labelled test.
// Entry is the next 5m open; stop is 1 ATR from d.atrPct; exit is the last closed 5m bar of the day.
function closeExitStats(dec, stockBySym, evD, evS, dayOrd, nDays, d0, d1, cost) {
  const perDay = Array.from({ length: nDays }, () => ({ s: 0, n: 0 }));
  let n = 0;
  let stopped = 0;
  let missing = 0;
  const rt = 2 * cost;
  for (let q = 0; q < evD.length; q++) {
    const d = dec[evD[q]];
    if (!d || d.j0 < 0 || d.side === 0 || !(d.atrPct > 0)) { missing++; continue; }
    const day = dayOrd[evD[q]];
    if (day < d0 || day >= d1) continue;
    const st = stockBySym.get(d.sym);
    if (!st) { missing++; continue; }
    const bars = st.b5;
    const entry = bars[d.j0] && bars[d.j0].o;
    const atr = entry > 0 ? (entry * d.atrPct) / 100 : 0;
    if (!(entry > 0) || !(atr > 0)) { missing++; continue; }
    const stop = d.side > 0 ? entry - atr : entry + atr;
    let exit = null;
    for (let j = d.j0; j <= d.end5 && j < bars.length; j++) {
      const b = bars[j];
      if (d.side > 0 && b.lo <= stop) { exit = stop; stopped++; break; }
      if (d.side < 0 && b.hi >= stop) { exit = stop; stopped++; break; }
    }
    if (exit == null) {
      const last = bars[Math.min(d.end5, bars.length - 1)];
      exit = last && last.cl;
    }
    if (!(exit > 0)) { missing++; continue; }
    const gross = d.side > 0 ? (exit / entry - 1) * 100 : (1 - exit / entry) * 100;
    const net = gross - rt;
    perDay[day].s += net;
    perDay[day].n++;
    n++;
  }
  const cl = A.clusterFast(perDay.slice(d0, d1));
  return {
    n, dec: n, days: cl.G, netExp: cl.mean, netLo: cl.ci[0], netHi: cl.ci[1], netP1: cl.p1,
    stopRate: n > 0 ? stopped / n : null, missing, perDay,
  };
}

function top20ByDay(dec) {
  const byDay = new Map();
  for (const d of dec) {
    if (d.openRvol == null) continue;
    let m = byDay.get(d.d);
    if (!m) byDay.set(d.d, (m = new Map()));
    const prev = m.get(d.sym);
    if (prev == null || d.openRvol > prev) m.set(d.sym, d.openRvol);
  }
  const out = new Map();
  for (const [day, m] of byDay) {
    const top = [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([sym]) => sym);
    out.set(day, new Set(top));
  }
  return out;
}

function filterEvents(dec, ev, keep) {
  const evD = [];
  const evS = [];
  for (let q = 0; q < ev.evD.length; q++) {
    if (keep(dec[ev.evD[q]])) {
      evD.push(ev.evD[q]);
      evS.push(ev.evS[q]);
    }
  }
  return { evD, evS };
}

// ORB papers take at most one trade per stock per day (first breakout). The scanner's
// side-run selector would otherwise re-enter after a failed breakout, which is not the
// tested rule and would inflate the event count.
function firstPerDay(dec, ev) {
  const seen = new Set();
  const evD = [];
  const evS = [];
  for (let q = 0; q < ev.evD.length; q++) {
    const d = dec[ev.evD[q]];
    const key = d.sym + "|" + d.d;
    if (seen.has(key)) continue;
    seen.add(key);
    evD.push(ev.evD[q]);
    evS.push(ev.evS[q]);
  }
  return { evD, evS };
}

function run(opts) {
  const log = opts.log || (() => {});
  const fix = opts.fix === undefined ? ALL_FIXES : opts.fix;
  log(`loading ${opts.data}`);
  const ds = loadDataset(opts.data, { limit: opts.limit });
  log(`loaded ${ds.stocks.length} stocks, ${ds.missing.length} missing, ${ds.calendar.size} full sessions`);

  const dec = [];
  const skipped = {};
  for (const st of ds.stocks) {
    const r = E.buildDecisions(st, {
      calendar: ds.calendar, mode: opts.mode, minPriorExtended: 10,
      corp: ds.corp, mktTrend: ds.mktTrend, delivPrev: ds.delivPrev, fix,
    });
    for (const d of r.decisions) dec.push(d);
    for (const k of Object.keys(r.skipped)) skipped[k] = (skipped[k] || 0) + r.skipped[k];
  }
  const dates = [...new Set(dec.map((d) => d.d))].sort();
  const nDays = dates.length;
  const dayIdx = new Map(dates.map((d, i) => [d, i]));
  const dayOrd = new Int32Array(dec.length);
  dec.forEach((d, i) => (dayOrd[i] = dayIdx.get(d.d)));
  const split = Math.floor(nDays / 2);
  log(`${dec.length} decisions on ${nDays} sessions (${dates[0]} .. ${dates[nDays - 1]}); split ${split}/${nDays - split}`);

  const cur = B.annotateCurrentSectors(dec);
  const hist = B.precomputeSectorDaily(dec, ds);
  B.annotateSectorHistory(dec, hist);
  log(`sector cross-sections: ${cur.groups}; eligible sector-times: ${cur.eligibleSectorTimes}; daily sector dates: ${hist.size}`);

  const O = E.computeOutcomes(dec, ds.stockBySym);
  log(`outcomes computed (${dec.length} x 2 sides x ${NC} configurations)`);

  const allCs = Array.from({ length: NC }, (_, i) => i);
  const symOrder = B.boardSymOrder(ds);
  const grid = [];
  const strategies = RS.buildResearchStrategies();
  const events = new Map();

  const addGrid = (kind, id, group, label, ev, extra) => {
    const agg = A.aggregate(O, dayOrd, nDays, ev.evD, ev.evS, allCs);
    for (let c = 0; c < NC; c++) {
      grid.push(Object.assign({
        kind, id, group, label, c,
        disc: A.cellStats(agg, c, 0, split, opts.cost),
        val: A.cellStats(agg, c, split, nDays, opts.cost),
        all: A.cellStats(agg, c, 0, nDays, opts.cost),
      }, extra || {}));
    }
    return { agg, ev };
  };

  for (const st of strategies) {
    let ev = A.selectEvents(dec, st, "run");
    if (st.group === "orb") ev = firstPerDay(dec, ev);
    events.set(st.id, ev);
    addGrid("strategy", st.id, st.group, st.label, ev, { meta: { events: ev.evD.length } });
  }
  for (const v of BOARD_VARIANTS) {
    const ev = B.boardEvents(dec, v.cfg, symOrder);
    events.set(v.id, ev);
    addGrid("board", v.id, "board", v.label, ev, { boardCfg: v.cfg, meta: ev.meta });
  }
  log(`grid done: ${grid.length} cells (${strategies.length} strategies + ${BOARD_VARIANTS.length} board variants) x ${NC} configurations`);

  // Hold-to-close ORB: the paper's exit. Not part of the 45/90/180m grid.
  const top20 = top20ByDay(dec);
  const keepTop20 = (d) => top20.has(d.d) && top20.get(d.d).has(d.sym);
  const smFirst = firstPerDay(dec, events.get("SM_REF"));
  const closeRules = [
    { id: "ORB5_CLOSE", label: "ORB5, 1 ATR stop, hold to close" },
    { id: "ORB15_CLOSE", label: "ORB15, 1 ATR stop, hold to close" },
    { id: "ORB5_RVOL_CLOSE", label: "ORB5 + RVOL≥1.5, 1 ATR stop, hold to close" },
    { id: "ORB15_RVOL_CLOSE", label: "ORB15 + RVOL≥1.5, 1 ATR stop, hold to close" },
    { id: "ORB5_TOP20_CLOSE", label: "ORB5, top 20 by first traded-5m RVOL, 1 ATR stop, hold to close" },
    { id: "ORB15_TOP20_CLOSE", label: "ORB15, top 20 by first traded-5m RVOL, 1 ATR stop, hold to close" },
    { id: "SM_REF_CLOSE", label: "Strong+moderate reference, 1 ATR stop, hold to close" },
  ];
  const closeResults = closeRules.map((r) => {
    let ev;
    if (r.id === "SM_REF_CLOSE") ev = smFirst;
    else if (r.id === "ORB5_TOP20_CLOSE") ev = filterEvents(dec, events.get("ORB5"), keepTop20);
    else if (r.id === "ORB15_TOP20_CLOSE") ev = filterEvents(dec, events.get("ORB15"), keepTop20);
    else ev = events.get(r.id.replace(/_CLOSE$/, ""));
    if (!ev) throw new Error(`missing events for ${r.id}`);
    const val = closeExitStats(dec, ds.stockBySym, ev.evD, ev.evS, dayOrd, nDays, split, nDays, opts.cost);
    const all = closeExitStats(dec, ds.stockBySym, ev.evD, ev.evS, dayOrd, nDays, 0, nDays, opts.cost);
    return { id: r.id, label: r.label, events: ev.evD.length, val, all };
  });
  const o5all = O5.orb5mStats(ds, dec, { cost: opts.cost, split, nDays, top20Only: false });
  const o5top = O5.orb5mStats(ds, dec, { cost: opts.cost, split, nDays, top20Only: true });
  const o5traded = O5.orb5mStats(ds, dec, { cost: opts.cost, split, nDays, top20Only: false, firstTraded: true });
  const o5tradedTop = O5.orb5mStats(ds, dec, { cost: opts.cost, split, nDays, top20Only: true, firstTraded: true });
  closeResults.push({ id: "ORB5M_CLOSE", label: "5m ORB (09:15 bar), close breakout, 1 ATR(5m) stop, hold to close", events: o5all.events, val: o5all.val, all: o5all.all });
  closeResults.push({ id: "ORB5M_TOP20_CLOSE", label: "5m ORB (09:15 bar), top 20 by first traded-5m RVOL, 1 ATR(5m) stop, hold to close", events: o5top.events, val: o5top.val, all: o5top.all });
  closeResults.push({ id: "ORB5MT_CLOSE", label: "5m ORB (first traded bar), close breakout, 1 ATR(5m) stop, hold to close", events: o5traded.events, val: o5traded.val, all: o5traded.all });
  closeResults.push({ id: "ORB5MT_TOP20_CLOSE", label: "5m ORB (first traded bar), top 20 by RVOL, 1 ATR(5m) stop, hold to close", events: o5tradedTop.events, val: o5tradedTop.val, all: o5tradedTop.all });
  const closeVal = closeResults.filter((r) => r.val.n >= A.MIN_DEC && r.val.netP1 != null);
  const closeQ = S.bhAdjust(closeVal.map((r) => r.val.netP1));
  closeVal.forEach((r, i) => (r.val.q = closeQ[i]));
  const closeNomPos = closeVal.filter((r) => r.val.netExp > 0 && r.val.netP1 < 0.05);
  const closeBhPos = closeVal.filter((r) => r.val.netExp > 0 && r.val.q != null && r.val.q < 0.1);
  log(`hold-to-close tests: ${closeResults.length} rules; ${closeVal.length} with n>=${A.MIN_DEC}; nominal positive ${closeNomPos.length}; BH positive ${closeBhPos.length}`);

  const valEligible = grid.filter((g) => g.val.dec >= A.MIN_DEC && g.val.netP1 != null);
  const q = S.bhAdjust(valEligible.map((g) => g.val.netP1));
  valEligible.forEach((g, i) => (g.q = q[i]));
  const nomPos = valEligible.filter((g) => g.val.netExp > 0 && g.val.netP1 < 0.05);
  const bhPos = valEligible.filter((g) => g.val.netExp > 0 && g.q != null && g.q < 0.1);
  const grossPos = valEligible.filter((g) => g.val.grossExp > 0 && g.val.grossP1 != null && g.val.grossP1 < 0.05);

  const byId = (id) => grid.filter((g) => g.id === id);
  const at = (id, c) => grid.find((g) => g.id === id && g.c === c);

  const boardP1 = BOARD_VARIANTS.map((v) => ({ v, g: at(v.id, P1) }));
  const boardP2 = BOARD_VARIANTS.map((v) => ({ v, g: at(v.id, P2) }));
  const stratP1 = strategies.map((s) => ({ s, g: at(s.id, P1) }));
  const stratP2 = strategies.map((s) => ({ s, g: at(s.id, P2) }));

  const bestVal = grid.filter((g) => g.val.dec >= A.MIN_DEC).slice().sort((a, b) => (b.val.netExp || -9) - (a.val.netExp || -9)).slice(0, 15);
  const bestBoard = boardP1.filter((x) => x.g && x.g.val.dec >= A.MIN_DEC).slice().sort((a, b) => (b.g.val.netExp || -9) - (a.g.val.netExp || -9))[0] || null;

  const headline = {
    sessions: nDays,
    first: dates[0],
    last: dates[nDays - 1],
    split,
    decisions: dec.length,
    cells: grid.length,
    validationEligible: valEligible.length,
    nominalPositive: nomPos.length,
    bhPositive: bhPos.length,
    grossPositive: grossPos.length,
    expectedByChanceNominal: Math.round(valEligible.length * 0.05),
    closeRules: closeResults.length,
    closeValidationEligible: closeVal.length,
    closeNominalPositive: closeNomPos.length,
    closeBhPositive: closeBhPos.length,
    bestBoardP1: bestBoard ? { id: bestBoard.v.id, dec: bestBoard.g.val.dec, hit: bestBoard.g.val.hit, netExp: bestBoard.g.val.netExp, netP1: bestBoard.g.val.netP1 } : null,
    verdict: bhPos.length || closeBhPos.length ? "candidate lead (hypothesis only)" : nomPos.length || closeNomPos.length ? "nominal only; no multiple-comparison survivor" : "no edge in this sample",
  };

  const report = makeReport({ opts, ds, dec, dates, nDays, split, skipped, grid, strategies, boardP1, boardP2, stratP1, stratP2, valEligible, nomPos, bhPos, grossPos, bestVal, headline, cur, hist, fix, closeResults, closeVal, closeNomPos, closeBhPos });
  fs.mkdirSync(opts.out, { recursive: true });
  fs.writeFileSync(path.join(opts.out, "research2_report.md"), report);
  fs.writeFileSync(path.join(opts.out, "research2_results.json"), JSON.stringify({
    meta: {
      runAt: new Date().toISOString(), data: path.resolve(opts.data), snapshotDate: ds.meta.snapshotDate,
      mode: opts.mode, costPerSidePct: opts.cost, fix, sessions: { evaluated: nDays, first: dates[0], last: dates[nDays - 1], split },
      decisions: dec.length, stocks: { loaded: ds.stocks.length, missing: ds.missing.length }, skipped,
      cells: grid.length, sectorCrossSections: cur.groups, eligibleSectorTimes: cur.eligibleSectorTimes,
    },
    headline,
    board: { p1: boardP1.map((x) => ({ id: x.v.id, label: x.v.label, cfg: x.v.cfg, meta: x.g.meta, val: strip(x.g.val), all: strip(x.g.all), disc: strip(x.g.disc) })), p2: boardP2.map((x) => ({ id: x.v.id, label: x.v.label, cfg: x.v.cfg, meta: x.g.meta, val: strip(x.g.val), all: strip(x.g.all), disc: strip(x.g.disc) })) },
    strategies: { p1: stratP1.map((x) => ({ id: x.s.id, group: x.s.group, label: x.s.label, meta: x.g.meta, val: strip(x.g.val), all: strip(x.g.all), disc: strip(x.g.disc) })), p2: stratP2.map((x) => ({ id: x.s.id, group: x.s.group, label: x.s.label, meta: x.g.meta, val: strip(x.g.val), all: strip(x.g.all), disc: strip(x.g.disc) })) },
    closeExit: {
      rules: closeResults.map((r) => ({ id: r.id, label: r.label, events: r.events, val: { n: r.val.n, days: r.val.days, netExp: r.val.netExp, netLo: r.val.netLo, netHi: r.val.netHi, netP1: r.val.netP1, stopRate: r.val.stopRate, q: r.val.q == null ? null : r.val.q }, all: { n: r.all.n, days: r.all.days, netExp: r.all.netExp, netLo: r.all.netLo, netHi: r.all.netHi, netP1: r.all.netP1, stopRate: r.all.stopRate } })),
      validationEligible: closeVal.length, nominalPositive: closeNomPos.length, bhPositive: closeBhPos.length,
    },
    multipleComparisons: { validationEligible: valEligible.length, nominalPositive: nomPos.map((g) => ({ id: g.id, config: cfgName(g.c), netExp: g.val.netExp, p: g.val.netP1 })), bhPositive: bhPos.map((g) => ({ id: g.id, config: cfgName(g.c), netExp: g.val.netExp, q: g.q })), grossPositive: grossPos.length, expectedByChanceNominal: headline.expectedByChanceNominal, closeValidationEligible: closeVal.length, closeNominalPositive: closeNomPos.map((r) => ({ id: r.id, netExp: r.val.netExp, p: r.val.netP1 })), closeBhPositive: closeBhPos.map((r) => ({ id: r.id, netExp: r.val.netExp, q: r.val.q })) },
    bestValidation: bestVal.map((g) => ({ id: g.id, kind: g.kind, config: cfgName(g.c), dec: g.val.dec, hit: g.val.hit, netExp: g.val.netExp, netLo: g.val.netLo, netHi: g.val.netHi, p: g.val.netP1, q: g.q == null ? null : g.q })),
  }, null, 1));

  const head = ["kind", "id", "config", "window", "events", "decidable", "hit", "break_even", "net_exp_pct", "net_lo", "net_hi", "net_p", "q"];
  const lines = [head.join(",")];
  for (const g of grid) {
    for (const [w, s] of [["discovery", g.disc], ["validation", g.val], ["all", g.all]]) {
      lines.push([g.kind, g.id, cfgName(g.c), w, g.meta ? g.meta.events : "", s.dec, s.hit, s.breakEven, s.netExp, s.netLo, s.netHi, s.netP1, g.q == null ? "" : g.q].map(esc).join(","));
    }
  }
  fs.writeFileSync(path.join(opts.out, "research2_grid.csv"), lines.join("\n"));
  const closeLines = ["id,window,events,days,net_exp_pct,net_lo,net_hi,stop_rate,p,q"];
  for (const r of closeResults) {
    for (const [w, s] of [["validation", r.val], ["all", r.all]]) {
      closeLines.push([r.id, w, r.events, s.n, s.days, s.netExp, s.netLo, s.netHi, s.stopRate, s.netP1, s.q == null ? "" : s.q].map(esc).join(","));
    }
  }
  fs.writeFileSync(path.join(opts.out, "research2_close.csv"), closeLines.join("\n"));
  fs.writeFileSync(path.join(opts.out, "research2_command.txt"), opts.command || "");
  log(`wrote ${opts.out}`);
  return { headline, grid, boardP1, boardP2, stratP1, stratP2, closeResults };
}

function makeReport(R) {
  const { opts, ds, dec, dates, nDays, split, skipped, grid, strategies, boardP1, boardP2, stratP1, stratP2, valEligible, nomPos, bhPos, grossPos, bestVal, headline, cur, fix, closeResults, closeVal, closeNomPos, closeBhPos } = R;
  const L = [];
  const P = (s = "") => L.push(s);

  P("# Research pass 2: uncapped sector board + literature-inspired tests");
  P();
  P(`Data snapshot: **${ds.meta.snapshotDate}** | run: ${new Date().toISOString()} | mode: \`${opts.mode}\` | cost: **${opts.cost}% per side on the underlying** (${(2 * opts.cost).toFixed(2)}% round trip). Option premium, spread, IV, theta and liquidity are **not** modeled.`);
  P(`Fixes used: **${Object.keys(fix).filter((k) => fix[k]).join(" + ") || "none"}**. The live \`lib/\` and \`api/\` code was not changed.`);
  P();
  P("## 1. Answer first");
  P();
  const anyNom = nomPos.length || closeNomPos.length;
  const anyBh = bhPos.length || closeBhPos.length;
  if (!anyNom) {
    P("**No tested board or literature-inspired rule produced a net-positive validation cell at nominal p<0.05.** Removing the 20-row cap or the sector cap did not create an edge in this sample, and the separate hold-to-close ORB test did not either. The honest conclusion is still no edge, not a hidden profitable configuration.");
  } else if (!anyBh) {
    P(`**${nomPos.length} grid cells and ${closeNomPos.length} hold-to-close ORB cells were nominally net-positive at p<0.05, but none survived the multiple-comparison correction (BH q<0.10).** About ${headline.expectedByChanceNominal} nominal hits are expected from noise alone. Treat them as hypotheses, not leads.`);
  } else {
    P(`**${bhPos.length} grid cells and ${closeBhPos.length} hold-to-close ORB cells survived the multiple-comparison correction (BH q<0.10).** This is a candidate hypothesis only: it has not been tested on a third, fresh sample and it is still an underlying-only result.`);
  }
  P();
  P(`- Sessions: **${nDays}** (${dates[0]} to ${dates[nDays - 1]}); discovery = first ${split}, validation = last ${nDays - split}. Signals in one session share the market move, so the effective sample is ~${nDays} days, not ${dec.length} independent trades.`);
  P(`- Decisions: **${dec.length}**. Cells tested: **${grid.length}** (${strategies.length} per-decision rules + ${boardP1.length} board variants, each on ${NC} barrier/horizon/entry settings). Validation cells with enough decidable signals: **${valEligible.length}**.`);
  P(`- Nominal net-positive validation cells: **${nomPos.length}** (about ${headline.expectedByChanceNominal} expected by chance). BH q<0.10: **${bhPos.length}**. Gross-positive before costs at p<0.05: **${grossPos.length}**.`);
  P(`- Hold-to-close ORB: **${closeResults.length}** rules; **${closeVal.length}** with n>=${A.MIN_DEC}; nominal net-positive **${closeNomPos.length}**; BH q<0.10 **${closeBhPos.length}**.`);
  P(`- Board cross-sections: **${cur.groups}**; eligible sector-times (2+ stocks): **${cur.eligibleSectorTimes}**.`);
  P();
  P("**Data correction:** the cached bhavcopy repeats the previous row for the two sessions missing from Yahoo (2026-09-14 and 2026-10-02). The first pass treated those duplicates as corporate actions for almost every symbol and silently dropped most decisions for the following month. `loader.js` now compares only NSE dates that are also full Yahoo sessions; corporate-action flags are **0**, and the corrected sample is **197,928** decisions. All tables below are from the corrected run.");
  P();

  P("## 2. What the literature actually supports");
  P();
  P("I only used sources with a real sample, explicit rules and a cost discussion. \"Heavily backtested\" does **not** mean transferable: most of the strong evidence is US equities/ETFs, and the one NSE ORB paper is a single stock for one year with statistically insignificant results.");
  P();
  P(md(["Source", "What was tested", "Reported result", "Why it does / does not fit this scanner"], [
    ["Zarattini, Barbon & Aziz (2024), *A Profitable Day Trading Strategy for the U.S. Equity Market*, SSRN 4729284", "7,000 US stocks, 2016–2023; 5-minute opening range; top 20 stocks by first-5m relative volume; 1 ATR stop; hold to close", "1,600%+ net, Sharpe 2.81, alpha 36% (authors)", "Closest strategy to test. But: US equities, 5m OR, top-20 selection, hold-to-close, 7,000-stock universe, no options. Our 213 F&O stocks, next-open entries and altered universe are an adaptation; we also run a closer 5m ORB test."],
    ["QuantConnect (2024), *Opening Range Breakout for Stocks in Play* (replication)", "1,000 liquid US stocks, 2016 only; 5m OR; top 20 relative volume; 1 ATR stop; hold to close", "2.4 Sharpe in 2016", "Independent replication of 2016, not 2016–2023. Community comments report poor other years, cost concerns and possible overfit. It is evidence that the rule is fragile, not a guarantee."],
    ["Gao, Han, Li & Zhou (2018), *Market Intraday Momentum*, JFE 129(2)", "US market index, 1993–2013; first half-hour return predicts last half-hour", "Significant intraday momentum", "Market-index, last-30-minute horizon. Our scanner is stock-level with 45–180m barriers; we do not have Nifty intraday bars in this cache. Not tested here."],
    ["Moskowitz & Grinblatt (1999), *Do Industries Explain Momentum?*, Journal of Finance", "US industries, 1963–1995; 6–12 month industry momentum", "Industry momentum explains much of stock momentum", "Supports **slow** sector momentum, not 15m sector rotation. Our 39 sessions cannot test the tested horizon; the 1-day/5-day sector overlay below is an adaptation, not a replication."],
    ["Zarattini & Aziz (2023), *Volume Weighted Average Price (VWAP): The Holy Grail for Day Trading Systems*, SSRN 4631351", "QQQ/TQQQ, 2018–2023; price above/below VWAP, trend rule", "671% net on QQQ, Sharpe 2.1, max DD 9.4%", "Single ETF, long sample, no broad cross-section. Our VWAP test is a component check, not a replication."],
    ["Wang & Gangwar (2025), *Optimizing Intraday Breakout Strategies on the NSE*, SSRN 5198458", "One NSE stock (Tata Motors), one year; 5/15/30m ORB with volume filters and block holding periods", "ORB beat buy-and-hold in raw returns, but p-values ~0.45–0.50; no statistical evidence", "Directly NSE, but one stock, one year, and the authors themselves call for stricter data coverage, transaction-cost modeling and significance testing. It is a warning: apparent ORB profits can be luck."],
  ]));
  P();
  P("**What this means for our scanner:** the evidence does not support the current six-check composite as a validated intraday edge, and it does not support 15-minute sector rotation. The strongest testable idea is ORB + relative volume. Sector momentum is a slower overlay; it should be tested as a filter, not sold as an intraday edge.");
  P();

  P("## 3. Exact rules tested");
  P();
  P("### Board selection variants");
  P();
  P(md(["Variant", "Sectors", "Row cap", "API scan caps", "Side alignment", "Row order"], boardP1.map(({ v }) => [
    v.id, v.cfg.sectorK === Infinity ? "all eligible" : String(v.cfg.sectorK), v.cfg.rowCap === 0 ? "none" : String(v.cfg.rowCap),
    Number.isFinite(v.cfg.maxSymbols) ? `${v.cfg.maxSymbols} symbols / ${v.cfg.maxPerSector} per sector` : "none",
    v.cfg.align ? "CE only in up sectors, PE only in down sectors" : "any strong/moderate side",
    v.cfg.sortMode === "sector" ? "sector hotness first" : "tier → agree → helpers → RVOL",
  ])));
  P();
  P("All board variants list only strong/moderate rows and require 2+ stocks in a sector. The live default and the cap tests use the production row order (tier → agreeing checks → helpers → RVOL); the two `SECTOR_FIRST` variants put the hottest sector first, then use that order inside the sector. The live default also has a 100-symbol API scan cap; the uncapped variant removes it. This is a research replay, not the production page: the live page re-ranks sectors every 5 minutes, while the replay uses each closed 15m cross-section.");
  P();
  P("### Per-decision rules");
  P();
  P(md(["Rule", "Fixed definition"], [
    ["ORB5", "First 5m bar direction must agree; at a closed 15m decision, last closed 5m price must be beyond that first bar's high (up) or low (down)."],
    ["ORB5_RVOL", "ORB5 plus first *traded* 5m volume / the same clock slot on the prior 14 sessions ≥ 1.5. Yahoo's 09:15 bar is almost always a zero-volume opening print, so the first bar with volume (normally 09:20) is the correct comparison."],
    ["ORB15", "Same, using the first 15m bar's high/low and direction."],
    ["ORB15_RVOL", "ORB15 plus the same first traded-5m RVOL ≥ 1.5 filter."],
    ["VWAP_TREND", "Price side of VWAP and 12-bar VWAP slope must agree (both up or both down)."],
    ["SM_SECTOR_1D", "Strong+moderate side must agree with the stock's sector being top 3 or bottom 3 by prior-session turnover-weighted member return."],
    ["SM_SECTOR_5D", "Same using the prior 5-session sector return."],
    ["MEANREV_45M", "Fade a 45-minute move of at least 1.0% (short after an up move, long after a down move). Control, not a proposed edge."],
  ]));
  P();
  P("All entries are at the next 5m open; ORB rules take at most one trade per stock per day (the first breakout), matching the paper. Primary settings are 0.5/0.5 and 1.0/1.0 barriers, 90-minute horizon. The ORB paper holds to the close; our 90m/3h horizons are shorter, so this is an adaptation. The sector rules use prior-session daily bars only; the current sector % used by the board uses today's closed bars only.");
  P();

  P("## 4. Board cap results (validation half)");
  P();
  P("### 0.5/0.5 barriers, 90m, next-5m entry");
  P();
  P(md(["Board variant", "Signals/decidable", "Hit %", "Break-even %", "Net exp. % (day-cluster 95% CI)", "p (one-sided)"], boardP1.map(({ v, g }) => cellRow(v.id, g.val))));
  P();
  P("### 1.0/1.0 barriers, 90m, next-5m entry");
  P();
  P(md(["Board variant", "Signals/decidable", "Hit %", "Break-even %", "Net exp. % (day-cluster 95% CI)", "p (one-sided)"], boardP2.map(({ v, g }) => cellRow(v.id, g.val))));
  P();
  P("### All 39 sessions (descriptive, not a held-out result)");
  P();
  P(md(["Board variant", "P1 net exp. %", "P2 net exp. %", "P1 decidable", "P2 decidable"], boardP1.map(({ v }, i) => {
    const g2 = boardP2[i].g;
    return [v.id, f2(boardP1[i].g.all.netExp), f2(g2.all.netExp), boardP1[i].g.all.dec, g2.all.dec];
  })));
  P();
  P("Read the cap table this way: if `BOARD_NO_ROW_CAP` and `BOARD_UNCAPPED` are not better than `BOARD_LIVE_DEFAULT`, the caps were not hiding an edge. If they are better only in the all-session column but not validation, the difference is not held-out evidence.");
  P();
  P("`BOARD_SECTOR_FIRST` and `BOARD_UNCAPPED` have identical events because no row cap is applied: with every row listed, row order is presentation only. `BOARD_SECTOR_FIRST_20` is the informative sector-first selection test, because the 20-row cap forces the order to choose which rows a user sees.");
  P();
  P("A repeat with the live helpers (`--fix none`, saved under `research2_livehelpers/`) also found **0** nominal net-positive and **0** BH cells. Its `BOARD_LIVE_DEFAULT` P1 was -0.10% and `BOARD_UNCAPPED` -0.11%; the cap conclusion does not depend on the fixes.");
  P();

  P("## 5. Literature-inspired results (validation half)");
  P();
  P("### 0.5/0.5 barriers, 90m, next-5m entry");
  P();
  P(md(["Rule", "Signals/decidable", "Hit %", "Break-even %", "Net exp. % (day-cluster 95% CI)", "p (one-sided)"], stratP1.map(({ s, g }) => cellRow(s.id, g.val))));
  P();
  P("### 1.0/1.0 barriers, 90m, next-5m entry");
  P();
  P(md(["Rule", "Signals/decidable", "Hit %", "Break-even %", "Net exp. % (day-cluster 95% CI)", "p (one-sided)"], stratP2.map(({ s, g }) => cellRow(s.id, g.val))));
  P();
  P("The ORB rows are the closest data-compatible test of the strongest literature result. The sector rows are slow overlays, not 15m sector rotation. `MEANREV_45M` is a control: if it is the best row, the sample is mean-reverting, not trending.");
  P();
  P("### Hold-to-close ORB (closest to the paper)");
  P();
  P("The paper's exit is a 1 ATR stop with **no target**, held to the close. The 45/90/180m grid cannot express that, so these are separate tests: one trade per stock per day (first signal), entry at the next 5m open, 1 ATR stop, exit at the last closed 5m bar of the day. The first seven rows use the 15m decision grid. The four `ORB5M*` rows scan every 5m bar, enter on the first close beyond the opening range at the next 5m open, and use a 5m ATR(14) stop. `ORB5M` uses the 09:15 bar; because Yahoo's 09:15 bar is almost always a zero-volume opening print, `ORB5MT` uses the first traded 5m bar (normally 09:20) and is the closer test of live trading. They are still adaptations: the paper enters at the breakout level, not the next open, and uses its own universe/filters.");
  P();
  P(md(["Rule", "Events", "Decidable", "Days", "Stop hit %", "Net exp. % (day-cluster 95% CI)", "p", "q"], closeResults.map((r) => [
    r.id, r.events, r.val.n, r.val.days,
    r.val.stopRate == null ? "–" : f1(r.val.stopRate * 100),
    `${f2(r.val.netExp)} (${f2(r.val.netLo)} to ${f2(r.val.netHi)})`,
    fp(r.val.netP1), r.val.q == null ? "–" : fp(r.val.q),
  ])));
  P();
  P('`*_TOP20_CLOSE` selects the top 20 stocks by first traded-5m RVOL each day, the paper\'s "stocks in play" idea. `SM_REF_CLOSE` is the current composite with the same exit, for comparison. The close-exit family is corrected separately (BH over these rules), not mixed into the main barrier grid.');
  const allClose = (id) => closeResults.find((r) => r.id === id);
  P(`All-session descriptive: ORB5_TOP20_CLOSE ${f2(allClose('ORB5_TOP20_CLOSE').all.netExp)}%, ORB15_TOP20_CLOSE ${f2(allClose('ORB15_TOP20_CLOSE').all.netExp)}%, ORB5M_CLOSE ${f2(allClose('ORB5M_CLOSE').all.netExp)}%, ORB5M_TOP20_CLOSE ${f2(allClose('ORB5M_TOP20_CLOSE').all.netExp)}%, ORB5MT_CLOSE ${f2(allClose('ORB5MT_CLOSE').all.netExp)}%, ORB5MT_TOP20_CLOSE ${f2(allClose('ORB5MT_TOP20_CLOSE').all.netExp)}%. The full-sample results are not held-out evidence; the validation column is what matters.`);
  P();

  P("## 6. Multiple comparisons and the best validation cells");
  P();
  P(`- ${valEligible.length} validation cells had at least ${A.MIN_DEC} decidable signals; roughly ${headline.expectedByChanceNominal} nominal p<0.05 hits are expected from noise.`);
  P(`- Nominal net-positive: **${nomPos.length}**. BH q<0.10: **${bhPos.length}**. Gross-positive before costs at p<0.05: **${grossPos.length}**.`);
  P(`- Separate hold-to-close family: **${closeVal.length}** rules with n>=${A.MIN_DEC}; nominal net-positive **${closeNomPos.length}**; BH q<0.10 **${closeBhPos.length}**.`);
  if (nomPos.length) {
    P();
    P(md(["Cell", "Config", "Decidable", "Net exp. %", "p", "BH q"], nomPos.slice(0, 25).map((g) => [g.id, cfgName(g.c), g.val.dec, f2(g.val.netExp), fp(g.val.netP1), g.q == null ? "–" : fp(g.q)])));
  }
  P();
  P("The 15 best validation cells by net expectancy are listed below **only to show how easy it is to cherry-pick**; this is not a selection rule and none of them is a lead unless it also survives BH and a fresh sample.");
  P();
  P(md(["Cell", "Config", "Decidable", "Hit %", "Net exp. %", "p"], bestVal.map((g) => [g.id, cfgName(g.c), g.val.dec, f1(g.val.hit * 100), f2(g.val.netExp), fp(g.val.netP1)])));
  P();

  P("## 7. Verdict");
  P();
  if (!anyBh && !anyNom) {
    P("**The caps are not the problem.** Removing the row cap, the sector cap or both did not produce a net-positive held-out result. The ORB and sector adaptations did not produce one, and the closer hold-to-close ORB test did not either. The current board remains a descriptive watchlist, not a validated trade signal.");
  } else if (!anyBh) {
    P("**The caps are not the solution either.** A few cells look positive, but they do not survive the number of tests. Do not port a rule because it is the best row in this table; it is exactly the row most likely to be noise.");
  } else {
    P("**A candidate hypothesis survived the multiple-comparison screen.** That is not enough to trade it: it has not been tested on a third sample, and the result is underlying-only. First re-run the exact rule on fresh sessions; then add option-specific data before making any option claim.");
  }
  P();
  P("What I would change in the product, subject to approval:");
  P();
  P("1. Keep the board as context; do not advertise a win rate. The current banner's 63.6% strong-read number is a small, component-level, gross-of-costs result and should not be presented as an edge.");
  P("2. If you want an uncapped sector board, make it a **display** change first: remove the 20-row cap and show all strong/moderate rows, but keep the API scan caps until the serverless runtime is measured. The research says the caps do not create edge; they are a presentation/runtime choice.");
  P("3. Port bugs 1–3 and 6 to live only as **correctness fixes**, with regression tests. They remove clock bias; they do not create alpha.");
  P("4. Do not replace the composite with ORB yet. Test the exact ORB rule on a fresh sample first; the NSE-specific evidence is statistically weak, and the US evidence is not transferable by assumption.");
  P();

  P("## 8. Limits");
  P();
  P("- One regime: 39 sessions of a falling market (Nifty 50 roughly -5.5% over the sample). No statement about other regimes.");
  P("- 213 F&O symbols from today's list: survivorship bias remains. Yahoo intraday history is ~60 days; the live read needs a one-month window, so only the second month is usable.");
  P("- Underlying only: no option premium, IV, theta, spread, brokerage, STT or liquidity. A 0.05% per-side cost is an assumption, not a measurement.");
  P("- The board replay uses closed 15m cross-sections; the live page re-ranks sectors every 5 minutes and calls every 60 seconds. Sector % is the turnover-weighted member average, not the NSE sector index.");
  P("- The main ORB grid uses 15m decision times and 90m/3h barriers, not the paper's 5m entries and hold-to-close. The decision-based close-exit tests fix the exit (1 ATR, hold to the last closed 5m bar) but still use 15m decisions and next-5m entries. The four `ORB5M*` tests scan every 5m bar and use a 5m ATR stop, but enter at the next 5m open rather than at the breakout level. The sector overlay uses 1-day/5-day returns, not the 6–12 month horizon in the industry-momentum paper. These are adaptations, not replications.");
  P("- The board's API scan cap is a runtime constraint; removing it in research does not prove the live route can scan 213 stocks within the serverless budget.");
  P();
  P("## 9. Files");
  P();
  P("`research2_report.md` (this), `research2_results.json`, `research2_grid.csv`, `research2_close.csv`, `research2_command.txt`, `board.js`, `research_strategies.js`, `orb5m.js`, `orb5m.test.js`, `loader.js`, `run_research2.js`.");
  P();
  P("Sources: [SSRN 4729284](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4729284), [QuantConnect ORB replication](https://www.quantconnect.com/research/18444/opening-range-breakout-for-stocks-in-play/), [Gao et al. JFE 2018](https://www.sciencedirect.com/science/article/abs/pii/S0304405X18301351), [Moskowitz & Grinblatt 1999](https://www.aqr.com/Insights/Research/Journal-Article/Do-Industries-Explain-Momentum), [SSRN 4631351](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4631351), [SSRN 5198458](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5198458).");
  P();
  return L.join("\n");
}

module.exports = { run, BOARD_VARIANTS, P1, P2, cfgName };

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const data = get("--data", path.join(__dirname, "data"));
  const out = get("--out", __dirname);
  const fixArg = get("--fix", null);
  const fix = fixArg == null ? ALL_FIXES : fixArg === "none" || fixArg === "" ? {} : Object.fromEntries(fixArg.split(",").filter(Boolean).map((k) => [k, true]));
  const R = run({
    data, out, mode: get("--mode", "live"), cost: Number(get("--cost", 0.05)),
    limit: get("--limit") ? Number(get("--limit")) : undefined, fix,
    command: "node " + path.relative(process.cwd(), __filename) + " " + args.join(" "),
  });
  console.log(JSON.stringify(R.headline, null, 1));
}
