"use strict";

// Fixed research study for long-only cash swing signals. It reuses the repo's
// candle-shape definitions, enters at the next NSE session open, uses a 2R
// target and a pattern-low stop, and forces an exit after 5/10/20 sessions.
// It never changes the Live Calls rulebook.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { patternAt } = require("../../lib/sector");
const Stats = require("../backtest-2026-10-20/stats");

const DIR = __dirname;
const CACHE = path.join(__dirname, "..", "backtest-2026-10-20", "data");
const SNAPSHOT = path.join(DIR, "daily-snapshot.json.gz");
const RESULTS = path.join(DIR, "results.json");
const REPORT = path.join(DIR, "report.md");
const PATTERNS = ["bullish engulfing", "hammer", "bull marubozu", "outside bar"];
const PULLBACK = "sma20 pullback reclaim";
const CONTEXTS = ["shape_only", "stock_uptrend", "market_uptrend", "both_uptrends"];
const HORIZONS = [5, 10, 20];
const TARGET_R = 2;
const MIN_STOP_PCT = 0.5;
const MAX_STOP_PCT = 8;
const COSTS_PER_SIDE = [0.05, 0.10];
const BOOTSTRAPS = 2500;
const INDICATOR_WARMUP = 50;
const EMBARGO_SESSIONS = 20;

function cleanDaily(raw) {
  const meta = raw && raw.meta || {};
  const q = raw && raw.indicators && raw.indicators.quote && raw.indicators.quote[0];
  const adj = raw && raw.indicators && raw.indicators.adjclose && raw.indicators.adjclose[0] && raw.indicators.adjclose[0].adjclose;
  const ts = raw && raw.timestamp || [];
  if (!q) return [];
  const off = Number.isFinite(meta.gmtoffset) ? meta.gmtoffset : 19800;
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const vals = [q.open && q.open[i], q.high && q.high[i], q.low && q.low[i], q.close && q.close[i]];
    if (!vals.every((v) => Number.isFinite(v) && v > 0)) continue;
    const close = vals[3];
    const factor = adj && Number.isFinite(adj[i]) && adj[i] > 0 ? adj[i] / close : 1;
    const bar = {
      date: new Date((ts[i] + off) * 1000).toISOString().slice(0, 10),
      o: vals[0] * factor,
      hi: vals[1] * factor,
      lo: vals[2] * factor,
      cl: close * factor,
      vol: q.volume && Number.isFinite(q.volume[i]) ? q.volume[i] : 0,
    };
    if (bar.hi >= Math.max(bar.o, bar.cl) && bar.lo <= Math.min(bar.o, bar.cl)) out.push(bar);
  }
  return out;
}

function readCache() {
  const meta = JSON.parse(fs.readFileSync(path.join(CACHE, "meta.json"), "utf8"));
  const stocks = [];
  for (const u of meta.universe) {
    try {
      stocks.push({ sym: u.sym, bars: cleanDaily(JSON.parse(fs.readFileSync(path.join(CACHE, "raw", "1d", `${u.sym}.json`), "utf8"))) });
    } catch (_) { /* report unavailable symbols after loading */ }
  }
  const nifty = cleanDaily(JSON.parse(fs.readFileSync(path.join(CACHE, "raw", "index", "NSEI_1d.json"), "utf8")));
  return { fetchedAt: meta.fetchedAt, source: "Yahoo Finance chart API", universeSource: "NSE F&O list captured in project research cache", stocks, nifty };
}

function writeSnapshot(snapshot) {
  fs.writeFileSync(SNAPSHOT, zlib.gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 }));
}

function readSnapshot() {
  const raw = fs.readFileSync(SNAPSHOT);
  return JSON.parse(zlib.gunzipSync(raw).toString("utf8"));
}

function sma(values, end, n) {
  if (end + 1 < n) return null;
  let sum = 0;
  for (let i = end - n + 1; i <= end; i++) sum += values[i];
  return sum / n;
}

function contextPass(context, stockUp, marketUp) {
  return context === "shape_only" || (context === "stock_uptrend" && stockUp) ||
    (context === "market_uptrend" && marketUp) || (context === "both_uptrends" && stockUp && marketUp);
}

function isPullbackReclaim(bars, i, sma20, stockUp) {
  if (!stockUp || i < 3 || !Number.isFinite(sma20[i])) return false;
  const signal = bars[i];
  if (!(signal.cl > signal.o && signal.cl > sma20[i])) return false;
  for (let k = i - 3; k < i; k++) {
    if (!Number.isFinite(sma20[k]) || !(bars[k].lo <= sma20[k])) return false;
  }
  return true;
}

function simulate(bars, signalIndex, horizon, targetR = TARGET_R, maxStopPct = MAX_STOP_PCT, costPerSidePct = COSTS_PER_SIDE[0], stopOverride = null) {
  const signal = bars[signalIndex];
  const entryBar = bars[signalIndex + 1];
  if (!signal || !entryBar || !(entryBar.o > 0)) return null;
  const entry = entryBar.o;
  const stop = Number.isFinite(stopOverride) ? stopOverride : signal.lo;
  const risk = entry - stop;
  const riskPct = (risk / entry) * 100;
  if (!(risk > 0) || riskPct < MIN_STOP_PCT || riskPct > maxStopPct) return null;
  const target = entry + risk * targetR;
  const end = Math.min(bars.length - 1, signalIndex + horizon);
  if (end !== signalIndex + horizon) return null; // same fixed holding window for every eligible event
  let exit = bars[end].cl;
  let exitIndex = end;
  let outcome = "time";
  for (let i = signalIndex + 1; i <= end; i++) {
    const b = bars[i];
    const stopHit = b.lo <= stop;
    const targetHit = b.hi >= target;
    if (stopHit) {
      exit = b.o <= stop ? b.o : stop;
      exitIndex = i;
      outcome = stopHit && targetHit ? "both-stop" : "stop";
      break;
    }
    if (targetHit) {
      exit = target;
      exitIndex = i;
      outcome = "target";
      break;
    }
  }
  const grossR = (exit - entry) / risk;
  const costPct = (2 * costPerSidePct) / 100;
  const costR = (costPct * entry) / risk;
  const buyHoldNetPct = ((bars[end].cl - entry) / entry - costPct) * 100;
  return {
    entryDate: entryBar.date,
    exitDate: bars[exitIndex].date,
    entry,
    stop,
    target,
    riskPct,
    grossR,
    netR: grossR - costR,
    netPct: ((exit - entry) / entry - costPct) * 100,
    buyHoldNetPct,
    outcome,
    exitIndex,
  };
}

function buildEvents(snapshot) {
  const calendar = snapshot.nifty.map((b) => b.date).sort();
  const dateOrd = new Map(calendar.map((d, i) => [d, i]));
  const niftyByDate = new Map(snapshot.nifty.map((b) => [b.date, b]));
  const niftyCloses = snapshot.nifty.map((b) => b.cl);
  const rows = [];
  let dataGaps = 0;
  for (const stock of snapshot.stocks) {
    const bars = stock.bars;
    if (bars.length < INDICATOR_WARMUP + Math.max(...HORIZONS) + 2) continue;
    const byDate = new Map(bars.map((b, i) => [b.date, i]));
    const closes = bars.map((b) => b.cl);
    const sma20 = closes.map((_, i) => sma(closes, i, 20));
    const sma50 = closes.map((_, i) => sma(closes, i, 50));
    for (let i = INDICATOR_WARMUP - 1; i < bars.length - Math.max(...HORIZONS) - 1; i++) {
      const bar = bars[i];
      const calI = dateOrd.get(bar.date);
      const nextDate = calI == null ? null : calendar[calI + 1];
      if (!nextDate || !byDate.has(nextDate)) { dataGaps++; continue; }
      const s20 = sma20[i];
      const s50 = sma50[i];
      const nI = dateOrd.get(bar.date);
      const marketBar = niftyByDate.get(bar.date);
      if (s20 == null || s50 == null || nI == null || !marketBar) continue;
      const nSma50 = sma(niftyCloses, nI, 50);
      if (nSma50 == null) continue;
      const stockUp = bar.cl > s50 && s20 > s50;
      const marketUp = marketBar.cl > nSma50;
      const pats = patternAt(bars, i).filter((p) => p.dir === "up" && PATTERNS.includes(p.name)).map((p) => ({ name: p.name, stop: bar.lo }));
      if (isPullbackReclaim(bars, i, sma20, stockUp)) {
        pats.push({ name: PULLBACK, stop: Math.min(...bars.slice(i - 3, i + 1).map((b) => b.lo)) });
      }
      for (const p of pats) {
        const contexts = p.name === PULLBACK ? ["stock_uptrend", "both_uptrends"] : CONTEXTS;
        for (const context of contexts) {
          if (!contextPass(context, stockUp, marketUp)) continue;
          for (const horizon of HORIZONS) {
            const sim = simulate(bars, i, horizon, TARGET_R, MAX_STOP_PCT, COSTS_PER_SIDE[0], p.stop);
            if (!sim) continue;
            rows.push({ sym: stock.sym, signalDate: bar.date, pattern: p.name, context, horizon, stockUp, marketUp, ...sim });
          }
        }
      }
    }
  }
  return { calendar, rows, dataGaps };
}

function nonOverlapping(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.sym}|${r.pattern}|${r.context}|${r.horizon}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const out = [];
  for (const group of byKey.values()) {
    group.sort((a, b) => a.signalDate.localeCompare(b.signalDate));
    let lock = "";
    for (const r of group) {
      if (r.signalDate <= lock) continue;
      out.push(r);
      lock = r.exitDate;
    }
  }
  return out;
}

function metrics(rows, validationStart, validationEnd, costPerSidePct = COSTS_PER_SIDE[0]) {
  const use = rows.filter((r) => r.signalDate >= validationStart && r.signalDate <= validationEnd);
  const perDay = new Map();
  let gross = 0, net = 0, netPct = 0, buyHold = 0, wins = 0, stops = 0, target = 0;
  for (const r of use) {
    const costR = (2 * costPerSidePct / 100) / (r.riskPct / 100);
    const nr = r.grossR - costR;
    net += nr; gross += r.grossR;
    netPct += r.netPct + (COSTS_PER_SIDE[0] - costPerSidePct) * 2;
    buyHold += r.buyHoldNetPct + (COSTS_PER_SIDE[0] - costPerSidePct) * 2;
    if (nr > 0) wins++;
    if (r.outcome === "stop" || r.outcome === "both-stop") stops++;
    if (r.outcome === "target") target++;
    const d = perDay.get(r.signalDate) || { s: 0, n: 0 };
    d.s += nr; d.n++;
    perDay.set(r.signalDate, d);
  }
  const c = Stats.clusterRatio([...perDay.values()]);
  return {
    n: use.length,
    days: c.G,
    grossMeanR: use.length ? gross / use.length : null,
    netMeanR: use.length ? net / use.length : null,
    netMeanPct: use.length ? netPct / use.length : null,
    matchedBuyHoldMeanPct: use.length ? buyHold / use.length : null,
    winRate: use.length ? wins / use.length : null,
    targetRate: use.length ? target / use.length : null,
    stopRate: use.length ? stops / use.length : null,
    ci: c.ci,
    pNonPositive: c.p1,
  };
}

function main() {
  if (process.argv.includes("--freeze-cache")) {
    const d = readCache();
    writeSnapshot(d);
    console.log(`Saved ${d.stocks.length} symbols and ${d.nifty.length} Nifty sessions to ${SNAPSHOT}`);
    return;
  }
  const snapshot = readSnapshot();
  const { calendar, rows: rawRows, dataGaps } = buildEvents(snapshot);
  const rows = nonOverlapping(rawRows);
  const first = calendar[0];
  const last = calendar[calendar.length - 1];
  const splitOrd = Math.floor(calendar.length / 2);
  const discoveryStart = calendar[INDICATOR_WARMUP];
  const discoveryEnd = calendar[Math.max(INDICATOR_WARMUP, splitOrd - EMBARGO_SESSIONS - 1)];
  const validationStart = calendar[Math.min(calendar.length - 1, splitOrd)];
  const validationEnd = calendar[calendar.length - Math.max(...HORIZONS) - 1];
  const configs = [];
  const tests = [...PATTERNS.flatMap((pattern) => CONTEXTS.map((context) => ({ pattern, context }))),
    ...["stock_uptrend", "both_uptrends"].map((context) => ({ pattern: PULLBACK, context }))];
  for (const { pattern, context } of tests) for (const horizon of HORIZONS) {
    const subset = rows.filter((r) => r.pattern === pattern && r.context === context && r.horizon === horizon);
    configs.push({ pattern, context, horizon, discovery: metrics(subset, discoveryStart, discoveryEnd), validation: metrics(subset, validationStart, validationEnd), stress: metrics(subset, validationStart, validationEnd, COSTS_PER_SIDE[1]) });
  }
  const qs = Stats.bhAdjust(configs.map((c) => c.validation.pNonPositive));
  configs.forEach((c, i) => { c.validation.bhQ = qs[i]; });
  configs.sort((a, b) => (b.validation.netMeanR ?? -Infinity) - (a.validation.netMeanR ?? -Infinity));
  const payload = {
    methodology: { patterns: [...PATTERNS, PULLBACK], contexts: CONTEXTS, horizons: HORIZONS, targetR: TARGET_R, minStopPct: MIN_STOP_PCT, maxStopPct: MAX_STOP_PCT, costsPerSidePct: COSTS_PER_SIDE, indicatorWarmup: INDICATOR_WARMUP, embargoSessions: EMBARGO_SESSIONS, familySize: configs.length, fill: "next NSE session open", stop: "pattern low or four-bar low for SMA20 reclaim candidate", ambiguousBar: "stop first", exit: "2R target, stop or fixed 5/10/20-session time stop", portfolio: "one open trade per symbol and rule; no overlapping trades within that rule" },
    data: { fetchedAt: snapshot.fetchedAt, source: snapshot.source, universeSource: snapshot.universeSource, symbols: snapshot.stocks.length, requestedSymbols: snapshot.stocks.length + (snapshot.failedSymbols || []).length, unavailableSymbols: (snapshot.failedSymbols || []).map((x) => x.sym), indexSessions: calendar.length, first, last, discoveryStart, discoveryEnd, embargoSessions: EMBARGO_SESSIONS, validationStart, validationEnd, possibleSignalBars: rawRows.length, skippedMissingNextSession: dataGaps },
    configs,
  };
  fs.writeFileSync(RESULTS, JSON.stringify(payload));
  writeReport(payload);
  console.log(`Saved ${configs.length} configurations and ${rows.length} non-overlapping trades (${validationStart} to ${validationEnd} validation).`);
}

function fmt(v, d = 3) { return Number.isFinite(v) ? v.toFixed(d) : "—"; }
function writeReport(d) {
  const pass = d.configs.filter((c) => c.validation.n >= 100 && c.validation.netMeanR > 0 && c.validation.ci[0] > 0 && c.validation.bhQ < 0.10);
  const table = d.configs.map((c) => `| ${c.pattern} | ${c.context} | ${c.horizon} | ${c.validation.n} | ${fmt(c.validation.winRate * 100, 1)}% | ${fmt(c.validation.grossMeanR)} | ${fmt(c.validation.netMeanR)} | ${fmt(c.validation.netMeanPct)}% | ${fmt(c.validation.matchedBuyHoldMeanPct)}% | ${fmt(c.validation.ci[0])} to ${fmt(c.validation.ci[1])} | ${fmt(c.validation.pNonPositive, 3)} | ${fmt(c.validation.bhQ, 3)} | ${fmt(c.stress.netMeanR)} |`).join("\n");
  const top = d.configs[0];
  const lines = [
    "# Daily cash swing candlestick study — 2026-10-21", "",
    `Data snapshot: ${d.data.fetchedAt}; ${d.data.symbols}/${d.data.requestedSymbols} current F&O stocks available, ${d.data.indexSessions} Nifty sessions, ${d.data.first} to ${d.data.last}. Discovery ${d.data.discoveryStart} to ${d.data.discoveryEnd}; a ${d.data.embargoSessions}-session purge separates validation (${d.data.validationStart} to ${d.data.validationEnd}).${d.data.unavailableSymbols.length ? ` Unavailable: ${d.data.unavailableSymbols.join(", ")}.` : ""}`, "",
    `This is long-only cash swing research. Bearish cash shorts are excluded because the user specified those as intraday only. It tests the repository's bullish engulfing, hammer, bull marubozu and bullish outside-bar definitions, plus a trend-pullback candidate: in a stock uptrend (SMA20>SMA50, close>SMA50), each of the prior three lows touches its then-current SMA20 and a bullish candle closes back above today's SMA20. Entry is the next NSE session open; candle stops use the signal low (four-bar lowest low for the pullback); target is 2R; stop width must be between ${MIN_STOP_PCT}% and ${MAX_STOP_PCT}% of entry; exit is at stop, target or after 5, 10 or 20 sessions. One trade per symbol/rule at a time. If stop and target fall inside the same daily bar, the result is charged as a stop. Signals without a complete forward horizon or next-session bar are omitted.`, "",
    "Candle patterns use four contexts: shape alone; stock uptrend; Nifty above SMA50; both trends. The SMA20 pullback is tested only with stock uptrend, and with/without the Nifty trend gate. The complete 54-test family is adjusted using Benjamini–Hochberg. Confidence intervals and one-sided p-values cluster by signal day. Base cost is 0.05% per side; stress is 0.10% per side. These are assumed underlying-share costs, not broker-specific estimates. The matched buy-and-hold column is the forward 5/10/20-session close return on the same entries, without the stop/target exit.", "",
    "Limitations: the universe is current F&O membership (survivorship bias); Yahoo OHLC is adjusted using its adjusted-close ratio; there are no delisted names, historical F&O membership, dividend cash flows, event filters, exact taxes/brokerage/impact costs or live fills. A positive row would still be a candidate for prospective paper testing, never immediate proof. The validation period is still one market path.", "",
    "## Validation results", "",
    "| Pattern | Context | Max hold | Trades | Win rate | Gross mean R | Net mean R | Net % | Matched hold % | Day-cluster 95% CI | P(net ≤ 0) | BH q | Net R at 0.10%/side |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    table, "",
    `Promotion gate: n ≥ 100, positive net expectancy, day-cluster 95% CI entirely above zero and BH q < 0.10. Passing rows: ${pass.length}/${d.configs.length}. The least-negative validation row is ${top.pattern} + ${top.context}, ${top.horizon}-session hold (n=${top.validation.n}, net ${fmt(top.validation.netMeanR)}R, 95% CI ${fmt(top.validation.ci[0])} to ${fmt(top.validation.ci[1])}, q=${fmt(top.validation.bhQ)}).`, "",
    "## Decision", "",
    pass.length ? "A row passed the statistical screen, but this is still not ready for live calls. Freeze the rule and test it prospectively in a paper journal, with actual cash-market quotes, liquidity, charges and missed alerts, before promotion." : "No tested daily candle/context/holding rule passed the promotion gate. Do not add a daily candlestick BUY to Live Calls. Keep the current directional stock watch non-alerting; continue collecting data or obtain a longer, survivorship-aware history before deciding whether a swing rule is worth adding.", "",
    "Reproduce from the committed five-year snapshot with `node research/swing-cash-2026-10-21/run-study.js`. Refresh the free daily snapshot from Yahoo and the current NSE F&O list with `node research/swing-cash-2026-10-21/fetch-daily.js`. The one-year fallback cache can be frozen with `node research/swing-cash-2026-10-21/run-study.js --freeze-cache`."
  ];
  fs.writeFileSync(REPORT, lines.join("\n") + "\n");
}

module.exports = { cleanDaily, writeSnapshot, readSnapshot, sma, contextPass, isPullbackReclaim, simulate, buildEvents, nonOverlapping, metrics, PATTERNS, CONTEXTS, HORIZONS, MIN_STOP_PCT, MAX_STOP_PCT, PULLBACK };

if (require.main === module) main();
