"use strict";
// fetch_data.js - downloads and caches everything the backtest needs, ONCE, to a data directory.
//
//   node research/backtest-2026-10-20/fetch_data.js --out research/backtest-2026-10-20/data
//
// Resumable (existing files are kept; use --refresh to re-download). Polite: low concurrency, backoff on 429/5xx.
// Written files (raw Yahoo `result` objects are stored untouched so the replay parses them with the repo's own parser):
//   meta.json                 universe, industries, snapshot date, per-file errors
//   raw/5m|15m|60m|1d/SYM.json   Yahoo 5m (60d), 15m (60d), 60m (3mo), daily (1y)
//   raw/1m/SYM.json           1m, last 7 days, 20 most liquid names (entry-timing only)
//   raw/index/NSEI_1d.json    Nifty 50 daily (market regime context)
//   bhav.json                 NSE sec_bhavdata_full per trading day: {SYM: [prevClose, close, qty, delivery%]}
//                             (the set of dates that exist IS the NSE trading calendar; used to validate Yahoo's)
//
// Options: --concurrency 4  --limit N  --min-universe 100  --refresh  --skip-bhav  --skip-1m  --yahoo <base>  --nse <base>
// The two base options exist so the downloader can be tested against a local mock server.

const fs = require("fs");
const path = require("path");
const { parseSymbols, splitCsvLine } = require(path.join(__dirname, "..", "..", "lib", "common"));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getRetry(url, kind, tries = 5) {
  let last = null;
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: kind === "json" ? "application/json" : "*/*", "Accept-Language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return { status: 404 };
      if (r.ok) return { status: 200, body: kind === "json" ? await r.json() : await r.text() };
      last = new Error("HTTP " + r.status);
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) {
      last = e;
    }
    await sleep(800 * 2 ** a);
  }
  throw last || new Error("request failed");
}

async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const k = next++;
      if (k >= items.length) return;
      await fn(items[k], k);
    }
  }));
}

function istToday() {
  return new Date(Date.now() + 19800000).toISOString().slice(0, 10);
}

async function main(argv) {
  const get = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
  const has = (k) => argv.includes(k);
  const out = path.resolve(get("--out", path.join(__dirname, "data")));
  const YH = get("--yahoo", "https://query1.finance.yahoo.com");
  const NSE = get("--nse", "https://nsearchives.nseindia.com").replace(/\/$/, "");
  const conc = Number(get("--concurrency", 4));
  const limit = get("--limit") ? Number(get("--limit")) : Infinity;
  const refresh = has("--refresh");
  for (const sub of ["5m", "15m", "60m", "1d", "1m", "index"]) fs.mkdirSync(path.join(out, "raw", sub), { recursive: true });
  const errors = {};
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

  // ---- universe (same source as the live app: NSE F&O lot file, industries from the NIFTY 500 list)
  log("universe ...");
  const fo = await getRetry(`${NSE}/content/fo/fo_mktlots.csv`, "text");
  if (fo.status !== 200) throw new Error("could not download fo_mktlots.csv");
  const foSyms = parseSymbols(fo.body);
  if (foSyms.length < Number(get("--min-universe", 100))) throw new Error(`F&O list looked wrong (${foSyms.length} symbols)`);
  const n500 = await getRetry(`${NSE}/content/indices/ind_nifty500list.csv`, "text");
  const industryOf = new Map(n500.status === 200 ? parseSymbols(n500.body).map((u) => [u.sym, u.industry]) : []);
  const universe = foSyms.slice(0, limit).map((u) => ({ sym: u.sym, industry: industryOf.get(u.sym) || "" }));
  log(`${universe.length} F&O symbols`);

  // ---- Yahoo
  const spec = { "5m": ["60d", "5m"], "15m": ["60d", "15m"], "60m": ["3mo", "60m"], "1d": ["1y", "1d"] };
  const todo = [];
  for (const u of universe) for (const iv of Object.keys(spec)) todo.push({ sym: u.sym, iv, code: u.sym + ".NS" });
  todo.push({ sym: "NSEI", iv: "1d", code: "^NSEI", dir: "index", file: "NSEI_1d.json", range: "1y", interval: "1d" });
  let done = 0;
  await pool(todo, conc, async (t) => {
    const dir = t.dir || t.iv;
    const file = path.join(out, "raw", dir, t.file || t.sym + ".json");
    if (!refresh && fs.existsSync(file)) {
      done++;
      return;
    }
    const [range, interval] = t.range ? [t.range, t.interval] : spec[t.iv];
    const url = `${YH}/v8/finance/chart/${encodeURIComponent(t.code)}?range=${range}&interval=${interval}`;
    try {
      const r = await getRetry(url, "json");
      const res = r.status === 200 && r.body && r.body.chart && r.body.chart.result && r.body.chart.result[0];
      if (!res || !(res.timestamp && res.timestamp.length)) errors[`${t.sym}/${t.iv}`] = r.status === 404 ? "not found at Yahoo" : "empty result";
      else fs.writeFileSync(file, JSON.stringify(res));
    } catch (e) {
      errors[`${t.sym}/${t.iv}`] = String(e && e.message).slice(0, 80);
    }
    if (++done % 50 === 0) log(`yahoo ${done}/${todo.length}`);
    await sleep(120);
  });
  log(`yahoo done: ${Object.keys(errors).length} problems`);

  // ---- 1m for the 20 most liquid names (mean daily turnover of the last 20 sessions)
  if (!has("--skip-1m")) {
    const liq = [];
    for (const u of universe) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(out, "raw", "1d", u.sym + ".json")));
        const q = r.indicators.quote[0];
        const n = r.timestamp.length;
        let s = 0;
        let k = 0;
        for (let i = Math.max(0, n - 21); i < n - 1; i++) if (q.close[i] > 0 && q.volume[i] > 0) {
          s += q.close[i] * q.volume[i];
          k++;
        }
        if (k >= 10) liq.push([u.sym, s / k]);
      } catch (e) {
        // no daily file: cannot rank this name
      }
    }
    liq.sort((a, b) => b[1] - a[1]);
    await pool(liq.slice(0, 20), conc, async ([sym]) => {
      const file = path.join(out, "raw", "1m", sym + ".json");
      if (!refresh && fs.existsSync(file)) return;
      try {
        const r = await getRetry(`${YH}/v8/finance/chart/${encodeURIComponent(sym + ".NS")}?range=7d&interval=1m`, "json");
        const res = r.status === 200 && r.body.chart.result && r.body.chart.result[0];
        if (res && res.timestamp && res.timestamp.length) fs.writeFileSync(file, JSON.stringify(res));
        else errors[`${sym}/1m`] = "empty result";
      } catch (e) {
        errors[`${sym}/1m`] = String(e && e.message).slice(0, 80);
      }
      await sleep(150);
    });
    log("1m done");
  }

  // ---- NSE bhavcopy for every weekday from 75 calendar days back (60d of intraday + prior-day delivery)
  const bhav = { tradingDates: [], rows: {}, note: "sec_bhavdata_full; [prevClose, close, qty, delivery%]; a missing file (404) = not a trading day" };
  if (!has("--skip-bhav")) {
    const bf = path.join(out, "bhav.json");
    let cache = null;
    if (!refresh && fs.existsSync(bf)) cache = JSON.parse(fs.readFileSync(bf, "utf8"));
    const want = new Set(universe.map((u) => u.sym));
    const today = istToday();
    const days = [];
    for (let k = 75; k >= 0; k--) {
      const d = new Date(Date.now() + 19800000 - k * 86400000);
      const w = d.getUTCDay();
      if (w !== 0 && w !== 6) days.push(d.toISOString().slice(0, 10));
    }
    const nonTrading = new Set(cache ? cache.nonTrading || [] : []);
    await pool(days, 3, async (iso) => {
      if (cache && (cache.rows[iso] || nonTrading.has(iso))) return;
      const ddmmyyyy = iso.slice(8, 10) + iso.slice(5, 7) + iso.slice(0, 4);
      try {
        const r = await getRetry(`${NSE}/products/content/sec_bhavdata_full_${ddmmyyyy}.csv`, "text");
        if (r.status === 404) {
          if (iso < today) nonTrading.add(iso); // today's file may simply not be published yet
          return;
        }
        const lines = r.body.split(/\r?\n/).filter((l) => l.trim());
        const head = splitCsvLine(lines[0]).map((x) => x.trim().toUpperCase());
        const ix = (n) => head.indexOf(n);
        const [si, sei, pi, ci, qi, di] = ["SYMBOL", "SERIES", "PREV_CLOSE", "CLOSE_PRICE", "TTL_TRD_QNTY", "DELIV_PER"].map(ix);
        if (si < 0 || ci < 0) throw new Error("unexpected bhavcopy header");
        const rows = {};
        for (const line of lines.slice(1)) {
          const c = splitCsvLine(line);
          const sym = (c[si] || "").trim().toUpperCase();
          if (!want.has(sym) || (sei >= 0 && (c[sei] || "").trim() !== "EQ")) continue;
          const n = (x) => {
            const v = parseFloat((x || "").trim());
            return Number.isFinite(v) ? v : null;
          };
          rows[sym] = [n(c[pi]), n(c[ci]), n(c[qi]), n(c[di])];
        }
        if (Object.keys(rows).length) (cache = cache || { rows: {} }).rows[iso] = rows;
      } catch (e) {
        errors[`bhav/${iso}`] = String(e && e.message).slice(0, 80);
      }
    });
    cache = cache || { rows: {} };
    bhav.rows = cache.rows;
    bhav.tradingDates = Object.keys(cache.rows).sort();
    bhav.nonTrading = [...nonTrading].sort();
    fs.writeFileSync(bf, JSON.stringify(bhav));
    log(`bhavcopy: ${bhav.tradingDates.length} trading days, ${bhav.nonTrading.length} non-trading weekdays`);
  }

  const meta = {
    snapshotDate: istToday(),
    fetchedAt: new Date().toISOString(),
    source: { yahoo: YH, nse: NSE },
    universe,
    errors,
    note: "Yahoo intraday history is limited to ~60 calendar days (5m, 15m); 60m 3 months; 1m 7 days.",
  };
  fs.writeFileSync(path.join(out, "meta.json"), JSON.stringify(meta, null, 1));
  log(`done. ${Object.keys(errors).length} problems recorded in meta.json (symbols that failed are listed as missing by the backtest)`);
  return meta;
}

module.exports = { main };
if (require.main === module) main(process.argv.slice(2)).catch((e) => {
  console.error("FAILED:", e && e.message);
  process.exit(1);
});
