"use strict";
// parity.js - asserts that the replay's read (engine.assemble via buildDecisions) equals what the REAL
// api/sectorstocks.js computeRows() returns for the same stock at the same moment.
//
// Method: Yahoo and the clock are stubbed. For a sampled (stock, decision bar) the stub serves exactly what Yahoo
// would have served at that instant (range=5d/5m = last 5 sessions, range=1mo/15m = bars from the same day one
// month earlier, closed bars only, regularMarketPrice = last closed 5m close) and Date.now() is set to the bar's
// close time. The windows are re-built here with plain date filters, deliberately NOT with the engine's index
// arithmetic, so the test also checks the engine's windowing.
//
// Run standalone on a data directory:   node research/backtest-2026-10-20/parity.js --data <dir> [--n 200]

const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
const E = require("./engine");

function toRaw(sym, bars, ltp, T) {
  return {
    meta: { symbol: sym + ".NS", gmtoffset: 19800, regularMarketPrice: ltp, regularMarketTime: T },
    timestamp: bars.map((b) => b.t),
    indicators: { quote: [{ open: bars.map((b) => b.o), high: bars.map((b) => b.hi), low: bars.map((b) => b.lo), close: bars.map((b) => b.cl), volume: bars.map((b) => b.vol) }] },
  };
}

// `mutate` is used only by harness_check.js to prove this test can FAIL: it perturbs what the stub serves.
function yahooAt(st, range, interval, T, mutate) {
  const D = new Date((T + 19800 - 1) * 1000).toISOString().slice(0, 10);
  if (interval === "5m") {
    const dates = [...new Set(st.b5.filter((b) => b.d <= D).map((b) => b.d))].slice(mutate === "5d-as-4" ? -4 : -5);
    const bars = st.b5.filter((b) => dates.includes(b.d) && b.t + 300 <= T);
    const px = bars[bars.length - 1].cl * (mutate === "ltp+0.3%" ? 1.003 : 1);
    return toRaw(st.sym, bars, px, bars[bars.length - 1].t + 300);
  }
  const mb = mutate === "1mo-shorter" ? E.addDays(E.monthBack(D), 10) : E.monthBack(D);
  const bars = st.b15.filter((b) => b.d >= mb && b.d <= D && b.t + 900 <= T);
  return toRaw(st.sym, bars, bars[bars.length - 1].cl, T);
}

// Same field list for both sides; floats compared with a tiny tolerance.
function fingerprint(read, extra) {
  const r = read;
  return {
    "lean.up": r.lean.up,
    "lean.down": r.lean.down,
    "lean.total": r.lean.total,
    "trend.side": r.trend ? r.trend.side : null,
    "trend.tier": r.trend ? r.trend.tier : null,
    "trend.agree": r.trend ? r.trend.agree : null,
    "trend.helpers": r.trend ? r.trend.helpers : null,
    "vwapTrend.dir": r.vwapTrend ? r.vwapTrend.dir : null,
    "vwapTrend.pct": r.vwapTrend ? r.vwapTrend.pct : null,
    "structure.dir": r.structure ? r.structure.dir : null,
    "structure.up": r.structure ? r.structure.up : null,
    "or.pos": r.or ? r.or.pos : null,
    "or.mm": r.or ? r.or.mm : null,
    "adx.v": r.adx ? r.adx.v : null,
    "adx.dir": r.adx ? r.adx.dir : null,
    "volSpike.mult": r.volSpike ? r.volSpike.mult : null,
    "range.ratio": r.range ? r.range.ratio : null,
    "patterns": JSON.stringify(r.patterns || []),
    rvol: extra.rvol,
    vwap: extra.vwap,
    pchg: extra.pchg,
    "lines.pos": extra.pos,
    "lines.kijun": extra.kijun,
  };
}

function same(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  return a === b;
}

// sample: [{ st, i15, d (decision record) }]
async function runParity(sample, mutate) {
  const common = require(path.join(ROOT, "lib", "common"));
  const realNow = Date.now;
  const realYahoo = common.yahooChart;
  const realGetText = common.getText;
  let curStock = null;
  let curT = 0;
  common.yahooChart = async (sym, i, range, interval) => yahooAt(curStock, range, interval, curT, mutate);
  common.getText = async () => {
    throw new Error("network disabled for the parity test"); // delivery % is display-only and not compared
  };
  for (const m of ["lib/sector.js", "api/sectorstocks.js"]) delete require.cache[require.resolve(path.join(ROOT, m))];
  const { computeRows } = require(path.join(ROOT, "api", "sectorstocks"))._internals;

  const mismatches = [];
  let compared = 0;
  const fields = new Set();
  try {
    for (const s of sample) {
      curStock = s.st;
      curT = s.d.T;
      Date.now = () => curT * 1000;
      const { rows } = await computeRows([s.st.sym], "15m", () => s.st.industry);
      Date.now = realNow;
      const row = rows[0];
      if (!row) {
        mismatches.push({ sym: s.st.sym, d: s.d.d, tm: s.d.tm, field: "(row)", live: "no row", replay: "row" });
        continue;
      }
      const live = fingerprint(row.read, { rvol: row.rvol == null ? null : row.rvol, vwap: row.vwap, pchg: row.pchg, pos: row.lines.ok ? row.lines.pos : null, kijun: row.lines.ok ? row.lines.kijun : null });
      // replay: re-run the engine assembly from the stored windows (same call the decision builder made)
      const rd = s.replay();
      const mine = fingerprint(rd.read, { rvol: rd.rvol == null ? null : Math.round(rd.rvol * 100) / 100, vwap: rd.vwapNow, pchg: rd.pchg, pos: rd.lines.ok ? rd.lines.pos : null, kijun: rd.lines.ok ? rd.lines.kijun : null });
      // computeRows rounds rvol to 2 dp; compare on that basis
      for (const k of Object.keys(live)) {
        fields.add(k);
        compared++;
        if (!same(live[k], mine[k])) mismatches.push({ sym: s.st.sym, d: s.d.d, tm: s.d.tm, field: k, live: live[k], replay: mine[k] });
      }
      // what buildDecisions STORED for this bar (the values the backtest actually uses) vs the real computeRows
      const stored = {
        "stored.lean.up": [row.read.lean.up, s.d.up],
        "stored.lean.down": [row.read.lean.down, s.d.dn],
        "stored.lean.total": [row.read.lean.total, s.d.tot],
        "stored.side": [row.read.trend && row.read.trend.side ? (row.read.trend.side === "up" ? 1 : -1) : 0, s.d.side],
        "stored.tier": [row.read.trend ? { strong: 3, moderate: 2, weak: 1, none: 0 }[row.read.trend.tier] : 0, s.d.tier],
        "stored.agree": [row.read.trend ? row.read.trend.agree : 0, s.d.agree],
        "stored.helpers": [row.read.trend && row.read.trend.helpers != null ? row.read.trend.helpers : null, s.d.helpers],
        "stored.adxV": [row.read.adx ? row.read.adx.v : null, s.d.adxV],
        "stored.rangeRatio": [row.read.range ? row.read.range.ratio : null, s.d.rangeRatio],
        "stored.rvol": [row.rvol, s.d.rvol == null ? null : Math.round(s.d.rvol * 100) / 100],
        "stored.pchg": [row.pchg, s.d.pchg],
        "stored.vwapDist": [row.vwapDistPct, s.d.vwapDist],
        "stored.kijun": [row.lines.ok ? row.lines.kijun : null, s.d.kijun],
        "stored.volSpike": [row.read.volSpike ? 1 : 0, s.d.vsOn],
      };
      for (const k of Object.keys(stored)) {
        fields.add(k);
        compared++;
        if (!same(stored[k][0], stored[k][1])) mismatches.push({ sym: s.st.sym, d: s.d.d, tm: s.d.tm, field: k, live: stored[k][0], replay: stored[k][1] });
      }
      // the six check slots must reproduce the live lean counts
      const up = s.d.slot.filter((x) => x === 1).length;
      const dn = s.d.slot.filter((x) => x === -1).length;
      compared += 2;
      if (up !== row.read.lean.up) mismatches.push({ sym: s.st.sym, d: s.d.d, tm: s.d.tm, field: "slots.up", live: row.read.lean.up, replay: up });
      if (dn !== row.read.lean.down) mismatches.push({ sym: s.st.sym, d: s.d.d, tm: s.d.tm, field: "slots.down", live: row.read.lean.down, replay: dn });
    }
  } finally {
    Date.now = realNow;
    common.yahooChart = realYahoo;
    common.getText = realGetText;
    for (const m of ["lib/sector.js", "api/sectorstocks.js"]) delete require.cache[require.resolve(path.join(ROOT, m))];
  }
  return { sampled: sample.length, compared, fields: [...fields], mismatches };
}

// Builds a stratified random sample of decisions and a closure that re-runs the engine assembly for each.
function makeSample(ds, decisions, n, seed) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const picked = new Set();
  const out = [];
  const N = decisions.length;
  let guard = 0;
  while (out.length < Math.min(n, N) && guard++ < n * 50) {
    const k = Math.floor(rnd() * N);
    if (picked.has(k)) continue;
    picked.add(k);
    const d = decisions[k];
    const st = ds.stockBySym.get(d.sym);
    out.push({
      st,
      d,
      replay: () => {
        // identical call to the one buildDecisions makes, but windows rebuilt from the decision's indices
        const o5 = st.idx5.ordOf.get(d.d);
        const j5 = E.lowerBoundT(st.t5, d.T - 300);
        const w5 = st.b5.slice(st.idx5.starts[Math.max(0, o5 - 4)], j5 + 1);
        const mb = E.monthBack(d.d);
        let s15 = st.idx15.starts[st.idx15.ordOf.get(d.d)];
        while (s15 > 0 && st.b15[s15 - 1].d >= mb) s15--;
        return E.assemble(w5, st.b15.slice(s15, d.i15 + 1), st.b5[j5].cl);
      },
    });
  }
  return out;
}

module.exports = { runParity, makeSample, yahooAt };

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (k, dflt) => (args.includes(k) ? args[args.indexOf(k) + 1] : dflt);
  const { loadDataset } = require("./loader");
  const ds = loadDataset(get("--data", path.join(__dirname, "data")));
  const all = [];
  for (const st of ds.stocks) all.push(...E.buildDecisions(st, { calendar: ds.calendar, mode: "live", corp: ds.corp, mktTrend: ds.mktTrend, delivPrev: ds.delivPrev }).decisions);
  const sample = makeSample(ds, all, Number(get("--n", 200)), 20261020);
  runParity(sample).then((r) => {
    console.log(JSON.stringify({ sampled: r.sampled, compared: r.compared, mismatches: r.mismatches.length }, null, 1));
    if (r.mismatches.length) console.log(r.mismatches.slice(0, 20));
    require("fs").writeFileSync(path.join(get("--out", __dirname), "parity.json"), JSON.stringify(r, null, 1));
    process.exit(r.mismatches.length ? 1 : 0);
  });
}
