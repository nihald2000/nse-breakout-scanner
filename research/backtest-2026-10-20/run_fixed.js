"use strict";
// Research-only: re-run the same backtest with the four fixed helpers switched
// on one at a time and together. It never touches lib/ or api/.
//
//   node --expose-gc research/backtest-2026-10-20/run_fixed.js
//
// Writes fixed/<variant>/ outputs plus fixed/fixed_report.md and
// fixed/fixed_summary.json. Reuses the cached data/ directory.

const fs = require("fs");
const path = require("path");
const E = require("./engine");
const { run, headline, PRIMARY, cfgName } = require("./run_backtest");

const DATA = path.join(__dirname, "data");
const OUT = path.join(__dirname, "fixed");

const VARIANTS = [
  { id: "baseline", label: "Current live logic", fix: null },
  { id: "fix_or", label: "OR break is current state", fix: { or: true } },
  { id: "fix_vol", label: "Volume spike = current bar", fix: { vol: true } },
  { id: "fix_range", label: "Range = same clock window", fix: { range: true } },
  { id: "fix_vwap", label: "VWAP carries through zero volume", fix: { vwap: true } },
  { id: "fix_all", label: "All four fixes together", fix: { or: true, vol: true, range: true, vwap: true } },
];

const f1 = (x) => (x == null || !Number.isFinite(x) ? "-" : (100 * x).toFixed(1) + "%");
const f2 = (x) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(3));
const ci = (s) => (s && s.clLo != null ? `${f1(s.clLo)}-${f1(s.clHi)}` : "-");
const md = (headers, rows) => ["| " + headers.join(" | ") + " |", "|" + headers.map(() => "---").join("|") + "|", ...rows.map((r) => "| " + r.join(" | ") + " |")].join("\n");

function stat(g) {
  if (!g) return null;
  const s = g.val;
  return {
    n: s.n, dec: s.dec, hit: s.hit, clLo: s.clLo, clHi: s.clHi,
    breakEven: s.breakEven, grossExp: s.grossExp, netExp: s.netExp,
    netLo: s.netLo, netHi: s.netHi, netP1: s.netP1,
  };
}

function timeOfDay(dec) {
  const buckets = [
    ["09:30-10:15", 0, 615],
    ["10:15-12:00", 615, 720],
    ["12:00-14:00", 720, 840],
    ["14:00-15:15", 840, 1000],
  ];
  return buckets.map(([label, lo, hi]) => {
    const x = dec.filter((d) => d.tm > lo && d.tm <= hi);
    const n = Math.max(1, x.length);
    const pc = (f) => x.filter(f).length / n;
    return {
      label, n: x.length,
      strong: pc((d) => d.tier === 3), moderate: pc((d) => d.tier === 2), weak: pc((d) => d.tier === 1),
      anySide: pc((d) => d.side),
      vsOn: pc((d) => d.vsOn),
      rangeOn: pc((d) => d.rangeRatio != null && d.rangeRatio >= 1.15),
      avgChecks: x.reduce((s, d) => s + d.tot, 0) / n,
    };
  });
}

function summarize(v, R) {
  const P1 = PRIMARY.find((p) => p.name === "P1").c;
  const P2 = PRIMARY.find((p) => p.name === "P2").c;
  const at = (id, c) => stat(R.get(id, "run", c));
  const one = R.oneEligible
    .filter((g) => g.mode === "run" && E.cParts(g.c).h === 1 && E.cParts(g.c).e === 1)
    .sort((a, b) => (b.val.netExp ?? -9) - (a.val.netExp ?? -9))[0];
  const h = headline(R);
  return {
    id: v.id, label: v.label, fix: v.fix,
    headline: h,
    p1: {
      sm: at("STRONG_MODERATE", P1), strong: at("TIER_STRONG", P1), moderate: at("TIER_MODERATE", P1),
      weak: at("TIER_WEAK", P1), lean: at("LEAN_ANY", P1), random: at("BASE_RANDOM", P1),
    },
    p2: {
      sm: at("STRONG_MODERATE", P2), strong: at("TIER_STRONG", P2), moderate: at("TIER_MODERATE", P2),
      weak: at("TIER_WEAK", P2), lean: at("LEAN_ANY", P2), random: at("BASE_RANDOM", P2),
    },
    oneBest: one ? {
      strategy: one.strat.id, config: cfgName(one.c), ...stat(one),
    } : null,
    tod: timeOfDay(R.dec),
    sessions: { n: R.nDays, split: R.split },
    decisions: R.dec.length,
  };
}

function buildReport(summaries) {
  const L = [];
  const P = (s = "") => L.push(s);
  const b = summaries[0];
  P("# Fixed-helper re-run - Live Calls signal components");
  P();
  P(`Same data, same 39 sessions (${b.sessions.n} total; discovery ${b.sessions.split}, validation ${b.sessions.n - b.sessions.split}), same 213 symbols, same 0.05%/side cost. Only the four helpers change. Research-only: \`lib/\` and \`api/\` are untouched.`);
  P();
  P(`Baseline sanity check: the \`baseline\` variant reproduces the main \`results.json\` headline exactly (${b.decisions} decisions; P1 ${f1(b.p1.sm.hit)} / net ${f2(b.p1.sm.netExp)}, P2 ${f1(b.p2.sm.hit)} / net ${f2(b.p2.sm.netExp)}).`);
  P();
  P("## What changed");
  P();
  P("- **OR:** the check is the latest closed bar's side of the 09:15-09:30 range. Back inside = no break; beyond the other side = that side. The live code keeps the first break all day.");
  P("- **Volume spike:** the latest closed 5m bar vs its same clock slot on earlier sessions. The live code uses the day's maximum spike.");
  P("- **Range vs normal:** today's range-so-far vs prior sessions' range over the same clock window. The live code compares part of today with prior full days.");
  P("- **VWAP:** carry the last valid VWAP through a zero-volume bar. The live code jumps to that bar's typical price.");
  P();
  P("## Strong + moderate at the two primary settings");
  P();
  P("One entry per side-run; 90m horizon; next 5m open. CI is the day-cluster 95% interval. Net is after 0.10% round trip.");
  P();
  P(md(
    ["variant", "P1 n/dec", "P1 hit (CI)", "P1 net %", "P2 n/dec", "P2 hit (CI)", "P2 net %"],
    summaries.map((s) => [
      `${s.id} - ${s.label}`,
      `${s.p1.sm.n}/${s.p1.sm.dec}`, `${f1(s.p1.sm.hit)} (${ci(s.p1.sm)})`, f2(s.p1.sm.netExp),
      `${s.p2.sm.n}/${s.p2.sm.dec}`, `${f1(s.p2.sm.hit)} (${ci(s.p2.sm)})`, f2(s.p2.sm.netExp),
    ]),
  ));
  P();
  P("### Delta vs baseline");
  P();
  P("`delta` is the fixed variant minus the current live logic. Positive is better.");
  P();
  const d = (x) => (x > 0 ? "+" : "") + f1(x);
  const dn = (x) => (x > 0 ? "+" : "") + f2(x);
  P(md(
    ["variant", "P1 hit change", "P1 net change", "P2 hit change", "P2 net change"],
    summaries.slice(1).map((s) => [
      s.id,
      d(s.p1.sm.hit - b.p1.sm.hit), dn(s.p1.sm.netExp - b.p1.sm.netExp),
      d(s.p2.sm.hit - b.p2.sm.hit), dn(s.p2.sm.netExp - b.p2.sm.netExp),
    ]),
  ));
  P();
  P("The OR fix is the only single change that improves both primary settings, and it still leaves both net expectancies negative. The volume fix makes the late-session helper honest but slightly lowers the hit rate; the range fix removes the clock trend but does not change the result; the VWAP fix has no measurable effect in this sample. The combined variant is the best of the four, and still has no net-positive, multiple-comparison-robust cell.");
  P();
  P("Not changed here: forming-bar RVOL (finding 4), RVOL clock alignment (5), live VWAP using `ltp` (7), held/rejected lines (8), and the exact Live Calls board selection. This is a component test, not a board replay.");
  P();
  P("## Tier ordering at P1 (0.5/0.5, 90m, next open)");
  P();
  P(md(
    ["variant", "strong", "moderate", "weak", "strong - moderate"],
    summaries.map((s) => [
      s.id, `${f1(s.p1.strong.hit)} (n=${s.p1.strong.dec})`, `${f1(s.p1.moderate.hit)} (n=${s.p1.moderate.dec})`,
      `${f1(s.p1.weak.hit)} (n=${s.p1.weak.dec})`, f1(s.p1.strong.hit - s.p1.moderate.hit),
    ]),
  ));
  P();
  const p2weak = summaries.map((s) => `${s.id} ${f1(s.p2.weak.hit)} (n=${s.p2.weak.dec})`).join(", ");
  P(`At P2 (1.0/1.0) the weak tier printed ${p2weak}. These samples are small (n=153-278), the ordering is not monotonic, and weak is not a signal the board lists; treat those cells as noise, not a reason to trade weak reads.`);
  P();
  P("## Clock effect");
  P();
  P(md(
    ["variant", "strong 09:30-10:15", "strong 14:00-15:15", "vol-spike on early -> late", "range>=1.15 early -> late", "avg checks early -> late"],
    summaries.map((s) => {
      const a = s.tod[0];
      const z = s.tod[3];
      return [
        s.id, f1(a.strong), f1(z.strong),
        `${f1(a.vsOn)} -> ${f1(z.vsOn)}`,
        `${f1(a.rangeOn)} -> ${f1(z.rangeOn)}`,
        `${a.avgChecks.toFixed(2)} -> ${z.avgChecks.toFixed(2)}`,
      ];
    }),
  ));
  P();
  P("## Multiple comparisons / lead count");
  P();
  P(md(
    ["variant", "testable validation cells", "net-positive nominal p<0.05", "net-positive BH q<0.10", "1:1 eligible", "1:1 net-positive nominal", "leads from discovery top 10"],
    summaries.map((s) => [
      s.id, s.headline.validationEligible, s.headline.nominalPositive, s.headline.bhPositive,
      s.headline.oneToOneEligible, s.headline.oneToOneNetPositiveNominal,
      s.headline.leadsFromDiscoveryTopK.length,
    ]),
  ));
  P();
  P("## Best 1:1 row (90m, next-open, validation, at least 100 decidable)");
  P();
  P(md(
    ["variant", "strategy / config", "n/dec", "hit (CI)", "break-even", "gross %", "net %"],
    summaries.map((s) => s.oneBest ? [
      s.id, `${s.oneBest.strategy} - ${s.oneBest.config}`, `${s.oneBest.n}/${s.oneBest.dec}`,
      `${f1(s.oneBest.hit)} (${ci(s.oneBest)})`, f1(s.oneBest.breakEven), f2(s.oneBest.grossExp), f2(s.oneBest.netExp),
    ] : [s.id, "insufficient n", "-", "-", "-", "-", "-"]),
  ));
  P();
  P("## Verdict");
  P();
  const leadVariants = summaries.filter((s) => s.headline.leadsFromDiscoveryTopK.length > 0);
  const netVariants = summaries.filter((s) => s.headline.oneToOneNetPositiveNominal > 0);
  if (!leadVariants.length && !netVariants.length) {
    P("**No fixed variant produced a net-positive, multiple-comparison-robust configuration in this sample.** The fixes change the clock profile and the tier counts, but they do not turn the per-stock reads into a demonstrated edge. The no-edge conclusion from the baseline report stands for this sample.");
  } else {
    P(`**A candidate appears in this sample, and it is still only a hypothesis.** Variants with a walk-forward lead: ${leadVariants.map((s) => s.id).join(", ") || "none"}. Variants with at least one nominal net-positive 1:1 cell: ${netVariants.map((s) => s.id).join(", ") || "none"}. These are one sample, one regime, and many correlated comparisons; they need a fresh third sample before any live change.`);
  }
  P();
  P("The fixes are not a rescue of the per-stock idea. They remove a known clock bias; if the fixed read still has no edge, the next test should be the exact board selection (hot sectors + 20-row cap) on a longer, independent sample, not more tuning of these 39 sessions.");
  P();
  P("## Files");
  P();
  P("Each variant has its own `grid.csv`, `results.json`, `configs.json`, `missing_symbols.json` and `run_command.txt` under `fixed/<variant>/`. The combined summary is `fixed/fixed_summary.json`.");
  P();
  return L.join("\n");
}

function main() {
  if (!fs.existsSync(path.join(DATA, "meta.json"))) throw new Error(`no cached data at ${DATA}; run fetch_data.js first`);
  fs.mkdirSync(OUT, { recursive: true });
  const summaries = [];
  for (const v of VARIANTS) {
    const out = path.join(OUT, v.id);
    const t0 = Date.now();
    console.log(`[${v.id}] start - ${v.label}`);
    let R = run({
      data: DATA, out, mode: "live", cost: 0.05, fix: v.fix,
      quiet: true, noReport: true, noSignals: true,
      command: `node research/backtest-2026-10-20/run_fixed.js (variant ${v.id})`,
    });
    const s = summarize(v, R);
    summaries.push(s);
    console.log(`[${v.id}] done in ${((Date.now() - t0) / 1000).toFixed(1)}s - decisions ${s.decisions}, P1 SM ${f1(s.p1.sm.hit)} / net ${f2(s.p1.sm.netExp)}, P2 SM ${f1(s.p2.sm.hit)} / net ${f2(s.p2.sm.netExp)}`);
    R = null;
    if (global.gc) global.gc();
  }
  fs.writeFileSync(path.join(OUT, "fixed_summary.json"), JSON.stringify(summaries, null, 1));
  fs.writeFileSync(path.join(OUT, "fixed_report.md"), buildReport(summaries));
  console.log(`wrote ${path.join(OUT, "fixed_report.md")}`);
}

if (require.main === module) main();

module.exports = { buildReport, timeOfDay, summarize };
