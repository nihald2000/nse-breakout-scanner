// Replays the existing index rulebook on a saved Yahoo Finance snapshot.
// Refresh from public data with: node research/index-rulebook-2026-10-21/run-study.js --refresh
const fs = require("node:fs");
const path = require("node:path");
const { yahooChart, indiaVix, vixState } = require("../../lib/common");
const { INDICES, parseIdx } = require("../../api/indices")._internals;
const { replayDay, sessionDates } = require("../../lib/replay");

const ROOT = __dirname;
const CACHE = path.join(ROOT, "yahoo-snapshot.json");
const REPORT = path.join(ROOT, "report.md");
const RESULTS = path.join(ROOT, "results.json");
const COST_SIDE = 0.0005;
const splitSample = (n) => Math.floor(n / 2);

async function refreshSnapshot() {
  const indices = {};
  for (let i = 0; i < INDICES.length; i++) {
    const ix = INDICES[i];
    const sym = ix.yahoo[0];
    const [r5, r15, r1h] = await Promise.all([
      yahooChart(sym, i, "60d", "5m"),
      yahooChart(sym, i + 1, "60d", "15m"),
      yahooChart(sym, i, "6mo", "60m"),
    ]);
    indices[ix.key] = { sym, p5: parseIdx(r5), p15: parseIdx(r15), p1h: parseIdx(r1h) };
  }
  const snapshot = { source: "Yahoo Finance", capturedAt: new Date().toISOString(), vix: await indiaVix(), indices };
  fs.writeFileSync(CACHE, JSON.stringify(snapshot));
  return snapshot;
}

function ci95ByDay(trades, seed = 271828) {
  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.date)) byDay.set(t.date, []);
    byDay.get(t.date).push(t.netR);
  }
  const days = [...byDay.values()];
  if (days.length < 2) return [null, null];
  let state = seed >>> 0;
  const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32);
  const means = [];
  for (let b = 0; b < 2500; b++) {
    let sum = 0, n = 0;
    for (let j = 0; j < days.length; j++) {
      const sample = days[Math.floor(random() * days.length)];
      for (const value of sample) { sum += value; n++; }
    }
    if (n) means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(means.length * 0.025)], means[Math.floor(means.length * 0.975)]];
}

function summarize(rows) {
  const total = rows.reduce((a, x) => a + x.netR, 0);
  const ci = ci95ByDay(rows);
  return {
    n: rows.length,
    days: new Set(rows.map((x) => x.date)).size,
    grossMeanR: rows.length ? rows.reduce((a, x) => a + x.grossR, 0) / rows.length : null,
    netMeanR: rows.length ? total / rows.length : null,
    netTotalR: total,
    winRate: rows.length ? rows.filter((x) => x.netR > 0).length / rows.length : null,
    netCI95DayCluster: ci,
  };
}

async function main() {
  const snapshot = process.argv.includes("--refresh") || !fs.existsSync(CACHE)
    ? await refreshSnapshot()
    : JSON.parse(fs.readFileSync(CACHE, "utf8"));
  const datesByIndex = {};
  const allTrades = [];
  const blocked = [];
  const unfilled = [];
  let sessions = [];

  for (const ix of INDICES) {
    const data = snapshot.indices[ix.key];
    const dates = sessionDates(data.p5.bars);
    const lastDate = dates.at(-1);
    const lastBars = data.p5.bars.filter((b) => b.d === lastDate);
    const completeDates = lastBars.at(-1).mm >= 920 ? dates : dates.slice(0, -1);
    const usable = completeDates.slice(2);
    datesByIndex[ix.key] = { from: usable[0], to: usable.at(-1), sessions: usable.length };
    sessions = usable;

    for (const date of usable) {
      const vix = vixState(snapshot.vix, date, false);
      const result = replayDay(ix, data, date, null, {});
      blocked.push(...result.blocked.map((x) => ({ ...x, reason: "opening-range size rule" })));
      unfilled.push(...(result.unfilled || []));
      for (const signal of result.signals) {
        for (const plan of ["x1", "x2"]) {
          const outcome = signal[plan];
          if (!outcome || outcome.exitMM == null) continue;
          const risk = Math.abs(signal.entry - signal.sl);
          const grossR = outcome.r;
          const costR = (2 * COST_SIDE * Math.abs(signal.entry) / risk) * signal.scale;
          allTrades.push({
            index: ix.key,
            strategy: signal.strategy,
            date,
            signalMM: signal.signalMM,
            entryMM: signal.entryMM,
            plan,
            side: signal.side,
            entry: signal.entry,
            sl: signal.sl,
            t1: signal.t1,
            t2: signal.t2,
            elevatedVix: !!(vix.ok && vix.elevated),
            vixKnown: vix.ok,
            grossR,
            costR,
            netR: grossR - costR,
            outcome: outcome.outcome,
          });
        }
      }
    }
  }

  const split = splitSample(sessions.length);
  const cutDate = sessions[split];
  const strategies = [...new Set(allTrades.map((t) => t.strategy))].sort();
  const plans = ["x1", "x2"];
  const rows = [];
  for (const strategy of strategies) for (const plan of plans) {
    for (const period of ["all", "discovery", "validation"]) for (const vixGroup of ["all", "elevated", "below_or_unknown"]) {
      const selected = allTrades.filter((t) => t.strategy === strategy && t.plan === plan &&
        (period === "all" || (period === "discovery" ? t.date < cutDate : t.date >= cutDate)) &&
        (vixGroup === "all" || (vixGroup === "elevated" ? t.elevatedVix : !t.elevatedVix)));
      if (selected.length) rows.push({ strategy, plan, period, vixGroup, ...summarize(selected) });
    }
  }

  const day21 = allTrades.filter((t) => t.date === "2026-10-21" && t.plan === "x1");
  const output = {
    source: snapshot.source,
    capturedAt: snapshot.capturedAt,
    sample: { from: sessions[0], to: sessions.at(-1), sessions: sessions.length, splitDate: cutDate || null, indices: datesByIndex },
    assumptions: {
      entry: "next 5-minute bar open after a finished signal candle",
      gapHandling: "skip if the open has crossed the stop, reached T1, or widened stop beyond the rule's limit",
      exit: "stop checked before target when both lie inside one bar; flat by 15:15",
      cost: `${COST_SIDE * 100}% of underlying notional per side, deducted in R; excludes option spreads/IV/theta and is an assumption`,
      vix: "previous completed session close compared with the preceding 60 closes; treated as a grouping variable, not a trade blocker",
      confidenceInterval: "95% day-cluster bootstrap, 2,500 resamples; exploratory, not a preregistered holdout",
      limitations: "underlying index only; no historical option bid/ask or premium P&L; Yahoo history may be revised",
    },
    counts: { replayTrades: allTrades.length, blockedBySize: blocked.length, skippedAtNextOpen: unfilled.length, vixElevatedSessionsWithTrades: new Set(allTrades.filter((t) => t.elevatedVix).map((t) => t.date)).size },
    blocked,
    unfilled,
    trades: allTrades,
    rows,
    vixGateComparison: strategies.map((strategy) => {
      const all = allTrades.filter((t) => t.strategy === strategy && t.plan === "x1");
      const gated = all.filter((t) => !t.elevatedVix);
      return { strategy, allX1: summarize(all), tradesAfterVixGateX1: summarize(gated), removedByVix: all.length - gated.length };
    }),
    oct21Trades: day21,
    oct21Vix: snapshot.vix && snapshot.vix.daily ? vixState(snapshot.vix, "2026-10-21", false) : null,
  };
  fs.writeFileSync(RESULTS, JSON.stringify(output, null, 2) + "\n");

  const fmt = (x) => x == null ? "—" : x.toFixed(3);
  const report = [
    "# Index rulebook replay: next-open fills and VIX gate audit",
    "",
    `Snapshot: ${output.capturedAt} (${output.source}). Sample: ${output.sample.from} to ${output.sample.to}, ${output.sample.sessions} complete sessions across five indices.`,
    "",
    "This is a corrective replay of the existing index rules, not a strategy promotion. Signals now enter at the next 5-minute open. It skips a fill if the opening gap has crossed the stop, reached T1, or expanded risk past the existing cap. Stop/targets stay at the prices that the signal displayed, so gaps change realized R.",
    "",
    `Cost stress: ${output.assumptions.cost}. Results are underlying-index R, not option-premium P&L. ${output.assumptions.confidenceInterval}. The later half is a descriptive validation period only; rule variants were already explored on overlapping dates.`,
    "",
    "## VIX gate comparison (T1 plan)",
    "",
    "| Rule | Trades without gate | Mean net R | Day-cluster 95% CI | Trades after VIX gate | Mean net R | Day-cluster 95% CI | Removed |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...output.vixGateComparison.map((x) => `| ${x.strategy} | ${x.allX1.n} | ${fmt(x.allX1.netMeanR)} | ${x.allX1.netCI95DayCluster.map(fmt).join(" to ")} | ${x.tradesAfterVixGateX1.n} | ${fmt(x.tradesAfterVixGateX1.netMeanR)} | ${x.tradesAfterVixGateX1.netCI95DayCluster.map(fmt).join(" to ")} | ${x.removedByVix} |`),
    "",
    "## Oct 21, 2026 session",
    "",
    `India VIX at the prior close was ${output.oct21Vix && output.oct21Vix.ok ? `${output.oct21Vix.value.toFixed(2)} vs p60 ${output.oct21Vix.p60.toFixed(2)} (elevated: ${output.oct21Vix.elevated})` : "unavailable"}.`,
    "",
    "| Index | Rule | Side | Signal bar | Next-open fill | Entry | Stop | T1 | T2 | T1 result | T2 result |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...day21.map((t) => {
      const s = output.trades.find((x) => x.index === t.index && x.strategy === t.strategy && x.date === t.date && x.plan === "x1");
      const other = output.trades.find((x) => x.index === t.index && x.strategy === t.strategy && x.date === t.date && x.plan === "x2");
      return `| ${t.index} | ${t.strategy} | BUY ${t.side === "long" ? "CE" : "PE"} | ${t.signalMM} | ${t.entryMM} | ${t.entry.toFixed(2)} | ${t.sl.toFixed(2)} | ${t.t1.toFixed(2)} | ${t.t2.toFixed(2)} | ${s ? `${s.outcome} ${fmt(s.netR)}R net` : "—"} | ${other ? `${other.outcome} ${fmt(other.netR)}R net` : "—"} |`;
    }),
    "",
    "One day is a case review, not evidence of a durable edge. High VIX is an option-cost warning, but this dataset cannot validate a hard block because it has no historical option premiums, spreads, or IV changes.",
    "",
    "The fixed snapshot and full trade-level results are in `yahoo-snapshot.json` and `results.json`.",
    "",
  ].join("\n");
  fs.writeFileSync(REPORT, report);
  console.log(report);
}

main().catch((err) => { console.error(err.stack || err); process.exitCode = 1; });
