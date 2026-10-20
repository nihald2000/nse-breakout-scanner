"use strict";
// Offline Elliott Phase 1 scan. Descriptive only: it counts mechanical impulse
// candidates and where the last close sits relative to them. It does not measure
// forward returns, costs or option P&L, so it cannot show an edge.
//
//   node research/elliott-phase1/scan.js
//   node research/elliott-phase1/scan.js --tf 15m --pct 0.75,1,1.5
//   node research/elliott-phase1/scan.js --data research/backtest-2026-10-20/data

const fs = require("fs");
const path = require("path");
const { cleanBars } = require("../backtest-2026-10-20/engine");
const { analyseElliott } = require("../../lib/elliott");

const DEFAULT_PCT = { "15m": [0.75, 1, 1.5], "1d": [3, 5, 8] };
const TF_ORDER = ["15m", "1d"];

function parseArgs(argv) {
  const out = {
    data: path.join(__dirname, "..", "backtest-2026-10-20", "data"),
    out: __dirname,
    tfs: TF_ORDER.slice(),
    pcts: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--data") out.data = path.resolve(argv[++i]);
    else if (k === "--out") out.out = path.resolve(argv[++i]);
    else if (k === "--tf") {
      const want = String(argv[++i] || "").split(",").map((x) => x.trim()).filter(Boolean);
      out.tfs = want.filter((x) => TF_ORDER.includes(x));
    } else if (k === "--pct") {
      out.pcts = String(argv[++i] || "").split(",").map(Number).filter((x) => x > 0);
    }
  }
  if (!out.tfs.length) out.tfs = TF_ORDER.slice();
  return out;
}

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);

function emptyAgg() {
  return { symbolsWithValid: 0, validWindows: 0, impulses: 0, nearMiss: 0, up: 0, down: 0 };
}

function scanTf(dataDir, tf, universe, pcts) {
  const rawDir = path.join(dataDir, "raw", tf);
  const coverage = { withData: 0, missing: 0, short: 0, firstDate: null, lastDate: null, bars: null };
  const barCounts = [];
  const agg = new Map(pcts.map((p) => [p, emptyAgg()]));
  const rows = [];
  if (!fs.existsSync(rawDir)) return { coverage, agg, rows };

  for (const u of universe) {
    const file = path.join(rawDir, u.sym + ".json");
    if (!fs.existsSync(file)) { coverage.missing++; continue; }
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { coverage.missing++; continue; }
    const bars = cleanBars(raw).bars;
    if (bars.length < 30) { coverage.short++; continue; }
    coverage.withData++;
    barCounts.push(bars.length);
    const first = bars[0];
    const last = bars[bars.length - 1];
    if (!coverage.firstDate || first.d < coverage.firstDate) coverage.firstDate = first.d;
    if (!coverage.lastDate || last.d > coverage.lastDate) coverage.lastDate = last.d;

    for (const pct of pcts) {
      const a = analyseElliott(bars, { pct });
      const g = agg.get(pct);
      g.impulses += a.impulses.length;
      g.validWindows += a.valid.length;
      g.nearMiss += a.impulses.filter((x) => !x.valid && x.rulesPassed === 3).length;
      if (!a.latest) continue;
      g.symbolsWithValid++;
      g[a.latest.dir]++;
      rows.push({
        sym: u.sym,
        industry: u.industry || null,
        tf,
        pct,
        dir: a.latest.dir,
        from: a.latest.from,
        to: a.latest.to,
        startPrice: r2(a.latest.start.price),
        endPrice: r2(a.latest.end.price),
        spanBars: a.latest.spanBars,
        pivots: a.pivots.length,
        rulesPassed: a.latest.rulesPassed,
        truncatedFifth: !a.latest.guidelines.w5BeyondW3,
        w2RetraceOfW1: r4(a.latest.guidelines.w2RetraceOfW1),
        w4RetraceOfW3: r4(a.latest.guidelines.w4RetraceOfW3),
        w3ExtensionOfW1: r4(a.latest.guidelines.w3ExtensionOfW1),
        lastDate: last.d,
        lastClose: r2(last.cl),
        position: a.position ? {
          sinceEndPct: r2(a.position.sinceEndPct),
          retracePctOfImpulse: r2(a.position.retracePctOfImpulse),
          beyondEnd: a.position.beyondEnd,
        } : null,
      });
    }
  }
  if (barCounts.length) {
    const s = barCounts.slice().sort((a, b) => a - b);
    coverage.bars = { min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
  }
  return { coverage, agg, rows };
}

function table(headers, rows) {
  const head = "| " + headers.join(" | ") + " |";
  const sep = "| " + headers.map(() => "---").join(" | ") + " |";
  return [head, sep, ...rows.map((r) => "| " + r.join(" | ") + " |")].join("\n");
}

function report(scan, args, meta) {
  const lines = [];
  lines.push("# Elliott Phase 1 - mechanical impulse scan");
  lines.push("");
  lines.push("Descriptive only. This scan finds six-pivot ZigZag windows that fit the four hard impulse rules.");
  lines.push("It does **not** measure forward returns, costs, option premiums or an edge, and it is **not a forecast**.");
  lines.push("");
  lines.push(`- Snapshot: ${meta.snapshotDate || "unknown"}`);
  lines.push(`- Universe: ${scan.universe} F&O symbols from the cached snapshot`);
  lines.push(`- Data: \`${path.relative(path.join(__dirname, "..", ".."), args.data)}\``);
  lines.push("- Bars: closed bars only, session-filtered by `engine.cleanBars`");
  lines.push("- Pivots: confirmed only after the reverse threshold, so a label cannot use a future extreme");
  lines.push("- Rules: W2 not a full retrace; W3 beyond W1; W4 outside W1; W3 not the shortest of 1/3/5");
  lines.push("- A truncated fifth (W5 short of W3) is allowed and flagged; it is a guideline, not a hard rule");
  lines.push("");
  lines.push("## Coverage");
  lines.push("");
  const covRows = [];
  for (const tf of args.tfs) {
    const c = scan.byTf[tf].coverage;
    const b = c.bars ? `${c.bars.min}/${c.bars.median}/${c.bars.max}` : "-";
    covRows.push([tf, c.withData, c.missing, c.short, `${c.firstDate || "-"} to ${c.lastDate || "-"}`, b]);
  }
  lines.push(table(
    ["timeframe", "symbols with data", "missing file", "shorter than 30 bars", "bar dates", "bars min/median/max"],
    covRows
  ));
  lines.push("");
  lines.push("## Counts by threshold");
  lines.push("");
  const countRows = [];
  for (const tf of args.tfs) {
    const m = scan.byTf[tf].agg;
    for (const pct of scan.byTf[tf].thresholds) {
      const g = m[pct];
      if (!g) continue;
      countRows.push([tf, pct + "%", g.symbolsWithValid, g.validWindows, g.up, g.down, g.nearMiss, g.impulses]);
    }
  }
  lines.push(table(
    ["timeframe", "ZigZag", "symbols with a valid count", "valid windows", "up", "down", "3-of-4 near misses", "all windows"],
    countRows
  ));
  lines.push("");
  lines.push("`valid windows` counts every six-pivot fit; a symbol can contribute more than one. `symbols with a valid count` counts each symbol once per threshold, and `up`/`down` split those symbols by the direction of their latest valid count. `near misses` fit three of the four hard rules.");
  lines.push("");
  lines.push("These are **not independent observations**. A seven-pivot run contains two overlapping six-pivot windows, and every symbol with enough data has at least one valid window at the loose thresholds. The counts describe how often the mechanical definition is satisfied, not how often a trade worked.");
  lines.push("");
  lines.push("## Latest valid counts (examples, not a ranked list)");
  lines.push("");
  lines.push("`since end` is direction-adjusted: positive means price continued in the impulse's direction, negative means it retraced. `retrace` is the percentage of the impulse given back from its end.");
  lines.push("");
  for (const tf of args.tfs) {
    const rows = scan.byTf[tf].rows.slice().sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0));
    lines.push(`### ${tf}`);
    lines.push("");
    if (!rows.length) {
      lines.push("No valid impulse found at these thresholds.");
      lines.push("");
      continue;
    }
    const shown = rows.slice(0, 15);
    lines.push(table(
      ["symbol", "industry", "threshold", "dir", "from", "to", "last close", "since end", "retrace", "W5 beyond W3"],
      shown.map((r) => [
        r.sym,
        r.industry || "-",
        r.pct + "%",
        r.dir,
        r.from,
        r.to,
        r.lastClose,
        r.position && r.position.sinceEndPct != null ? r.position.sinceEndPct + "%" : "-",
        r.position && r.position.retracePctOfImpulse != null ? r.position.retracePctOfImpulse + "%" : "-",
        r.truncatedFifth ? "no (truncated)" : "yes",
      ])
    ));
    lines.push("");
  }
  lines.push("## What this does not show");
  lines.push("");
  lines.push("- No forward returns, hit rate, expectancy, costs or option P&L: none of that is computed here.");
  lines.push("- No stability test: the count is conditional on the chosen ZigZag threshold, and nearby thresholds can disagree.");
  lines.push("- No correction (A-B-C), diagonal or multi-degree labelling. Phase 1 is impulse candidates only.");
  lines.push("- No claim that a valid count predicts the next move. The four rules are a definition, not evidence.");
  lines.push("- ZigZag runs continuously across sessions: an overnight gap counts as a price move and a pivot can span two sessions.");
  const spans = args.tfs.map((tf) => {
    const c = scan.byTf[tf].coverage;
    return `${tf} ${c.firstDate || "?"} to ${c.lastDate || "?"}`;
  }).join("; ");
  lines.push(`- Sample span: ${spans}. That is one market regime, and the universe is today's F&O list, so survivorship bias remains.`);
  lines.push("");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const metaFile = path.join(args.data, "meta.json");
  if (!fs.existsSync(metaFile)) throw new Error(`no meta.json in ${args.data}`);
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  const universe = Array.isArray(meta.universe) ? meta.universe : [];

  const scan = { generatedAt: new Date().toISOString(), snapshot: meta.snapshotDate || null, universe: universe.length, byTf: {} };
  for (const tf of args.tfs) {
    const pcts = args.pcts && args.pcts.length ? args.pcts : DEFAULT_PCT[tf];
    const got = scanTf(args.data, tf, universe, pcts);
    const agg = {};
    for (const [pct, g] of got.agg) agg[pct] = g;
    scan.byTf[tf] = { thresholds: pcts, coverage: got.coverage, agg, rows: got.rows };
  }

  fs.mkdirSync(args.out, { recursive: true });
  const jsonFile = path.join(args.out, "elliott_scan.json");
  const mdFile = path.join(args.out, "elliott_scan.md");
  fs.writeFileSync(jsonFile, JSON.stringify(scan, null, 2));
  fs.writeFileSync(mdFile, report(scan, args, meta) + "\n");

  console.log(`wrote ${path.relative(process.cwd(), mdFile)}`);
  console.log(`wrote ${path.relative(process.cwd(), jsonFile)}`);
  for (const tf of args.tfs) {
    const cov = scan.byTf[tf].coverage;
    console.log(`${tf}: ${cov.withData} symbols with data, ${cov.missing} missing, ${cov.short} short`);
  }
}

main();
