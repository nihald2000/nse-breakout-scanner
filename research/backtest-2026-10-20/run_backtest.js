"use strict";
// run_backtest.js - walk-forward backtest of every signal component behind the Live Calls board.
//
//   node research/backtest-2026-10-20/run_backtest.js --data <dir> --out <dir> [--mode live|extended] [--cost 0.05]
//
// Offline research only: it reads the cached data directory, never the network, never writes outside --out,
// never changes thresholds in lib/ or api/.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const E = require("./engine");
const A = require("./analysis");
const S = require("./stats");
const { loadDataset } = require("./loader");
const { NC, NB, NH, NE, BARRIERS, HORIZONS, ENTRIES, cIndex, cParts, RES, RES_NAME } = E;

const cfgName = (c) => {
  const { b, h, e } = cParts(c);
  return `${BARRIERS[b].id}; ${HORIZONS[h]} bars (${HORIZONS[h] * 15}m); entry ${ENTRIES[e] === "close" ? "bar close" : "next 5m open"}`;
};
const ONE_TO_ONE = [0, 3, 5, 6, 7, 8]; // barrier indices that are 1:1: fixed .5/.5, 1/1, ATR .5/.5, 1/1, Kijun, Kijun capped
const PRIMARY = [
  { name: "P1", c: cIndex(0, 1, 1), note: "fixed 0.5%/0.5%, 90m, next 5m open" },
  { name: "P2", c: cIndex(3, 1, 1), note: "fixed 1.0%/1.0%, 90m, next 5m open" },
];

// ---------------------------------------------------------------------------------------------------------
const f1 = (x) => (x == null || !Number.isFinite(x) ? "-" : (100 * x).toFixed(1) + "%");
const f2 = (x) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(3));
const f3 = (x) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(2));
const fp = (x) => (x == null || !Number.isFinite(x) ? "-" : x < 0.001 ? "<0.001" : x.toFixed(3));
function md(headers, rows) {
  return ["| " + headers.join(" | ") + " |", "|" + headers.map(() => "---").join("|") + "|", ...rows.map((r) => "| " + r.join(" | ") + " |")].join("\n");
}
function cellRow(label, st) {
  if (st.dec < A.MIN_DEC) return [label, `${st.n}/${st.dec}`, "insufficient n", "-", "-", "-", "-"];
  return [label, `${st.n}/${st.dec}`, `${f1(st.hit)} (naive ${f1(st.wLo)}-${f1(st.wHi)}; day-cluster ${f1(st.clLo)}-${f1(st.clHi)})`, f1(st.breakEven), f2(st.grossExp), `${f2(st.netExp)} (${f2(st.netLo)} to ${f2(st.netHi)})`, fp(st.netP1)];
}
const CELL_HEAD = ["", "events / decidable", "hit % of decidable", "break-even hit % (net)", "gross exp. %/trade", "NET exp. %/trade (95% day-cluster CI)", "p (net exp. <= 0)"];

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------------------------------------------------------------------------------------------------------
function run(opts) {
  const T0 = Date.now();
  const log = (...a) => {
    if (!opts.quiet) console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
  };
  fs.mkdirSync(opts.out, { recursive: true });
  const ds = loadDataset(opts.data, { limit: opts.limit });
  log(`loaded ${ds.stocks.length} stocks, ${ds.missing.length} missing, ${ds.calendar.size} full sessions`);

  // ---- decisions
  const dec = [];
  const skipped = {};
  const perStock = [];
  for (const st of ds.stocks) {
    const r = E.buildDecisions(st, { calendar: ds.calendar, mode: opts.mode, minPriorExtended: 10, corp: ds.corp, mktTrend: ds.mktTrend, delivPrev: ds.delivPrev, fix: opts.fix });
    for (const d of r.decisions) dec.push(d);
    for (const k of Object.keys(r.skipped)) skipped[k] = (skipped[k] || 0) + r.skipped[k];
    perStock.push({ sym: st.sym, decisions: r.decisions.length });
  }
  const dates = [...new Set(dec.map((d) => d.d))].sort();
  const nDays = dates.length;
  if (nDays < 4) throw new Error(`only ${nDays} evaluable sessions - not enough for a walk-forward split`);
  const dayIdx = new Map(dates.map((d, i) => [d, i]));
  const dayOrd = new Int16Array(dec.length);
  dec.forEach((d, i) => (dayOrd[i] = dayIdx.get(d.d)));
  const split = Math.floor(nDays / 2);
  log(`${dec.length} decisions on ${nDays} sessions (${dates[0]} .. ${dates[nDays - 1]}); discovery = first ${split}, validation = last ${nDays - split}`);

  // delivery median per date (display-only filter)
  const byDate = new Map();
  for (const d of dec) if (d.deliv != null) (byDate.get(d.d) || byDate.set(d.d, new Map()).get(d.d)).set(d.sym, d.deliv);
  const delivMedian = new Map();
  for (const [dt, m] of byDate) delivMedian.set(dt, [...m.values()].sort((a, b) => a - b)[Math.floor(m.size / 2)]);

  // ---- consistency guard: the stored side must equal the lean rule applied to the stored slots
  let guardBad = 0;
  for (const d of dec) if (A.leanSide(d.slot, -1) !== d.side) guardBad++;
  if (guardBad) log(`WARNING: lean-rule guard disagreed on ${guardBad} decisions`);

  // ---- outcomes
  const O = E.computeOutcomes(dec, ds.stockBySym);
  log(`outcomes computed (${dec.length} x 2 sides x ${NC} configurations)`);

  const strategies = A.buildStrategies({ delivMedian });
  const allCs = Array.from({ length: NC }, (_, i) => i);
  const MODES = ["run", "every"];
  const grid = []; // one record per strategy x mode x config with disc / val / all stats
  const aggs = new Map();
  for (const st of strategies) {
    for (const mode of MODES) {
      const ev = A.selectEvents(dec, st, mode);
      const agg = A.aggregate(O, dayOrd, nDays, ev.evD, ev.evS, allCs);
      aggs.set(st.id + "|" + mode, { ev, agg });
      for (let c = 0; c < NC; c++) {
        grid.push({
          strat: st, mode, c,
          disc: A.cellStats(agg, c, 0, split, opts.cost),
          val: A.cellStats(agg, c, split, nDays, opts.cost),
          all: A.cellStats(agg, c, 0, nDays, opts.cost),
        });
      }
    }
  }
  log(`grid done: ${grid.length} configurations (${strategies.length} strategies x ${MODES.length} signal modes x ${NC} barrier/horizon/entry settings)`);

  // ---- multiple-comparison bookkeeping (validation half)
  const real = grid.filter((g) => g.strat.group !== "baseline");
  const valEligible = real.filter((g) => g.val.dec >= A.MIN_DEC && g.val.netP1 != null);
  const q = S.bhAdjust(valEligible.map((g) => g.val.netP1));
  valEligible.forEach((g, i) => (g.q = q[i]));
  const nomPos = valEligible.filter((g) => g.val.netExp > 0 && g.val.netP1 < 0.05);
  const bhPos = valEligible.filter((g) => g.val.netExp > 0 && g.q != null && g.q < 0.1);
  const grossPos = valEligible.filter((g) => g.val.grossExp > 0 && g.val.grossP1 != null && g.val.grossP1 < 0.05);

  // ---- walk-forward selection: top K by DISCOVERY net expectancy, judged on VALIDATION only
  const K = 10;
  const discPool = real.filter((g) => g.disc.dec >= A.MIN_DEC && g.disc.netExp != null && g.mode === "run");
  discPool.sort((a, b) => b.disc.netExp - a.disc.netExp);
  const picks = [];
  const seen = new Set();
  for (const g of discPool) {
    const key = g.strat.id + "|" + g.c;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(g);
    if (picks.length >= K) break;
  }
  for (const g of picks) g.lead = g.val.dec >= A.MIN_DEC && g.val.netExp > 0 && g.val.netP1 != null && g.val.netP1 < 0.05 / K;

  // ---- 1:1 headline cells (validation)
  const oneToOne = real.filter((g) => ONE_TO_ONE.includes(cParts(g.c).b));
  const oneEligible = oneToOne.filter((g) => g.val.dec >= A.MIN_DEC);
  const oneBeat50 = oneEligible.filter((g) => g.val.clLo != null && g.val.clLo > 0.5);
  const oneNetPos = oneEligible.filter((g) => g.val.netExp > 0 && g.val.netP1 < 0.05);

  // ---- tier / baseline tables for the primary configs
  const get = (id, mode, c) => grid.find((g) => g.strat.id === id && g.mode === mode && g.c === c);

  // ---- slices for the primary configs
  const sliceDims = [
    ["tier (lean rule, any tier)", (d) => ["none", "weak", "moderate", "strong"][d.tier]],
    ["side", (d, s) => (s === 0 ? "long / CE read" : "short / PE read")],
    ["time of day (decision close)", (d) => (d.tm <= 615 ? "09:30-10:15" : d.tm <= 720 ? "10:15-12:00" : d.tm <= 840 ? "12:00-14:00" : "14:00-15:15")],
    ["sector (NIFTY-500 industry)", (d) => d.ind],
    ["ADX bucket", (d) => (d.adxV == null ? "n/a" : d.adxV < 18 ? "<18" : d.adxV < 25 ? "18-25" : d.adxV < 35 ? "25-35" : ">=35")],
    ["day-range vs 20-session mean", (d) => (d.rangeRatio == null ? "n/a" : d.rangeRatio < 0.5 ? "<0.5x" : d.rangeRatio < 0.85 ? "0.5-0.85x" : d.rangeRatio < 1.15 ? "0.85-1.15x" : ">=1.15x")],
    ["running RVOL", (d) => (d.rvol == null ? "n/a" : d.rvol < 0.8 ? "<0.8" : d.rvol < 1.2 ? "0.8-1.2" : d.rvol < 2 ? "1.2-2" : ">=2")],
    ["daily trend (prior close vs SMA20)", (d, s) => (!d.dTrend ? "n/a" : d.dTrend === (s === 0 ? 1 : -1) ? "with the trend" : "against the trend")],
    ["60m trend (close vs EMA20)", (d, s) => (!d.hTrend ? "n/a" : d.hTrend === (s === 0 ? 1 : -1) ? "with the trend" : "against the trend")],
    ["Nifty daily trend", (d, s) => (!d.mTrend ? "n/a" : d.mTrend === (s === 0 ? 1 : -1) ? "with the trend" : "against the trend")],
  ];
  const allEvD = [];
  const allEvS = [];
  dec.forEach((d, i) => {
    if (d.j0 < 0) return;
    allEvD.push(i, i);
    allEvS.push(0, 1);
  });
  const sliceResults = []; // { strat, cfg, dim, label, disc, val, base:{disc,val} }
  let sliceCells = 0;
  for (const sid of ["STRONG_MODERATE", "LEAN_ANY"]) {
    const ev = aggs.get(sid + "|run").ev;
    for (const P of PRIMARY) {
      for (const [dimName, fn] of sliceDims) {
        const groups = new Map();
        const bgroups = new Map();
        for (let k = 0; k < ev.evD.length; k++) {
          const lab = fn(dec[ev.evD[k]], ev.evS[k]);
          if (!groups.has(lab)) groups.set(lab, { evD: [], evS: [] });
          groups.get(lab).evD.push(ev.evD[k]);
          groups.get(lab).evS.push(ev.evS[k]);
        }
        for (let k = 0; k < allEvD.length; k++) {
          const lab = fn(dec[allEvD[k]], allEvS[k]);
          if (!groups.has(lab)) continue;
          if (!bgroups.has(lab)) bgroups.set(lab, { evD: [], evS: [] });
          bgroups.get(lab).evD.push(allEvD[k]);
          bgroups.get(lab).evS.push(allEvS[k]);
        }
        for (const [lab, g] of [...groups.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
          const a1 = A.aggregate(O, dayOrd, nDays, g.evD, g.evS, [P.c]);
          const b = bgroups.get(lab);
          const a2 = b ? A.aggregate(O, dayOrd, nDays, b.evD, b.evS, [P.c]) : null;
          sliceResults.push({
            sid, P, dimName, label: lab,
            disc: A.cellStats(a1, 0, 0, split, opts.cost), val: A.cellStats(a1, 0, split, nDays, opts.cost),
            bdisc: a2 ? A.cellStats(a2, 0, 0, split, opts.cost) : null, bval: a2 ? A.cellStats(a2, 0, split, nDays, opts.cost) : null,
          });
          sliceCells++;
        }
      }
    }
  }
  log(`slices done: ${sliceCells} cells`);

  // ---- outputs: raw files
  const out = opts.out;
  const gridHead = ["strategy", "group", "signal_mode", "barrier", "horizon_15m_bars", "entry", "window", "events", "decidable", "target", "stop", "both", "timeout", "open", "hit", "wilson_lo", "wilson_hi", "cluster_lo", "cluster_hi", "break_even_hit", "gross_exp_pct", "net_exp_pct", "net_lo", "net_hi", "net_t", "net_p_one_sided", "avg_stop_pct", "avg_mfe_pct", "avg_mae_pct", "sessions"];
  const lines = [gridHead.join(",")];
  for (const g of grid) {
    const { b, h, e } = cParts(g.c);
    for (const [w, s] of [["discovery", g.disc], ["validation", g.val], ["all", g.all]]) {
      lines.push([g.strat.id, g.strat.group, g.mode, BARRIERS[b].id, HORIZONS[h], ENTRIES[e], w, s.n, s.dec, s.tgt, s.stp, s.both, s.tmo, s.opn, s.hit, s.wLo, s.wHi, s.clLo, s.clHi, s.breakEven, s.grossExp, s.netExp, s.netLo, s.netHi, s.netT, s.netP1, s.avgStop, s.mfe, s.mae, s.days].map((v) => csvEscape(typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v)).join(","));
    }
  }
  fs.writeFileSync(path.join(out, "grid.csv"), lines.join("\n"));

  if (!opts.noSignals) {
  // per-signal rows: every decision with a lean side (any tier), run mode; outcomes for ALL configurations
  const sig = aggs.get("LEAN_ANY|run").ev;
  const sh = ["symbol", "date", "time_ist", "sector", "side", "tier", "agree", "of_checks", "helpers", "chk_vwap_pos", "chk_vwap_slope", "chk_ichimoku", "chk_structure", "chk_or", "chk_adx", "adx", "range_ratio", "rvol", "day_chg_pct", "entry_close", "kijun", "atr_pct", "session_half"];
  for (let c = 0; c < NC; c++) sh.push("res_c" + c);
  for (let c = 0; c < NC; c++) sh.push("ret_c" + c);
  const sl = [sh.join(",")];
  for (let q2 = 0; q2 < sig.evD.length; q2++) {
    const di = sig.evD[q2];
    const s = sig.evS[q2];
    const d = dec[di];
    const t = d.tm; // decision close minute (IST)
    const row = [d.sym, d.d, `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`, d.ind, s === 0 ? "long" : "short", ["none", "weak", "moderate", "strong"][d.tier], d.agree, d.tot, d.helpers, ...d.slot, d.adxV == null ? "" : d.adxV.toFixed(1), d.rangeRatio == null ? "" : d.rangeRatio.toFixed(2), d.rvol == null ? "" : d.rvol.toFixed(2), d.pchg.toFixed(3), d.e, d.kijun == null ? "" : d.kijun.toFixed(2), d.atrPct == null ? "" : d.atrPct.toFixed(3), dayOrd[di] < split ? "discovery" : "validation"];
    const base = (di * 2 + s) * NC;
    for (let c = 0; c < NC; c++) row.push(RES_NAME[O.res[base + c]]);
    for (let c = 0; c < NC; c++) row.push(O.res[base + c] === RES.NA ? "" : O.ret[base + c].toFixed(4));
    sl.push(row.map(csvEscape).join(","));
  }
  fs.writeFileSync(path.join(out, "signals.csv.gz"), zlib.gzipSync(sl.join("\n")));
  }
  fs.writeFileSync(path.join(out, "configs.json"), JSON.stringify(Array.from({ length: NC }, (_, c) => ({ c, name: cfgName(c) })), null, 1));

  const meta = {
    runAt: new Date().toISOString(),
    data: path.resolve(opts.data),
    snapshotDate: ds.meta.snapshotDate,
    synthetic: !!ds.meta.synthetic,
    mode: opts.mode,
    costPerSidePct: opts.cost,
    fix: opts.fix || null,
    sessions: { evaluated: nDays, first: dates[0], last: dates[nDays - 1], discovery: dates.slice(0, split), validation: dates.slice(split) },
    stocks: { loaded: ds.stocks.length, missing: ds.missing },
    decisions: dec.length,
    skipped,
    calendar: ds.cal,
    corpActions: ds.corpNotes,
    configurationsTested: grid.length,
    leanGuardMismatches: guardBad,
  };

  const R = {
    meta, dec, O, grid, picks, valEligible, nomPos, bhPos, grossPos, oneToOne, oneEligible, oneBeat50, oneNetPos, sliceResults, sliceCells,
    strategies, get, ds, K, dates, split, nDays, skipped,
  };
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ meta, headline: headline(R), picks: picks.map((g) => ({ strategy: g.strat.id, config: cfgName(g.c), discovery: strip(g.disc), validation: strip(g.val), lead: g.lead })) }, null, 1));
  if (!opts.noReport) fs.writeFileSync(path.join(out, "report.md"), report(R, opts));
  fs.writeFileSync(path.join(out, "run_command.txt"), opts.command || "");
  fs.writeFileSync(path.join(out, "missing_symbols.json"), JSON.stringify(ds.missing, null, 1));
  log(`wrote ${out}`);
  return R;
}

function strip(s) {
  const o = { ...s };
  delete o.perHit;
  return o;
}

function headline(R) {
  const lead = R.picks.filter((g) => g.lead);
  return {
    configurationsTested: R.grid.length,
    validationEligible: R.valEligible.length,
    nominalPositive: R.nomPos.length,
    bhPositive: R.bhPos.length,
    expectedByChanceNominal: Math.round(R.valEligible.length * 0.05),
    oneToOneEligible: R.oneEligible.length,
    oneToOneHitCiAbove50: R.oneBeat50.length,
    oneToOneNetPositiveNominal: R.oneNetPos.length,
    leadsFromDiscoveryTopK: lead.map((g) => ({ strategy: g.strat.id, config: cfgName(g.c) })),
    verdict: lead.length ? "candidate lead (hypothesis only)" : "no edge in this sample",
  };
}

// ---------------------------------------------------------------------------------------------------------
function report(R, opts) {
  const { meta, picks, grid } = R;
  const H = headline(R);
  const L = [];
  const P = (s = "") => L.push(s);
  const synth = meta.synthetic;
  const fixLabel = opts.fix && Object.keys(opts.fix).length ? Object.keys(opts.fix).filter((k) => opts.fix[k]).join("+") : null;
  P(`# Backtest of the Live Calls signal components${fixLabel ? " - FIXED VARIANTS: " + fixLabel : ""}${synth ? " - SYNTHETIC DATA, NOT A RESULT" : ""}`);
  P();
  if (synth) {
    P("> **This report was produced from a SYNTHETIC market for harness validation. None of the numbers describe NSE or the live board.**");
    P();
  }
  P(`Data snapshot: **${meta.snapshotDate}** | run: ${meta.runAt} | mode: \`${meta.mode}\` | cost assumption: **${opts.cost}% per side on the underlying** (${(2 * opts.cost).toFixed(2)}% round trip). Option premium, spread and IV are NOT modeled.`);
  P();
  P("## 1. Answer first");
  P();
  const lead = picks.filter((g) => g.lead);
  if (!lead.length) {
    P(`**No edge in this sample.** No strategy beat break-even after costs in the validation half once the number of comparisons is respected.`);
  } else {
    P(`**A candidate lead exists, and only as a hypothesis** (${lead.length} of the top ${R.K} discovery picks stayed positive net of costs in the held-out half at a Bonferroni-adjusted level). It has not been tested on a third sample.`);
  }
  P();
  P(`- Sessions evaluated: **${R.nDays}** (${meta.sessions.first} to ${meta.sessions.last}); discovery = first ${R.split}, validation = last ${R.nDays - R.split}. Signals inside one session share the market's move, so the effective sample is closer to ${R.nDays} days than to the event counts; day-cluster intervals below account for that, "naive" Wilson intervals do not.`);
  P(`- 1:1 settings with at least ${A.MIN_DEC} decidable validation signals: **${R.oneEligible.length}**. Of those, hit-rate 95% day-cluster interval entirely above 50% (gross): **${R.oneBeat50.length}** (about ${Math.round(R.oneEligible.length * 0.025)} expected by chance alone); net expectancy > 0 at p<0.05: **${R.oneNetPos.length}**.`);
  P(`- Configurations tested: **${grid.length}** (${R.strategies.length} strategies x 2 signal modes x ${NC} barrier/horizon/entry settings), each on discovery / validation / all. Of ${R.valEligible.length} with enough validation signals, **${R.nomPos.length}** are net-positive at nominal p<0.05 (about ${H.expectedByChanceNominal} would be expected by chance alone even with no edge; Benjamini-Hochberg q<0.10: **${R.bhPos.length}**). Gross-positive at p<0.05: ${R.grossPos.length}.`);
  P(`- Slices add ${R.sliceCells} more cells (not included in the count above). Treat any single slice as a hypothesis generator.`);
  P();
  P(`### Walk-forward: the ${R.K} best discovery configurations, judged only on the validation half`);
  P();
  P("Selection rule (fixed before looking): signal mode = one entry per side-run, non-baseline strategies, at least " + A.MIN_DEC + " decidable signals in discovery, ranked by NET expectancy in the discovery half.");
  P();
  P(md(["strategy / setting", "discovery: events/dec., net exp. %", "validation: events/dec., hit %, break-even, net exp. % (CI), p", "lead?"], picks.map((g) => [
    `${g.strat.id} - ${cfgName(g.c)}`,
    `${g.disc.n}/${g.disc.dec}, ${f2(g.disc.netExp)}`,
    g.val.dec < A.MIN_DEC ? `${g.val.n}/${g.val.dec}, insufficient n` : `${g.val.n}/${g.val.dec}, ${f1(g.val.hit)} (day-cluster ${f1(g.val.clLo)}-${f1(g.val.clHi)}), BE ${f1(g.val.breakEven)}, ${f2(g.val.netExp)} (${f2(g.val.netLo)} to ${f2(g.val.netHi)}), p=${fp(g.val.netP1)}`,
    g.lead ? "yes (hypothesis)" : "no",
  ])));
  P();
  P("A strategy chosen because it was best in discovery will look worse in validation by construction (regression to the mean). A \"lead\" needs: validation decidable >= " + A.MIN_DEC + ", net expectancy > 0, and one-sided p < 0.05/" + R.K + " (Bonferroni over the " + R.K + " picks).");
  P();

  // ---- data
  P("## 2. Data and hygiene");
  P();
  P(`- Universe: ${meta.stocks.loaded + meta.stocks.missing.length} symbols requested, **${meta.stocks.loaded} usable**, **${meta.stocks.missing.length} missing/skipped** (list in \`missing_symbols.json\`${meta.stocks.missing.length ? ": " + meta.stocks.missing.slice(0, 25).map((m) => `${m.sym} (${m.why})`).join("; ") + (meta.stocks.missing.length > 25 ? "; ..." : "") : ""}). Missing data is skipped, never zero-filled.`);
  P(`- Sessions in the cache: ${meta.calendar.yahooSessions}; full sessions used for decisions: ${meta.calendar.fullSessions}. Short or partial sessions excluded: ${meta.calendar.shortDates.length ? meta.calendar.shortDates.map((x) => `${x.date} (median ${x.medianBars5m} bars)`).join(", ") : "none"}.`);
  P(`- NSE bhavcopy calendar validation: ${meta.calendar.bhavValidated ? `done. In Yahoo but not NSE: ${meta.calendar.onlyInYahoo.join(", ") || "none"}. In NSE but missing from Yahoo: ${meta.calendar.onlyInNSE.join(", ") || "none"}.` : "**not done** (no bhav.json in the data directory)."}`);
  P(`- Corporate-action flags (decisions inside the 1-month window after one are dropped): ${meta.corpActions.length ? meta.corpActions.map((c) => `${c.sym} ${c.date}`).join(", ") : "none"}.`);
  P(`- Decisions built: **${meta.decisions}**. Skipped, by reason: ${Object.entries(meta.skipped).map(([k, v]) => `${k} = ${v}`).join("; ") || "none"}.`);
  P(`- Sessions are IST 09:15-15:30 only; bars outside that window and duplicate timestamps are removed. Decisions are taken at every closed 15m bar from the one closing 09:30 up to the one closing 15:15, with the 5m series aligned to the same instant and no look-ahead (verified by a truncation test in \`harness_check.js\`).`);
  P(`- Yahoo limits intraday history to ~60 calendar days, and the live read needs a one-month window for Ichimoku/ADX/range baselines, so in \`live\` mode only the second month can be evaluated. That is why the sample is short.`);
  P();

  // ---- fidelity
  P("## 3. Fidelity to production");
  P();
  P("The replay imports the same pure helpers from `lib/sector.js` and parses bars with the same `parseIdx`; the assembly in `computeRows()` is mirrored and checked by `parity.js` against the real `computeRows()` with Yahoo and the clock stubbed (see `parity.json` when produced from real data, and the self-test output for the synthetic proof).");
  if (fixLabel) {
    P();
    P(`**This run is a research variant, not a replay of live production.** The fixed helpers are in \`fixes.js\` and are switched on with \`--fix ${fixLabel}\`. Baseline parity applies to the live helpers only.`);
  }
  P();
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(opts.out, "parity.json"), "utf8"));
    P(`**Parity on this run's data:** ${pj.sampled} stock-bars sampled, ${pj.compared} field comparisons, **${Array.isArray(pj.mismatches) ? pj.mismatches.length : pj.mismatches} mismatches** against the real computeRows().`);
    P();
  } catch (e) {
    P("**Parity on this run's data: not run** (run `parity.js` first, or use `run_all.js`).");
    P();
  }
  P("Known differences, documented and not hidden:");
  P("1. Live uses `ltp` (regularMarketPrice) for the VWAP-position check; the replay uses the last closed 5m close. In the parity mutation test a 0.3% change in this one price flipped the lean counts on about a quarter of stock-bars, so this difference matters at the margin and is quantified with 1-minute data in `timing_1m.md` when that script has been run.");
  P("2. Live `today` (RVOL) and `rangeVsNormal` include the still-forming bar; the replay sees only closed bars.");
  P("3. Live asks Yahoo for `range=5d` / `range=1mo` at call time; the replay rebuilds those windows (last 5 sessions; bars from the same calendar day one month earlier) from the cache. The exact window Yahoo returns for `1mo` is an assumption.");
  P("4. `lib/candlebacktest.js` (the in-app journal replay) computes everything on 15m bars and uses all prior sessions for volume baselines, so it is a different, easier-to-pass read. This report does not use it.");
  P();

  // ---- baselines + tiers
  const tierIds = ["STRONG_MODERATE", "TIER_STRONG", "TIER_MODERATE", "TIER_WEAK", "LEAN_ANY"];
  const baseIds = ["BASE_LONG", "BASE_SHORT", "BASE_RANDOM", "INVERSE_SM"];
  P("## 4. Tiers and baselines (primary settings, one entry per side-run)");
  P();
  P("Primary settings were fixed before running: " + PRIMARY.map((p) => `**${p.name}** = ${p.note}`).join("; ") + ". The baselines show what a signal-free or inverted rule does on the same bars; a signal only means something relative to them.");
  for (const Pm of PRIMARY) {
    P();
    P(`### ${Pm.name}: ${Pm.note}`);
    P();
    const rows = [];
    for (const id of [...tierIds, ...baseIds]) {
      const g = R.get(id, "run", Pm.c);
      rows.push(cellRow(`${id} - discovery`, g.disc), cellRow(`${id} - **validation**`, g.val));
    }
    P(md(CELL_HEAD, rows));
  }
  P();
  P();
  P("### How often does the board fire, and does that drift through the day?");
  P();
  const bk = [["09:30-10:15", 0, 615], ["10:15-12:00", 615, 720], ["12:00-14:00", 720, 840], ["14:00-15:15", 840, 1000]];
  P(md(["decision time (IST)", "stock-bars", "any side", "strong", "moderate", "weak", "volume-spike helper on", "range >= 1.15x helper on", "avg checks counted (of 6)"], bk.map(([nm, lo, hi]) => {
    const x = R.dec.filter((d) => d.tm > lo && d.tm <= hi);
    const pc = (f) => f1(x.filter(f).length / Math.max(1, x.length));
    return [nm, x.length, pc((d) => d.side), pc((d) => d.tier === 3), pc((d) => d.tier === 2), pc((d) => d.tier === 1), pc((d) => d.vsOn), pc((d) => d.rangeRatio != null && d.rangeRatio >= 1.15), (x.reduce((s2, d) => s2 + d.tot, 0) / Math.max(1, x.length)).toFixed(2)];
  })));
  P();
  P("The volume-spike helper is a running maximum over the day and the range helper compares a part-day range with full-day averages, so both can only become more likely as the session ages (see `CODE_REVIEW.md`, findings 4-6). If the strong/moderate share climbs through the day here, part of the tier is a clock effect, not a market one.");
  P();
  P("The same table for \"every bar\" (a signal counted at each bar it is on) is in `grid.csv`; those events overlap in time, so they are far less independent than the table above.");
  P();

  // ---- ablation
  P("## 5. Ablation: which component adds anything?");
  P();
  P("Single checks use the check's side alone; leave-one-out applies the lean rule (agree >= 3 and >= 60%) to the other five checks. A component only 'adds' if removing it clearly lowers the result; where intervals overlap, the honest answer is that the data cannot separate them.");
  for (const Pm of PRIMARY) {
    P();
    P(`### ${Pm.name}: ${Pm.note} - validation half`);
    P();
    const full = R.get("LEAN_ANY", "run", Pm.c);
    const rows = [];
    rows.push(cellRow("LEAN_ANY (all six checks)", full.val));
    A.CHECK_NAMES.forEach((nm, k) => {
      const g = R.get("LOO_" + k, "run", Pm.c);
      const d = g.val.netExp != null && full.val.netExp != null ? g.val.netExp - full.val.netExp : null;
      const overlap = g.val.netLo != null && full.val.netLo != null ? !(g.val.netHi < full.val.netLo || g.val.netLo > full.val.netHi) : true;
      rows.push(cellRow(`without ${nm} (delta net ${f2(d)}, ${overlap ? "CIs overlap" : "CIs separate"})`, g.val));
    });
    A.CHECK_NAMES.forEach((nm, k) => rows.push(cellRow(`only ${nm}`, R.get("ONLY_" + k, "run", Pm.c).val)));
    for (const id of ["SM_PATTERN", "SM_RVOL", "SM_DELIV", "SM_DAYCHG", "SM_DAILY", "SM_60M", "SM_MKT", "PAT_ONLY", "DAYCHG_ONLY"]) rows.push(cellRow(R.strategies.find((s) => s.id === id).label, R.get(id, "run", Pm.c).val));
    P(md(CELL_HEAD, rows));
  }
  P();
  P("Display-only items (candle patterns, RVOL, delivery %, day change) are tested only as standalone rules and as filters on strong+moderate, never as tier attribution. Daily/60m/Nifty regime rows use only information known before the decision.");
  P();

  // ---- 1:1 table
  P("## 6. 1:1 settings after costs, validation half");
  P();
  const oneRows = [];
  for (const g of R.oneEligible.filter((x) => x.mode === "run" && cParts(x.c).h === 1 && cParts(x.c).e === 1).sort((a, b) => (b.val.netExp || -9) - (a.val.netExp || -9)).slice(0, 40)) oneRows.push(cellRow(`${g.strat.id} - ${BARRIERS[cParts(g.c).b].id}`, g.val));
  P("Listing: run mode, 90m horizon, next-5m-open entry, strategies with enough validation signals, sorted by validation net expectancy (a descriptive listing, not a selection). All settings are in `grid.csv`.");
  P();
  P(oneRows.length ? md(CELL_HEAD, oneRows) : "_No 1:1 cell reached the minimum decidable count in the validation half._");
  P();

  // ---- slices
  P("## 7. Slices (primary settings; validation and discovery side by side)");
  P();
  P(`Cells with fewer than ${A.MIN_DEC} decidable signals say "insufficient n". "All bars" = both sides at every decision in the slice, a signal-free reference. ${R.sliceCells} slice cells were examined: expect several to look good or bad by chance.`);
  for (const sid of ["STRONG_MODERATE", "LEAN_ANY"]) {
    for (const Pm of PRIMARY) {
      P();
      P(`### ${sid} at ${Pm.name} (${Pm.note})`);
      const dims = [...new Set(R.sliceResults.filter((x) => x.sid === sid && x.P.name === Pm.name).map((x) => x.dimName))];
      for (const dn of dims) {
        P();
        P(`**${dn}**`);
        P();
        const rows = R.sliceResults.filter((x) => x.sid === sid && x.P.name === Pm.name && x.dimName === dn).map((x) => {
          const v = x.val;
          const b = x.bval;
          return [
            x.label,
            `${x.disc.n}/${x.disc.dec}`,
            x.disc.dec < A.MIN_DEC ? "insufficient n" : `${f1(x.disc.hit)} / ${f2(x.disc.netExp)}`,
            `${v.n}/${v.dec}`,
            v.dec < A.MIN_DEC ? "insufficient n" : `${f1(v.hit)} (${f1(v.clLo)}-${f1(v.clHi)}) / ${f2(v.netExp)}`,
            b && b.dec >= A.MIN_DEC ? `${f1(b.hit)} / ${f2(b.netExp)}` : "insufficient n",
          ];
        });
        P(md(["slice", "disc. events/dec.", "disc. hit / net exp. %", "valid. events/dec.", "valid. hit (day-cluster CI) / net exp. %", "valid. all bars: hit / net exp. %"], rows));
      }
    }
  }
  P();

  // ---- multiple comparisons + limits
  P("## 8. Multiple comparisons and limits");
  P();
  P(`- ${grid.length} configurations x 3 windows were computed and ${R.sliceCells} slice cells; nothing here was tuned. All thresholds (tiers, RVOL >= ${A.RVOL_MIN}, day change >= ${A.DAYCHG_MIN}%, 0.1% tolerance etc.) are the live ones or were fixed before the run.`);
  P(`- With ${R.valEligible.length} testable validation cells, roughly ${H.expectedByChanceNominal} nominal "p < 0.05" results are expected from noise; cells share events and days, so they are strongly correlated and the count of independent tests is smaller but unknowable.`);
  P("- Day-cluster intervals use few clusters (about " + (R.nDays - R.split) + " validation sessions) with a t-distribution; with so few clusters they are still approximate and likely somewhat too narrow.");
  P("- 'Both in one candle' is never counted as a win; for expectancy it is charged as a stop. Trades that hit neither barrier are marked at the horizon close ('timeout'), or at the session close if the horizon would run past it ('open').");
  P("- Underlying only: no option premium, theta, IV change, spread, brokerage, STT or liquidity. Costs are a flat " + opts.cost + "% per side of the underlying, an assumption, not a measurement.");
  P("- One regime: roughly two months of one market. A result here says nothing about other regimes.");
  P();
  P("## 9. Files");
  P();
  P("`report.md` (this), `results.json`, `grid.csv` (every configuration x window), `signals.csv.gz` (every lean signal in run mode with all " + NC + " outcomes; `configs.json` lists what each `res_c*`/`ret_c*` column is), `missing_symbols.json`, `parity.json` (when produced), `run_command.txt`.");
  return L.join("\n");
}

// ---------------------------------------------------------------------------------------------------------
module.exports = { run, report, headline, PRIMARY, cfgName };

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const data = get("--data", path.join(__dirname, "data"));
  const out = get("--out", __dirname);
  const fixArg = get("--fix", "");
  const fix = fixArg ? Object.fromEntries(fixArg.split(",").filter(Boolean).map((k) => [k, true])) : null;
  const R = run({
    data, out, mode: get("--mode", "live"), cost: Number(get("--cost", 0.05)), limit: get("--limit") ? Number(get("--limit")) : undefined, fix,
    command: "node " + path.relative(process.cwd(), __filename) + " " + args.join(" "),
  });
  console.log(JSON.stringify(headline(R), null, 1));
}
