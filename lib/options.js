// lib/options.js - the free NSE option-chain adapter used by the Live Calls board and the
// Options Skew Map. NSE's v3 chain is quoted by the exchange in near real time; we only
// read it, never place orders.
//
// What is computed here:
//   * ATM quote from the strike nearest the underlying.
//   * 25-delta call and put IV, linearly interpolated by Black-Scholes delta.
//   * raw skew = put25 IV - call25 IV (vol points), normalised by ATM IV.
//   * a liquidity/quality tag from the quoted bid/ask spreads and open interest.
//
// Honesty rules:
//   * IV is derived from the bid/ask mid (or last price when a quote is one-sided) with
//     Black-Scholes, r = 6.5%, no dividend. It is a model output, not a forecast.
//   * NSE data is a snapshot. After the close it is the last session's chain; the timestamp
//     is carried through to the page and never presented as live when it is not.
//   * A stock with no usable 25-delta bracket is "missing", never zero-filled.
//   * The F&O ban list is a separate NSE publication and is NOT checked here.

const { getText, getUniverse, FO_INDEX, mapPool, istParts, formatIST, sleep } = require("./common");
const { NSE_HOLIDAYS } = require("./rules_core");
const { impliedVol, delta, price } = require("./bs");

const NSE = "https://www.nseindia.com";
const CHAIN = "/api/option-chain-v3";
const INFO = "/api/option-chain-contract-info";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/option-chain",
};
const R = 0.065;
const DAY = 864e5;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const MONTH_LABEL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// --------------------------------------------------------------------------
// Small date helpers. NSE labels are IST; this app only ever runs on IST sessions.
// --------------------------------------------------------------------------
function parseNseTimestamp(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || "").trim());
  if (!m || !(m[2] in MONTHS)) return null;
  return Date.UTC(+m[3], MONTHS[m[2]], +m[1], +m[4] - 5, +m[5] - 30, +(m[6] || 0));
}

function nseToIso(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || "").trim());
  if (!m || !(m[2] in MONTHS)) return null;
  return `${m[3]}-${String(MONTHS[m[2]] + 1).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
}

function isoToNse(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return null;
  return `${+m[3]}-${MONTH_LABEL[+m[2] - 1]}-${m[1]}`;
}

function expiryMs(label) {
  const iso = nseToIso(label);
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 15 - 5, 30 - 30, 0); // 15:30 IST
}

function dteDays(label, atMs = Date.now()) {
  const e = expiryMs(label);
  return e == null ? null : (e - atMs) / DAY;
}

function todayISO(now = new Date()) {
  return istParts(now).iso;
}

function isMarketOpen(now = new Date()) {
  const p = istParts(now);
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  if (NSE_HOLIDAYS.has(p.iso)) return false;
  return p.minutes >= 9 * 60 + 15 && p.minutes <= 15 * 60 + 30;
}

function asOfIST(tsMs) {
  return tsMs == null ? null : formatIST(Math.floor(tsMs / 1000));
}

// --------------------------------------------------------------------------
// NSE HTTP. The v3 endpoint accepts browser-like headers, but from a cloud IP it also
// needs the short-lived cookie session established by the option-chain page. Without
// that session NSE answers a few requests with empty quotes and then rejects the burst.
// One jar is kept per warm function instance; every response can rotate `_abck`.
// --------------------------------------------------------------------------
const cookies = new Map();
let cookieAt = 0;
let warmPromise = null;

function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function storeSetCookies(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const pair = String(raw).split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function warmSession(force = false) {
  if (!force && cookies.size && Date.now() - cookieAt < 15 * 60 * 1000) return;
  if (warmPromise) return warmPromise;
  warmPromise = (async () => {
    try {
      const r = await fetch(`${NSE}/option-chain`, {
        headers: {
          ...HEADERS,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(10000),
      });
      storeSetCookies(r);
      await r.text().catch(() => "");
      if (cookies.size) cookieAt = Date.now();
    } catch (e) {
      // A warm-up failure is not fatal; the request below can still be tried.
    } finally {
      warmPromise = null;
    }
  })();
  return warmPromise;
}

async function fetchJson(url, ms = 12000) {
  await warmSession();
  let err = new Error("NSE request failed");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const headers = { ...HEADERS };
      const cookie = cookieHeader();
      if (cookie) headers.Cookie = cookie;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
      storeSetCookies(r);
      const text = await r.text();
      if (!r.ok) {
        err = new Error(`NSE HTTP ${r.status}`);
        if (r.status === 404) break;
        if (r.status === 401 || r.status === 403 || r.status === 429) await warmSession(true);
      } else {
        try {
          return JSON.parse(text);
        } catch (e) {
          err = new Error("NSE returned non-JSON");
        }
      }
    } catch (e) {
      err = e;
    }
    if (attempt < 2) await sleep(350 * (attempt + 1) + Math.floor(Math.random() * 150));
  }
  throw err;
}

const expiryCache = new Map(); // reference symbol -> { at, expiries }
const chainCache = new Map(); // sym|expiry -> { at, chain }
const contractCache = new Map(); // sym -> { at, expiries }

function cacheGet(map, key, ttl) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  if (hit) map.delete(key);
  return null;
}

function cacheSet(map, key, data) {
  map.set(key, { at: Date.now(), data });
  if (map.size > 500) {
    const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, map.size - 400);
    for (const [k] of oldest) map.delete(k);
  }
}

async function contractInfo(symbol) {
  const hit = cacheGet(contractCache, symbol, 3600 * 1000);
  if (hit) return hit;
  const j = await fetchJson(`${NSE}${INFO}?symbol=${encodeURIComponent(symbol)}`, 10000);
  const expiries = (Array.isArray(j.expiryDates) ? j.expiryDates : [])
    .map((label) => ({ label, iso: nseToIso(label) }))
    .filter((e) => e.iso);
  const out = { symbol, expiries };
  cacheSet(contractCache, symbol, out);
  return out;
}

// All stock options share the monthly expiry calendar. One liquid reference is enough;
// fall back to a second name only if NSE returns an empty list for the first.
async function getReferenceExpiries(force = false) {
  if (!force) {
    const hit = cacheGet(expiryCache, "ref", 30 * 60 * 1000);
    if (hit) return hit;
  }
  let lastErr = null;
  for (const sym of ["RELIANCE", "HDFCBANK", "TCS"]) {
    try {
      const info = await contractInfo(sym);
      if (info.expiries.length) {
        const out = { symbol: sym, expiries: info.expiries };
        cacheSet(expiryCache, "ref", out);
        return out;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("NSE expiry list unavailable");
}

// First expiry at least minDTE days away; if none, the farthest still-valid expiry.
function pickExpiry(expiries, minDTE, nowMs = Date.now()) {
  const list = (expiries || [])
    .map((e) => (typeof e === "string" ? { label: e, iso: nseToIso(e) } : e))
    .map((e) => ({ ...e, dte: dteDays(e.label, nowMs) }))
    .filter((e) => e.iso && e.dte != null && e.dte > 0)
    .sort((a, b) => a.dte - b.dte);
  if (!list.length) return null;
  return list.find((e) => e.dte >= minDTE) || list[list.length - 1];
}

function quoteOf(o) {
  if (!o) return null;
  return {
    bid: +o.buyPrice1 || 0,
    ask: +o.sellPrice1 || 0,
    last: +o.lastPrice || 0,
    ivNse: +o.impliedVolatility || 0,
    oi: +o.openInterest || 0,
    oiChg: +o.changeinOpenInterest || 0,
    vol: +o.totalTradedVolume || 0,
  };
}

async function fetchChain(symbol, expiry, ttl = 60 * 1000) {
  const key = `${symbol}|${expiry}`;
  const hit = cacheGet(chainCache, key, ttl);
  if (hit) return hit;
  const url = `${NSE}${CHAIN}?type=Equity&symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(expiry)}`;
  const j = await fetchJson(url, 12000);
  const rows = (j && j.records && Array.isArray(j.records.data) ? j.records.data : [])
    .map((r) => ({ strike: +r.strikePrice || 0, ce: quoteOf(r.CE), pe: quoteOf(r.PE) }))
    .filter((r) => r.strike > 0);
  const chain = {
    sym: symbol,
    expiry,
    ts: (j && j.records && j.records.timestamp) || null,
    spot: +(j && j.records && j.records.underlyingValue) || 0,
    rows,
  };
  if (!chain.spot && rows.length) {
    const any = j.records.data.find((r) => (r.CE && r.CE.underlyingValue) || (r.PE && r.PE.underlyingValue));
    if (any) chain.spot = +(any.CE && any.CE.underlyingValue) || +(any.PE && any.PE.underlyingValue) || 0;
  }
  cacheSet(chainCache, key, chain);
  return chain;
}

// For the live board: use the front expiry, but if a symbol has no contract at that
// expiry, ask NSE for that symbol's own list and try its first valid expiry.
async function fetchChainForSymbol(symbol, minDTE = 2) {
  let ref;
  try {
    ref = await getReferenceExpiries();
  } catch (e) {
    ref = null;
  }
  let chosen = ref ? pickExpiry(ref.expiries, minDTE) : null;
  if (chosen) {
    try {
      const chain = await fetchChain(symbol, chosen.label, 45 * 1000);
      if (chain.rows.length && chain.spot > 0) return { chain, expiry: chosen };
    } catch (e) {
      // fall through to the per-symbol list
    }
  }
  try {
    const own = await contractInfo(symbol);
    const pick = pickExpiry(own.expiries, minDTE) || pickExpiry(own.expiries, 0);
    if (pick) {
      const chain = await fetchChain(symbol, pick.label, 45 * 1000);
      return { chain, expiry: pick };
    }
  } catch (e) {
    // no fallback
  }
  return { chain: null, expiry: chosen };
}

// --------------------------------------------------------------------------
// Pure maths: mark price, IV, delta, interpolation, summary.
// --------------------------------------------------------------------------
function markOf(q) {
  if (!q) return null;
  if (q.bid > 0 && q.ask > 0 && q.ask >= q.bid) {
    const px = (q.bid + q.ask) / 2;
    return { px, src: "mid", spreadPct: (q.ask - q.bid) / px, bid: q.bid, ask: q.ask, oi: q.oi, oiChg: q.oiChg, vol: q.vol };
  }
  if (q.last > 0) return { px: q.last, src: "last", spreadPct: null, bid: q.bid, ask: q.ask, oi: q.oi, oiChg: q.oiChg, vol: q.vol };
  return null;
}

function atmStrike(strikes, spot) {
  let best = null;
  for (const k of strikes) if (best == null || Math.abs(k - spot) < Math.abs(best - spot)) best = k;
  return best;
}

function interpAtDelta(points, target) {
  if (!points || !points.length) return null;
  const sorted = [...points].sort((a, b) => a.delta - b.delta);
  const exact = sorted.find((p) => Math.abs(p.delta - target) <= 0.005);
  if (exact) return { ...exact, target, gap: 0, mode: "exact" };
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if ((a.delta - target) * (b.delta - target) <= 0 && b.delta !== a.delta) {
      const w = (target - a.delta) / (b.delta - a.delta);
      return {
        iv: a.iv + (b.iv - a.iv) * w,
        strike: a.strike + (b.strike - a.strike) * w,
        delta: target,
        target,
        gap: b.delta - a.delta,
        mode: "interp",
        left: a,
        right: b,
        spreadPct: Math.max(a.spreadPct == null ? 0 : a.spreadPct, b.spreadPct == null ? 0 : b.spreadPct),
        oi: Math.min(a.oi, b.oi),
        src: a.src === "last" || b.src === "last" ? "last" : "mid",
      };
    }
  }
  return null;
}

function pointOut(p) {
  if (!p) return null;
  return {
    strike: round(p.strike, 2),
    delta: round(p.delta, 4),
    iv: round(p.iv, 6),
    px: p.px == null ? null : round(p.px, 4),
    bid: p.bid == null ? null : round(p.bid, 4),
    ask: p.ask == null ? null : round(p.ask, 4),
    spreadPct: p.spreadPct == null ? null : round(p.spreadPct, 4),
    oi: p.oi == null ? null : p.oi,
    oiChg: p.oiChg == null ? null : p.oiChg,
    vol: p.vol == null ? null : p.vol,
    src: p.src || null,
    mode: p.mode || null,
  };
}

function round(v, n) {
  return Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : null;
}

function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const k = (a.length - 1) / 2;
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  return a[lo] + (a[hi] - a[lo]) * (k - lo);
}

function buildPoints(chain, nowMs = Date.now()) {
  const spot = +chain.spot;
  const ts = parseNseTimestamp(chain.ts) || nowMs;
  const exp = expiryMs(chain.expiry);
  const T = exp == null ? null : (exp - ts) / (365 * DAY);
  if (!(spot > 0) || !(T > 0) || !chain.rows.length) return null;
  const points = [];
  for (const row of chain.rows) {
    const out = { strike: row.strike, call: null, put: null };
    for (const type of ["call", "put"]) {
      const q = type === "call" ? row.ce : row.pe;
      const m = markOf(q);
      if (!m) continue;
      const iv = impliedVol(m.px, spot, row.strike, T, R, type);
      if (!iv) continue;
      const d = delta(spot, row.strike, T, R, iv, type);
      out[type] = { ...m, strike: row.strike, iv, delta: d };
    }
    if (out.call || out.put) points.push(out);
  }
  if (!points.length) return null;
  const strikes = [...new Set(points.map((p) => p.strike))].sort((a, b) => a - b);
  const atmK = atmStrike(strikes, spot);
  const atm = points.find((p) => p.strike === atmK) || null;
  return { spot, ts, T, exp, atmK, atm, points };
}

// Pure summary of one chain. `includePoints` adds the smile points for the detail panel.
function summarizeChain(chain, opts = {}) {
  const built = buildPoints(chain, opts.nowMs);
  const sym = chain.sym;
  if (!built) {
    return { sym, expiry: chain.expiry, spot: chain.spot || null, error: "no usable option quotes", quality: "missing", flags: ["no usable option quotes"], n: { rows: chain.rows ? chain.rows.length : 0, calls: 0, puts: 0 } };
  }
  const { spot, ts, T, atmK, atm, points } = built;
  const calls = [];
  const puts = [];
  for (const p of points) {
    if (p.call && p.call.strike >= spot * 0.97 && p.call.delta > 0.03 && p.call.delta < 0.97) calls.push(p.call);
    if (p.put && p.put.strike <= spot * 1.03 && p.put.delta < -0.03 && p.put.delta > -0.97) puts.push(p.put);
  }
  calls.sort((a, b) => a.delta - b.delta);
  puts.sort((a, b) => a.delta - b.delta);
  const c25 = interpAtDelta(calls, 0.25);
  const p25 = interpAtDelta(puts, -0.25);
  const atmC = atm && atm.call ? atm.call : null;
  const atmP = atm && atm.put ? atm.put : null;
  const atmIV = atmC && atmP ? (atmC.iv + atmP.iv) / 2 : atmC ? atmC.iv : atmP ? atmP.iv : null;
  const rawSkew = c25 && p25 && atmIV ? p25.iv - c25.iv : null;
  const normSkew = rawSkew != null && atmIV > 0 ? rawSkew / atmIV : null;

  const flags = [];
  if (!atmIV) flags.push("no ATM IV");
  if (!c25) flags.push("no 25Δ call bracket");
  if (!p25) flags.push("no 25Δ put bracket");
  const spreads = [atmC, atmP, c25, p25].map((x) => (x && x.spreadPct != null ? x.spreadPct : null)).filter((x) => x != null);
  const maxSpread = spreads.length ? Math.max(...spreads) : null;
  const oiMin = c25 && p25 ? Math.min(c25.oi || 0, p25.oi || 0) : null;
  const gapMax = c25 && p25 ? Math.max(c25.gap || 0, p25.gap || 0) : null;
  if (maxSpread != null && maxSpread > 0.25) flags.push("wide quote spread");
  if (oiMin === 0) flags.push("zero OI at a 25Δ strike");
  if (gapMax != null && gapMax > 0.1) flags.push("wide delta gap");
  if (atmC && atmC.src === "last") flags.push("ATM call from last price");
  if (atmP && atmP.src === "last") flags.push("ATM put from last price");
  if (c25 && c25.src === "last") flags.push("25Δ call from last price");
  if (p25 && p25.src === "last") flags.push("25Δ put from last price");
  const quotedAll = [atmC, atmP, c25, p25].every((x) => x && x.src === "mid" && x.spreadPct != null);
  const quality = rawSkew == null ? "missing" : quotedAll && maxSpread <= 0.25 && oiMin > 0 && gapMax != null && gapMax <= 0.1 ? "ok" : "thin";

  const out = {
    sym,
    expiry: chain.expiry,
    asOf: chain.ts || null,
    asOfTs: ts,
    spot: round(spot, 2),
    dte: round((built.exp - ts) / DAY, 1),
    atm: {
      strike: atmK,
      iv: round(atmIV, 6),
      call: pointOut(atmC),
      put: pointOut(atmP),
    },
    call25: pointOut(c25),
    put25: pointOut(p25),
    rawSkew: round(rawSkew, 6),
    normSkew: round(normSkew, 6),
    quality,
    flags,
    maxSpreadPct: maxSpread == null ? null : round(maxSpread, 4),
    oiMin,
    n: { rows: chain.rows.length, calls: calls.length, puts: puts.length },
  };
  if (opts.includePoints) {
    out.points = points
      .filter((p) => Math.abs(p.strike / spot - 1) <= 0.25)
      .sort((a, b) => a.strike - b.strike)
      .slice(0, 90)
      .map((p) => ({ strike: round(p.strike, 2), call: pointOut(p.call), put: pointOut(p.put) }));
  }
  return out;
}

// Sector view: median raw/normalised skew and the share of valid stocks leaning the
// same way as the median. `total` includes stocks that could not be measured.
function sectorSkew(stocks, universe, industryOf) {
  const total = new Map();
  for (const u of universe) {
    const ind = (industryOf && industryOf.get(u.sym)) || "Other";
    total.set(ind, (total.get(ind) || 0) + 1);
  }
  const groups = new Map();
  for (const s of stocks) {
    const ind = (industryOf && industryOf.get(s.sym)) || "Other";
    if (!groups.has(ind)) groups.set(ind, []);
    groups.get(ind).push(s);
  }
  const out = [];
  for (const [sector, rows] of groups) {
    const valid = rows.filter((r) => r.normSkew != null && Number.isFinite(r.normSkew));
    if (!valid.length) continue;
    const okRows = valid.filter((r) => r.quality === "ok");
    const norm = median(valid.map((r) => r.normSkew));
    const raw = median(valid.map((r) => r.rawSkew));
    const atmIV = median(valid.map((r) => (r.atm && r.atm.iv != null ? r.atm.iv : null)));
    const normOk = okRows.length ? median(okRows.map((r) => r.normSkew)) : null;
    const sign = norm >= 0 ? 1 : -1;
    const agree = valid.filter((r) => (r.normSkew >= 0 ? 1 : -1) === sign).length;
    out.push({
      sector,
      total: total.get(sector) || rows.length,
      n: valid.length,
      ok: okRows.length,
      thin: valid.length - okRows.length,
      medianNormSkew: round(norm, 6),
      medianRawSkew: round(raw, 6),
      medianAtmIV: round(atmIV, 6),
      medianOkNormSkew: round(normOk, 6),
      agreement: valid.length ? round(agree / valid.length, 4) : null,
      lowSample: valid.length < 3,
      stocks: [...rows].sort((a, b) => (b.normSkew == null ? -Infinity : b.normSkew) - (a.normSkew == null ? -Infinity : a.normSkew)),
    });
  }
  out.sort((a, b) => b.medianNormSkew - a.medianNormSkew || b.n - a.n);
  return out;
}

async function buildSkewMap({ universe, industryOf, expiry, concurrency = 10, nowMs = Date.now() }) {
  const t0 = Date.now();
  const results = await mapPool(universe, concurrency, async (u) => {
    try {
      const chain = await fetchChain(u.sym, expiry, 60 * 1000);
      return summarizeChain(chain, { nowMs });
    } catch (e) {
      return { sym: u.sym, expiry, error: "NSE chain unavailable", quality: "failed", flags: ["chain unavailable"] };
    }
  });
  const annotated = results.map((r) => ({ ...r, industry: (industryOf && industryOf.get(r.sym)) || "Other" }));
  const stocks = annotated.filter((r) => r.normSkew != null);
  const failed = annotated.filter((r) => r.quality === "failed");
  const missing = annotated.filter((r) => r.quality === "missing");
  const ok = stocks.filter((r) => r.quality === "ok");
  const thin = stocks.filter((r) => r.quality !== "ok");
  const sectors = sectorSkew(annotated, universe, industryOf);
  const first = stocks.find((r) => r.asOfTs);
  const asOfTs = first ? first.asOfTs : null;
  const live = !!(asOfTs && todayISO(new Date(nowMs)) === istParts(new Date(asOfTs)).iso && isMarketOpen(new Date(nowMs)));
  return {
    expiry,
    asOf: asOfTs ? asOfIST(asOfTs) : null,
    asOfTs,
    dte: dteDays(expiry, asOfTs || nowMs),
    live,
    universe: universe.length,
    stocks: stocks.sort((a, b) => b.normSkew - a.normSkew),
    sectors,
    missing,
    failed,
    meta: {
      valid: stocks.length,
      ok: ok.length,
      thin: thin.length,
      missing: missing.length,
      failed: failed.length,
      sectors: sectors.length,
      tookMs: Date.now() - t0,
    },
  };
}

module.exports = {
  NSE,
  R,
  parseNseTimestamp,
  nseToIso,
  isoToNse,
  expiryMs,
  dteDays,
  isMarketOpen,
  asOfIST,
  getReferenceExpiries,
  contractInfo,
  pickExpiry,
  fetchChain,
  fetchChainForSymbol,
  summarizeChain,
  buildPoints,
  interpAtDelta,
  sectorSkew,
  buildSkewMap,
  median,
  markOf,
  _internals: { HEADERS, DAY, MONTHS, impliedVol, delta, price, getText, getUniverse, FO_INDEX, mapPool },
};
