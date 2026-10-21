"use strict";

// Explore context filters for candle shapes on the cached NSE F&O universe.
// This is research-only; it does not feed Live Calls. Signal at a completed 5m
// bar, enter at the next 5m open, structural stop, 1R/2R target, EOD exit.

const path = require("node:path");
const fs = require("node:fs");
const { loadDataset } = require("../backtest-2026-10-20/loader");
const Engine = require("../backtest-2026-10-20/engine");
const Sector = require("../../lib/sector");
const Stats = require("../backtest-2026-10-20/stats");

const ROOT = path.join(__dirname, "..", "backtest-2026-10-20", "data");
const START = "2026-08-24";
const END = "2026-10-19";
const COSTS_PER_SIDE = [0.05, 0.10];
const MAX_RISK_PCT = 1.0;
const PATTERNS = ["bullish engulfing", "bearish engulfing", "hammer", "shooting star", "bull marubozu", "bear marubozu", "outside bar", "inside-breakout"];
const FILTERS = ["shape_only", "trend_60m", "vwap_side", "opening_range", "trend_60m_rvol", "local_extreme"];
const FILTER_COUNT = PATTERNS.length * FILTERS.length * 2;

function validBar(b) { return b && [b.o, b.hi, b.lo, b.cl, b.vol, b.mm, b.t].every(Number.isFinite) && b.o > 0 && b.lo > 0 && b.hi >= Math.max(b.o, b.cl) && b.lo <= Math.min(b.o, b.cl); }

function insideBreakSignals(bars, dayStart, dayEnd) {
  const out = [];
  for (let i = dayStart + 1; i < dayEnd - 1; i++) {
    const mother = bars[i - 1], inside = bars[i];
    if (!(inside.hi <= mother.hi && inside.lo >= mother.lo)) continue;
    for (let k = i + 1; k < Math.min(dayEnd - 1, i + 4); k++) {
      const b = bars[k];
      if (b.mm + 5 >= 870) break;
      if (b.cl > inside.hi) { out.push({ i: k, fillI: k + 1, side: 1, kind: "inside-breakout", stop: inside.lo, contextI: k }); break; }
      if (b.cl < inside.lo) { out.push({ i: k, fillI: k + 1, side: -1, kind: "inside-breakout", stop: inside.hi, contextI: k }); break; }
    }
  }
  return out;
}

function localContext(st, i, dayStart, dayEnd, cache) {
  const b = st.b5[i];
  const key = `${dayStart}:${i}`;
  if (cache.has(key)) return cache.get(key);
  const session = st.b5.slice(dayStart, i + 1);
  const openBars = session.filter((x) => x.mm >= 555 && x.mm < 570);
  const or = openBars.length >= 3 ? { hi: Math.max(...openBars.map((x) => x.hi)), lo: Math.min(...openBars.map((x) => x.lo)) } : null;
  const vwap = Sector.vwapSeries(session).at(-1);
  const prevVol = st.b5.slice(Math.max(dayStart, i - 20), i).map((x) => x.vol).filter((x) => x > 0).sort((a, b) => a - b);
  const med = prevVol.length >= 10 ? prevVol[Math.floor((prevVol.length - 1) / 2)] : null;
  const rvol = med > 0 && b.vol > 0 ? b.vol / med : null;
  const lb = st.b5.slice(Math.max(dayStart, i - 12), i);
  const lo = lb.length ? Math.min(...lb.map((x) => x.lo)) : null;
  const hi = lb.length ? Math.max(...lb.map((x) => x.hi)) : null;
  const T = b.t + 300;
  const trend = Engine.hourTrendSign(st, T, b.cl);
  const ctx = { trend, vwap, or, rvol, localLow: lo, localHigh: hi, time: T, dayEnd };
  cache.set(key, ctx);
  return ctx;
}

function passes(filter, sig, ctx, bars) {
  const direction = sig.side;
  if (filter === "shape_only") return true;
  if (filter === "trend_60m") return ctx.trend === direction;
  if (filter === "vwap_side") return (direction > 0 ? bars[sig.contextI].cl > ctx.vwap : bars[sig.contextI].cl < ctx.vwap);
  if (filter === "opening_range") return !!ctx.or && (direction > 0 ? bars[sig.contextI].cl > ctx.or.hi : bars[sig.contextI].cl < ctx.or.lo);
  if (filter === "trend_60m_rvol") return ctx.trend === direction && ctx.rvol != null && ctx.rvol >= 1.5;
  if (filter === "local_extreme") {
    const b = bars[sig.contextI];
    const nearLow = ctx.localLow != null && b.lo <= ctx.localLow * 1.001;
    const nearHigh = ctx.localHigh != null && b.hi >= ctx.localHigh * 0.999;
    return direction > 0 ? nearLow : nearHigh;
  }
  return false;
}

function collectSignals(st, dates) {
  const out = [];
  const dateSet = new Set(dates);
  const contexts = new Map();
  const { b5, idx5 } = st;
  for (let dayOrd = 0; dayOrd < idx5.dates.length; dayOrd++) {
    const date = idx5.dates[dayOrd];
    if (!dateSet.has(date)) continue;
    const dayStart = idx5.starts[dayOrd], dayEnd = idx5.ends[dayOrd] + 1;
    const dayBars = b5.slice(dayStart, dayEnd);
    if (dayBars.length < 60) continue;
    const signals = [];
    for (let i = dayStart + 1; i < dayEnd - 1; i++) {
      const b = b5[i];
      if (b.mm + 5 < 570 || b.mm + 5 >= 870 || !validBar(b) || !validBar(b5[i + 1])) continue;
      for (const p of Sector.patternAt(b5, i)) {
        if (p.dir && PATTERNS.slice(0, 7).includes(p.name)) signals.push({ i, fillI: i + 1, side: p.dir === "up" ? 1 : -1, kind: p.name, stop: p.dir === "up" ? b.lo : b.hi, contextI: i });
      }
    }
    signals.push(...insideBreakSignals(b5, dayStart, dayEnd));
    for (const filter of FILTERS) {
      const seen = new Set();
      for (const sig of signals) {
        if (seen.has(sig.kind)) continue;
        const ctx = localContext(st, sig.contextI, dayStart, dayEnd, contexts);
        if (!passes(filter, sig, ctx, b5)) continue;
        const entry = b5[sig.fillI].o;
        const risk = sig.side > 0 ? entry - sig.stop : sig.stop - entry;
        if (!(entry > 0 && risk > 0 && risk / entry * 100 <= MAX_RISK_PCT)) continue;
        const row = { sym: st.sym, date, kind: sig.kind, filter, side: sig.side, signalMM: b5[sig.i].mm, entryMM: b5[sig.fillI].mm, regime: Engine.dailyTrendSign(st.bd, date) };
        for (const targetR of [1, 2]) row[`r${targetR}`] = tradeResult(dayBars, { ...sig, i: sig.i - dayStart, fillI: sig.fillI - dayStart }, targetR);
        if ([row.r1, row.r2].some((x) => !x)) continue;
        seen.add(sig.kind);
        out.push(row);
      }
    }
  }
  return out;
}

function tradeResult(bars, sig, targetR) {
  const fill = bars[sig.fillI];
  if (!fill || !(fill.o > 0)) return null;
  const entry = fill.o;
  const risk = sig.side > 0 ? entry - sig.stop : sig.stop - entry;
  if (!(risk > 0) || risk / entry * 100 > MAX_RISK_PCT) return null;
  const target = entry + sig.side * risk * targetR;
  let exit = bars[bars.length - 1].cl, result = "eod";
  for (let i = sig.fillI; i < bars.length; i++) {
    const b = bars[i];
    const stopHit = sig.side > 0 ? b.lo <= sig.stop : b.hi >= sig.stop;
    const targetHit = sig.side > 0 ? b.hi >= target : b.lo <= target;
    if (stopHit) { exit = sig.side > 0 ? Math.min(b.o, sig.stop) : Math.max(b.o, sig.stop); result = targetHit ? "both-stop" : "stop"; break; }
    if (targetHit) { exit = target; result = "target"; break; }
  }
  const grossR = sig.side * (exit - entry) / risk;
  return { grossR, result, entry, riskPct: risk / entry * 100 };
}

function summarize(events, dates, startDate, costSide, predicate = () => true) {
  const validDates = dates.filter((d) => d >= startDate);
  const results = [];
  for (const kind of PATTERNS) for (const filter of FILTERS) for (const targetR of [1, 2]) {
    const selected = events.filter((e) => e.kind === kind && e.filter === filter && e.date >= startDate && predicate(e));
    const netPerTrade = (e) => e[`r${targetR}`].grossR - (2 * costSide / 100) / (e[`r${targetR}`].riskPct / 100);
    const perDay = validDates.map((date) => { const xs = selected.filter((e) => e.date === date); return { s: xs.reduce((a, e) => a + netPerTrade(e), 0), n: xs.length }; });
    const grossPerDay = validDates.map((date) => { const xs = selected.filter((e) => e.date === date); return { s: xs.reduce((a, e) => a + e[`r${targetR}`].grossR, 0), n: xs.length }; });
    const stat = Stats.clusterRatio(perDay), gross = Stats.clusterRatio(grossPerDay);
    results.push({ kind, filter, targetR, n: selected.length, meanGrossR: gross.mean, meanNetR: stat.mean, ci: stat.ci, p: stat.p1, clusterDays: stat.G, hitPct: selected.length ? selected.filter((e) => e[`r${targetR}`].result === "target").length / selected.length : null, bothBars: selected.filter((e) => e[`r${targetR}`].result === "both-stop").length });
  }
  const q = Stats.bhAdjust(results.map((x) => x.p));
  results.forEach((x, i) => { x.q = q[i]; });
  return results;
}

function run() {
  const ds = loadDataset(ROOT);
  const dates = [...ds.calendar].filter((d) => d >= START && d <= END).sort();
  const split = Math.floor(dates.length / 2), validationStart = dates[split];
  const events = ds.stocks.flatMap((st) => collectSignals(st, dates));
  const validations = summarize(events, dates, validationStart, COSTS_PER_SIDE[0]);
  const discoveries = summarize(events, dates, dates[0], COSTS_PER_SIDE[0]);
  const up = summarize(events, dates, validationStart, COSTS_PER_SIDE[0], (e) => e.side > 0);
  const down = summarize(events, dates, validationStart, COSTS_PER_SIDE[0], (e) => e.side < 0);
  const stress = summarize(events, dates, validationStart, COSTS_PER_SIDE[1]);
  const validationEvents = events.filter((e) => e.date >= validationStart);
  const regimes = {
    priorNiftyAboveSma20: summarize(events, dates, validationStart, COSTS_PER_SIDE[0], (e) => e.regime > 0),
    priorNiftyBelowSma20: summarize(events, dates, validationStart, COSTS_PER_SIDE[0], (e) => e.regime < 0),
    priorNiftyUnknown: summarize(events, dates, validationStart, COSTS_PER_SIDE[0], (e) => e.regime === 0),
  };
  const inferenceFamilies = [validations, stress, up, down, ...Object.values(regimes)];
  const inferenceRows = inferenceFamilies.flat();
  const globalQ = Stats.bhAdjust(inferenceRows.map((r) => r.p));
  inferenceRows.forEach((r, i) => { r.q = globalQ[i]; });
  const fmt = (x, n = 3) => x == null || !Number.isFinite(x) ? "—" : x.toFixed(n);
  const sorted = validations.slice().sort((a, b) => (b.meanNetR ?? -Infinity) - (a.meanNetR ?? -Infinity));
  const lines = [
    "# Context-aware candlestick replay — 2026-10-21", "",
    `Data: ${ds.stocks.length} current F&O symbols, ${dates.length} full sessions (${dates[0]} to ${dates.at(-1)}); discovery ${split} sessions, validation ${dates.length - split} sessions from ${validationStart}. ${validationEvents.length} overlapping context events across ${new Set(validationEvents.map((e) => e.date)).size} market days.`,
    `Signals use completed 5m bars and fill at the next 5m open. Stops are signal/pattern extremes; targets 1R/2R; same-bar stop/target is charged as a stop; EOD exits; max underlying risk ${MAX_RISK_PCT}%; base cost ${COSTS_PER_SIDE[0]}% per side. Sensitivity also reports ${COSTS_PER_SIDE[1]}% per side. No option premiums, spread, slippage, brokerage or taxes.`,
    `The 60m filter uses only a 60m candle whose close time is no later than the signal close. Session VWAP and opening range use bars available by that close. Relative volume compares the signal bar with the median of up to 20 prior 5m bars in the same session (at least 10 positive-volume bars required). Local-extreme reversal requires the signal bar to touch within 0.1% of the prior 12-bar low/high.`,
    `This is exploratory, fixed-family screening after earlier pattern research, not a fresh pre-registered test. Global BH correction covers ${inferenceRows.length} rows across the pooled validation, cost stress, direction splits and three Nifty-regime slices (${FILTER_COUNT} pattern/filter/target configurations per slice). The same events overlap across patterns and filters; day clustering reduces but does not eliminate dependence. Today's F&O membership causes survivorship bias.`, "",
    "## Validation ranking at base cost (all filters/patterns; descriptive ranking only)", "",
    "| Pattern | Context filter | Target | n | Target hit | Gross R | Net R | 95% day-cluster CI | p(net≤0) | BH q | same-bar both |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of sorted.slice(0, 40)) lines.push(`| ${r.kind} | ${r.filter} | ${r.targetR}R | ${r.n} | ${r.hitPct == null ? "—" : fmt(r.hitPct * 100, 1) + "%"} | ${fmt(r.meanGrossR)} | ${fmt(r.meanNetR)} | ${fmt(r.ci[0])} to ${fmt(r.ci[1])} | ${fmt(r.p)} | ${fmt(r.q)} | ${r.bothBars} |`);
  lines.push("", "## Family conclusions", "", `Positive validation net rows at p<.05: ${validations.filter((r) => r.n >= 100 && r.meanNetR > 0 && r.p < 0.05).length}/${validations.filter((r) => r.n >= 100).length} eligible. Positive after BH q<.10: ${validations.filter((r) => r.n >= 100 && r.meanNetR > 0 && r.q < 0.10).length}.`, "", "### Cost stress: best 10 rows re-rated at 0.10% per side", "", "| Pattern | Context filter | Target | n | Net R | 95% CI | p | BH q |", "|---|---|---:|---:|---:|---:|---:|---:|");
  for (const best of sorted.slice(0, 10)) { const s = stress.find((r) => r.kind === best.kind && r.filter === best.filter && r.targetR === best.targetR); lines.push(`| ${s.kind} | ${s.filter} | ${s.targetR}R | ${s.n} | ${fmt(s.meanNetR)} | ${fmt(s.ci[0])} to ${fmt(s.ci[1])} | ${fmt(s.p)} | ${fmt(s.q)} |`); }
  lines.push("", "## Regime and direction checks", "", "Regime is prior Nifty daily close versus its trailing 20-session SMA; unknown rows are excluded from directional regimes. Tables below list the 15 best validation configurations inside each slice. Results after selecting from this same validation period are descriptive and require a new holdout.", "");
  for (const [name, rows] of Object.entries(regimes)) {
    lines.push(`### ${name}`, "", "| Pattern | Context filter | Target | n | Net R | 95% CI | BH q |", "|---|---|---:|---:|---:|---:|---:|");
    for (const r of rows.slice().sort((a, b) => (b.meanNetR ?? -Infinity) - (a.meanNetR ?? -Infinity)).slice(0, 15)) lines.push(`| ${r.kind} | ${r.filter} | ${r.targetR}R | ${r.n} | ${fmt(r.meanNetR)} | ${fmt(r.ci[0])} to ${fmt(r.ci[1])} | ${fmt(r.q)} |`);
    lines.push("");
  }
  const id = (r) => `${r.kind}|${r.filter}|${r.targetR}`;
  lines.push("### Side split of best pooled-validation rows", "", "| Pattern | Context filter | Target | Long n / net R | Short n / net R |", "|---|---|---:|---:|---:|");
  for (const b of sorted.slice(0, 20)) {
    const l = up.find((x) => id(x) === id(b)), s = down.find((x) => id(x) === id(b));
    lines.push(`| ${b.kind} | ${b.filter} | ${b.targetR}R | ${l.n} / ${fmt(l.meanNetR)} | ${s.n} / ${fmt(s.meanNetR)} |`);
  }
  lines.push("", "## Decision", "", "A positive row here is a candidate for a genuinely untouched follow-up, not sufficient evidence to add a CE/PE call. Live Calls must remain unchanged unless a specific configuration has positive cost-adjusted validation, survives family correction, behaves across both market regimes and both directions, and passes option-premium plus prospective paper validation. Underlying results are not option returns.", "");
  fs.writeFileSync(path.join(__dirname, "report.md"), lines.join("\n"));
  fs.writeFileSync(path.join(__dirname, "results.json"), JSON.stringify({ meta: { symbols: ds.stocks.length, dates, split, validationStart, baseCostPerSidePct: COSTS_PER_SIDE[0], stressCostPerSidePct: COSTS_PER_SIDE[1], maxRiskPct: MAX_RISK_PCT, eventCount: events.length, validationEvents: validationEvents.length, filterCount: FILTER_COUNT, correctedComparisonCount: inferenceRows.length }, validation: validations, discovery: discoveries, stress, byDirection: { up, down }, regimes }, null, 2));
  console.log(lines.slice(0, 9).join("\n"));
  console.log(`\nSaved ${events.length} events; validation rows ${validations.length}; best net validation row: ${JSON.stringify(sorted[0])}`);
}

run();
