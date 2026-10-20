"use strict";
// harness_check.js - proves the harness before any real data is trusted.
//   node --test research/backtest-2026-10-20/harness_check.js
// (set SELFTEST_TMP to choose where synthetic data is written; it is generated, never committed)
//
//  1. outcome mechanics (target / stop / both / timeout / open / n-a, long and short, both entry modes)
//  2. the lean rule used for leave-one-out equals the live trendVerdict side
//  3. day-cluster confidence intervals have honest coverage on clustered data
//  4. no look-ahead: scrambling every bar at/after a cut-off cannot change any decision made before it
//  5. data hygiene: holidays, half-day, short history, missing symbol, split, out-of-session/duplicate bars
//  6. parity with the REAL computeRows() on 200 sampled stock-bars, and the parity test FAILS when it should
//  7. null market: the pipeline must not manufacture an edge; false-positive rate is measured
//  8. planted-edge market: the pipeline must find it, with the right sign for longs and shorts

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const E = require("./engine");
const A = require("./analysis");
const S = require("./stats");
const synth = require("./synth");
const { loadDataset } = require("./loader");
const { run } = require("./run_backtest");
const P = require("./parity");
const sector = require(path.join(__dirname, "..", "..", "lib", "sector"));

const TMP = process.env.SELFTEST_TMP || fs.mkdtempSync(path.join(os.tmpdir(), "bt-harness-"));
const data = {};
function dataset(name, opts) {
  if (!data[name]) {
    const dir = path.join(TMP, name);
    synth.generate({ outDir: dir, ...opts });
    data[name] = dir;
  }
  return data[name];
}

// ---------------------------------------------------------------------------------------------------------
test("1. outcome mechanics", () => {
  const n = 12;
  const mk = (o, h, l, c) => ({ o5: Float64Array.from(o), h5: Float64Array.from(h), l5: Float64Array.from(l), c5: Float64Array.from(c) });
  const flat = (v) => Array(n - 2).fill(v);
  const st = mk([100.05, 100.1, ...flat(100.4)], [100.2, 100.52, ...flat(100.45)], [99.9, 100.0, ...flat(100.35)], [100.1, 100.4, ...flat(100.4)]);
  const dec = (extra) => ({ sym: "X", j0: 0, end5: n - 1, e: 100, atrPct: 0.4, kijun: 99.7, ...extra });
  const O = E.computeOutcomes([dec()], new Map([["X", st]]));
  const at = (side, b, h, en) => {
    const k = (0 * 2 + (side > 0 ? 0 : 1)) * E.NC + E.cIndex(b, h, en);
    return [E.RES_NAME[O.res[k]], Math.round(O.ret[k] * 1e4) / 1e4];
  };
  // fixed 0.5/0.5, 45m horizon (9 bars), entry at the bar close (100): hi 100.52 >= 100.5
  assert.deepStrictEqual(at(1, 0, 0, 0), ["target", 0.5]);
  assert.deepStrictEqual(at(-1, 0, 0, 0), ["stop", -0.5]); // the same bar is the short's stop
  // entry next 5m open (100.05): target 100.5503 is not reached, stop not reached -> timeout at the 9th bar close
  const to = at(1, 0, 0, 1);
  assert.strictEqual(to[0], "timeout");
  assert.ok(Math.abs(to[1] - ((100.4 - 100.05) / 100.05) * 100) < 1e-3);
  assert.ok(Math.abs(at(-1, 0, 0, 1)[1] + to[1]) < 1e-3); // short is the mirror
  // 3h horizon is longer than the 12 bars left in the session -> open (marked at the session close)
  assert.strictEqual(at(1, 0, 2, 1)[0], "open");
  // Kijun below price: long gets a 0.3% 1:1 bracket, short has no valid Kijun stop -> n/a
  assert.deepStrictEqual(at(1, 7, 0, 0), ["target", 0.3]);
  assert.strictEqual(at(-1, 7, 0, 0)[0], "n/a");
  // ATR 0.5x/1.0x with atr 0.4%: target 0.2%, stop 0.4%
  assert.deepStrictEqual(at(1, 4, 0, 0), ["target", 0.2]);
  // a bar touching both barriers is "both" and charged as a stop, never a win
  const st2 = mk([100], [100.7], [99.3], [100]);
  const O2 = E.computeOutcomes([{ sym: "X", j0: 0, end5: 0, e: 100, atrPct: null, kijun: null }], new Map([["X", st2]]));
  const k2 = E.cIndex(0, 0, 0);
  assert.strictEqual(E.RES_NAME[O2.res[k2]], "both");
  assert.strictEqual(Math.round(O2.ret[k2] * 100) / 100, -0.5);
  // no 5m bar after the decision -> every cell n/a
  const O3 = E.computeOutcomes([{ sym: "X", j0: -1, end5: 0, e: 100 }], new Map([["X", st2]]));
  assert.ok(Array.from(O3.res).every((x) => x === E.RES.NA));
});

test("1b. run mode selects one entry per side-run; every mode selects each bar", () => {
  const mkd = (sym, d, side) => ({ sym, d, j0: 1, side });
  const dec = [mkd("A", "d1", 0), mkd("A", "d1", 1), mkd("A", "d1", 1), mkd("A", "d1", 0), mkd("A", "d1", -1), mkd("A", "d1", -1), mkd("A", "d2", -1), mkd("A", "d2", -1)];
  const strat = { side: (d) => d.side };
  assert.deepStrictEqual(A.selectEvents(dec, strat, "run").evD, [1, 4, 6]); // d2 starts a fresh run
  assert.deepStrictEqual(A.selectEvents(dec, strat, "every").evD, [1, 2, 4, 5, 6, 7]);
  assert.deepStrictEqual(A.selectEvents(dec, strat, "run").evS, [0, 1, 1]);
});

test("2. leave-one-out lean rule equals the live trendVerdict side", () => {
  const r = synth.rng(5);
  let bad = 0;
  for (let i = 0; i < 20000; i++) {
    const slot = Array.from({ length: 6 }, () => [1, -1, 0][Math.floor(r.u() * 3)]);
    const up = slot.filter((x) => x === 1).length;
    const down = slot.filter((x) => x === -1).length;
    const v = sector.trendVerdict({ lean: { up, down, total: up + down } });
    const live = v && v.side ? (v.side === "up" ? 1 : -1) : 0;
    if (live !== A.leanSide(slot, -1)) bad++;
  }
  assert.strictEqual(bad, 0);
});

test("3. day-cluster intervals have honest coverage; naive Wilson does not", () => {
  const r = synth.rng(99);
  const G = 10;
  let cover = 0;
  let wCover = 0;
  const sims = 2000;
  const mu = 0.4; // true win probability
  for (let s = 0; s < sims; s++) {
    const per = [];
    let k = 0;
    let n = 0;
    for (let g = 0; g < G; g++) {
      const pg = Math.min(0.95, Math.max(0.05, mu + 0.18 * r.n())); // the market's day shifts every stock's odds together
      const m = 30 + Math.floor(r.u() * 60);
      let w = 0;
      for (let i = 0; i < m; i++) if (r.u() < pg) w++;
      per.push({ s: w, n: m });
      k += w;
      n += m;
    }
    const c = S.clusterRatio(per);
    if (c.ci[0] <= mu && mu <= c.ci[1]) cover++;
    const wl = S.wilson(k, n);
    if (wl.lo <= mu && mu <= wl.hi) wCover++;
  }
  console.log(`      coverage of a 95% interval: day-cluster ${(100 * cover / sims).toFixed(1)}%, naive Wilson ${(100 * wCover / sims).toFixed(1)}%`);
  assert.ok(cover / sims > 0.9, "cluster CI undercovers");
  assert.ok(wCover / sims < 0.85, "the demonstration should show naive Wilson undercovering");
});

// ---------------------------------------------------------------------------------------------------------
function ctxOf(ds) {
  return { calendar: ds.calendar, mode: "live", corp: ds.corp, mktTrend: ds.mktTrend, delivPrev: ds.delivPrev };
}

test("4. no look-ahead: scrambling the future cannot change an earlier decision", () => {
  const dir = dataset("null", { seed: 7, nStocks: 12, edge: 0 });
  const ds = loadDataset(dir);
  const sym = ds.stocks.find((s) => s.sym === "SYN03") || ds.stocks[0];
  const base = E.buildDecisions(sym, ctxOf(ds)).decisions;
  const lastDay = base[base.length - 1].d;
  // cut at 12:00 IST on the last evaluable day
  const day = base.filter((d) => d.d === lastDay);
  const cutMm = 12 * 60;
  const Tc = day.find((d) => d.tm === cutMm).T;
  const r = synth.rng(1234);
  const scrambled = {};
  for (const iv of ["5m", "15m", "60m", "1d"]) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "raw", iv, sym.sym + ".json")));
    const q = raw.indicators.quote[0];
    raw.timestamp.forEach((t, i) => {
      if (t >= Tc && q.close[i] != null) {
        const f = 0.9 + 0.2 * r.u();
        for (const k of ["open", "high", "low", "close"]) q[k][i] *= f;
        q.volume[i] = Math.round(q.volume[i] * (0.2 + 3 * r.u()));
      }
    });
    scrambled[iv] = raw;
  }
  const st2 = E.prepStock(sym.sym, scrambled, sym.industry);
  const alt = E.buildDecisions(st2, ctxOf(ds)).decisions;
  const strip = (d) => JSON.stringify({ ...d, j0: undefined, end5: undefined });
  const a = base.filter((d) => d.T <= Tc).map(strip);
  const b = alt.filter((d) => d.T <= Tc).map(strip);
  assert.ok(a.length > 100);
  assert.deepStrictEqual(b, a);
  // and the scramble really did change later decisions (the test is not vacuous)
  const later = (arr) => arr.filter((d) => d.T > Tc && d.d === lastDay).map(strip).join();
  assert.notStrictEqual(later(alt), later(base));
});

test("5. data hygiene on injected faults", () => {
  const dir = dataset("null", { seed: 7, nStocks: 12, edge: 0 });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json")));
  // nStocks 12 keeps SYN04 (short history), SYN06 (split), SYN08 (no file), SYN10 (out-of-session/duplicates)
  const ds = loadDataset(dir);
  const miss = Object.fromEntries(ds.missing.map((m) => [m.sym, m.why]));
  assert.match(miss.SYN04, /short history/);
  assert.match(miss.SYN08, /missing/);
  assert.ok(!ds.calendar.has(meta.injected.halfDay), "half-day must not be a decision day");
  for (const h of meta.injected.holidays) assert.ok(!ds.calendar.has(h));
  const oos = ds.stockBySym.get("SYN10");
  assert.ok(oos.hygiene["5m"].outOfSession >= 2 && oos.hygiene["5m"].duplicate >= 1, JSON.stringify(oos.hygiene["5m"]));
  assert.ok(oos.b5.every((b) => b.mm >= 555 && b.mm < 930));
  assert.ok(ds.corp.has("SYN06"), "split must be flagged");
  const split = ds.stockBySym.get("SYN06");
  const r = E.buildDecisions(split, ctxOf(ds));
  const sd = meta.injected.splitDate;
  assert.ok(!r.decisions.some((d) => d.d >= sd && d.d <= E.addDays(sd, 31)), "no decision may sit inside the corporate-action window");
  // null bars are skipped, never zero-filled
  assert.ok(ds.stocks.every((s) => s.b5.every((b) => b.hi > 0 && b.lo > 0 && b.cl > 0)));
});

test("6. parity with the real computeRows() and the parity test can fail", async () => {
  const dir = dataset("null40", { seed: 7, nStocks: 40, edge: 0 });
  const ds = loadDataset(dir);
  const all = [];
  for (const st of ds.stocks) all.push(...E.buildDecisions(st, ctxOf(ds)).decisions);
  const smp = P.makeSample(ds, all, 200, 20261020);
  const ok = await P.runParity(smp);
  console.log(`      parity: ${ok.sampled} stock-bars, ${ok.compared} field comparisons, ${ok.mismatches.length} mismatches`);
  assert.strictEqual(ok.sampled, 200);
  assert.strictEqual(ok.mismatches.length, 0, JSON.stringify(ok.mismatches.slice(0, 5)));
  for (const mut of ["5d-as-4", "ltp+0.3%", "1mo-shorter"]) {
    const bad = await P.runParity(smp, mut);
    console.log(`      mutation ${mut}: ${bad.mismatches.length} mismatches (must be > 0)`);
    assert.ok(bad.mismatches.length > 0, mut + " went undetected");
  }
  fs.writeFileSync(path.join(TMP, "parity.json"), JSON.stringify({ sampled: ok.sampled, compared: ok.compared, mismatches: ok.mismatches.length }));
});

function runOn(dir, cost, tag) {
  return run({ data: dir, out: path.join(TMP, "out-" + tag), mode: "live", cost, quiet: true, command: "harness check " + tag });
}

test("7. null market: no manufactured edge; false-positive rate measured", () => {
  const rates = [];
  let leads = 0;
  for (const seed of [21, 22, 23, 24, 25, 26]) {
    const dir = dataset("nullcal" + seed, { seed, nStocks: 24, edge: 0, specials: false });
    const R = runOn(dir, 0, "nullcal" + seed); // zero cost: tests the statistics themselves
    const fp = R.valEligible.filter((g) => g.mode === "run" && g.val.grossExp > 0 && g.val.grossP1 != null && g.val.grossP1 < 0.05).length;
    const el = R.valEligible.filter((g) => g.mode === "run").length;
    rates.push(fp / el);
    const Rc = runOn(dir, 0.05, "nullnet" + seed);
    leads += Rc.picks.filter((g) => g.lead).length;
  }
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  console.log(`      null market, cost 0: share of testable cells that look 'significantly positive' at p<0.05 = ${rates.map((x) => (100 * x).toFixed(1) + "%").join(", ")}; mean ${(100 * mean).toFixed(1)}% (nominal 5%); leads declared at 0.05% cost: ${leads}`);
  assert.ok(mean < 0.12, "false-positive rate is far above nominal: the statistics are anti-conservative");
  assert.strictEqual(leads, 0);
});

test("8. planted-edge market: the pipeline finds it, long and short", () => {
  const dir = dataset("edge", { seed: 31, nStocks: 40, edge: 0.04, specials: false });
  const R = runOn(dir, 0, "edge");
  const P1 = require("./run_backtest").PRIMARY[0];
  const sm = R.get("STRONG_MODERATE", "run", P1.c);
  const inv = R.get("INVERSE_SM", "run", P1.c);
  const rnd = R.get("BASE_RANDOM", "run", P1.c);
  console.log(`      planted edge: strong+moderate gross exp ${sm.all.grossExp.toFixed(3)}%/trade (p=${sm.all.grossP1.toExponential(1)}), inverse ${inv.all.grossExp.toFixed(3)}, random ${rnd.all.grossExp.toFixed(3)}`);
  assert.ok(sm.all.grossExp > 0.03 && sm.all.grossP1 < 0.05, "edge not detected");
  assert.ok(inv.all.grossExp < -0.03, "inverse should lose what the signal wins");
  assert.ok(Math.abs(rnd.all.grossExp) < 0.03, "random side should be near zero gross");
  const sideRows = R.sliceResults.filter((x) => x.sid === "STRONG_MODERATE" && x.P.name === "P1" && x.dimName === "side");
  assert.strictEqual(sideRows.length, 2);
  for (const x of sideRows) assert.ok(x.disc.grossExp > 0 && x.val.grossExp > 0, `${x.label} not positive in both halves`);
});

// ---------------------------------------------------------------------------------------------------------
test("9. fetch_data.js round trip against a local mock of Yahoo + NSE archives", async () => {
  const http = require("http");
  const { main } = require("./fetch_data");
  const src = dataset("null", { seed: 7, nStocks: 12, edge: 0 });
  const meta = JSON.parse(fs.readFileSync(path.join(src, "meta.json")));
  const bhav = JSON.parse(fs.readFileSync(path.join(src, "bhav.json")));
  const ivDir = { "5m": "5m", "15m": "15m", "60m": "60m", "1d": "1d" };
  let hits = { yahoo: 0, bhav: 0, flaky: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (code, body, type) => {
      res.writeHead(code, { "Content-Type": type || "text/plain" });
      res.end(body);
    };
    if (u.pathname === "/content/fo/fo_mktlots.csv") {
      return send(200, "UNDERLYING,SYMBOL,OCT-26\n" + "Index,NIFTY,75\nDummy,DUMMYX1,1\n" + "SYMBOL,SYMBOL,OCT-26\n" + meta.universe.map((x) => `Co ${x.sym},${x.sym},100`).join("\n") + "\nFPI,NIFTYFPI,1\n");
    }
    if (u.pathname === "/content/indices/ind_nifty500list.csv") {
      return send(200, "Company Name,Industry,Symbol,Series,ISIN Code\n" + meta.universe.map((x) => `Co ${x.sym},${x.industry},${x.sym},EQ,INE000`).join("\n"));
    }
    const m = u.pathname.match(/^\/v8\/finance\/chart\/(.+)$/);
    if (m) {
      hits.yahoo++;
      const code = decodeURIComponent(m[1]);
      const iv = u.searchParams.get("interval");
      let f;
      if (code === "^NSEI") f = path.join(src, "raw", "index", "NSEI_1d.json");
      else if (ivDir[iv]) f = path.join(src, "raw", ivDir[iv], code.replace(/\.NS$/, "") + ".json");
      if (code === "SYN03.NS" && iv === "5m" && hits.flaky++ < 2) return send(429, "slow down"); // must be retried
      if (!f || !fs.existsSync(f)) return send(404, "{}");
      return send(200, JSON.stringify({ chart: { result: [JSON.parse(fs.readFileSync(f))], error: null } }), "application/json");
    }
    const b = u.pathname.match(/sec_bhavdata_full_(\d{2})(\d{2})(\d{4})\.csv$/);
    if (b) {
      hits.bhav++;
      const iso = `${b[3]}-${b[2]}-${b[1]}`;
      const rows = bhav.rows[iso];
      if (!rows) return send(404, "not found");
      const head = "SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER";
      const body = Object.entries(rows).map(([s, r]) => `${s}, EQ, 01-Jan-2026, ${r[0]}, 1, 1, 1, 1, ${r[1]}, 1, ${r[2]}, 1, 1, 1, ${r[3]}`);
      body.push("OTHERCO, EQ, 01-Jan-2026, 10, 1, 1, 1, 1, 10, 1, 5, 1, 1, 1, 50", `${Object.keys(rows)[0]}, BE, 01-Jan-2026, 99, 1, 1, 1, 1, 99, 1, 5, 1, 1, 1, -`);
      return send(200, head + "\n" + body.join("\n"));
    }
    return send(404, "nope");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const out = path.join(TMP, "fetched");
  fs.rmSync(out, { recursive: true, force: true });
  try {
    const m = await main(["--out", out, "--yahoo", base, "--nse", base, "--skip-1m", "--concurrency", "3", "--min-universe", "5"]);
    assert.strictEqual(m.universe.length, 12, "bogus SYMBOL/NIFTY/DUMMY/NIFTYFPI rows must be dropped");
    assert.ok(m.errors["SYN08/5m"], "a symbol Yahoo does not have must be recorded as a problem");
    assert.ok(hits.flaky >= 2, "the 429s must have been retried");
    const again = hits.yahoo;
    await main(["--out", out, "--yahoo", base, "--nse", base, "--skip-1m", "--skip-bhav", "--concurrency", "3", "--min-universe", "5"]);
    assert.ok(hits.yahoo - again <= 8, "a second run must resume from the cache, not download everything again");
  } finally {
    server.close();
  }
  // the downloaded directory must behave exactly like the directory it was served from
  const a = runOn(src, 0.05, "direct");
  const b = runOn(out, 0.05, "fetched");
  assert.strictEqual(b.dec.length, a.dec.length);
  assert.strictEqual(fs.readFileSync(path.join(TMP, "out-direct", "grid.csv"), "utf8"), fs.readFileSync(path.join(TMP, "out-fetched", "grid.csv"), "utf8"));
});

test("10. 1m timing study agrees with the 5m replay wherever 5m is unambiguous", () => {
  const T = require("./timing_1m");
  const dir = dataset("t1m", { seed: 3, nStocks: 20, edge: 0.02, specials: false });
  const r = T.run({ data: dir, cost: 0.05 });
  assert.ok(r.names >= 4 && r.events > 100 && r.sessions >= 3, JSON.stringify({ n: r.names, e: r.events, s: r.sessions }));
  assert.strictEqual(r.consistency.mismatched, 0);
  assert.ok(r.flips.checks > 500);
  assert.ok(r.flips.byMinute[4].flipped >= r.flips.byMinute[1].flipped, "the further into the bar, the more flips");
  assert.ok(T.toMarkdown(r, 0.05).includes("Cost of a late entry"));
});
