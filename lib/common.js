// lib/common.js - helpers shared by the scanner functions:
//   NSE stock lists (nsearchives.nseindia.com CSVs), Yahoo Finance chart fetch/parse, IST time maths.
// Zero dependencies. Not a route: it lives outside api/ on purpose.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const ARCHIVE = "https://nsearchives.nseindia.com/content/indices/";
const FO_URL = "https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv";
const LISTS = {
  "NIFTY 50": "ind_nifty50list.csv",
  "NIFTY NEXT 50": "ind_niftynext50list.csv",
  "NIFTY 100": "ind_nifty100list.csv",
  "NIFTY 200": "ind_nifty200list.csv",
  "NIFTY 500": "ind_nifty500list.csv",
  "NIFTY MIDCAP 100": "ind_niftymidcap100list.csv",
  "NIFTY SMALLCAP 100": "ind_niftysmallcap100list.csv",
};
const FO_INDEX = "SECURITIES IN F&O";
const INDEX_SYMBOLS = /^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|NIFTYNXT50)$/;
// Rows that appear in NSE files but are not real stocks: a repeated header fragment
// and the fictitious F&O pseudo-underlying "NIFTYFPI".
const BOGUS_SYMBOLS = new Set(["SYMBOL", "NIFTYFPI"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);

// --------------------------------------------------------------------------
// Stock lists (cached in memory while the function instance stays warm)
// --------------------------------------------------------------------------
const uniCache = new Map();

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

async function getText(url, tries = 2) {
  let err = new Error("request failed");
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(12000),
      });
      if (r.ok) return await r.text();
      err = new Error(`HTTP ${r.status} for ${url}`);
    } catch (e) {
      err = e;
    }
    await sleep(500 * (i + 1));
  }
  throw err;
}

function parseSymbols(csv) {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const h = lines.findIndex((l) => /symbol/i.test(l));
  if (h < 0) return [];
  const head = splitCsvLine(lines[h]).map((x) => x.toLowerCase());
  const si = head.indexOf("symbol");
  const ser = head.indexOf("series");
  const ind = head.indexOf("industry");
  if (si < 0) return [];
  const out = [];
  const seen = new Set();
  for (const line of lines.slice(h + 1)) {
    const c = splitCsvLine(line);
    const sym = (c[si] || "").toUpperCase();
    if (!/^[A-Z0-9&-]{1,20}$/.test(sym)) continue;
    if (sym.startsWith("DUMMY") || INDEX_SYMBOLS.test(sym) || BOGUS_SYMBOLS.has(sym)) continue;
    if (ser >= 0 && c[ser] && c[ser].toUpperCase() !== "EQ") continue;
    if (seen.has(sym)) continue;
    seen.add(sym);
    out.push({ sym, industry: ind >= 0 ? c[ind] || "" : "" });
  }
  return out;
}

async function getUniverse(index) {
  const hit = uniCache.get(index);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.symbols;
  const url = index === FO_INDEX ? FO_URL : ARCHIVE + LISTS[index];
  const symbols = parseSymbols(await getText(url));
  if (symbols.length < 20) throw new Error(`stock list looked wrong (${symbols.length} symbols from ${url})`);
  uniCache.set(index, { at: Date.now(), symbols });
  return symbols;
}

// --------------------------------------------------------------------------
// Prices (Yahoo Finance chart API)
// --------------------------------------------------------------------------
const YH_HOSTS = ["query1", "query2"];

async function yahooChart(sym, i, range = "3mo", interval = "1d") {
  const code = /^\^|\./.test(sym) ? sym : sym + ".NS"; // index tickers (^NSEI, X.NS) are used as given
  const url = `https://${YH_HOSTS[i % 2]}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}?range=${range}&interval=${interval}`;
  let err = new Error("request failed");
  for (let a = 0; a < 2; a++) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(9000),
      });
      if (r.ok) {
        const j = await r.json();
        const res = j && j.chart && j.chart.result && j.chart.result[0];
        if (res) return res;
        err = new Error("empty result");
        break;
      }
      err = new Error("HTTP " + r.status);
      if (r.status === 404) break;
    } catch (e) {
      err = e;
    }
    await sleep(350 * (a + 1));
  }
  throw err;
}

function parseChart(res) {
  const m = res.meta || {};
  const off = Number.isFinite(m.gmtoffset) ? m.gmtoffset : 19800;
  const dayOf = (t) => new Date((t + off) * 1000).toISOString().slice(0, 10);
  const ts = res.timestamp || [];
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const hi = q.high && q.high[i];
    const lo = q.low && q.low[i];
    const cl = q.close && q.close[i];
    const vol = q.volume && q.volume[i];
    const op = q.open && q.open[i];
    if (![hi, lo, cl, vol].every((x) => Number.isFinite(x))) continue;
    bars.push({ d: dayOf(ts[i]), t: ts[i], o: Number.isFinite(op) ? op : 0, hi, lo, cl, vol });
  }
  if (!Number.isFinite(m.regularMarketTime) || !Number.isFinite(m.regularMarketPrice)) return null;
  return { bars, meta: m, liveTs: m.regularMarketTime, liveISO: dayOf(m.regularMarketTime) };
}

// --------------------------------------------------------------------------
// India VIX (Yahoo ^INDIAVIX). Fetched at most once per hour per warm instance. Returns null when it cannot be had,
// and callers then show the IV caution as unavailable (they never pretend it passed).
// --------------------------------------------------------------------------
let vixCache = null;

async function indiaVix(force = false, fetcher = yahooChart) {
  if (!force && vixCache && Date.now() - vixCache.at < 3600 * 1000) return vixCache.v;
  let v = null;
  try {
    const r = await fetcher("^INDIAVIX", 0, "1y", "1d");
    const m = r.meta || {};
    const off = Number.isFinite(m.gmtoffset) ? m.gmtoffset : 19800;
    const ts = r.timestamp || [];
    const cl = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
    const daily = [];
    for (let i = 0; i < ts.length; i++) {
      if (Number.isFinite(cl[i]) && cl[i] > 0) daily.push({ d: new Date((ts[i] + off) * 1000).toISOString().slice(0, 10), c: cl[i] });
    }
    if (daily.length >= 30) v = { daily, live: Number.isFinite(m.regularMarketPrice) ? m.regularMarketPrice : null };
  } catch (e) {
    v = null;
  }
  if (v) vixCache = { at: Date.now(), v };
  return v;
}

// Percentile with linear interpolation (p in 0..100) of an unsorted array.
function percentile(arr, p) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const k = ((a.length - 1) * p) / 100;
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  return a[lo] + (a[hi] - a[lo]) * (k - lo);
}

// VIX state as known at the start of session `iso`. `daily` = [{d, c}] ascending.
// Live (useLive): the current level against the previous 60 completed sessions.
// Replay: the previous session's close against the 60 sessions before it (nothing from `iso` or later is used).
function vixState(vix, iso, useLive) {
  if (!vix || !vix.daily) return { ok: false, note: "India VIX unavailable" };
  const prior = vix.daily.filter((x) => x.d < iso);
  if (prior.length < 31) return { ok: false, note: "India VIX history too short" };
  const live = useLive && Number.isFinite(vix.live) ? vix.live : null;
  const value = live != null ? live : prior[prior.length - 1].c;
  const hist = (live != null ? prior : prior.slice(0, -1)).slice(-60).map((x) => x.c);
  if (hist.length < 30) return { ok: false, note: "India VIX history too short" };
  const p60 = percentile(hist, 60);
  return { ok: true, value, p60, n: hist.length, elevated: value > p60 };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const k = next++;
      if (k >= items.length) return;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

// --------------------------------------------------------------------------
// Time helpers (IST)
// --------------------------------------------------------------------------
function istParts(date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  return {
    iso: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    minutes: Number(p.hour) * 60 + Number(p.minute) + Number(p.second) / 60,
  };
}

function sessionFraction(now) {
  if (now.weekday === "Sat" || now.weekday === "Sun") return 1;
  const open = 9 * 60 + 15;
  const close = 15 * 60 + 30;
  if (now.minutes <= open || now.minutes >= close) return 1;
  return Math.max((now.minutes - open) / (close - open), 0.05);
}

// Volume is front-loaded, so a concave curve is a better "expected share so far" than linear.
const expectedVolumeShare = (frac) => (frac >= 1 ? 1 : Math.pow(frac, 0.7));

function formatIST(tsSeconds) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(tsSeconds * 1000))
      .map((x) => [x.type, x.value])
  );
  return `${p.day}-${MONTHS[Number(p.month) - 1]}-${p.year} ${p.hour}:${p.minute} IST`;
}

module.exports = {
  UA, LISTS, FO_INDEX, sleep, clamp, splitCsvLine, getText, parseSymbols, getUniverse,
  yahooChart, parseChart, indiaVix, percentile, vixState, mapPool, istParts, sessionFraction, expectedVolumeShare, formatIST,
};
