"use strict";

// Fixed candlestick-pattern study. No live code is changed by this script.
// Signals use completed 5m OHLC bars; entries are the next 5m bar open; the stop
// is the signal pattern's extreme; targets are fixed at 1R and 2R; all trades
// exit by the last 5m close of the session. One signal per symbol/pattern/day.

const path = require("node:path");
const { loadDataset } = require("../backtest-2026-10-20/loader");
const { patternAt } = require("../../lib/sector");
const Stats = require("../backtest-2026-10-20/stats");

const ROOT = path.join(__dirname, "..", "backtest-2026-10-20", "data");
const START = "2026-08-24";
const END = "2026-10-19";
const COST_PER_SIDE_PCT = 0.05;
const MAX_UNDERLYING_RISK_PCT = 1.0;

function allPatternSignals(bars, dayStart, dayEnd) {
  const out = [];
  for (let i = dayStart; i < dayEnd; i++) {
    const b = bars[i];
    const mmClose = b.mm + 5;
    if (mmClose < 570 || mmClose >= 870 || i + 1 >= dayEnd) continue; // 09:30-14:30 signal closes only
    for (const p of patternAt(bars, i)) {
      if (!p.dir || !["bullish engulfing", "bearish engulfing", "hammer", "shooting star", "bull marubozu", "bear marubozu", "outside bar"].includes(p.name)) continue;
      out.push({ i, fillI: i + 1, side: p.dir === "up" ? 1 : -1, kind: p.name, stop: p.dir === "up" ? b.lo : b.hi });
    }
    // Inside bars are neutral labels in the UI. Test a separate, explicit follow-through rule:
    // first later close outside the inside bar range, stop at the opposite side of that range.
    const prev = bars[i - 1];
    if (prev && b.hi <= prev.hi && b.lo >= prev.lo) {
      let trigger = -1;
      let side = 0;
      for (let k = i + 1; k < Math.min(dayEnd - 1, i + 4); k++) {
        if (bars[k].cl > b.hi) { trigger = k; side = 1; break; }
        if (bars[k].cl < b.lo) { trigger = k; side = -1; break; }
      }
      if (trigger >= 0 && bars[trigger].mm + 5 < 870) {
        out.push({ i: trigger, fillI: trigger + 1, side, kind: "inside-breakout", stop: side > 0 ? b.lo : b.hi });
      }
    }
  }
  return out;
}

function tradeResult(bars, sig, targetR) {
  const entryBar = bars[sig.fillI];
  if (!entryBar || !(entryBar.o > 0)) return null;
  const entry = entryBar.o;
  const risk = sig.side > 0 ? entry - sig.stop : sig.stop - entry;
  if (!(risk > 0) || !(risk / entry > 0.0001)) return null;
  if ((risk / entry) * 100 > MAX_UNDERLYING_RISK_PCT) return null;
  const target = entry + sig.side * risk * targetR;
  let exit = bars[bars.length - 1].cl;
  let exitCode = "eod";
  for (let i = sig.fillI; i < bars.length; i++) {
    const b = bars[i];
    const stopHit = sig.side > 0 ? b.lo <= sig.stop : b.hi >= sig.stop;
    const targetHit = sig.side > 0 ? b.hi >= target : b.lo <= target;
    if (stopHit) {
      exit = sig.side > 0 ? Math.min(b.o, sig.stop) : Math.max(b.o, sig.stop);
      exitCode = stopHit && targetHit ? "both-stop" : "stop"; // conservative if both in one 5m bar
      break;
    }
    if (targetHit) { exit = target; exitCode = "target"; break; }
  }
  const grossR = sig.side * (exit - entry) / risk;
  const costR = (2 * COST_PER_SIDE_PCT / 100) / (risk / entry);
  return { netR: grossR - costR, grossR, result: exitCode, riskPct: (risk / entry) * 100 };
}

function run() {
  const ds = loadDataset(ROOT);
  const dates = [...ds.calendar].filter((d) => d >= START && d <= END).sort();
  const kinds = ["bullish engulfing", "bearish engulfing", "hammer", "shooting star", "bull marubozu", "bear marubozu", "outside bar", "inside-breakout"];
  const events = [];
  let scannedDays = 0;
  for (const st of ds.stocks) {
    const byDate = st.idx5.dates;
    for (let dayOrd = 0; dayOrd < byDate.length; dayOrd++) {
      const date = byDate[dayOrd];
      if (!dates.includes(date)) continue;
      const dayStart = st.idx5.starts[dayOrd];
      const dayEnd = st.idx5.ends[dayOrd] + 1;
      const bars = st.b5;
      const signals = allPatternSignals(bars, dayStart, dayEnd);
      const seen = new Set();
      for (const sig of signals) {
        if (seen.has(sig.kind)) continue;
        const row = { sym: st.sym, date, kind: sig.kind, side: sig.side, signalMM: bars[sig.i].mm, entryMM: bars[sig.fillI].mm };
        for (const r of [1, 2]) row[`r${r}`] = tradeResult(bars.slice(dayStart, dayEnd), { ...sig, i: sig.i - dayStart, fillI: sig.fillI - dayStart }, r);
        if (!row.r1 || !row.r2) continue;
        seen.add(sig.kind); // first eligible trade per name, stock and session
        events.push(row);
      }
    }
  }
  scannedDays = dates.length;
  const split = Math.floor(scannedDays / 2);
  const validationStart = dates[split];
  const resultRows = [];
  for (const kind of kinds) for (const targetR of [1, 2]) {
    const all = events.filter((e) => e.kind === kind);
    const validation = all.filter((e) => e.date >= validationStart);
    const perDay = dates.slice(split).map((date) => {
      const xs = validation.filter((e) => e.date === date);
      return { s: xs.reduce((n, x) => n + x[`r${targetR}`].netR, 0), n: xs.length };
    });
    const stat = Stats.clusterRatio(perDay);
    const grossByDay = dates.slice(split).map((date) => {
      const xs = validation.filter((e) => e.date === date);
      return { s: xs.reduce((n, x) => n + x[`r${targetR}`].grossR, 0), n: xs.length };
    });
    const gross = Stats.clusterRatio(grossByDay);
    const wins = validation.filter((e) => e[`r${targetR}`].result === "target").length;
    resultRows.push({ kind, targetR, discoveryN: all.filter((e) => e.date < validationStart).length, validationN: validation.length, hit: validation.length ? wins / validation.length : null, meanGrossR: gross.mean, grossCI: gross.ci, meanNetR: stat.mean, ci: stat.ci, p: stat.p1, days: stat.G, both: validation.filter((e) => e[`r${targetR}`].result === "both-stop").length });
  }
  const qs = Stats.bhAdjust(resultRows.map((r) => r.p));
  resultRows.forEach((r, i) => { r.q = qs[i]; });
  const f = (x, n = 3) => x == null || !Number.isFinite(x) ? "—" : x.toFixed(n);
  const lines = [
    "# Candlestick strategy study — 2026-10-21", "",
    `Data: cached NSE F&O universe, ${ds.stocks.length} usable symbols; ${scannedDays} validated full sessions (${dates[0]} to ${dates.at(-1)}). Discovery: first ${split} sessions. Validation: last ${scannedDays - split} sessions from ${validationStart}.`,
    `Each named candle is tested as the only signal. Fixed rules: first eligible signal per symbol/pattern/session; closed 5m trigger; fill at next 5m open; stop at pattern extreme; skip if the underlying stop is wider than ${MAX_UNDERLYING_RISK_PCT}% of entry; target 1R or 2R; exit at stop, target, or last bar close; both touched in one bar is charged as the stop. Underlying cost assumption: ${COST_PER_SIDE_PCT}% per side. Cluster confidence intervals group by trading day. Benjamini–Hochberg correction covers ${resultRows.length} pattern/target comparisons.`,
    "", "This is a predeclared fixed-rule screening study, not an options backtest. It does not model option premiums, spread, IV, theta, broker charges, taxes or slippage. The sample is short and recent; symbol membership is today's F&O list, so survivorship bias remains.", "",
    "| Pattern | Target | Discovery n | Validation n | Target hit | Gross mean (R) | Net mean (R) | 95% day-cluster net CI | p(net ≤ 0) | BH q | Both bars (charged stop) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of resultRows) lines.push(`| ${r.kind} | ${r.targetR}R | ${r.discoveryN} | ${r.validationN} | ${r.hit == null ? "—" : f(r.hit * 100, 1) + "%"} | ${f(r.meanGrossR)} | ${f(r.meanNetR)} | ${f(r.ci[0])} to ${f(r.ci[1])} | ${f(r.p)} | ${f(r.q)} | ${r.both} |`);
  lines.push("", "## Interpretation guardrails", "", "- A pattern is only a candle-shape definition. The study does not establish a profitable strategy or transferable edge.", "- Named patterns overlap in time and stock; the per-day cluster interval addresses shared market days, while BH adjusts this fixed family of 16 comparisons.", "- The validation period was held out from choosing the rule definitions, but this is still one market regime and not a fresh prospective test.", "- Do not add a pattern to actionable Live Calls unless its validation net expectancy is positive, survives correction, has a sufficiently narrow day-cluster interval, and is separately validated on option data / prospective paper calls.", "");
  const fs = require("node:fs");
  fs.writeFileSync(path.join(__dirname, "report.md"), lines.join("\n"));
  fs.writeFileSync(path.join(__dirname, "results.json"), JSON.stringify({ meta: { symbols: ds.stocks.length, dates, split, validationStart, costPerSidePct: COST_PER_SIDE_PCT, maxUnderlyingRiskPct: MAX_UNDERLYING_RISK_PCT, eventCount: events.length }, results: resultRows }, null, 2));
  console.log(lines.slice(0, 7).join("\n"));
  console.log(`\nSaved ${events.length} pattern events to ${path.join(__dirname, "results.json")}`);
}

run();
