"use strict";
// code_review_probes.js - executable evidence for each finding in CODE_REVIEW.md. Nothing here changes production code.
//   node research/backtest-2026-10-20/code_review_probes.js [--data <dir>]
// Part 1 runs hand-built inputs through the real lib/sector.js and lib/candlebacktest.js functions.
// Part 2 (needs --data) measures how the checks and tiers behave by time of day on the data in <dir>.

const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
const sector = require(path.join(ROOT, "lib", "sector"));
const CB = require(path.join(ROOT, "lib", "candlebacktest"));

const out = [];
const say = (...a) => {
  console.log(...a);
  out.push(a.join(" "));
};
const bar = (mm, o, hi, lo, cl, vol, d = "2026-10-15") => ({ d, mm, t: 0, o, hi, lo, cl, vol });

// ---- P1: vwapSeries on a zero-volume bar -------------------------------------------------------------------
say("== P1 vwapSeries with a zero-volume bar (parseIdx turns a missing volume into 0)");
{
  const bars = [bar(555, 100, 101, 99, 100, 1000), bar(560, 100, 100.5, 99.5, 100, 0), bar(565, 100, 100.4, 99.6, 100, 1000)];
  // make the middle bar's typical price far from the running VWAP
  bars[1] = bar(560, 103, 104, 102, 103, 0);
  const v = sector.vwapSeries(bars);
  say("  running VWAP should stay near 100 through the empty bar; got:", v.map((x) => x.toFixed(3)).join(", "));
}

// ---- P2: lineState "held/rejected" judged against today's lines, not each bar's own lines ---------------------
say("== P2 lineState: pullback test uses the CURRENT Tenkan/Kijun for past bars (look=20 here only to exaggerate; the live default is look=2, so the live effect is at most one bar of line drift; context-only, not in the lean)");
{
  const bars = [];
  let px = 100;
  for (let i = 0; i < 75; i++) {
    px += 0.1;
    bars.push(bar(555 + 15 * (i % 25), px, px + 0.15, px - 0.15, px, 1000, "2026-10-0" + (1 + Math.floor(i / 25))));
  }
  // one past bar dips to where the line is NOW, but the line was far lower back then
  const st = sector.lineState(bars, 20);
  const tk = sector.tenkanKijun(bars);
  const k20 = bars.length - 20;
  const st2 = sector.lineState(bars);
  say("  with the live default look=2 the tag is:", st2.held, "(steady 0.1/bar uptrend, no pullback exists)");
  say("  now: tenkan", st.tenkan.toFixed(2), "kijun", st.kijun.toFixed(2), "| 20 bars ago the lines were", tk.tenkan[k20].toFixed(2), "/", tk.kijun[k20].toFixed(2), "| held tag:", st.held);
}

// ---- P3: intradayRvol aligns by bar COUNT, not clock --------------------------------------------------------
say("== P3 intradayRvol: a missing bar in an earlier session shifts that session's baseline");
{
  const mk = (d, skip) => {
    const a = [];
    for (let k = 0; k < 12; k++) if (k !== skip) a.push(bar(555 + 5 * k, 100, 100.1, 99.9, 100, 100 + k * 10, d));
    return a;
  };
  const today = mk("2026-10-16", -1).slice(0, 6); // 09:15..09:40, volumes 100..150
  const full = new Map([["a", mk("2026-10-13", -1)], ["b", mk("2026-10-14", -1)], ["c", mk("2026-10-15", -1)]]);
  const holey = new Map([["a", mk("2026-10-13", 2)], ["b", mk("2026-10-14", 2)], ["c", mk("2026-10-15", 2)]]); // 09:25 bar missing
  say("  RVOL with complete history:", sector.intradayRvol(today, full).toFixed(3), "| same data but the 09:25 bar missing in the 3 earlier sessions:", sector.intradayRvol(today, holey).toFixed(3), "(true value is unchanged)");
}

// ---- P4: forming bar is included in today's cumulative volume ------------------------------------------------
say("== P4 live RVOL includes the forming bar (computeRows passes `today`, not the closed bars)");
{
  const hist = new Map(["2026-10-13", "2026-10-14", "2026-10-15"].map((d) => [d, Array.from({ length: 12 }, (_, k) => bar(555 + 5 * k, 100, 101, 99, 100, 1000, d))]));
  const closed = Array.from({ length: 6 }, (_, k) => bar(555 + 5 * k, 100, 101, 99, 100, 1000, "2026-10-16"));
  const forming = bar(585, 100, 101, 99, 100, 200, "2026-10-16"); // 40 seconds into a 5-minute bar
  say("  closed bars only:", sector.intradayRvol(closed, hist).toFixed(3), "| with the forming bar:", sector.intradayRvol([...closed, forming], hist).toFixed(3), "(the live call mixes a partial bar into a count-matched baseline of full bars)");
}

// ---- P5: opening-range break never expires ------------------------------------------------------------------
say("== P5 orStats: the first break wins forever");
{
  const b = [];
  const px = [100, 100.1, 100.05, 100.6, 100.9, 100.4, 99.8, 99.2, 98.9, 98.7]; // up through OR high, then fully reverses below OR low
  px.forEach((p, k) => b.push(bar(555 + 5 * k, p, p + 0.1, p - 0.1, p, 1000)));
  const or = sector.orStats(b);
  say("  OR", or.lo.toFixed(2), "-", or.hi.toFixed(2), "| brokeUp", or.brokeUp, "brokeDown", or.brokeDown, "| last close", b[b.length - 1].cl, "=> check reports UP although price is now 1.4% below the range (earlier break wins)");
}

// ---- P6: volSpike is a running maximum over the day -----------------------------------------------------------
say("== P6 volSpike: a 09:20 spike keeps the 'volume' helper on until the close");
{
  const hist = new Map(["2026-10-13", "2026-10-14", "2026-10-15"].map((d) => [d, Array.from({ length: 30 }, (_, k) => bar(555 + 5 * k, 100, 101, 99, 100, 1000, d))]));
  const day = Array.from({ length: 30 }, (_, k) => bar(555 + 5 * k, 100, 101, 99, 100, k === 1 ? 5000 : 1000, "2026-10-16"));
  const early = sector.volSpike(day.slice(0, 3), hist);
  const late = sector.volSpike(day, hist);
  say("  at 09:30:", JSON.stringify(early && { mm: early.mm, x: early.mult }), "| at 11:35 (25 quiet bars later):", JSON.stringify(late && { mm: late.mm, x: late.mult }));
}

// ---- P7: rangeVsNormal compares a part-day range with full-day averages ------------------------------------------
say("== P7 rangeVsNormal: part-day range vs full-day mean");
{
  const bars = [];
  const days = [];
  for (let d = 0; d < 21; d++) days.push("2026-09-" + String(1 + d).padStart(2, "0"));
  days.forEach((dd, di) => {
    for (let k = 0; k < 25; k++) {
      const wob = di < 20 ? 0.4 : 0.4; // identical volatility on every day, including today
      const p = 100 + wob * Math.sin(k / 2.5);
      bars.push(bar(555 + 15 * k, p, p + 0.3, p - 0.3, p, 1000, dd));
    }
  });
  const at = (n) => sector.rangeVsNormal(bars.slice(0, bars.length - 25 + n)).ratio;
  say("  an EXACTLY average day: ratio at 09:30 =", at(1).toFixed(2), "| 10:30 =", at(5).toFixed(2), "| 12:30 =", at(13).toFixed(2), "| 15:15 =", at(25).toFixed(2), "(a 1.15x helper therefore means different things at different hours)");
}

// ---- P8: candlebacktest.measureOutcome near the close ------------------------------------------------------------------
say("== P8 candlebacktest.measureOutcome: a truncated horizon is reported as 'timeout'");
{
  const day = Array.from({ length: 25 }, (_, k) => bar(555 + 15 * k, 100, 100.1, 99.9, 100, 1000));
  const r = CB.measureOutcome(day, 22, "up", 100, 6, 0.5, 0.5);
  say("  signal on bar 22 of 25 with h=6:", JSON.stringify(r), "=> labelled timeout after only", r.bars, "bars (not 'open')");
}

// ---- Part 2: data-driven -------------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes("--data")) {
  const E = require("./engine");
  const { loadDataset } = require("./loader");
  const ds = loadDataset(args[args.indexOf("--data") + 1]);
  const dec = [];
  for (const st of ds.stocks) dec.push(...E.buildDecisions(st, { calendar: ds.calendar, mode: "live", corp: ds.corp, mktTrend: ds.mktTrend, delivPrev: ds.delivPrev }).decisions);
  const buckets = [["09:30-10:15", 0, 615], ["10:15-12:00", 615, 720], ["12:00-14:00", 720, 840], ["14:00-15:15", 840, 1000]];
  say("== P9 how the board's ingredients drift through the day (" + dec.length + " decisions in " + args[args.indexOf("--data") + 1] + ")");
  say("  bucket | n | any side | strong | moderate | weak | volume helper on | range>=1.15x | OR check set | |checks counted|");
  for (const [nm, lo, hi] of buckets) {
    const x = dec.filter((d) => d.tm > lo && d.tm <= hi);
    const p = (f) => (100 * x.filter(f).length / Math.max(1, x.length)).toFixed(1) + "%";
    const avgTot = (x.reduce((s, d) => s + d.tot, 0) / Math.max(1, x.length)).toFixed(2);
    say(`  ${nm} | ${x.length} | ${p((d) => d.side)} | ${p((d) => d.tier === 3)} | ${p((d) => d.tier === 2)} | ${p((d) => d.tier === 1)} | ${p((d) => d.vsOn)} | ${p((d) => d.rangeRatio != null && d.rangeRatio >= 1.15)} | ${p((d) => d.orFirst !== 0)} | ${avgTot}`);
  }
  const sm = dec.filter((d) => d.tier >= 2).length;
  say(`  overall: ${(100 * sm / dec.length).toFixed(1)}% of all stock-bars qualify as strong or moderate (${sm} of ${dec.length}).`);
  const orStale = dec.filter((d) => d.tm >= 720 && d.orFirst !== 0 && d.slot[0] !== 0 && d.orFirst !== d.slot[0]).length;
  const orSet = dec.filter((d) => d.tm >= 720 && d.orFirst !== 0 && d.slot[0] !== 0).length;
  say(`  after 12:00 the opening-range check points against the VWAP-position check in ${orSet ? (100 * orStale / orSet).toFixed(1) : "-"}% of bars where both are set.`);
  let zero = 0;
  let total = 0;
  for (const st of ds.stocks) {
    zero += st.hygiene["5m"].zeroVol;
    total += st.hygiene["5m"].parsed;
  }
  say(`  zero-volume 5m bars in the cache (which trip P1): ${zero} of ${total} (${(100 * zero / Math.max(1, total)).toFixed(3)}%).`);
}

if (require.main === module) require("fs").writeFileSync(path.join(__dirname, "code_review_probes.out.txt"), out.join("\n") + "\n");
