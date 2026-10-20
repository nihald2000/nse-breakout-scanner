"use strict";
// timing_1m.js - entry-timing study on 1-minute data (last ~7 sessions, ~20 liquid names). NOT a signal test: the sample
// is far too small for that. It answers two practical questions the 5m replay cannot:
//   A. How much does a late entry cost? The signal appears at the 15m close T; an order placed at T+k minutes enters at
//      the open of that minute. Horizon end is fixed at T+90m, so delay shortens the hold.
//   B. How often does the VWAP-position check flip between the last CLOSED 5m close (what the replay uses) and the live
//      price a few minutes into the forming bar (what production uses, difference D1)?
// Also reports how many 5m "both in one candle" outcomes the 1m path resolves.
//
//   node research/backtest-2026-10-20/timing_1m.js --data <dir> --out <dir> [--cost 0.05]

const fs = require("fs");
const path = require("path");
const E = require("./engine");
const A = require("./analysis");
const S = require("./stats");
const { loadDataset, readJson } = require("./loader");

const DELAYS = [0, 1, 2, 3, 5]; // minutes after the 15m close
const BARRIERS = [
  { name: "fixed 0.5/0.5", t: 0.5, s: 0.5 },
  { name: "fixed 1.0/1.0", t: 1.0, s: 1.0 },
];
const HOLD_MIN = 90;

function walk1(b1, j0, jEnd, side, e, T, Sd) {
  const tgt = e * (1 + (side * T) / 100);
  const stp = e * (1 - (side * Sd) / 100);
  for (let j = j0; j <= jEnd; j++) {
    const hT = side > 0 ? b1[j].hi >= tgt : b1[j].lo <= tgt;
    const hS = side > 0 ? b1[j].lo <= stp : b1[j].hi >= stp;
    if (hT && hS) return { r: "both", ret: -Sd };
    if (hS) return { r: "stop", ret: -Sd };
    if (hT) return { r: "target", ret: T };
  }
  const last = b1[jEnd];
  return { r: "timeout", ret: ((last.cl - e) / e) * 100 * side };
}

function run(opts) {
  const ds = loadDataset(opts.data);
  const names = [];
  for (const st of ds.stocks) {
    const raw = readJson(path.join(opts.data, "raw", "1m", st.sym + ".json"));
    if (raw) names.push({ st, b1: E.cleanBars(raw).bars });
  }
  const res = { names: names.length, sessions: 0, events: 0, delays: {}, flips: { checks: 0, flipped: 0, byMinute: {} }, bothResolved: { fiveMinBoth: 0, resolvedTarget: 0, resolvedStop: 0, stillBoth: 0 }, consistency: { compared: 0, mismatched: 0 } };
  if (!names.length) {
    res.note = "no 1m files in the data directory (fetch_data.js --skip-1m was used, or Yahoo returned none)";
    return res;
  }
  const rt = 2 * opts.cost;
  const acc = {};
  for (const B of BARRIERS) for (const k of DELAYS) acc[B.name + "|" + k] = { n: 0, tgt: 0, stp: 0, both: 0, tmo: 0, gross: 0 };
  const sessions = new Set();
  for (const { st, b1 } of names) {
    const t1 = Float64Array.from(b1, (b) => b.t);
    const decs = E.buildDecisions(st, { calendar: ds.calendar, mode: "live", corp: ds.corp, mktTrend: ds.mktTrend, delivPrev: ds.delivPrev }).decisions;
    const idxOf = (t) => {
      const j = E.lowerBoundT(t1, t);
      return j < t1.length && t1[j] === t ? j : -1;
    };
    for (const d of decs) {
      if (idxOf(d.T) < 0) continue; // outside the 1m window
      sessions.add(d.d);
      // B. VWAP position: closed-5m close vs the price k minutes into the forming bar (close of the minute before)
      if (d.vwap != null) {
        const base = Math.sign(d.px - d.vwap);
        for (let k = 1; k <= 4; k++) {
          const j = idxOf(d.T + 60 * k - 60);
          if (j < 0 || d.T + 60 * k - 60 < d.T) continue;
          const px = b1[j].cl;
          res.flips.checks++;
          res.flips.byMinute[k] = res.flips.byMinute[k] || { checks: 0, flipped: 0 };
          res.flips.byMinute[k].checks++;
          if (Math.sign(px - d.vwap) !== base) {
            res.flips.flipped++;
            res.flips.byMinute[k].flipped++;
          }
        }
      }
      // A. delayed entries for strong+moderate signals
      if (d.tier < 2 || !d.side) continue;
      res.events++;
      const endT = Math.min(d.T + HOLD_MIN * 60, st.t5[d.end5] + 300);
      for (const B of BARRIERS) {
        for (const k of DELAYS) {
          const j0 = idxOf(d.T + 60 * k);
          if (j0 < 0) continue;
          let jEnd = j0;
          while (jEnd + 1 < b1.length && b1[jEnd + 1].t < endT && b1[jEnd + 1].d === d.d) jEnd++;
          const e = b1[j0].o;
          const w = walk1(b1, j0, jEnd, d.side, e, B.t, B.s);
          const a = acc[B.name + "|" + k];
          a.n++;
          a.gross += w.ret;
          if (w.r === "target") a.tgt++;
          else if (w.r === "stop") a.stp++;
          else if (w.r === "both") a.both++;
          else a.tmo++;
        }
      }
      // 5m vs 1m consistency and 'both' resolution at zero delay (fixed 0.5/0.5, 90m, next 5m open)
      const j5 = d.j0;
      if (j5 >= 0) {
        const B = BARRIERS[0];
        const e5 = st.o5[j5];
        let jEnd5 = Math.min(j5 + 17, d.end5);
        const side = d.side;
        const tgt = e5 * (1 + (side * B.t) / 100);
        const stp = e5 * (1 - (side * B.s) / 100);
        let r5 = "timeout";
        for (let j = j5; j <= jEnd5; j++) {
          const hT = side > 0 ? st.h5[j] >= tgt : st.l5[j] <= tgt;
          const hS = side > 0 ? st.l5[j] <= stp : st.h5[j] >= stp;
          if (hT && hS) { r5 = "both"; break; }
          if (hS) { r5 = "stop"; break; }
          if (hT) { r5 = "target"; break; }
        }
        const j0 = idxOf(d.T);
        let jE = j0;
        const endT5 = st.t5[jEnd5] + 300;
        while (jE + 1 < b1.length && b1[jE + 1].t < endT5 && b1[jE + 1].d === d.d) jE++;
        const w = walk1(b1, j0, jE, side, b1[j0].o, B.t, B.s);
        res.consistency.compared++;
        if (r5 === "both") {
          res.bothResolved.fiveMinBoth++;
          if (w.r === "target") res.bothResolved.resolvedTarget++;
          else if (w.r === "stop") res.bothResolved.resolvedStop++;
          else if (w.r === "both") res.bothResolved.stillBoth++;
        } else if (r5 !== w.r) res.consistency.mismatched++;
      }
    }
  }
  res.sessions = sessions.size;
  for (const key of Object.keys(acc)) {
    const a = acc[key];
    const dec = a.tgt + a.stp;
    res.delays[key] = { events: a.n, decidable: dec, hit: dec ? a.tgt / dec : null, both: a.both, timeout: a.tmo, grossExp: a.n ? a.gross / a.n : null, netExp: a.n ? a.gross / a.n - rt : null };
  }
  res.note = "Tiny sample (about 5 sessions x 20 names): use it to size execution effects, never to judge the signal.";
  return res;
}

function toMarkdown(res, cost) {
  const f = (x, d = 3) => (x == null ? "-" : x.toFixed(d));
  const L = ["# 1-minute entry-timing study", "", `Names with 1m data: ${res.names}; sessions covered: ${res.sessions}; strong+moderate events: ${res.events}. ${res.note || ""}`, ""];
  if (!res.events && !res.flips.checks) return L.join("\n");
  L.push("## A. Cost of a late entry (strong+moderate, hold ends 90 min after the 15m close)", "", "| barrier | delay (min) | events | decidable | hit % | both | timeout | gross exp. %/trade | net exp. %/trade |", "|---|---|---|---|---|---|---|---|---|");
  for (const key of Object.keys(res.delays)) {
    const [b, k] = key.split("|");
    const x = res.delays[key];
    L.push(`| ${b} | ${k} | ${x.events} | ${x.decidable} | ${x.hit == null ? "-" : (100 * x.hit).toFixed(1) + "%"} | ${x.both} | ${x.timeout} | ${f(x.grossExp)} | ${f(x.netExp)} |`);
  }
  L.push("", `Net uses ${cost}% per side. With only a few hundred events no difference between delays can be called real.`, "", "## B. VWAP-position check: closed 5m close vs the live price inside the forming bar (difference D1)", "");
  L.push(`Checks: ${res.flips.checks}; the side of the check flipped in ${res.flips.flipped} (${res.flips.checks ? (100 * res.flips.flipped / res.flips.checks).toFixed(1) : "-"}%).`, "", "| minutes into the forming bar | checks | flipped | % |", "|---|---|---|---|");
  for (const k of Object.keys(res.flips.byMinute)) L.push(`| ${k} | ${res.flips.byMinute[k].checks} | ${res.flips.byMinute[k].flipped} | ${(100 * res.flips.byMinute[k].flipped / res.flips.byMinute[k].checks).toFixed(1)}% |`);
  const b = res.bothResolved;
  L.push("", "## C. Candles that touched both barriers (fixed 0.5/0.5, 90m, next 5m open)", "", `5m outcomes marked 'both': ${b.fiveMinBoth}. With 1m bars: target first ${b.resolvedTarget}, stop first ${b.resolvedStop}, still both inside one minute ${b.stillBoth}.`, "", `Consistency: for every event where the 5m outcome was not 'both', the 1m outcome was identical in ${res.consistency.compared - b.fiveMinBoth - res.consistency.mismatched} of ${res.consistency.compared - b.fiveMinBoth} cases (mismatches: ${res.consistency.mismatched}).`);
  return L.join("\n");
}

module.exports = { run, toMarkdown };

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const out = get("--out", __dirname);
  const cost = Number(get("--cost", 0.05));
  const res = run({ data: get("--data", path.join(__dirname, "data")), cost });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "timing_1m.json"), JSON.stringify(res, null, 1));
  fs.writeFileSync(path.join(out, "timing_1m.md"), toMarkdown(res, cost));
  console.log(toMarkdown(res, cost));
}
