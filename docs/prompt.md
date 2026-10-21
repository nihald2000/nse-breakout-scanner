# NSE Intraday Scanner Suite (v2): full build prompt

> Historical rebuild prompt dated 2026-10-19. It predates the current Trade Monitor and strategy audit. Do not treat its appendix as current source or restore its VIX hard block / trigger-close replay. Current architecture is documented in `README.md`; current strategy evidence and replay semantics are in `research/strategy-audit-2026-10-21.md` and `research/index-rulebook-2026-10-21/`. VIX is now premium-cost context only, and index rulebook studies fill at the next 5-minute open.

Paste this whole file into a fresh Claude Code session (with Vercel access) to rebuild the project. It records the user, the goals, every decision, the exact rules and parameters, the test method, the deployment procedure, what is unverified, and, in the appendix, the complete source of all 23 files.

Date of this write-up: Mon 2026-10-19 (IST). Deployed app: https://nse-breakout-scanner-tau.vercel.app (Vercel project `nse-breakout-scanner`, team `team_KP30bRdjsOHTVsKmxZj8qU9w`, region iad1, Node 22, Vercel login protection (SSO) still on, so the assistant that built it could not open the live site).

---

## 1. Who this is for, and the ground rules

- The user is an Indian intraday and swing trader (NSE). They want screening aids on a phone and a desktop, not advice.
- Never fabricate results. Never promise profits. State every limitation next to the feature it applies to. A flat or negative result is a valid result.
- Plain, short, practical language. Numbers in Indian format (en-IN). Times are IST.
- Buy CE / buy PE only. Nothing here sells options.
- No look-ahead anywhere: only finished candles; a swing point is only known `n` bars after it formed.
- Parameters are fixed in advance and are NOT tuned on the backtest sample (do not change 0.7% to 0.9% or 2R to 1.8R to turn a table green).
- A skipped filter must be visible in the checks list and in the data-quality tag. Never fabricate option-chain data.
- Keep the wording "This is a sanity check on behaviour, not proof."
- Zero dependencies. No API keys, secrets or .env in the repository. Do not delete or recreate the Vercel project, do not transfer the team.

## 2. What exists (four pages, five API routes)

| Page | Purpose |
|---|---|
| `/` Breakouts | NSE stocks breaking their 20-day high/low with volume confirmation. Universe selectable. Live prices every 10 s, rescan every 3 min. |
| `/ichimoku.html` Ichimoku Cloud | Stocks that just closed beyond the 9/26/52 cloud (Daily / 1h / 15m) with a BUY / WAIT / SELL call and an SL/T1/T2 plan. |
| `/indices.html` Index Options | The F&O index rulebook (section 4): live signals for NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50, a 5-minute chart with rule levels and replayed signals, a strikes-only ladder, an India VIX bar, and a Backtest tab with diagnostics. |
| `/journal.html` Journal | Paper-trade log in localStorage (keys `bs-journal-v1`, `bs-bt-summary`), compares the log with the last backtest summary, CSV export (text columns are guarded against formula injection with `csvCell(v, isText)`; numbers are not prefixed). |

API routes: `api/scan.js`, `api/quotes.js`, `api/ichimoku.js` (exports `_internals`), `api/indices.js` (live rulebook, exports `_internals`), `api/indexchart.js` (one session of 5m candles + overlays + replayed signals), `api/backtest.js` (about 40 sessions per index, returns the trade list with Black-Scholes option P&L).
Libraries (outside `api/`, so not routes): `lib/common.js` (NSE lists, Yahoo fetch, IST time, India VIX + percentile + `vixState`), `lib/indicators.js` (EMA, Wilder RSI, Wilder ADX/DI), `lib/bs.js` (Black-Scholes + expiry calendar), `lib/broker.js` (the one broker plug-in point; NO adapter configured), `lib/rules_core.js` (shared constants `P`, helpers, `settle`, VIX/size handling, reliability), `lib/rules_orb.js`, `lib/rules_ichi.js`, `lib/rules_vwap.js`, `lib/rules_maxpain.js`, `lib/replay.js`.

Stack: Vercel serverless, CommonJS, **zero dependencies**, static files from `public/`, shared dark theme in `public/app.css`. `vercel.json` `maxDuration`: scan 60, ichimoku 60, indices 30, indexchart 30, backtest 60. `package.json`: name `nse-breakout-scanner`, version 1.0.0, private, node 22.x.

## 3. Data sources and their limits

- **Stock lists**: NSE archive CSVs (reachable from Vercel). **Prices**: Yahoo Finance v8 chart API. NSE's live endpoints (including the option chain) are blocked from cloud servers.
- **Index tickers**: `^NSEI`, `^NSEBANK`, `NIFTY_FIN_SERVICE.NS`, `NIFTY_MID_SELECT.NS`, `^NSMIDCP`. India VIX is `^INDIAVIX`.
- **Index feeds carry no volume.** So index VWAP is only a session-average proxy, volume filters are skipped (and say so), and the two VWAP strategies are NO TRADE on Yahoo index data. Row state is "NO TRADE (needs true VWAP)" with action NO TRADE.
- **History depth**: about 60 calendar days of 5m/15m (about 40 sessions), 1h and 1d longer. This caps every backtest.
- **Expiry calendar**: Tuesday; NIFTY weekly, the others last Tuesday of the month. Holiday shifts are NOT handled. Strike steps 50, 100, 50, 25, 100.
- The build sandbox cannot reach Yahoo or a broker, so engine tests use a deterministic synthetic market. Anything seen in tests (for example ORB breakout 128 trades, -0.07R on the index) is TEST data, not real results. Real-data behaviour has not been verified by the assistant.

## 4. The index rulebook (v2: exact rules and parameters)

Engine: closed bars only; mirrored (negated) series for shorts; no-look-ahead pivots; 4h bars aggregated from 60m; Wilder RSI/ADX. Opening range = 9:15 to 9:30. A trigger is actionable for at most 2 bars.

**VIX filter.** India VIX above the 60th percentile of the previous 60 sessions downgrades every BUY to WAIT ("IV elevated"). Needs at least 31 prior closes, otherwise the filter is SKIPPED visibly (tag "VIX n/a"). Replay uses the previous close against the 60 sessions before it.

**Size hint (ORB).** Opening-range width vs the recent typical width: 0.5x to 2x = full; 2x to 3x = half (0.5R in the backtest); beyond 3x or under 0.5x = skip (no trade; counted as "blocked", not as a trade).

**A. ORB breakout, Track 1 (5m).** Close beyond the range edge plus 10% of the width, no retest. Breakout candle volume at least 1.5x the mean of up to the 20 prior session bars (minimum 3; the spec's 20 is unreachable at 9:35); skipped visibly when there is no volume. Stop = extreme from the breakout candle to the latest bar, capped at 0.7%. T1 2R, T2 3R. Trail (information only): VWAP, or the 20 EMA when VWAP is a proxy.
**ORB retest, Track 2.** The earlier logic: break, retest within 10% of the width that holds, then a close beyond the retest candle; a close back inside cancels it. T1 1R, T2 2R. Only evaluated when Track 1 has not fired. Both tracks: skipped on chop, after 14:00, stop over 0.7%.

**B. Ichimoku + Fib, intraday (15m).** Trend filter: ADX(14) on 15m at least 20 with +DI above -DI (long) or the reverse (short); if ADX is unavailable the 5m 20-EMA slope over 10 bars. The 1h cloud is information only. Leg = last confirmed swing low then high (3 bars each side); retrace 38.2% to 61.8% (deeper = PULLBACK TOO DEEP); the candle dips into the zone, closes back beyond 38.2%, with volume at least the mean of the prior 3 bars when volume exists. No entries before 10:00 or after the 14:30 candle. Stop = retrace extreme, cap 1.0%; the prior swing must be at least 1R away.
**Ichimoku swing (Daily / 4h).** Same logic one level up (Daily cloud at least 0.25% wide). Stop cap 4.0% (my assumption). Shown on the page, NOT backtested.

**C. VWAP reclaim (5m, needs true VWAP).** At least 9 consecutive closes on the trend side, then 1 to 3 closes across, then a close back with volume at least the mean of the prior 2 candles. Stop at the dip extreme, cap 0.5%, T1 2R, T2 3R. RSI(9) 38 to 58 at the dip low for calls (45 to 65 at the dip high for puts), skipped with a note if the dip is inside the first 15 bars.
**VWAP pullback (5m, needs true VWAP).** Last two swing lows rising (highs falling for puts); dip to within 0.1% of VWAP that holds after 3 of the previous 6 closes were clear of it; trigger a close beyond that candle. Skip on 3 or more VWAP crossings, stop over 0.5%, or after 14:30; starts 9:50. Every VWAP row carries a reliability tag: low = no volume; medium = under 12 bars or under 95% volume coverage; high otherwise. Low means NO TRADE.

**D. Expiry max pain (NIFTY, BANKNIFTY, expiry days, 14:00 to 15:30).** Needs open interest from an option chain; without a broker adapter the row says NO TRADE and never guesses. Not backtestable.

Every row also carries data-quality tags (true VWAP / proxy / no volume / VIX ok / VIX blocked / VIX n/a / chain ok / no chain), a checks list (informational checks marked), and the option to look at (`ATM <strike> CE (1 ITM ...)`). Expiry days block ORB, Ichimoku and VWAP. When the market is closed BUY/WAIT become CLOSED.

## 5. Replay, option model and backtest design

- `replayDay` walks one session from 9:30, handing the rules only bars finished by then. The first BUY per strategy per session is the trade (one trade per strategy per session). Entry = close of the trigger candle; stop checked before target inside a candle; a gap through the stop fills at the open; flat at 15:15. Two plans: Stop/T1 and Stop/T2. `sizeHint` scales R (full 1, half 0.5, skip 0). Size-skip signals are excluded from the trade list and counted as blocked.
- Black-Scholes (`lib/bs.js`): r 6.5%, IV = India VIX / 100 (+0.02 for the 1-ITM strike), "-10% IV" scenario uses sigma x 0.9. optR = (P1 - P0) / (P0 - P(S = stop, T0)). Costs are applied in the browser (index cost in R, option cost in % of premium). Option R can be huge when the stop is tiny (one trade showed about 40R), which drags the average; the premium % is unaffected, and the page says so next to the table.
- Sigma note: lowering sigma lowers BOTH call and put values (the original spec said it raises the put; that is not what Black-Scholes does).
- Broker premium hook: if `lib/broker.js` supplies premiums, the page uses them in the "no IV change" column and labels it "N with real broker premium". This hook was tested only against a FAKE adapter, never a real one. No vendor is chosen.
- Statistics (browser): trades, Wilson 95% hit-rate interval, average R with a 95% range, profit factor, max drawdown R, longest losing run, equity curves, by-index table, every trade. Diagnostics: outcome classes, average stop, by side, by entry hour, by weekday; every table adds up to the trade count. Rows under 30 trades are flagged.
- The ladder is strikes only. No premium, bid/ask or OI (no feed). Do not fake it.

## 6. How the tests were done

All tests ran against a deterministic synthetic market (`synth_server`), not real data: 131 assertions over 5 Node test files (helpers, ORB, Ichimoku, VWAP, misc/market), a look-ahead property test, a fake-broker-adapter test (3 modes), and a Playwright UI run at desktop and phone widths (no horizontal overflow, no console errors; a `data:` favicon removes the favicon 404). All dynamic text is set with `textContent`.

## 7. Why a backtest is often negative (honest diagnosis)

Costs alone subtract about 0.10R per trade by default; simple known rules usually have no edge after costs; tight stops are inside 5-minute noise; the simulation is pessimistic (stop before target, entry after confirmation); index VWAP is a proxy; 40 sessions can be one regime and five indices are not independent; the option model leaves out spread, skew, IV change and expiry-week gamma. Do not tweak parameters until the table turns green. A real answer needs longer history from a broker API with a train/test split, real option premiums, and 20 to 30 forward paper sessions in the Journal.

## 8. Deployment procedure (Vercel MCP) and gotchas

- `create_deployment` with `name` and `project` = `nse-breakout-scanner`, `target` = `production`, and NO `teamId` (passing it 403s). No CLI: files are sent inline (`encoding: utf-8`) or by `sha` + `size` reference.
- A deployment replaces the whole file set, so every file must be present in every call. A referenced sha that does not match the new local file silently deploys the OLD file. After every deployment run `list_deployment_files` and compare each `uid` with `sha1sum` of the local file. (When hand-inlining a large file, a one-character slip changes the sha: it happened once, an escaped em dash became a literal one, harmless, and the local file was synced to match.)
- Poll `get_deployment` until READY and check the alias `nse-breakout-scanner-tau.vercel.app` is attached.

## 9. Open items

No broker adapter vendor is chosen; Vercel SSO protection is on; the expiry calendar ignores holidays; ichimoku_swing is shown (on /indices.html) but not backtested; expiry max pain is not backtestable without OI; GitHub is not connected (the project is not Git-linked, a local git commit of the v1 state exists); `rules_ichi.js` has a stray unused option `sgFix` (harmless).

---

# Appendix: complete source (23 files)

Each block below is the exact file as deployed. Recreate each at the given path.

## `package.json`

````json
{
  "name": "nse-breakout-scanner",
  "version": "1.0.0",
  "private": true,
  "description": "Intraday breakout scanner on NSE data",
  "engines": { "node": "22.x" }
}
````

## `vercel.json`

````json
{
  "functions": {
    "api/scan.js": {
      "maxDuration": 60
    },
    "api/ichimoku.js": {
      "maxDuration": 60
    },
    "api/indices.js": {
      "maxDuration": 30
    },
    "api/indexchart.js": {
      "maxDuration": 30
    },
    "api/backtest.js": {
      "maxDuration": 60
    }
  }
}
````

## `lib/common.js`

````js
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
    if (sym.startsWith("DUMMY") || INDEX_SYMBOLS.test(sym)) continue;
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
// and callers then SKIP the VIX filter and say so (they never pretend it passed).
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
  return { ok: true, value, p60, n: hist.length, blocked: value > p60 };
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
````

## `lib/indicators.js`

````js
// lib/indicators.js - EMA, RSI and ADX/DI (Wilder). Zero dependencies, pure functions.
// Every value at index i uses bars 0..i only (no look-ahead). Not a route: it lives outside api/.

function ema(values, p) {
  const k = 2 / (p + 1);
  let e = null;
  return values.map((v) => (e = e == null ? v : v * k + e * (1 - k)));
}

// Wilder RSI. The first value is at index p (needs p changes); earlier entries are null.
function rsi(closes, p = 9) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= p) return out;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d;
    else l -= d;
  }
  g /= p;
  l /= p;
  const val = () => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[p] = val();
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
    l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
    out[i] = val();
  }
  return out;
}

// Wilder ADX with +DI / -DI. bars need hi, lo, cl. ADX first appears at index 2p-1; DI at index p.
function adx(bars, p = 14) {
  const n = bars.length;
  const adxA = new Array(n).fill(null);
  const pdi = new Array(n).fill(null);
  const mdi = new Array(n).fill(null);
  if (n < 2 * p) return { adx: adxA, pdi, mdi };
  const tr = [0];
  const pdm = [0];
  const mdm = [0];
  for (let i = 1; i < n; i++) {
    const up = bars[i].hi - bars[i - 1].hi;
    const dn = bars[i - 1].lo - bars[i].lo;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(bars[i].hi - bars[i].lo, Math.abs(bars[i].hi - bars[i - 1].cl), Math.abs(bars[i].lo - bars[i - 1].cl)));
  }
  let sTR = 0;
  let sP = 0;
  let sM = 0;
  for (let i = 1; i <= p; i++) {
    sTR += tr[i];
    sP += pdm[i];
    sM += mdm[i];
  }
  const dx = [];
  const setDI = (i) => {
    pdi[i] = sTR > 0 ? (100 * sP) / sTR : 0;
    mdi[i] = sTR > 0 ? (100 * sM) / sTR : 0;
    const s = pdi[i] + mdi[i];
    return s > 0 ? (100 * Math.abs(pdi[i] - mdi[i])) / s : 0;
  };
  dx.push(setDI(p));
  for (let i = p + 1; i < n; i++) {
    sTR = sTR - sTR / p + tr[i];
    sP = sP - sP / p + pdm[i];
    sM = sM - sM / p + mdm[i];
    dx.push(setDI(i));
    if (dx.length === p) adxA[i] = dx.reduce((a, b) => a + b, 0) / p;
    else if (dx.length > p) adxA[i] = (adxA[i - 1] * (p - 1) + dx[dx.length - 1]) / p;
  }
  return { adx: adxA, pdi, mdi };
}

module.exports = { ema, rsi, adx };
````

## `lib/bs.js`

````js
// lib/bs.js - Black-Scholes APPROXIMATION of option premium on an index. Zero dependencies.
// This is a model, not market data. It uses India VIX as a stand-in for ATM implied volatility, assumes a flat
// smile, European exercise and a fixed risk-free rate. It does not model the bid/ask spread, skew, the IV
// change during the trade, assignment, pin risk, or the gamma/IV behaviour of expiry week.

const BS = {
  r: 0.065, // risk-free rate
  itmBumpVol: 0.02, // +2 volatility points for the 1-ITM strike
  crush: 0.9, // exit IV = 90% of entry IV in the "-10% IV" scenario
  minutesPerYear: 525600,
};

// Standard normal CDF, Abramowitz & Stegun 26.2.17 (absolute error below 7.5e-8).
function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upper = d * poly;
  return x >= 0 ? 1 - upper : upper;
}

function d1d2(S, K, T, r, sigma) {
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / v;
  return [d1, d1 - v];
}

// type: "call" | "put". T in years. At or past expiry the price is the intrinsic value.
function price(S, K, T, r, sigma, type) {
  if (!(S > 0) || !(K > 0)) return NaN;
  if (!(T > 0) || !(sigma > 0)) return Math.max(type === "call" ? S - K : K - S, 0);
  const [d1, d2] = d1d2(S, K, T, r, sigma);
  const disc = Math.exp(-r * T);
  return type === "call" ? S * ncdf(d1) - K * disc * ncdf(d2) : K * disc * ncdf(-d2) - S * ncdf(-d1);
}

function delta(S, K, T, r, sigma, type) {
  if (!(T > 0) || !(sigma > 0)) return type === "call" ? (S > K ? 1 : 0) : S < K ? -1 : 0;
  const [d1] = d1d2(S, K, T, r, sigma);
  return type === "call" ? ncdf(d1) : ncdf(d1) - 1;
}

// --------------------------------------------------------------------------
// Expiry calendar (same assumption as the rules engine: Tuesday; NIFTY weekly, the rest last Tuesday of the month).
// Holiday shifts are NOT handled.
// --------------------------------------------------------------------------
const DAY = 864e5;
const toDate = (iso) => new Date(iso + "T00:00:00Z");
const toISO = (d) => d.toISOString().slice(0, 10);

function lastTuesday(y, m) {
  let d = new Date(Date.UTC(y, m + 1, 0)); // last day of month m
  while (d.getUTCDay() !== 2) d = new Date(d.getTime() - DAY);
  return d;
}

// The expiry date on or after `iso`.
function expiryOnOrAfter(ix, iso) {
  const d = toDate(iso);
  if (ix.weekly) {
    let x = d;
    while (x.getUTCDay() !== 2) x = new Date(x.getTime() + DAY);
    return toISO(x);
  }
  let lt = lastTuesday(d.getUTCFullYear(), d.getUTCMonth());
  if (lt < d) lt = lastTuesday(d.getUTCFullYear() + (d.getUTCMonth() === 11 ? 1 : 0), (d.getUTCMonth() + 1) % 12);
  return toISO(lt);
}

// Years from (date, minutes after midnight IST) to the 15:30 expiry close.
function yearsTo(expiryISO, iso, mm) {
  const days = Math.round((toDate(expiryISO) - toDate(iso)) / DAY);
  return Math.max((days * 1440 + (930 - mm)) / BS.minutesPerYear, 0);
}

// --------------------------------------------------------------------------
// Option P&L of one index trade.
//   t: { side, date, entryMM, entry, sl, exitMM, exitPrice }
//   o: { ix, vix (India VIX level, e.g. 14.2), itm (bool), expiryISO? }
// Returns null when it cannot be priced. Costs are applied by the caller (they are an input on the page).
// optPnlPct = premium change in %, optR = premium change / premium risk (entry to the stop-level premium).
// --------------------------------------------------------------------------
function simOption(t, o) {
  if (!(o.vix > 0) || t.exitMM == null || !(t.exitPrice > 0)) return null;
  const step = o.ix.step;
  const atm = Math.round(t.entry / step) * step;
  const long = t.side === "long";
  const K = o.itm ? (long ? atm - step : atm + step) : atm;
  const type = long ? "call" : "put";
  const sigma = o.vix / 100 + (o.itm ? BS.itmBumpVol : 0);
  const exp = o.expiryISO || expiryOnOrAfter(o.ix, t.date);
  const T0 = yearsTo(exp, t.date, t.entryMM);
  const T1 = yearsTo(exp, t.date, Math.min(t.exitMM, 930));
  const P0 = price(t.entry, K, T0, BS.r, sigma, type);
  const Pstop = price(t.sl, K, T0, BS.r, sigma, type);
  if (!(P0 > 0.05)) return null; // a few paise: not a real trade
  const riskPrem = P0 - Pstop;
  if (!(riskPrem > 0)) return null;
  const mk = (sig1) => {
    const P1 = price(t.exitPrice, K, T1, BS.r, sig1, type);
    return { P1, pct: ((P1 - P0) / P0) * 100, r: (P1 - P0) / riskPrem };
  };
  const a = mk(sigma);
  const b = mk(sigma * BS.crush);
  return {
    strike: K,
    type,
    expiry: exp,
    sigma,
    P0,
    riskFrac: riskPrem / P0,
    delta: delta(t.entry, K, T0, BS.r, sigma, type),
    noIv: { P1: a.P1, pct: a.pct, r: a.r },
    crush: { P1: b.P1, pct: b.pct, r: b.r },
  };
}

module.exports = { BS, ncdf, price, delta, expiryOnOrAfter, yearsTo, simOption };
````

## `lib/broker.js`

````js
// lib/broker.js - the ONE place a broker data adapter plugs in. No adapter is configured, so every call throws.
//
// Why it exists: Yahoo Finance has no index volume, no option chain and no option premium history. Without a
// broker feed the app cannot compute a true VWAP, show live open interest / max pain, or back-test real premiums.
// The rest of the code calls these functions inside try/catch and shows "no broker data" instead of guessing.
//
// To enable one, replace the bodies below (and set configured() to true) using your broker's historical-data and
// option-chain API. Keep any credentials in Vercel environment variables, never in this repository.
//
// Contract (all times IST, bars oldest first):
//   fetchBars(symbol, interval, range)   -> [{ t (unix s), o, hi, lo, cl, vol }]   e.g. ("NIFTY", "5m", "2y")
//   fetchOptionChain(underlying, expiry) -> { underlying, expiry, spot, strikes: [{ strike, ce: {oi, ltp, iv}, pe: {oi, ltp, iv} }] }
//   fetchOptionPremium(underlying, expiry, strike, type, fromSec, toSec, interval) -> [{ t, o, hi, lo, cl }]   (optional)

const NONE = "No broker adapter configured";

function configured() {
  return false;
}

async function fetchBars(symbol, interval, range) {
  throw new Error(NONE);
}

async function fetchOptionChain(underlying, expiry) {
  throw new Error(NONE);
}

async function fetchOptionPremium(underlying, expiry, strike, type, fromSec, toSec, interval) {
  throw new Error(NONE);
}

module.exports = { configured, fetchBars, fetchOptionChain, fetchOptionPremium };
````

## `lib/rules_core.js`

````js
// lib/rules_core.js - shared pieces of the index rulebooks (v2). Pure functions, no network.
// Honesty rules: only finished candles; swing points are only known n bars after they formed; every filter that
// cannot run is SKIPPED VISIBLY (it appears in the checks list), never silently passed.

const { ema } = require("./indicators");

// Strike steps are typical ATM steps; confirm against your broker's option chain.
const INDICES = [
  { key: "NIFTY", name: "NIFTY 50", yahoo: ["^NSEI"], step: 50, weekly: true },
  { key: "BANKNIFTY", name: "NIFTY BANK", yahoo: ["^NSEBANK"], step: 100, weekly: false },
  { key: "FINNIFTY", name: "NIFTY FIN SERVICE", yahoo: ["NIFTY_FIN_SERVICE.NS"], step: 50, weekly: false },
  { key: "MIDCPNIFTY", name: "NIFTY MIDCAP SELECT", yahoo: ["NIFTY_MID_SELECT.NS"], step: 25, weekly: false },
  { key: "NIFTYNXT50", name: "NIFTY NEXT 50", yahoo: ["^NSMIDCP"], step: 100, weekly: false },
];

// Rule parameters (v2). Fixed in advance. NOT optimised on any data. Do not change them to improve a backtest.
const P = {
  orStart: 555, // 09:15 in minutes after midnight
  orEnd: 570, // 09:30
  sessionEnd: 930, // 15:30
  bufW: 0.1, // breakout buffer = 10% of the opening range width
  retestW: 0.1, // a retest counts when the low comes within 10% of the width above the level
  orWidthLo: 0.5, // opening range vs the recent typical width: full size 0.5x to 2x
  orWidthHi: 2,
  orbSizeHalfMax: 3, // 2x to 3x typical = half size; beyond 3x or under 0.5x = skip
  orbVolMult: 1.5, // Track 1: breakout candle volume >= 1.5x the mean of up to 20 prior bars of the session
  orbVolBars: 20,
  orbVolMinBars: 3,
  orbBreak: { t1: 2, t2: 3 }, // Track 1 targets in R
  orbRetest: { t1: 1, t2: 2 }, // Track 2 targets in R
  maxAge: 2, // a trigger is only actionable for this many closed bars
  orbCutoff: 840, // no new ORB entries after 14:00
  // Ichimoku (intraday)
  ichiTrendADX: 20,
  ichiEMASlopeBars: 10,
  ichiStart: 600, // no intraday entries 9:15 to 10:00
  ichiCutoff: 870, // trigger candle must start before 14:30 (so no entries 14:45 to 15:30)
  ichiMaxRetrace: 0.618,
  ichiMinRetrace: 0.382,
  ichiMinLegPct: 0.4,
  ichiVolMult: 1.0,
  ichiVolBars: 3,
  cloudMinPct: 0.25, // Daily cloud thinner than this = chop (ichi_swing only)
  swingMaxRiskPct: 4.0, // ichi_swing underlying stop cap, % of price (assumption: the spec gave no number)
  // VWAP
  vwapStart: 590, // 09:50
  vwapCutoff: 870, // no new entries after 14:30
  vwapEvalEnd: 885, // evaluation window ends 14:45
  vwapTolPct: 0.1, // "at VWAP" = within 0.1% of price
  vwapMaxCross: 3, // this many VWAP crossings since 09:30 = chop (pullback only)
  vwapReclaimAboveMin: 45, // minutes above VWAP before the dip = 9 five-minute closes
  vwapReclaimDipMax: 3,
  vwapReclaimVolMult: 1.0,
  vwapReclaimVolBars: 2,
  vwapRSIPeriod: 9,
  vwapRSIMinBars: 15,
  vwapRSILong: [38, 58],
  vwapRSIShort: [45, 65],
  // Options filters
  vixPctlBlock: 60,
  vixWindow: 60,
  maxPainMinDist: 0.5,
  maxPainMaxDist: 1.5,
  maxPainSkipNear: 0.2,
  maxPainStart: 840,
  maxPainEnd: 930,
  maxRiskPct: { orb: 0.7, vwap: 0.5, ichi: 1.0 }, // underlying stop distance, % of price
};

const STRATS = {
  orb_break: { label: "ORB breakout (Track 1)", group: "orb" },
  orb_retest: { label: "ORB retest (Track 2)", group: "orb" },
  ichi: { label: "Ichimoku + Fib (intraday)", group: "ichi" },
  ichi_swing: { label: "Ichimoku swing (Daily / 4h)", group: "ichi" },
  vwap_reclaim: { label: "VWAP reclaim", group: "vwap" },
  vwap_pullback: { label: "VWAP pullback", group: "vwap" },
  vwap_info: { label: "Session average (proxy) — information only", group: "vwap" },
  expiry_maxpain: { label: "Expiry max-pain", group: "expiry" },
};

const f2 = (v) => (Math.round(v * 100) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hhmm = (mm) => String(Math.floor(mm / 60)).padStart(2, "0") + ":" + String(mm % 60).padStart(2, "0");
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// Only bars that have finished. A bar ends at its start + step, but never later than the 15:30 close.
function closedOnly(bars, step, nowSec) {
  return bars.filter((b) => b.t + Math.min(step, Math.max(60, (P.sessionEnd - b.mm) * 60)) <= nowSec);
}

// Swing points: a bar is a pivot when it beats `n` bars on each side. A pivot is only known n bars later,
// so only bars with n closed bars after them are returned (no look-ahead).
function pivots(bars, n) {
  const hi = [];
  const lo = [];
  for (let i = n; i < bars.length - n; i++) {
    let isH = true;
    let isL = true;
    for (let k = 1; k <= n; k++) {
      if (!(bars[i].hi > bars[i - k].hi) || !(bars[i].hi >= bars[i + k].hi)) isH = false;
      if (!(bars[i].lo < bars[i - k].lo) || !(bars[i].lo <= bars[i + k].lo)) isL = false;
    }
    if (isH) hi.push({ i, p: bars[i].hi });
    if (isL) lo.push({ i, p: bars[i].lo });
  }
  return { hi, lo };
}

// Mirror a bar so every strategy can be written once for the long side. Prices are negated, so a short
// setup is a long setup in negative space; sg * value maps a level back to real prices.
const neg = (b) => ({ ...b, o: -b.o, hi: -b.lo, lo: -b.hi, cl: -b.cl });

function isExpiryDay(ix, iso) {
  const d = new Date(iso + "T00:00:00Z");
  if (d.getUTCDay() !== 2) return false; // Tuesday
  if (ix.weekly) return true;
  return new Date(d.getTime() + 7 * 864e5).getUTCMonth() !== d.getUTCMonth(); // last Tuesday of the month
}

function res(strategy, state, action, o = {}) {
  const s = STRATS[strategy] || { label: strategy, group: strategy };
  return {
    strategy,
    label: o.label || s.label,
    group: s.group,
    state,
    action, // BUY CE | BUY PE | WAIT | NO TRADE | NO DATA | CLOSED | INFO
    side: o.side || null,
    note: o.note || "",
    level: o.level == null ? null : o.level,
    levelNote: o.levelNote || "",
    sl: o.sl == null ? null : o.sl,
    t1: o.t1 == null ? null : o.t1,
    t2: o.t2 == null ? null : o.t2,
    riskPct: o.riskPct == null ? null : o.riskPct,
    checks: o.checks || [],
    info: !!o.info, // information-only row: never counted as actionable
    sizeHint: o.sizeHint || null, // ORB: full | half | skip
    trail: o.trail || null, // information only, not simulated
    trendSource: o.trendSource || null, // Ichimoku: ADX15 | EMA5 | none
    reliability: o.reliability || null, // VWAP rows: high | medium | low
    blockedBy: null, // "vix" | "size" when a BUY was downgraded
    tags: [],
  };
}

// Turn a triggered setup into a final call, applying the blocking rules. Checks flagged info:true never block.
function settle(r, ctx, blockers) {
  const bad = blockers.filter((b) => !b.ok && !b.info);
  r.checks = r.checks.concat(blockers);
  if (bad.length) {
    r.action = "NO TRADE";
    r.note = bad.map((b) => b.text).join(" · ");
    return r;
  }
  r.action = r.side === "long" ? "BUY CE" : "BUY PE";
  return r;
}

function expiryBlock(ix, ctx) {
  return [{ ok: !ctx.expiry[ix.key], text: "Not an expiry day (expiry-day trading is outside this ruleset)" }];
}

// True when the recent bars carry volume (at least 80% of the last 40 bars have vol > 0). Index feeds usually do not.
function hasVolOf(bars) {
  const a = bars.slice(-40);
  return a.length > 0 && a.filter((b) => b.vol > 0).length >= 0.8 * a.length;
}

// Volume confirmation: bars[k].vol >= mult x mean of the `back` bars before k. Returns {ok, skipped, ...}.
function volCheck(bars, k, back, mult, hasVol, minBars) {
  if (!hasVol) return { ok: true, skipped: true };
  const prev = bars.slice(Math.max(0, k - back), k);
  if (prev.length < (minBars || back)) return { ok: false, skipped: false, short: true, prevN: prev.length };
  const m = mean(prev.map((b) => b.vol));
  return { ok: m <= 0 ? bars[k].vol > 0 : bars[k].vol >= mult * m, skipped: false, vol: bars[k].vol, mean: m };
}

// Fibonacci pullback trigger shared by the intraday and swing Ichimoku rules (long side on mirrored bars).
// bars: mirrored closed bars; opts: { tfMin, startMM, cutoffMM (null for no time rule), maxRisk, volMult, volBars, hasVol, ctx, ix }
function fibEngine(S, side, bars, price, base, o) {
  const sg = side === "long" ? 1 : -1;
  const pv = pivots(bars, 3);
  const Hp = pv.hi[pv.hi.length - 1];
  const Lp = Hp ? [...pv.lo].reverse().find((x) => x.i < Hp.i) : null;
  if (!Hp || !Lp) return res(S, "NO SWING LEG", "WAIT", { ...base, note: `No confirmed ${o.tfName} swing low then swing high yet.` });
  const leg = Hp.p - Lp.p;
  const n = bars.length;
  if ((leg / Math.abs(price)) * 100 < P.ichiMinLegPct) {
    return res(S, "SWING LEG TOO SMALL", "WAIT", { ...base, note: `Last ${o.tfName} swing leg is under ${P.ichiMinLegPct}% of price.` });
  }
  let rl = Infinity;
  for (let k = Hp.i + 1; k < n; k++) rl = Math.min(rl, bars[k].lo);
  const l382 = Hp.p - P.ichiMinRetrace * leg;
  const l618 = Hp.p - P.ichiMaxRetrace * leg;
  const zone = `${f2(sg * l382)} to ${f2(sg * l618)} (38.2% to 61.8%)`;
  base.levelNote = `${base.levelNote ? base.levelNote + " · " : ""}Swing ${f2(sg * Lp.p)} to ${f2(sg * Hp.p)}; zone ${zone}`;
  if (rl < Lp.p) return res(S, "STRUCTURE BROKEN", "NO TRADE", { ...base, note: "Price has gone below the swing the leg started from." });
  const depth = (Hp.p - rl) / leg;
  if (depth < P.ichiMinRetrace) {
    return res(S, "TREND OK, AWAITING PULLBACK", "WAIT", { ...base, level: sg * l382, note: `Wait for a pullback into ${zone}.` });
  }
  if (depth > P.ichiMaxRetrace) {
    return res(S, "PULLBACK TOO DEEP", "NO TRADE", { ...base, note: `Retraced ${(depth * 100).toFixed(0)}% of the leg (limit 61.8%): not a shallow continuation.` });
  }
  const deepest = depth >= 0.5 ? "50%" : "38.2%";

  let touch = -1;
  for (let k = Hp.i + 1; k < n; k++) {
    if (bars[k].lo <= l382) {
      touch = k;
      break;
    }
  }
  let trig = -1;
  let volWhy = null;
  let volSkipped = false;
  for (let k = touch; k < n; k++) {
    const b = bars[k];
    if (o.startMM != null && b.mm < o.startMM) continue; // no entries before the start time
    if (!(b.lo <= l382 && b.cl > l382)) continue; // dips into the zone and closes back beyond the 38.2% level
    const v = volCheck(bars, k, o.volBars, o.volMult, o.hasVol, o.volBars);
    if (v.skipped) volSkipped = true;
    if (!v.ok) {
      volWhy = v;
      continue;
    }
    trig = k;
    break;
  }
  const volTxt = volSkipped ? "Volume clause skipped (no index volume)" : `Trigger candle volume at least ${o.volMult}x the mean of the prior ${o.volBars} bars`;
  base.checks = base.checks.concat([{ ok: true, text: volTxt, info: volSkipped }]);
  if (trig < 0) {
    return res(S, "IN FIB ZONE, AWAITING REJECTION", "WAIT", {
      ...base,
      level: sg * l382,
      note: volWhy
        ? `Pulled back to the ${deepest} level and closed back ${side === "long" ? "above" : "below"} it, but volume was too low. Needs the volume clause.`
        : `Pulled back to the ${deepest} level. Needs a ${o.tfName} candle that dips in and closes back ${side === "long" ? "above" : "below"} ${f2(sg * l382)}${o.hasVol ? " on volume" : ""}.`,
    });
  }
  const slT = Math.min(...bars.slice(touch, trig + 1).map((b) => b.lo));
  const trigMM = bars[trig].mm;
  const trigTime = o.tfMin >= 240 ? `${bars[trig].d.slice(5)} ${hhmm(trigMM)}` : hhmm(trigMM + o.tfMin);
  for (let k = trig + 1; k < n; k++) {
    if (bars[k].cl < slT) return res(S, "STOPPED OUT", "NO TRADE", { ...base, note: `Triggered ${trigTime}, then closed under the retrace low.` });
  }
  if (o.cutoffMM != null && trigMM >= o.cutoffMM) return res(S, "PAST ENTRY CUTOFF", "NO TRADE", { ...base, note: `Triggered ${trigTime}, after the entry cutoff.` });
  const age = n - 1 - trig;
  if (age > P.maxAge) return res(S, "TRIGGER STALE", "WAIT", { ...base, note: `Triggered ${trigTime}, ${age} bars ago. Do not chase.` });

  const entryT = sg * price;
  const R = entryT - slT;
  const riskPct = (R / Math.abs(price)) * 100;
  const t1T = Hp.p;
  const t2T = Lp.p + 1.272 * leg;
  const out = res(S, "TRIGGERED", "WAIT", {
    ...base,
    level: price,
    sl: sg * slT,
    t1: sg * t1T,
    t2: sg * t2T,
    riskPct,
    note: `Rejection at the ${deepest} level, trigger ${trigTime}. Stop under the retrace low; T1 is the prior swing, T2 the 127.2% extension.`,
  });
  const blockers = [
    { ok: R > 0, text: "Stop is on the right side of price" },
    { ok: riskPct <= o.maxRisk, text: `Underlying stop ${riskPct.toFixed(2)}% of price (max ${o.maxRisk}%)` },
    { ok: t1T - entryT >= R, text: "Room to the prior swing is at least 1x the risk" },
  ];
  if (o.expiryBlock) blockers.push(...expiryBlock(o.ix, o.ctx));
  return settle(out, o.ctx, blockers);
}

module.exports = { INDICES, P, STRATS, f2, hhmm, mean, ema, closedOnly, pivots, neg, isExpiryDay, res, settle, expiryBlock, hasVolOf, volCheck, fibEngine };
````

## `lib/rules_orb.js`

````js
// lib/rules_orb.js - Opening Range Breakout, two independent tracks (5-minute candles, finished candles only).
//   Track 1 orb_break : a 5m close beyond the range edge plus buffer is the trigger (no retest), with a volume filter.
//   Track 2 orb_retest: the v1 logic, unchanged: break, retest that holds, then a close above the retest candle.
// Track 2 is only evaluated when Track 1 has not fired. The range-width check is information; it sets sizeHint.

const { P, f2, hhmm, mean, neg, res, settle, expiryBlock, volCheck } = require("./rules_core");

// Long-side state machine on mirrored bars (Track 2, v1 logic). H = range high, W = range width.
function orbSide(post, H, W) {
  const buf = P.bufW * W;
  const tol = P.retestW * W;
  let brk = -1;
  let ret = -1;
  let trig = -1;
  let failed = -1;
  let stop = -1;
  for (let k = 0; k < post.length; k++) {
    const b = post[k];
    if (brk < 0) {
      if (b.cl > H + buf) brk = k; // first 5m close beyond the level plus buffer
      continue;
    }
    if (trig < 0) {
      if (b.cl < H) {
        failed = k; // closed back inside the range: one attempt per side per day
        break;
      }
      if (ret < 0) {
        if (b.lo <= H + tol) ret = k; // revisited the level and held above it
        continue;
      }
      if (b.cl > post[ret].hi) trig = k; // continuation: closes above the retest candle's high
    } else if (b.cl < H) {
      stop = k;
      break;
    }
  }
  return { brk, ret, trig, failed, stop };
}

// Track 1: the first close beyond the level plus buffer that passes the volume filter is the trigger.
// `day` is the raw session (only its volumes are used); post/off locate the bar inside it.
function breakSide(day, post, H, W, hasVol) {
  const buf = P.bufW * W;
  const off = day.length - post.length;
  let first = -1;
  let trig = -1;
  let stop = -1;
  let volWhy = null;
  let volSkipped = false;
  for (let k = 0; k < post.length; k++) {
    const b = post[k];
    if (trig < 0) {
      if (b.cl > H + buf) {
        if (first < 0) first = k;
        const v = volCheck(day, off + k, P.orbVolBars, P.orbVolMult, hasVol, P.orbVolMinBars);
        if (v.ok) {
          trig = k;
          volSkipped = !!v.skipped;
        } else volWhy = v;
      }
    } else if (b.cl < H) {
      stop = k;
      break;
    }
  }
  return { first, trig, stop, volWhy, volSkipped };
}

function sizeOf(wPct, typ) {
  if (typ == null) return { hint: "full", ratio: null };
  const ratio = wPct / typ;
  if (ratio > P.orbSizeHalfMax || ratio < P.orWidthLo) return { hint: "skip", ratio };
  if (ratio > P.orWidthHi) return { hint: "half", ratio };
  return { hint: "full", ratio };
}

// Returns [orb_break row, orb_retest row].
function evalOrb(ix, c5, price, ctx) {
  const liveISO = ctx.liveISO;
  const day = c5.filter((b) => b.d === liveISO);
  const hasVol = !!ctx.hasVol;
  const trail = hasVol ? "VWAP" : "20 EMA";
  const mk = (id, state, action, o) => res(id, state, action, { trail, ...o });
  const both = (state, action, o) => [mk("orb_break", state, action, o), mk("orb_retest", state, action, o)];

  const orBars = day.filter((b) => b.mm >= P.orStart && b.mm < P.orEnd);
  if (orBars.length < 3) return both("OPENING RANGE FORMING", "WAIT", { note: "The 9:15 to 9:30 range is not complete yet." });
  const H = Math.max(...orBars.map((b) => b.hi));
  const L = Math.min(...orBars.map((b) => b.lo));
  const W = H - L;
  if (!(W > 0)) return both("NO DATA", "NO DATA", { note: "Flat opening range." });

  // Typical opening-range width from earlier sessions (known before today's range completes).
  const byDay = new Map();
  for (const b of c5) {
    if (b.d < liveISO && b.mm >= P.orStart && b.mm < P.orEnd) {
      if (!byDay.has(b.d)) byDay.set(b.d, []);
      byDay.get(b.d).push(b);
    }
  }
  const widths = [...byDay.values()]
    .filter((a) => a.length === 3)
    .map((a) => {
      const h = Math.max(...a.map((b) => b.hi));
      const l = Math.min(...a.map((b) => b.lo));
      return ((h - l) / ((h + l) / 2)) * 100;
    });
  const wPct = (W / ((H + L) / 2)) * 100;
  const typ = widths.length >= 2 ? mean(widths) : null;
  const sz = sizeOf(wPct, typ);
  const rangeTxt = `Opening range ${wPct.toFixed(2)}% wide${typ == null ? " (no history to compare)" : `, ${sz.ratio.toFixed(2)}x the typical ${typ.toFixed(2)}%`} → size: ${sz.hint} (information; full ${P.orWidthLo}x to ${P.orWidthHi}x, half up to ${P.orbSizeHalfMax}x)`;
  const rangeCheck = { ok: sz.hint !== "skip", text: rangeTxt, info: true };
  const volCheckRow = hasVol
    ? { ok: true, text: `Volume filter: breakout candle at least ${P.orbVolMult}x the mean of up to ${P.orbVolBars} prior bars`, info: true }
    : { ok: true, text: "volume filter skipped (no index volume)", info: true };
  const checks = [rangeCheck, volCheckRow];
  const baseAll = { checks, sizeHint: sz.hint };

  const post = day.filter((b) => b.mm >= P.orEnd);
  const postN = post.map(neg);
  const A = orbSide(post, H, W);
  const B = orbSide(postN, -L, W);
  const A1 = breakSide(day, post, H, W, hasVol);
  const B1 = breakSide(day, postN, -L, W, hasVol);
  const levels = `Range ${f2(L)} to ${f2(H)}`;
  const buf = P.bufW * W;

  if (A.brk >= 0 && B.brk >= 0) {
    return both("CHOPPY: BOTH EDGES BROKEN", "NO TRADE", { ...baseAll, note: "Price has closed beyond both edges of the range today. Skip.", levelNote: levels });
  }
  if (A.brk < 0 && B.brk < 0) {
    return both("INSIDE RANGE", "WAIT", { ...baseAll, note: `Waiting for a 5m close above ${f2(H + buf)} (CE) or below ${f2(L - buf)} (PE).`, levelNote: levels });
  }
  const side = A.brk >= 0 ? "long" : "short";
  const sg = side === "long" ? 1 : -1;
  const T = side === "long" ? post : postN; // mirrored bars
  const Hl = side === "long" ? H : -L; // the level, in mirrored space
  const r2 = side === "long" ? A : B;
  const r1 = side === "long" ? A1 : B1;
  const base = { ...baseAll, side, levelNote: levels };

  // Shared finishing: risk, cutoff, staleness, targets, blockers, size.
  function finish(id, k, slT, tg, trigNote, stopK) {
    const trigTime = hhmm(post[k].mm + 5);
    if (stopK >= 0) return mk(id, "STOPPED OUT", "NO TRADE", { ...base, note: `Triggered ${trigTime}, then closed back through the level at ${hhmm(post[stopK].mm + 5)}.` });
    if (post[k].mm >= P.orbCutoff) return mk(id, "PAST ENTRY CUTOFF", "NO TRADE", { ...base, note: `Triggered ${trigTime}, after the 14:00 cutoff for new entries.` });
    const age = post.length - 1 - k;
    if (age > P.maxAge) return mk(id, "TRIGGER STALE", "WAIT", { ...base, note: `Triggered ${trigTime}, ${age} bars ago. Do not chase; wait for a fresh setup.` });
    const entryT = sg * price;
    const R = entryT - slT;
    const riskPct = (R / Math.abs(price)) * 100;
    const out = mk(id, "TRIGGERED", "WAIT", {
      ...base,
      level: price,
      levelNote: `Entry about ${f2(price)} · ${levels}`,
      sl: sg * slT,
      t1: sg * (entryT + tg.t1 * R),
      t2: sg * (entryT + tg.t2 * R),
      riskPct,
      note: `${trigNote(trigTime)} Trail (information only): ${trail}.`,
      checks: [],
    });
    settle(out, ctx, [
      rangeCheck,
      { ok: R > 0, text: "Stop is on the right side of price" },
      { ok: riskPct <= P.maxRiskPct.orb, text: `Underlying stop ${riskPct.toFixed(2)}% of price (max ${P.maxRiskPct.orb}%)` },
      ...expiryBlock(ix, ctx),
    ]);
    out.checks.push(volCheckRow);
    if (/^BUY/.test(out.action)) {
      if (sz.hint === "skip") {
        out.action = "NO TRADE";
        out.blockedBy = "size";
        out.note = `Opening range is ${sz.ratio.toFixed(2)}x the typical width (outside ${P.orWidthLo}x to ${P.orbSizeHalfMax}x). Skip.`;
      } else if (sz.hint === "half") {
        out.note += " HALF SIZE: the opening range is 2x to 3x the typical width.";
      }
    }
    return out;
  }

  // ---- Track 1: break ----
  let row1;
  if (r1.trig < 0) {
    if (r1.first >= 0) {
      const v = r1.volWhy;
      row1 = mk("orb_break", "BROKE OUT, VOLUME NOT CONFIRMED", "WAIT", {
        ...base,
        level: sg * Hl,
        note: v && v.short
          ? `Closed beyond the range but there are too few prior bars to confirm volume. Waiting.`
          : `Closed beyond the range but volume was under ${P.orbVolMult}x the prior mean. Waiting for a high-volume close; no entry on a weak breakout.`,
      });
    } else {
      row1 = mk("orb_break", "INSIDE RANGE", "WAIT", { ...base, note: `Waiting for a 5m close ${side === "long" ? "above" : "below"} ${f2(sg * (Hl + buf))}.` });
    }
  } else {
    const slT = Math.min(...T.slice(r1.trig).map((b) => b.lo)); // lowest low from the breakout candle to the current bar
    row1 = finish("orb_break", r1.trig, slT, P.orbBreak, (t) => `Closed beyond the range at ${t}${r1.volSkipped ? " (volume filter skipped)" : " on volume"}. Stop at the lowest ${side === "long" ? "low" : "high"} since the breakout candle; targets 2R and 3R.`, r1.stop);
  }

  // ---- Track 2: retest (only when Track 1 has not fired) ----
  let row2;
  if (r1.trig >= 0) {
    row2 = mk("orb_retest", "TRACK 1 FIRED", "NO TRADE", { ...base, note: `The breakout track already fired at ${hhmm(post[r1.trig].mm + 5)}, so the retest track is not evaluated.` });
  } else if (r2.failed >= 0) {
    row2 = mk("orb_retest", "FAILED BREAKOUT", "NO TRADE", { ...base, note: `Closed back inside the range at ${hhmm(post[r2.failed].mm + 5)} after breaking out. No second attempt.` });
  } else if (r2.trig < 0) {
    if (r2.ret < 0) {
      const ext = side === "long" ? price - H : L - price;
      row2 = mk("orb_retest", "BROKE OUT, AWAITING RETEST", "WAIT", {
        ...base,
        level: sg * Hl,
        note: ext > W ? "Already extended with no retest. Do not chase." : `Waiting for a pullback to ${f2(sg * Hl)} that holds, then a close ${side === "long" ? "above" : "below"} the retest candle.`,
      });
    } else {
      row2 = mk("orb_retest", "RETEST HELD, AWAITING TRIGGER", "WAIT", {
        ...base,
        level: sg * T[r2.ret].hi,
        note: `Needs a 5m close ${side === "long" ? "above" : "below"} ${f2(sg * T[r2.ret].hi)} (the retest candle).`,
      });
    }
  } else {
    const slT = Math.min(...T.slice(r2.ret, r2.trig + 1).map((b) => b.lo));
    row2 = finish("orb_retest", r2.trig, slT, P.orbRetest, (t) => `Retest held and closed through at ${t}. Stop under the retest candle; targets 1R and 2R.`, r2.stop);
  }
  return [row1, row2];
}

module.exports = { orbSide, breakSide, sizeOf, evalOrb };
````

## `lib/rules_ichi.js`

````js
// lib/rules_ichi.js - Ichimoku + Fibonacci continuation, v2.
//   ichi       : intraday. Trend filter = ADX(14) on 15m (+DI/-DI), falling back to the 5m 20-EMA slope. The 1h cloud is
//                shown as information only and never blocks. Entries only from 10:00 to 14:30 (trigger candle start).
//   ichi_swing : Daily cloud trend + 4h pullback (the v1 1h-cloud logic moved up one level). Not time-of-day limited.

const { ichimoku, FIRST_CLOUD } = require("../api/ichimoku")._internals;
const { adx, ema } = require("./indicators");
const { P, f2, neg, pivots, res, fibEngine, hasVolOf } = require("./rules_core");

function cloudInfo(c1h) {
  if (c1h.length < FIRST_CLOUD + 2) return null;
  const ich = ichimoku(c1h);
  const last = c1h.length - 1;
  const top = ich.top[last];
  const bot = ich.bot[last];
  if (top == null || bot == null) return null;
  const c = c1h[last].cl;
  const pos = c > top ? "above" : c < bot ? "below" : "inside";
  const future = ich.spanA[last] > ich.spanB[last] ? "green" : ich.spanA[last] < ich.spanB[last] ? "red" : "flat";
  const tk = ich.tenkan[last] == null || ich.kijun[last] == null ? null : ich.tenkan[last] > ich.kijun[last] ? "Tenkan above Kijun" : ich.tenkan[last] < ich.kijun[last] ? "Tenkan below Kijun" : "Tenkan on Kijun";
  const widthPct = ((top - bot) / c) * 100;
  return { ich, last, top, bot, c, pos, future, tk, widthPct, cloudTxt: `1h cloud ${f2(bot)} to ${f2(top)} (${widthPct.toFixed(2)}% wide)` };
}

function evalIchi(ix, c1h, c15, c5, price, ctx) {
  const S = "ichi";
  if (c15.length < 12 && c5.length < 12) return res(S, "NO DATA", "NO DATA", { note: "Not enough 15m or 5m history.", trendSource: "none" });
  const ci = cloudInfo(c1h);
  const infoChecks = ci
    ? [
        { ok: true, info: true, text: `1h cloud is ${ci.pos} price; future cloud ${ci.future}; ${ci.tk || "Tenkan/Kijun n/a"} (information only, not a filter)` },
      ]
    : [{ ok: true, info: true, text: "1h cloud not available (information only)" }];
  const cloudTxt = ci ? ci.cloudTxt : "";

  // Trend filter: ADX(14) on 15m first, then the 5m 20-EMA slope.
  let side = null;
  let trendSource = "none";
  let trendTxt = "";
  const a15 = c15.length >= 28 ? adx(c15, 14) : null;
  const li = c15.length - 1;
  if (a15 && a15.adx[li] != null) {
    trendSource = "ADX15";
    const A = a15.adx[li];
    const pd = a15.pdi[li];
    const md = a15.mdi[li];
    trendTxt = `15m ADX(14) ${A.toFixed(1)}, +DI ${pd.toFixed(1)}, -DI ${md.toFixed(1)} (needs ADX at least ${P.ichiTrendADX} and the right DI on top)`;
    if (A >= P.ichiTrendADX && pd > md) side = "long";
    else if (A >= P.ichiTrendADX && md > pd) side = "short";
  } else if (c5.length >= 20 + P.ichiEMASlopeBars) {
    trendSource = "EMA5";
    const e = ema(c5.map((b) => b.cl), 20);
    const slope = e[e.length - 1] - e[e.length - 1 - P.ichiEMASlopeBars];
    trendTxt = `ADX unavailable, so 5m 20-EMA slope over ${P.ichiEMASlopeBars} bars is ${slope >= 0 ? "+" : ""}${f2(slope)}`;
    if (slope > 0) side = "long";
    else if (slope < 0) side = "short";
  }
  if (trendSource === "none") {
    return res(S, "NO DATA", "NO DATA", { note: "Not enough history for the ADX or the EMA trend filter.", trendSource, levelNote: cloudTxt, checks: infoChecks });
  }
  const trendCheck = { ok: !!side, text: trendTxt };
  if (!side) {
    return res(S, "NO TREND", "NO TRADE", { note: `No intraday trend: ${trendTxt}.`, trendSource, levelNote: cloudTxt, checks: [trendCheck, ...infoChecks] });
  }
  const sg = side === "long" ? 1 : -1;
  const base = { side, levelNote: cloudTxt, trendSource, checks: [trendCheck, ...infoChecks] };
  if (c15.length < 12) return res(S, "NO SWING LEG", "WAIT", { ...base, note: "Not enough 15m bars to find a swing leg." });
  const bars = (side === "long" ? c15 : c15.map(neg)).slice(-200);
  return fibEngine(S, side, bars, price, base, {
    tfName: "15m",
    tfMin: 15,
    startMM: P.ichiStart,
    cutoffMM: P.ichiCutoff,
    maxRisk: P.maxRiskPct.ichi,
    volMult: P.ichiVolMult,
    volBars: P.ichiVolBars,
    hasVol: hasVolOf(c15),
    expiryBlock: true,
    ix,
    ctx,
    sgFix: sg,
  });
}

// ichi_swing: the v1 trend logic on the Daily cloud with a 4h trigger.
function evalIchiSwing(ix, cD, c4h, price, ctx) {
  const S = "ichi_swing";
  if (cD.length < FIRST_CLOUD + 2 || c4h.length < 12) return res(S, "NO DATA", "NO DATA", { note: "Not enough Daily or 4h history." });
  const ci = cloudInfo(cD);
  if (!ci) return res(S, "NO DATA", "NO DATA", { note: "No Daily cloud yet." });
  const pv = pivots(cD, 2);
  const two = (a) => (a.length >= 2 ? [a[a.length - 2].p, a[a.length - 1].p] : null);
  const ph = two(pv.hi);
  const pl = two(pv.lo);
  const up = ph && pl && ph[1] > ph[0] && pl[1] > pl[0];
  const down = ph && pl && ph[1] < ph[0] && pl[1] < pl[0];
  const cloudTxt = ci.cloudTxt.replace("1h", "Daily");
  let side = null;
  if (ci.c > ci.top && up) side = "long";
  else if (ci.c < ci.bot && down) side = "short";
  if (!side) {
    const why = ci.pos === "inside" ? "Price is inside the Daily cloud." : ci.pos === "above" ? "Above the Daily cloud but no higher-high / higher-low structure." : "Below the Daily cloud but no lower-high / lower-low structure.";
    return res(S, "NO DAILY TREND", "NO TRADE", { note: why, levelNote: cloudTxt });
  }
  const checks = [
    { ok: true, text: `Daily close ${side === "long" ? "above" : "below"} the cloud and ${side === "long" ? "higher highs / higher lows" : "lower highs / lower lows"}` },
    { ok: ci.widthPct >= P.cloudMinPct, text: `Daily cloud ${ci.widthPct.toFixed(2)}% wide (min ${P.cloudMinPct}% or it is chop)` },
    { ok: true, info: true, text: `Future cloud ${ci.future}; ${ci.tk || "Tenkan/Kijun n/a"} (information only)` },
  ];
  const base = { side, levelNote: cloudTxt, checks };
  if (ci.widthPct < P.cloudMinPct) return res(S, "THIN CLOUD (CHOP)", "NO TRADE", { ...base, note: "Daily cloud is too thin to trust the trend." });
  const bars = side === "long" ? c4h.slice(-200) : c4h.slice(-200).map(neg);
  return fibEngine(S, side, bars, price, base, {
    tfName: "4h",
    tfMin: 240,
    startMM: null,
    cutoffMM: null,
    maxRisk: P.swingMaxRiskPct,
    volMult: P.ichiVolMult,
    volBars: P.ichiVolBars,
    hasVol: hasVolOf(c4h),
    expiryBlock: false,
    ix,
    ctx,
  });
}

// 60-minute bars -> 4-hour bars: [09:15 to 13:15] and [13:15 to 15:30]. Finished-ness is decided by closedOnly(, 14400).
function to4h(b1h) {
  const out = [];
  let cur = null;
  for (const b of b1h) {
    const key = b.d + (b.mm < 795 ? "a" : "b");
    if (!cur || cur.key !== key) {
      cur = { key, t: b.t, d: b.d, mm: b.mm, o: b.o, hi: b.hi, lo: b.lo, cl: b.cl, vol: b.vol };
      out.push(cur);
    } else {
      cur.hi = Math.max(cur.hi, b.hi);
      cur.lo = Math.min(cur.lo, b.lo);
      cur.cl = b.cl;
      cur.vol += b.vol;
    }
  }
  return out.map(({ key, ...r }) => r);
}

module.exports = { evalIchi, evalIchiSwing, to4h, cloudInfo };
````

## `lib/rules_vwap.js`

````js
// lib/rules_vwap.js - VWAP strategies, v2 (5-minute candles, finished candles only).
//   vwap_reclaim : 9+ closes above VWAP, a 1 to 3 close dip below, then a close back above on volume.
//   vwap_pullback: the v1 pullback + continuation, gated on a TRUE VWAP.
//   vwap_info    : the v1 logic on the session-average proxy, INFORMATION ONLY, never an action.
// Index feeds carry no volume, so on them there is no true VWAP: the two real strategies say NO TRADE and never BUY.

const { P, f2, hhmm, neg, pivots, res, settle, expiryBlock, volCheck, ema } = require("./rules_core");
const { rsi } = require("./indicators");

const NEED_TRUE = "Needs true VWAP; this feed has no volume. See the session-average state below.";

function vwapSeries(day, hasVol) {
  let sv = 0;
  let sp = 0;
  let cnt = 0;
  return day.map((b) => {
    const tp = (b.hi + b.lo + b.cl) / 3;
    if (hasVol) {
      sp += tp * b.vol;
      sv += b.vol;
      return sv > 0 ? sp / sv : tp;
    }
    sp += tp;
    cnt++;
    return sp / cnt;
  });
}

// Reliability of the VWAP itself (my definition; fixed in advance):
//   low    = no volume in the feed (the line is only a session average)        -> NO TRADE
//   medium = volume present but less than 60 minutes of session, or gaps in it
//   high   = volume on at least 95% of the bars and 60+ minutes of session
function reliabilityOf(hasVol, day) {
  if (!hasVol) return "low";
  const cov = day.filter((b) => b.vol > 0).length / Math.max(1, day.length);
  return day.length >= 12 && cov >= 0.95 ? "high" : "medium";
}

// ---- reclaim, long side on mirrored bars B / mirrored vwap V; raw `day` is only used for volumes ----
function reclaimScan(B, V, day) {
  const need = Math.round(P.vwapReclaimAboveMin / 5);
  let above = 0;
  let prevAbove = 0;
  let dip = 0;
  let dipLow = Infinity;
  let dipK = -1;
  let rec = null;
  let volFail = null;
  for (let k = 0; k < B.length; k++) {
    const b = B[k];
    if (b.cl > V[k]) {
      if (dip >= 1 && dip <= P.vwapReclaimDipMax && prevAbove >= need) {
        if (b.mm >= P.vwapStart) {
          const v = volCheck(day, k, P.vwapReclaimVolBars, P.vwapReclaimVolMult, true, P.vwapReclaimVolBars);
          if (v.ok) rec = { k, dipLow, dipK, dipN: dip, prevAbove };
          else volFail = { k };
        }
        above = 1;
        prevAbove = 0;
        dip = 0;
        dipLow = Infinity;
      } else if (dip > 0) {
        above = 1; // the dip was too long or there was no real run before it: start counting again
        prevAbove = 0;
        dip = 0;
        dipLow = Infinity;
      } else above++;
    } else {
      if (dip === 0) prevAbove = above;
      dip++;
      above = 0;
      if (b.lo < dipLow) {
        dipLow = b.lo;
        dipK = k;
      }
    }
  }
  const inDip = dip >= 1 && dip <= P.vwapReclaimDipMax && prevAbove >= need;
  return { rec, volFail, inDip, dip, prevAbove, dipLow, dipK };
}

function evalReclaim(ix, day, vw, price, ctx, rel) {
  const S = "vwap_reclaim";
  const n = day.length;
  const rs = rsi(day.map((b) => b.cl), P.vwapRSIPeriod);
  const mk = (state, action, o) => res(S, state, action, { reliability: rel, ...o });
  const out = {};
  for (const side of ["long", "short"]) {
    const sg = side === "long" ? 1 : -1;
    const B = side === "long" ? day : day.map(neg);
    const V = vw.map((x) => sg * x);
    out[side] = { sg, B, ...reclaimScan(B, V, day) };
  }
  const L = out.long;
  const Sh = out.short;
  const pick = [L, Sh].filter((x) => x.rec).sort((a, b) => b.rec.k - a.rec.k)[0];
  const lbl = "VWAP " + f2(vw[n - 1]);
  if (!pick) {
    const dipSide = L.inDip ? L : Sh.inDip ? Sh : null;
    const failed = [L, Sh].filter((x) => x.volFail && n - 1 - x.volFail.k <= P.maxAge)[0];
    if (failed) {
      return mk("RECLAIM WITHOUT VOLUME", "WAIT", {
        side: failed.sg > 0 ? "long" : "short",
        levelNote: lbl,
        note: `Closed back ${failed.sg > 0 ? "above" : "below"} VWAP but volume was under the prior ${P.vwapReclaimVolBars}-candle mean. No entry on a weak reclaim.`,
      });
    }
    if (dipSide) {
      const sd = dipSide.sg > 0 ? "long" : "short";
      return mk("DIP, AWAITING RECLAIM", "WAIT", {
        side: sd,
        levelNote: lbl,
        level: vw[n - 1],
        note: `${dipSide.dip} close${dipSide.dip > 1 ? "s" : ""} ${sd === "long" ? "below" : "above"} VWAP after ${dipSide.prevAbove} on the other side. Needs a close back ${sd === "long" ? "above" : "below"} ${f2(vw[n - 1])} on volume (at least the mean of the prior ${P.vwapReclaimVolBars} candles).`,
      });
    }
    return mk("NO RECLAIM SETUP", "WAIT", { levelNote: lbl, note: `Needs ${Math.round(P.vwapReclaimAboveMin / 5)}+ closes on one side of VWAP, a 1 to ${P.vwapReclaimDipMax} close dip across it, then a close back on volume.` });
  }
  const { sg, B, rec } = pick;
  const side = sg > 0 ? "long" : "short";
  const base = { side, levelNote: lbl };
  const trigTime = hhmm(day[rec.k].mm + 5);
  const slT = rec.dipLow;
  for (let k = rec.k + 1; k < n; k++) {
    if (B[k].cl < slT) return mk("STOPPED OUT", "NO TRADE", { ...base, note: `Reclaimed at ${trigTime}, then closed under the dip ${side === "long" ? "low" : "high"}.` });
  }
  if (day[rec.k].mm >= P.vwapCutoff) return mk("PAST ENTRY CUTOFF", "NO TRADE", { ...base, note: `Reclaimed at ${trigTime}, after the 14:30 cutoff for new entries.` });
  const age = n - 1 - rec.k;
  if (age > P.maxAge) return mk("TRIGGER STALE", "WAIT", { ...base, note: `Reclaimed at ${trigTime}, ${age} bars ago. Do not chase.` });

  const entryT = sg * price;
  const R = entryT - slT;
  const riskPct = (R / Math.abs(price)) * 100;
  const r = mk("TRIGGERED", "WAIT", {
    ...base,
    level: price,
    sl: sg * slT,
    t1: sg * (entryT + 2 * R),
    t2: sg * (entryT + 3 * R),
    riskPct,
    note: `${rec.dipN}-candle dip then a close back ${side === "long" ? "above" : "below"} VWAP at ${trigTime} on volume. Stop at the dip ${side === "long" ? "low" : "high"}; targets 2R and 3R.`,
  });
  // RSI(9) at the dip extreme: 38 to 58 at the dip low (long), 45 to 65 at the dip high (short).
  const rv = rs[rec.dipK];
  const [lo, hi] = side === "long" ? P.vwapRSILong : P.vwapRSIShort;
  const rsiBlock =
    rec.dipK + 1 < P.vwapRSIMinBars || rv == null
      ? { ok: true, info: true, text: `RSI(${P.vwapRSIPeriod}) filter skipped (fewer than ${P.vwapRSIMinBars} 5m bars in the session at the dip)` }
      : { ok: rv >= lo && rv <= hi, text: `RSI(${P.vwapRSIPeriod}) at the dip ${side === "long" ? "low" : "high"} is ${rv.toFixed(1)} (needs ${lo} to ${hi})` };
  return settle(r, ctx, [
    { ok: true, text: `At least ${Math.round(P.vwapReclaimAboveMin / 5)} closes on the trend side before the dip`, info: true },
    rsiBlock,
    { ok: R > 0, text: "Stop is on the right side of price" },
    { ok: riskPct <= P.maxRiskPct.vwap, text: `Underlying stop ${riskPct.toFixed(2)}% of price (max ${P.maxRiskPct.vwap}%)` },
    ...expiryBlock(ix, ctx),
  ]);
}

// ---- v1 pullback + continuation (works on a true VWAP or, for the information row, on the session average) ----
function pullbackCore(S, ix, c5, day, vw, price, ctx, lbl, rel) {
  const n = day.length;
  const em = ema(c5.map((b) => b.cl), 20).slice(-n);
  const lastC = day[n - 1].cl;
  const side = lastC >= vw[n - 1] ? "long" : "short";
  const sg = side === "long" ? 1 : -1;
  let cross = 0;
  let prevSign = 0;
  for (let k = 0; k < n; k++) {
    if (day[k].mm < P.orEnd) continue;
    const s = Math.sign(day[k].cl - vw[k]);
    if (s !== 0 && prevSign !== 0 && s !== prevSign) cross++;
    if (s !== 0) prevSign = s;
  }
  const bars = side === "long" ? day : day.map(neg);
  const vT = vw.map((x) => sg * x);
  const eT = em.map((x) => sg * x);
  const tol = (P.vwapTolPct / 100) * Math.abs(price);
  const lowsT = pivots(bars, 2).lo;
  const structure = lowsT.length >= 2 && lowsT[lowsT.length - 1].p > lowsT[lowsT.length - 2].p;
  const emaOk = bars[n - 1].cl > eT[n - 1];
  const checks = [
    { ok: cross < P.vwapMaxCross, text: `${cross} crossings of ${lbl} since 9:30 (chop at ${P.vwapMaxCross}+)` },
    { ok: structure, text: `Last two 5m swing ${side === "long" ? "lows rising" : "highs falling"}` },
    { ok: emaOk, text: `Price on the ${side === "long" ? "upper" : "lower"} side of the 20 EMA (optional filter)`, info: true },
  ];
  const base = { side, checks, levelNote: `${lbl} ${f2(vw[n - 1])}`, reliability: rel };
  if (cross >= P.vwapMaxCross) return res(S, "CHOPPY AROUND VWAP", "NO TRADE", { ...base, note: `Price has crossed ${lbl.toLowerCase()} ${cross} times today. Skip.` });

  let touch = -1;
  let trig = -1;
  let trigTouch = -1;
  for (let k = 0; k < n; k++) {
    if (bars[k].mm < P.vwapStart) continue;
    const b = bars[k];
    if (touch >= 0 && b.cl < vT[k] - tol) touch = -1; // closed through VWAP: pullback failed
    if (touch >= 0 && k > touch && b.cl > bars[touch].hi && b.cl > vT[k]) {
      trig = k;
      trigTouch = touch;
      touch = -1;
      continue;
    }
    if (touch < 0 && b.lo <= vT[k] + tol && b.cl >= vT[k] - tol) {
      let on = 0;
      for (let j = Math.max(0, k - 6); j < k; j++) if (bars[j].cl > vT[j] + tol) on++;
      if (on >= 3) touch = k;
    }
  }
  if (trig < 0) {
    if (touch >= 0) {
      return res(S, "PULLBACK AT VWAP, AWAITING TRIGGER", "WAIT", {
        ...base,
        level: sg * bars[touch].hi,
        note: `Needs a 5m close ${side === "long" ? "above" : "below"} ${f2(sg * bars[touch].hi)} (the touch candle).`,
      });
    }
    const gap = Math.abs(lastC - vw[n - 1]);
    if (!structure) {
      return res(S, "NO CLEAR STRUCTURE", "WAIT", {
        ...base,
        note: `Price is ${side === "long" ? "above" : "below"} ${lbl.toLowerCase()} but the last two 5m swing ${side === "long" ? "lows are not rising" : "highs are not falling"}.`,
      });
    }
    return res(S, "TREND, NO PULLBACK YET", "WAIT", {
      ...base,
      note: `${((gap / lastC) * 100).toFixed(2)}% ${side === "long" ? "above" : "below"} ${lbl.toLowerCase()}. Wait for a pullback to ${f2(vw[n - 1])}.`,
    });
  }
  const slT = Math.min(...bars.slice(trigTouch, trig + 1).map((b) => b.lo));
  const trigTime = hhmm(day[trig].mm + 5);
  for (let k = trig + 1; k < n; k++) {
    if (bars[k].cl < slT) return res(S, "STOPPED OUT", "NO TRADE", { ...base, note: `Triggered ${trigTime}, then closed under the pullback low.` });
  }
  if (day[trig].mm >= P.vwapCutoff) return res(S, "PAST ENTRY CUTOFF", "NO TRADE", { ...base, note: `Triggered ${trigTime}, after the 14:30 cutoff for new entries.` });
  const age = n - 1 - trig;
  if (age > P.maxAge) return res(S, "TRIGGER STALE", "WAIT", { ...base, note: `Triggered ${trigTime}, ${age} bars ago. Do not chase.` });

  const entryT = sg * price;
  const R = entryT - slT;
  const riskPct = (R / Math.abs(price)) * 100;
  const out = res(S, "TRIGGERED", "WAIT", {
    ...base,
    level: price,
    sl: sg * slT,
    t1: sg * (entryT + R),
    t2: sg * (entryT + 2 * R),
    riskPct,
    note: `Pullback to ${lbl.toLowerCase()} held and closed through at ${trigTime}. Stop under the pullback low.`,
    checks: [checks[0], checks[2]],
  });
  return settle(out, ctx, [
    checks[1],
    { ok: R > 0, text: "Stop is on the right side of price" },
    { ok: riskPct <= P.maxRiskPct.vwap, text: `Underlying stop ${riskPct.toFixed(2)}% of price (max ${P.maxRiskPct.vwap}%)` },
    ...expiryBlock(ix, ctx),
  ]);
}

// Returns [vwap_reclaim, vwap_pullback, (vwap_info when there is no true VWAP)].
function evalVwap(ix, c5, price, ctx) {
  const liveISO = ctx.liveISO;
  const day = c5.filter((b) => b.d === liveISO && b.mm < P.vwapEvalEnd);
  const hasVol = !!ctx.hasVol;
  const rel = reliabilityOf(hasVol, day);
  const young = (id, extra) => res(id, "SESSION TOO YOUNG", "WAIT", { note: "Needs about 40 minutes of 5m bars.", reliability: rel, ...extra });
  if (day.length < 8) {
    const rows = [young("vwap_reclaim"), young("vwap_pullback", hasVol ? {} : { label: "Session average pullback" })];
    if (!hasVol) rows.push(young("vwap_info", { info: true }));
    return rows;
  }
  const vw = vwapSeries(day, hasVol);
  if (!hasVol) {
    const needTrue = (id, label) => res(id, "NO TRADE (needs true VWAP)", "NO TRADE", { note: NEED_TRUE, reliability: "low", ...(label ? { label } : {}) });
    const info = pullbackCore("vwap_info", ix, c5, day, vw, price, ctx, "Session average price (no index volume)", "low");
    info.info = true;
    info.state = info.state + " (proxy)";
    info.note = "Information only: this is the session-average proxy, not a signal. " + info.note;
    info.action = "INFO";
    info.sl = info.t1 = info.t2 = info.riskPct = null;
    info.checks = info.checks.map((c) => ({ ...c, info: true }));
    return [needTrue("vwap_reclaim"), needTrue("vwap_pullback", "Session average pullback"), info];
  }
  const reclaim = evalReclaim(ix, day, vw, price, ctx, rel);
  const pull = pullbackCore("vwap_pullback", ix, c5, day, vw, price, ctx, "VWAP", rel);
  return [reclaim, pull];
}

module.exports = { evalVwap, vwapSeries, reliabilityOf, reclaimScan };
````

## `lib/rules_maxpain.js`

````js
// lib/rules_maxpain.js - expiry-day max-pain drift (NIFTY and BANKNIFTY only, 14:00 to 15:30 on expiry days).
// It needs OPEN INTEREST from an option chain. Yahoo has none, so without a broker adapter this row says NO TRADE and
// never guesses. Max pain = the settlement price at which option WRITERS lose the least in total.

const { P, f2, hhmm, res, settle } = require("./rules_core");

const S = "expiry_maxpain";
const ONLY = /^(NIFTY|BANKNIFTY)$/;

// chain: { strikes: [{ strike, ce: { oi }, pe: { oi } }] }
function maxPain(chain) {
  const rows = (chain && chain.strikes) || [];
  if (rows.length < 3) return null;
  let best = null;
  for (const t of rows) {
    const s = t.strike;
    let loss = 0;
    for (const u of rows) {
      loss += ((u.ce && u.ce.oi) || 0) * Math.max(s - u.strike, 0) + ((u.pe && u.pe.oi) || 0) * Math.max(u.strike - s, 0);
    }
    if (!best || loss < best.loss) best = { strike: s, loss };
  }
  return best;
}

// Returns a row, or null when the strategy does not apply (not NIFTY / BANKNIFTY, or not an expiry day).
function evalMaxPain(ix, c5, price, ctx) {
  if (!ONLY.test(ix.key) || !ctx.expiry[ix.key]) return null;
  if (!ctx.chain) return res(S, "NO OPTION CHAIN", "NO TRADE", { note: "Needs option-chain OI; configure a broker adapter." });
  const mp = maxPain(ctx.chain);
  if (!mp) return res(S, "NO OPTION CHAIN", "NO TRADE", { note: "Needs option-chain OI; the chain from the adapter had too few strikes." });
  const day = c5.filter((b) => b.d === ctx.liveISO);
  const n = day.length;
  if (n < 2) return res(S, "WAITING", "WAIT", { note: "Not enough bars yet." });
  const levelNote = `Max pain ${f2(mp.strike)}`;
  const nowMM = day[n - 1].mm + 5;
  if (nowMM < P.maxPainStart) return res(S, "ACTIVE FROM 14:00", "WAIT", { levelNote, note: `Max pain is ${f2(mp.strike)}. The rule is only active from 14:00 on expiry day.` });
  const dist = (p) => (Math.abs(p - mp.strike) / p) * 100;

  let trig = -1;
  let side = null;
  for (let k = Math.max(1, day.findIndex((b) => b.mm >= P.maxPainStart)); k < n; k++) {
    if (day[k].mm < P.maxPainStart || day[k].mm >= P.maxPainEnd) continue;
    const d = dist(day[k].cl);
    if (d < P.maxPainMinDist || d > P.maxPainMaxDist) continue;
    const above = day[k].cl > mp.strike;
    const toward = above ? day[k].cl < day[k - 1].cl : day[k].cl > day[k - 1].cl;
    if (toward) {
      trig = k;
      side = above ? "short" : "long";
      break;
    }
  }
  const d0 = dist(price);
  if (trig < 0) {
    if (d0 > P.maxPainMaxDist) return res(S, "TOO FAR FROM MAX PAIN", "NO TRADE", { levelNote, note: `Price is ${d0.toFixed(2)}% from max pain (limit ${P.maxPainMaxDist}%). Skip.` });
    if (d0 < P.maxPainMinDist) {
      return res(S, "TOO CLOSE TO MAX PAIN", "NO TRADE", { levelNote, note: `Price is ${d0.toFixed(2)}% from max pain (needs ${P.maxPainMinDist}% to ${P.maxPainMaxDist}%${d0 < P.maxPainSkipNear ? "; under 0.2% is skipped outright" : ""}).` });
    }
    return res(S, "AWAITING 5M CLOSE TOWARD MAX PAIN", "WAIT", { levelNote, level: mp.strike, note: `Price is ${d0.toFixed(2)}% from max pain. Needs a 5m close toward ${f2(mp.strike)}.` });
  }
  const sg = side === "long" ? 1 : -1;
  const prior = day.slice(Math.max(0, trig - 3), trig);
  const slT = side === "long" ? Math.min(...prior.map((b) => b.lo)) : Math.max(...prior.map((b) => b.hi));
  const trigTime = hhmm(day[trig].mm + 5);
  const age = n - 1 - trig;
  const base = { side, levelNote };
  if (age > P.maxAge) return res(S, "TRIGGER STALE", "WAIT", { ...base, note: `Triggered ${trigTime}, ${age} bars ago. Do not chase.` });
  const R = sg * (price - slT);
  const riskPct = (R / price) * 100;
  const out = res(S, "TRIGGERED", "WAIT", {
    ...base,
    level: price,
    sl: slT,
    t1: mp.strike,
    t2: null,
    riskPct,
    note: `5m close toward max pain ${f2(mp.strike)} at ${trigTime}, ${dist(day[trig].cl).toFixed(2)}% away. Stop beyond the prior 3 candles; the only target is max pain.`,
  });
  return settle(out, ctx, [
    { ok: R > 0, text: "Stop is on the right side of price" },
    { ok: sg * (mp.strike - price) >= R, text: "Room to max pain is at least 1x the risk", info: true },
  ]);
}

module.exports = { maxPain, evalMaxPain };
````

## `lib/replay.js`

````js
// lib/replay.js - replays the index rulebooks bar by bar over past sessions (used by the chart and the backtest).
// v2 notes: strategy ids are orb_break, orb_retest, ichi, vwap_reclaim, vwap_pullback. ichi_swing and expiry_maxpain are
// NOT replayed (they need Daily/4h history and option-chain OI), so they are shown as "not backtested".
// A BUY downgraded by the India VIX filter or by the ORB size rule is counted as BLOCKED, not as a trade.
// Honesty rules, all enforced here:
//   * At each step the engine only sees bars that had finished by that moment (same code path as the live page).
//   * One trade per strategy per session (the first BUY), so the sample is not inflated by repeat signals.
//   * Entry is the close of the trigger candle. Stops are checked before targets inside a candle (pessimistic).
//   * Everything is measured on the INDEX in R multiples. No option premium, theta, spread or costs.

const { yahooChart } = require("./common");
const broker = require("./broker");
const { _internals: I } = require("../api/indices");

const { P, analyse, isExpiryDay, parseIdx } = I;
const EXIT_MM = 915; // flat by 15:15
const HIST5 = 374; // the live page sees about 5 sessions of 5m bars; keep the same window

function lowerBound(arr, t) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].t < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

// Fetch the three timeframes. 5m and 15m reach back about 60 days on Yahoo; 1h reaches much further.
async function fetchData(ix, i, long) {
  let err = null;
  if (long && broker.configured()) {
    // A broker adapter can serve up to 2 years of 5m / 15m bars (with volume). Fall back to Yahoo if it fails.
    try {
      const shape = (arr) =>
        arr.map((b) => {
          const lt = b.t + 19800;
          return { t: b.t, d: new Date(lt * 1000).toISOString().slice(0, 10), mm: Math.floor((lt % 86400) / 60), o: b.o, hi: b.hi, lo: b.lo, cl: b.cl, vol: b.vol || 0 };
        });
      const [b5, b15, b1h] = await Promise.all([broker.fetchBars(ix.key, "5m", "2y"), broker.fetchBars(ix.key, "15m", "2y"), broker.fetchBars(ix.key, "60m", "2y")]);
      if (b5 && b5.length) return { sym: ix.key, source: "broker", p5: { bars: shape(b5), meta: {} }, p15: { bars: shape(b15 || []), meta: {} }, p1h: { bars: shape(b1h || []), meta: {} } };
    } catch (e) {
      err = e;
    }
  }
  for (const sym of ix.yahoo) {
    try {
      const [r5, r15, r1h] = await Promise.allSettled([
        yahooChart(sym, i, long ? "60d" : "5d", "5m"),
        yahooChart(sym, i + 1, long ? "60d" : "1mo", "15m"),
        yahooChart(sym, i, long ? "6mo" : "3mo", "60m"),
      ]);
      if (r5.status !== "fulfilled") throw r5.reason;
      return {
        sym,
        p5: parseIdx(r5.value),
        p15: r15.status === "fulfilled" ? parseIdx(r15.value) : null,
        p1h: r1h.status === "fulfilled" ? parseIdx(r1h.value) : null,
      };
    } catch (e) {
      err = e;
    }
  }
  return { error: String((err && err.message) || err) };
}

// Walk the bars after entry. Returns the R result for a given target, stop checked first inside a bar.
function walk(sig, bars, target) {
  const sg = sig.side === "long" ? 1 : -1;
  const R = Math.abs(sig.entry - sig.sl);
  const rOf = (px) => (sg * (px - sig.entry)) / R;
  let last = null;
  for (const b of bars) {
    if (b.mm >= EXIT_MM) return { r: rOf(b.o), outcome: "EOD", exitMM: b.mm, exitPrice: b.o };
    last = b;
    const stopHit = sg > 0 ? b.lo <= sig.sl : b.hi >= sig.sl;
    const tgtHit = sg > 0 ? b.hi >= target : b.lo <= target;
    if (stopHit) {
      const px = sg > 0 ? Math.min(b.o, sig.sl) : Math.max(b.o, sig.sl); // a gap through the stop fills at the open
      return { r: rOf(px), outcome: "SL", exitMM: b.mm + 5, exitPrice: px };
    }
    if (tgtHit) return { r: rOf(target), outcome: "TGT", exitMM: b.mm + 5, exitPrice: target };
  }
  if (!last) return { r: 0, outcome: "OPEN", exitMM: null, exitPrice: sig.entry };
  const done = last.mm + 5 >= EXIT_MM;
  return { r: rOf(last.cl), outcome: done ? "EOD" : "OPEN", exitMM: last.mm + 5, exitPrice: last.cl };
}

// Replay one session. nowCap (unix seconds) stops the replay at "now" when the session is still running.
// opts.vix: the India VIX state known at the start of that session (lib/common.vixState), or null to skip the filter.
const SIZE_SCALE = { full: 1, half: 0.5, skip: 0 };

function replayDay(ix, data, iso, nowCap, opts = {}) {
  const b5 = data.p5.bars;
  const b15 = data.p15 ? data.p15.bars : [];
  const b1h = data.p1h ? data.p1h.bars : [];
  const first = b5.findIndex((b) => b.d === iso);
  if (first < 0) return { signals: [], blocked: [], skipped: "no bars" };
  const expiry = { [ix.key]: isExpiryDay(ix, iso) };
  const found = {};
  const blockedSeen = {};
  const blocked = [];
  let steps = 0;
  for (let k = first; k < b5.length && b5[k].d === iso; k++) {
    const bar = b5[k];
    if (bar.mm < P.orEnd) continue; // the opening range is not complete before 9:30
    if (bar.mm >= P.vwapCutoff) break; // no strategy takes entries from 14:30 on
    const nowSec = bar.t + 300;
    if (nowCap && nowSec > nowCap) break;
    const j15 = lowerBound(b15, nowSec);
    const j1h = lowerBound(b1h, nowSec);
    const view = {
      p5: { bars: b5.slice(Math.max(0, k + 1 - HIST5), k + 1), meta: {} },
      p15: b15.length ? { bars: b15.slice(Math.max(0, j15 - 400), j15), meta: {} } : null,
      p1h: b1h.length ? { bars: b1h.slice(Math.max(0, j1h - 600), j1h), meta: {} } : null,
    };
    const out = analyse(ix, view, { nowSec, todayISO: iso, marketOpen: true, expiry, vix: opts.vix || null, skipSwing: true, skipMaxPain: true });
    steps++;
    for (const r of out.rows) {
      if (r.info) continue;
      const entry = view.p5.bars[view.p5.bars.length - 1].cl;
      if (r.blockedBy && !found[r.strategy] && !blockedSeen[r.strategy + r.blockedBy]) {
        blockedSeen[r.strategy + r.blockedBy] = true;
        blocked.push({ strategy: r.strategy, index: ix.key, date: iso, by: r.blockedBy, side: r.side, entryMM: bar.mm + 5, entry, sizeHint: r.sizeHint });
        continue;
      }
      if (found[r.strategy] || !/^BUY/.test(r.action)) continue;
      // The engine prices the signal at the last close here, so levels are consistent with the entry used below.
      found[r.strategy] = {
        strategy: r.strategy,
        index: ix.key,
        date: iso,
        side: r.side,
        cut: k,
        entryMM: bar.mm + 5,
        entry,
        sl: r.sl,
        t1: r.t1,
        t2: r.t2,
        riskPct: r.riskPct,
        option: r.option,
        state: r.state,
        sizeHint: r.sizeHint || "full",
        trail: r.trail || null,
        trendSource: r.trendSource || null,
        reliability: r.reliability || null,
        vixValue: opts.vix && opts.vix.ok ? opts.vix.value : null,
      };
    }
  }
  const signals = Object.values(found).map((s) => {
    const R = Math.abs(s.entry - s.sl);
    const after = [];
    for (let k = s.cut + 1; k < b5.length && b5[k].d === iso; k++) after.push(b5[k]);
    const t = { ...s };
    delete t.cut;
    if (!(R > 0)) return { ...t, valid: false };
    t.valid = true;
    t.scale = SIZE_SCALE[s.sizeHint] == null ? 1 : SIZE_SCALE[s.sizeHint];
    t.rr1 = Math.abs(s.t1 - s.entry) / R;
    t.rr2 = Math.abs(s.t2 - s.entry) / R;
    for (const [key, tg] of [["x1", s.t1], ["x2", s.t2]]) {
      const x = walk(s, after, tg);
      x.rRaw = x.r;
      x.r = x.rRaw * t.scale; // half size counts as 0.5 of the R
      t[key] = x;
    }
    return t;
  });
  signals.sort((a, b) => a.entryMM - b.entryMM);
  return { signals, blocked, steps, expiry: expiry[ix.key] };
}

function sessionDates(bars) {
  const seen = [];
  for (const b of bars) if (seen[seen.length - 1] !== b.d) seen.push(b.d);
  return seen;
}

module.exports = { fetchData, replayDay, walk, sessionDates, lowerBound, EXIT_MM, SIZE_SCALE };
````

## `api/quotes.js`

````js
// api/quotes.js - lightweight live price refresh for a handful of symbols.
// GET /api/quotes?symbols=TCS,INFY,RELIANCE   (max 60)
// Prices come from Yahoo Finance (NSE symbols as SYMBOL.NS). Not an exchange feed.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fin = (x) => (Number.isFinite(x) ? x : null);

function istParts(date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  return { weekday: p.weekday, minutes: Number(p.hour) * 60 + Number(p.minute) + Number(p.second) / 60 };
}

function sessionFraction(now) {
  if (now.weekday === "Sat" || now.weekday === "Sun") return 1;
  const open = 9 * 60 + 15;
  const close = 15 * 60 + 30;
  if (now.minutes <= open || now.minutes >= close) return 1;
  return Math.max((now.minutes - open) / (close - open), 0.05);
}

const expectedVolumeShare = (frac) => (frac >= 1 ? 1 : Math.pow(frac, 0.7));

async function quote(sym, i) {
  const url = `https://${i % 2 ? "query2" : "query1"}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}.NS?range=1d&interval=1d`;
  for (let a = 0; a < 2; a++) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      });
      if (r.ok) {
        const j = await r.json();
        const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
        if (m && Number.isFinite(m.regularMarketPrice)) {
          return {
            ltp: m.regularMarketPrice,
            hi: fin(m.regularMarketDayHigh),
            lo: fin(m.regularMarketDayLow),
            vol: fin(m.regularMarketVolume),
            t: fin(m.regularMarketTime),
          };
        }
        return null;
      }
      if (r.status === 404) return null;
    } catch (_) {
      /* retry once */
    }
    await sleep(200);
  }
  return null;
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

module.exports = async function handler(req, res) {
  const raw = (req.query && req.query.symbols) || "";
  const list = (Array.isArray(raw) ? raw.join(",") : String(raw))
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9&-]{1,20}$/.test(s));
  const symbols = [...new Set(list)].slice(0, 60);
  if (symbols.length === 0) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: "Pass ?symbols=TCS,INFY (up to 60 NSE symbols)." });
  }

  const got = await mapPool(symbols, 20, (s, i) => quote(s, i));
  const quotes = {};
  let missing = 0;
  symbols.forEach((s, i) => {
    if (got[i]) quotes[s] = got[i];
    else missing++;
  });

  const frac = sessionFraction(istParts());
  res.setHeader("Cache-Control", "public, s-maxage=5, stale-while-revalidate=10");
  return res.status(200).json({
    serverTime: Math.floor(Date.now() / 1000),
    marketOpen: frac < 1,
    share: expectedVolumeShare(frac),
    missing,
    quotes,
  });
};
````

## `api/scan.js`

````js
// api/scan.js - Vercel serverless function (Node, CommonJS, zero dependencies).
// Breakout / breakdown scanner for NSE stocks.
//   Stock lists : NSE's own constituent CSVs (nsearchives.nseindia.com)
//   Prices      : Yahoo Finance chart API (NSE symbols as SYMBOL.NS), one call per stock
// NSE's own live-data endpoints return web pages instead of data to Vercel's servers,
// so this does not depend on them. Screening aid only, not trading advice.

const {
  LISTS, FO_INDEX, clamp, getUniverse, yahooChart, parseChart, mapPool,
  istParts, sessionFraction, expectedVolumeShare, formatIST, parseSymbols,
} = require("../lib/common");

// --------------------------------------------------------------------------
// Baseline and scoring
// --------------------------------------------------------------------------
function buildBaseline(bars, liveISO, lookback) {
  const win = bars
    .filter((b) => b.d < liveISO) // only sessions BEFORE the live day
    .sort((a, b) => (a.d < b.d ? 1 : -1))
    .slice(0, lookback);
  if (win.length < Math.max(10, Math.floor(lookback / 2))) return null;

  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const ranges = win.map((p) => p.hi - p.lo);
  const fullRange = mean(ranges);
  const avgVol = mean(win.map((p) => p.vol));
  return {
    high: Math.max(...win.map((p) => p.hi)),
    low: Math.min(...win.map((p) => p.lo)),
    prevClose: win[0].cl,
    avgVol,
    avgTurnover: avgVol * win[0].cl,
    // < 1 means the last 5 sessions were tighter than the 20-session norm (a "base")
    contraction: fullRange ? mean(ranges.slice(0, 5)) / fullRange : 1,
  };
}

function evaluate(s, base, side, share, o) {
  const rng = s.hi - s.lo;
  if (!(rng > 0)) return null;
  let level, dist, pos, move, stop, word, gapped;
  if (side === "long") {
    level = base.high;
    dist = ((s.ltp - level) / level) * 100;
    pos = (s.ltp - s.lo) / rng;
    move = s.pchg;
    stop = s.lo;
    word = "BREAKOUT";
    gapped = s.open > level * 1.015;
  } else {
    level = base.low;
    dist = ((level - s.ltp) / level) * 100;
    pos = (s.hi - s.ltp) / rng;
    move = -s.pchg;
    stop = s.hi;
    word = "BREAKDOWN";
    gapped = s.open > 0 && s.open < level * 0.985;
  }

  if (dist > o.maxExtension) return null; // already ran too far
  let status;
  if (dist > 0) status = word;
  else if (dist >= -o.nearPct) status = "NEAR";
  else return null;

  if (base.avgTurnover < o.minTurnoverCr * 1e7) return null; // illiquid
  const rvol = base.avgVol ? s.vol / (base.avgVol * share) : 0;
  if (rvol < o.minRvol) return null;

  let score = status === word ? 25 : 12;
  score += rvol >= 3 ? 30 : rvol >= 2 ? 22 : rvol >= 1.5 ? 14 : 6;
  score += pos >= 0.9 ? 25 : pos >= 0.8 ? 18 : pos >= 0.7 ? 10 : 0;
  score += base.contraction < 0.8 ? 10 : 0;
  score += move >= 1 && move <= 5 ? 10 : (move >= 0.5 && move < 1) || (move > 5 && move <= 7) ? 5 : 0;

  const notes = [];
  if (base.contraction < 0.8) notes.push("tight base");
  if (gapped) notes.push("gapped past level");

  return {
    symbol: s.symbol,
    side,
    ltp: s.ltp,
    chgPct: s.pchg,
    level,
    distPct: dist,
    rvol,
    rangePos: pos,
    score,
    status,
    refStop: stop,
    notes: notes.join(", "),
    // raw values so the page can keep these columns live between scans
    prevClose: base.prevClose,
    avgVol: base.avgVol,
    dayHigh: s.hi,
    dayLow: s.lo,
    volume: s.vol,
  };
}

// --------------------------------------------------------------------------
// Handler
// --------------------------------------------------------------------------
async function handler(req, res) {
  const t0 = Date.now();
  const q = req.query || {};
  const index = q.index === FO_INDEX || LISTS[q.index] ? q.index : "NIFTY 500";
  const side = ["long", "short", "both"].includes(q.side) ? q.side : "long";
  const o = {
    minRvol: clamp(parseFloat(q.minRvol), 0, 10, 1.2),
    minPrice: 50,
    minTurnoverCr: 5,
    nearPct: 0.5,
    maxExtension: 3,
  };
  const lookback = 20;

  let universe;
  try {
    universe = await getUniverse(index);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({
      error: "Could not load the NSE stock list.",
      detail: String((e && e.message) || e),
      hint: "Try again in a minute, or pick a different universe.",
    });
  }

  const symbols = universe.map((u) => u.sym);
  const industryOf = new Map(universe.map((u) => [u.sym, u.industry]));

  // One price call per stock, run in parallel.
  let failed = 0;
  let partial = false;
  const errSamples = [];
  const charts = await mapPool(symbols, 24, async (sym, i) => {
    if (Date.now() - t0 > 45000) {
      partial = true;
      return null;
    }
    try {
      const p = parseChart(await yahooChart(sym, i));
      if (!p) throw new Error("no live price");
      return { sym, p };
    } catch (e) {
      failed++;
      if (errSamples.length < 3) errSamples.push(`${sym}: ${String((e && e.message) || e).slice(0, 60)}`);
      return null;
    }
  });
  const got = charts.filter(Boolean);

  if (got.length === 0) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({
      error: "Could not load prices for any stock.",
      detail: errSamples.join(" | ") || "no responses",
      hint: "The price source may be rate-limiting this server. Try again in a minute.",
    });
  }

  // Live session date = the most common last-trade date across stocks.
  const tally = new Map();
  for (const { p } of got) tally.set(p.liveISO, (tally.get(p.liveISO) || 0) + 1);
  const liveISO = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const now = istParts();
  const frac = liveISO === now.iso ? sessionFraction(now) : 1;
  const share = expectedVolumeShare(frac);

  let newestTs = 0;
  let stale = 0;
  const stocks = [];
  for (const { sym, p } of got) {
    if (p.liveISO !== liveISO) {
      stale++; // suspended or not traded on the live date
      continue;
    }
    const base = buildBaseline(p.bars, liveISO, lookback);
    if (!base || !(base.prevClose > 0)) continue;
    const m = p.meta;
    const todayBar = p.bars.find((b) => b.d === liveISO);
    const ltp = m.regularMarketPrice;
    const hi = Number.isFinite(m.regularMarketDayHigh) ? m.regularMarketDayHigh : todayBar ? todayBar.hi : ltp;
    const lo = Number.isFinite(m.regularMarketDayLow) ? m.regularMarketDayLow : todayBar ? todayBar.lo : ltp;
    const vol = Number.isFinite(m.regularMarketVolume) ? m.regularMarketVolume : todayBar ? todayBar.vol : 0;
    if (!(ltp > 0) || !(hi > lo)) continue;
    newestTs = Math.max(newestTs, p.liveTs);
    stocks.push({
      s: {
        symbol: sym,
        ltp,
        open: todayBar ? todayBar.o : 0,
        hi,
        lo,
        pchg: ((ltp - base.prevClose) / base.prevClose) * 100,
        vol,
      },
      base,
    });
  }

  const results = [];
  let candidates = 0;
  const sides = side === "both" ? ["long", "short"] : [side];
  for (const sd of sides) {
    for (const { s, base } of stocks) {
      if (s.ltp < o.minPrice) continue;
      const rng = s.hi - s.lo;
      const ok =
        sd === "long"
          ? s.pchg >= 0.5 && (s.ltp - s.lo) / rng >= 0.6
          : s.pchg <= -0.5 && (s.hi - s.ltp) / rng >= 0.6;
      if (!ok) continue;
      candidates++;
      const r = evaluate(s, base, sd, share, o);
      if (r) {
        r.industry = industryOf.get(s.symbol) || "";
        results.push(r);
      }
    }
  }
  results.sort((a, b) => b.score - a.score);

  const warnings = [];
  if (failed > symbols.length * 0.3) {
    warnings.push(`Prices missing for ${failed} of ${symbols.length} stocks (source may be rate-limiting). Results may be incomplete.`);
  }
  if (partial) warnings.push("Stopped early to stay within the time limit; some stocks were not checked.");
  const lagMin = newestTs ? Math.round((Date.now() / 1000 - newestTs) / 60) : 0;
  if (frac < 1 && lagMin > 10) {
    warnings.push(`The newest price is ${lagMin} minutes old, so the data source may be delayed.`);
  }

  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
  return res.status(200).json({
    meta: {
      index,
      side,
      asOf: newestTs ? formatIST(newestTs) : null,
      marketOpen: frac < 1,
      sessionPct: Math.round(frac * 100),
      universe: stocks.length,
      universeSize: symbols.length,
      volShare: share,
      candidates,
      historyFailed: failed,
      staleSkipped: stale,
      minRvol: o.minRvol,
      source: "NSE index lists + Yahoo Finance prices",
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - t0,
    },
    warnings,
    results: results.slice(0, 60),
  });
}

module.exports = handler;
module.exports._internals = { evaluate, buildBaseline, parseSymbols, parseChart, sessionFraction, expectedVolumeShare };
````

## `api/ichimoku.js`

````js
// api/ichimoku.js - Ichimoku Cloud (Kumo) breakout scanner for NSE stocks.
//   Stock lists : NSE's own constituent CSVs (nsearchives.nseindia.com)
//   Prices      : Yahoo Finance chart API (NSE symbols as SYMBOL.NS), one call per stock
// Standard settings 9 / 26 / 52 with a 26-bar displacement.
// Screening aid only, not trading advice.

const {
  LISTS, FO_INDEX, getUniverse, yahooChart, parseChart, mapPool,
  istParts, sessionFraction, expectedVolumeShare, formatIST,
} = require("../lib/common");

// Timeframes. "nearPct" = how close to the cloud edge counts as "about to break".
const TF = {
  "1d": { label: "Daily", range: "6mo", interval: "1d", nearPct: 1.0, intraday: false, unit: "d" },
  "1h": { label: "1 hour", range: "3mo", interval: "60m", nearPct: 0.6, intraday: true, unit: "bar" },
  "15m": { label: "15 min", range: "1mo", interval: "15m", nearPct: 0.4, intraday: true, unit: "bar" },
};

const TENKAN = 9;
const KIJUN = 26;
const SENKOU_B = 52;
const SHIFT = 26; // cloud is plotted 26 bars ahead, chikou 26 bars back
const FIRST_CLOUD = SHIFT + SENKOU_B - 1; // first bar index that has a plotted cloud (77)
const MAX_AGE = 5; // a break older than this many bars is no longer "fresh"
const MIN_BARS = FIRST_CLOUD + MAX_AGE + 8;
const KEEP_BARS = 160; // only the tail matters for the signal
const MIN_PRICE = 50;
const MIN_TURNOVER_CR = 5;
const MAX_ROWS = 100;

const fin = (x) => (Number.isFinite(x) ? x : null);

// --------------------------------------------------------------------------
// Indicator
// --------------------------------------------------------------------------
// bars: ascending [{hi, lo, cl}]. Returns arrays aligned to bar index.
//   tenkan/kijun/spanA/spanB are the "raw" values computed AT each bar.
//   top/bot are the cloud edges as PLOTTED at each bar (spans from 26 bars earlier).
function ichimoku(bars) {
  const n = bars.length;
  const mid = (i, p) => {
    let h = -Infinity;
    let l = Infinity;
    for (let k = i - p + 1; k <= i; k++) {
      if (bars[k].hi > h) h = bars[k].hi;
      if (bars[k].lo < l) l = bars[k].lo;
    }
    return (h + l) / 2;
  };
  const tenkan = new Array(n).fill(null);
  const kijun = new Array(n).fill(null);
  const spanA = new Array(n).fill(null);
  const spanB = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i >= TENKAN - 1) tenkan[i] = mid(i, TENKAN);
    if (i >= KIJUN - 1) {
      kijun[i] = mid(i, KIJUN);
      spanA[i] = (tenkan[i] + kijun[i]) / 2;
    }
    if (i >= SENKOU_B - 1) spanB[i] = mid(i, SENKOU_B);
  }
  const top = new Array(n).fill(null);
  const bot = new Array(n).fill(null);
  for (let j = FIRST_CLOUD; j < n; j++) {
    const a = spanA[j - SHIFT];
    const b = spanB[j - SHIFT];
    top[j] = Math.max(a, b);
    bot[j] = Math.min(a, b);
  }
  return { tenkan, kijun, spanA, spanB, top, bot };
}

// --------------------------------------------------------------------------
// Signal for one side. Returns null when there is nothing to show.
//   age = bars since the close first moved beyond the cloud (0 = the latest bar),
//   age = null means "NEAR": still on the near side of the cloud edge, within nearPct of it.
// --------------------------------------------------------------------------
function signal(bars, ich, side, cfg) {
  const n = bars.length;
  const last = n - 1;
  const long = side === "long";
  const beyond = (i) => (long ? bars[i].cl > ich.top[i] : bars[i].cl < ich.bot[i]);
  const edgeNow = long ? ich.top[last] : ich.bot[last];
  if (!Number.isFinite(edgeNow)) return null;
  const c = bars[last].cl;

  let age = null;
  let from = null;
  if (beyond(last)) {
    let k = last;
    while (k >= FIRST_CLOUD && beyond(k)) k--;
    if (k < FIRST_CLOUD) return null; // beyond the cloud for as long as we can see: an old trend, not a fresh break
    age = last - (k + 1);
    if (age > MAX_AGE) return null;
    const pc = bars[k].cl; // the close just before the break
    from = long ? (pc < ich.bot[k] ? "below" : "inside") : pc > ich.top[k] ? "above" : "inside";
  } else {
    const short = long ? ((edgeNow - c) / edgeNow) * 100 : ((c - edgeNow) / edgeNow) * 100; // % still to go
    if (short > cfg.nearPct) return null;
  }

  const tk = long ? ich.tenkan[last] > ich.kijun[last] : ich.tenkan[last] < ich.kijun[last];
  const kj = long ? c > ich.kijun[last] : c < ich.kijun[last];

  // Chikou span = today's close drawn 26 bars back. "Clear" = it sits beyond the candles there
  // (and beyond the cloud there, when one exists).
  let chikou = false;
  let chikouPart = false;
  const ref = last - SHIFT;
  if (ref >= 0) {
    chikouPart = long ? c > bars[ref].cl : c < bars[ref].cl;
    const clearPrice = long ? c > bars[ref].hi : c < bars[ref].lo;
    const clearCloud = ref < FIRST_CLOUD || (long ? c > ich.top[ref] : c < ich.bot[ref]);
    chikou = clearPrice && clearCloud;
  }

  // Colour of the cloud 26 bars ahead (spans computed now): green = bullish, red = bearish.
  const future = long ? ich.spanA[last] > ich.spanB[last] : ich.spanA[last] < ich.spanB[last];

  return {
    side,
    age,
    from,
    tk,
    kj,
    chikou,
    chikouPart,
    future,
    top: ich.top[last],
    bot: ich.bot[last],
    tenkan: ich.tenkan[last],
    kijun: ich.kijun[last],
  };
}

function scoreOf(sig, rvol, cfg) {
  let s = sig.age == null ? 10 : Math.max(40 - 7 * sig.age, 12);
  if (sig.tk) s += 12;
  if (sig.kj) s += 6;
  s += sig.chikou ? 14 : sig.chikouPart ? 6 : 0;
  if (sig.future) s += 10;
  let max = 82; // intraday bars carry no volume component
  if (!cfg.intraday) {
    max = 100;
    s += rvol >= 2 ? 18 : rvol >= 1.5 ? 12 : rvol >= 1 ? 6 : 0;
  }
  return Math.round(Math.min(100, (s * 100) / max));
}

// A reference stop only. Fresh break: the closer of Kijun / cloud far edge that is on the safe side of price.
// NEAR: the last 5 bars' swing low (long) or high (short).
function refStopOf(sig, bars, ltp) {
  const long = sig.side === "long";
  const last = bars.length - 1;
  if (sig.age != null) {
    if (long) {
      const s = sig.kijun < ltp ? Math.max(sig.kijun, sig.bot) : sig.bot;
      return s < ltp ? s : ltp * 0.98;
    }
    const s = sig.kijun > ltp ? Math.min(sig.kijun, sig.top) : sig.top;
    return s > ltp ? s : ltp * 1.02;
  }
  const w = bars.slice(Math.max(0, last - 4));
  if (long) {
    const s = Math.min(...w.map((b) => b.lo));
    return s < ltp ? s : ltp * 0.98;
  }
  const s = Math.max(...w.map((b) => b.hi));
  return s > ltp ? s : ltp * 1.02;
}

// --------------------------------------------------------------------------
// Data prep
// --------------------------------------------------------------------------
// Session-level stats from all bars before the live day (works for any timeframe).
function sessionStats(bars, liveISO) {
  const days = new Map(); // date -> {vol, val, close}
  for (const b of bars) {
    if (b.d >= liveISO) continue;
    let d = days.get(b.d);
    if (!d) days.set(b.d, (d = { vol: 0, val: 0, close: b.cl }));
    d.vol += b.vol;
    d.val += b.vol * b.cl;
    d.close = b.cl; // bars ascend, so this ends as the day's last close
  }
  const dates = [...days.keys()].sort().slice(-20);
  if (dates.length < 10) return null;
  const mean = (f) => dates.reduce((s, k) => s + f(days.get(k)), 0) / dates.length;
  return {
    prevClose: days.get(dates[dates.length - 1]).close,
    avgVol: mean((d) => d.vol),
    avgTurnover: mean((d) => d.val),
  };
}

// The bar series with the live price folded into the latest bar.
// Daily: if Yahoo has no bar for the live day yet, build one from the quote.
// Intraday: the latest bar must belong to the live day.
function liveSeries(p, cfg, liveISO) {
  const m = p.meta;
  const ltp = m.regularMarketPrice;
  let bars = p.bars.slice();
  if (!cfg.intraday) {
    // Yahoo occasionally repeats the live day's bar; keep the last one per date.
    bars = bars.filter((b, i) => i === bars.length - 1 || b.d !== bars[i + 1].d);
  }
  const lastB = bars[bars.length - 1];
  if (lastB && lastB.d === liveISO) {
    bars[bars.length - 1] = { ...lastB, cl: ltp, hi: Math.max(lastB.hi, ltp), lo: Math.min(lastB.lo, ltp) };
    return bars;
  }
  if (cfg.intraday) return null;
  const hi = fin(m.regularMarketDayHigh);
  const lo = fin(m.regularMarketDayLow);
  if (!(hi > 0 && lo > 0)) return null;
  bars.push({ d: liveISO, t: p.liveTs, o: 0, hi: Math.max(hi, ltp), lo: Math.min(lo, ltp), cl: ltp, vol: fin(m.regularMarketVolume) || 0 });
  return bars;
}

// --------------------------------------------------------------------------
// Handler
// --------------------------------------------------------------------------
async function handler(req, res) {
  const t0 = Date.now();
  const q = req.query || {};
  const index = q.index === FO_INDEX || LISTS[q.index] ? q.index : "NIFTY 500";
  const tf = TF[q.tf] ? q.tf : "1d";
  const cfg = TF[tf];
  const side = ["long", "short", "both"].includes(q.side) ? q.side : "long";

  let universe;
  try {
    universe = await getUniverse(index);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({
      error: "Could not load the NSE stock list.",
      detail: String((e && e.message) || e),
      hint: "Try again in a minute, or pick a different universe.",
    });
  }
  const symbols = universe.map((u) => u.sym);
  const industryOf = new Map(universe.map((u) => [u.sym, u.industry]));

  let failed = 0;
  let partial = false;
  const errSamples = [];
  const charts = await mapPool(symbols, 24, async (sym, i) => {
    if (Date.now() - t0 > 45000) {
      partial = true;
      return null;
    }
    try {
      const p = parseChart(await yahooChart(sym, i, cfg.range, cfg.interval));
      if (!p) throw new Error("no live price");
      return { sym, p };
    } catch (e) {
      failed++;
      if (errSamples.length < 3) errSamples.push(`${sym}: ${String((e && e.message) || e).slice(0, 60)}`);
      return null;
    }
  });
  const got = charts.filter(Boolean);
  if (got.length === 0) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({
      error: "Could not load prices for any stock.",
      detail: errSamples.join(" | ") || "no responses",
      hint: "The price source may be rate-limiting this server. Try again in a minute.",
    });
  }

  // Live session date = the most common last-trade date across stocks.
  const tally = new Map();
  for (const { p } of got) tally.set(p.liveISO, (tally.get(p.liveISO) || 0) + 1);
  const liveISO = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const now = istParts();
  const frac = liveISO === now.iso ? sessionFraction(now) : 1;
  const share = expectedVolumeShare(frac);

  let newestTs = 0;
  let stale = 0;
  let tooFew = 0;
  let analysed = 0;
  const sides = side === "both" ? ["long", "short"] : [side];
  const results = [];

  for (const { sym, p } of got) {
    if (p.liveISO !== liveISO) {
      stale++;
      continue;
    }
    const stats = sessionStats(p.bars, liveISO);
    if (!stats || !(stats.prevClose > 0)) {
      tooFew++;
      continue;
    }
    const series = liveSeries(p, cfg, liveISO);
    if (!series) {
      stale++;
      continue;
    }
    const bars = series.slice(-KEEP_BARS);
    if (bars.length < MIN_BARS) {
      tooFew++;
      continue;
    }
    const m = p.meta;
    const ltp = m.regularMarketPrice;
    if (!(ltp >= MIN_PRICE) || stats.avgTurnover < MIN_TURNOVER_CR * 1e7) continue;
    newestTs = Math.max(newestTs, p.liveTs);
    analysed++;

    const ich = ichimoku(bars);
    const dayVol = fin(m.regularMarketVolume) != null ? m.regularMarketVolume : bars[bars.length - 1].vol;
    const rvol = !cfg.intraday && stats.avgVol > 0 ? dayVol / (stats.avgVol * share) : null;

    for (const sd of sides) {
      const sig = signal(bars, ich, sd, cfg);
      if (!sig) continue;
      const long = sd === "long";
      const edge = long ? sig.top : sig.bot;
      const distPct = (long ? (ltp - edge) / edge : (edge - ltp) / edge) * 100;
      const stop = refStopOf(sig, bars, ltp);
      const notes = [];
      if (sig.from) notes.push(`from ${sig.from}`);
      notes.push(`cloud ${(((sig.top - sig.bot) / ltp) * 100).toFixed(1)}% wide`);
      notes.push(`risk ${((Math.abs(ltp - stop) / ltp) * 100).toFixed(1)}%`);
      results.push({
        symbol: sym,
        industry: industryOf.get(sym) || "",
        side: sd,
        ltp,
        chgPct: ((ltp - stats.prevClose) / stats.prevClose) * 100,
        prevClose: stats.prevClose,
        top: sig.top,
        bot: sig.bot,
        level: edge,
        distPct,
        age: sig.age,
        from: sig.from,
        status: sig.age == null ? "NEAR" : sig.age === 0 ? (long ? "BREAKOUT" : "BREAKDOWN") : "RECENT",
        tk: sig.tk,
        kj: sig.kj,
        chikou: sig.chikou,
        future: sig.future,
        tenkan: sig.tenkan,
        kijun: sig.kijun,
        rvol,
        avgVol: cfg.intraday ? null : stats.avgVol,
        volume: cfg.intraday ? null : dayVol,
        score: scoreOf(sig, rvol, cfg),
        refStop: stop,
        notes: notes.join(", "),
      });
    }
  }

  results.sort((a, b) => b.score - a.score || (a.age == null ? 99 : a.age) - (b.age == null ? 99 : b.age));

  const warnings = [];
  if (failed > symbols.length * 0.3) {
    warnings.push(`Prices missing for ${failed} of ${symbols.length} stocks (source may be rate-limiting). Results may be incomplete.`);
  }
  if (partial) warnings.push("Stopped early to stay within the time limit; some stocks were not checked.");
  const lagMin = newestTs ? Math.round((Date.now() / 1000 - newestTs) / 60) : 0;
  if (frac < 1 && lagMin > 10) {
    warnings.push(`The newest price is ${lagMin} minutes old, so the data source may be delayed.`);
  }

  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
  return res.status(200).json({
    meta: {
      index,
      tf,
      tfLabel: cfg.label,
      unit: cfg.unit,
      intraday: cfg.intraday,
      nearPct: cfg.nearPct,
      maxAge: MAX_AGE,
      side,
      asOf: newestTs ? formatIST(newestTs) : null,
      marketOpen: frac < 1,
      sessionPct: Math.round(frac * 100),
      universe: analysed,
      universeSize: symbols.length,
      volShare: share,
      historyFailed: failed,
      staleSkipped: stale,
      tooFewBars: tooFew,
      source: "NSE index lists + Yahoo Finance prices",
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - t0,
    },
    warnings,
    results: results.slice(0, MAX_ROWS),
  });
}

module.exports = handler;
module.exports._internals = { ichimoku, signal, scoreOf, refStopOf, sessionStats, liveSeries, TF, FIRST_CLOUD, MIN_BARS };
````

## `api/indices.js`

````js
// api/indices.js - rule status for the NSE index-derivative underlyings (buy CE / buy PE only).
//   Underlyings : NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50 (Yahoo Finance index tickers)
//   Strategies  : ORB (breakout + retest tracks), Ichimoku + Fibonacci (intraday and Daily/4h swing),
//                 VWAP (reclaim, pullback; needs true VWAP), expiry-day max pain (needs an option chain).
// Rules live in lib/rules_*.js. This file fetches data, applies the India VIX filter and tags data quality.
// It evaluates the INDEX price only. No option premium, bid/ask or open interest comes from Yahoo.
// Screening aid only, not trading advice, and none of this is proof of an edge.

const { yahooChart, mapPool, istParts, sessionFraction, formatIST, indiaVix, vixState } = require("../lib/common");
const core = require("../lib/rules_core");
const { evalOrb, orbSide } = require("../lib/rules_orb");
const { evalIchi, evalIchiSwing, to4h } = require("../lib/rules_ichi");
const { evalVwap } = require("../lib/rules_vwap");
const { evalMaxPain, maxPain } = require("../lib/rules_maxpain");
const broker = require("../lib/broker");

const { INDICES, P, STRATS, closedOnly, pivots, neg, isExpiryDay, res, hasVolOf } = core;

// Index charts often carry no volume, so unlike lib/common.parseChart this keeps bars with missing volume.
function parseIdx(r) {
  const m = r.meta || {};
  const off = Number.isFinite(m.gmtoffset) ? m.gmtoffset : 19800;
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const hi = q.high && q.high[i];
    const lo = q.low && q.low[i];
    const cl = q.close && q.close[i];
    if (![hi, lo, cl].every(Number.isFinite)) continue;
    const op = q.open && q.open[i];
    const v = q.volume && q.volume[i];
    const lt = ts[i] + off;
    bars.push({
      t: ts[i],
      d: new Date(lt * 1000).toISOString().slice(0, 10),
      mm: Math.floor((lt % 86400) / 60),
      o: Number.isFinite(op) ? op : cl,
      hi,
      lo,
      cl,
      vol: Number.isFinite(v) ? v : 0,
    });
  }
  return { bars, meta: m };
}

const IV_BLOCK_NOTE = "IV elevated (VIX above 60th percentile); buying premium is unfavourable";

// --------------------------------------------------------------------------
// Per-index analysis (pure: no network, easy to test)
//   ctx: { nowSec, todayISO, marketOpen, expiry:{KEY:bool}, vix?:vixState, chain?, skipSwing?, skipMaxPain? }
// --------------------------------------------------------------------------
function analyse(ix, data, ctx) {
  const base = { index: ix.key, name: ix.name, step: ix.step, expiry: !!ctx.expiry[ix.key] };
  if (!data || !data.p5 || !data.p5.bars.length) {
    const ids = ["orb_break", "orb_retest", "ichi", "ichi_swing", "vwap_reclaim", "vwap_pullback"];
    return { ...base, ltp: null, chgPct: null, rows: ids.map((s) => res(s, "NO DATA", "NO DATA", { note: "No price data from the source for this index." })) };
  }
  const all5 = data.p5.bars;
  const liveISO = all5[all5.length - 1].d;
  const c5 = closedOnly(all5, 300, ctx.nowSec);
  const c15 = data.p15 ? closedOnly(data.p15.bars, 900, ctx.nowSec) : [];
  const c1h = data.p1h ? closedOnly(data.p1h.bars, 3600, ctx.nowSec) : [];
  const cD = data.pD ? closedOnly(data.pD.bars, 86400, ctx.nowSec) : [];
  const c4h = data.p1h ? closedOnly(to4h(data.p1h.bars), 14400, ctx.nowSec) : [];
  const m = data.p5.meta || {};
  const lastClose = all5[all5.length - 1].cl;
  const price = Number.isFinite(m.regularMarketPrice) ? m.regularMarketPrice : lastClose;
  const prevDay = [...all5].reverse().find((b) => b.d < liveISO);
  const prevClose = prevDay ? prevDay.cl : m.chartPreviousClose;
  const live = ctx.todayISO === liveISO && ctx.marketOpen;
  const hasVol = hasVolOf(c5.filter((b) => b.d === liveISO));
  const c = { ...ctx, liveISO, live, hasVol };
  const atm = Math.round(price / ix.step) * ix.step;

  const rows = [...evalOrb(ix, c5, price, c), evalIchi(ix, c1h, c15, c5, price, c)];
  if (!ctx.skipSwing) rows.push(evalIchiSwing(ix, cD, c4h, price, c));
  rows.push(...evalVwap(ix, c5, price, c));
  if (!ctx.skipMaxPain) {
    const mp = evalMaxPain(ix, c5, price, c);
    if (mp) rows.push(mp);
  }

  const vs = ctx.vix || null;
  for (const r of rows) {
    // India VIX filter: a hard block on every BUY. If the VIX could not be fetched the filter is skipped, visibly.
    if (/^BUY/.test(r.action) && vs && vs.ok && vs.blocked) {
      r.wouldBe = r.action;
      r.action = "WAIT";
      r.blockedBy = "vix";
      r.note = IV_BLOCK_NOTE;
    }
    if (vs && vs.ok) {
      r.checks = r.checks.concat([{ ok: !vs.blocked, info: !vs.blocked ? true : false, text: `India VIX ${vs.value.toFixed(2)} vs its 60th percentile ${vs.p60.toFixed(2)} over the last ${vs.n} sessions` }]);
    } else {
      r.checks = r.checks.concat([{ ok: true, info: true, text: `VIX filter skipped (${(vs && vs.note) || "India VIX unavailable"})` }]);
    }
    if (r.side) r.option = r.side === "long" ? `${atm} CE (1 ITM ${atm - ix.step})` : `${atm} PE (1 ITM ${atm + ix.step})`;
    if (!live && /^BUY|^WAIT$/.test(r.action)) {
      r.action = "CLOSED";
      r.note = "Market is closed; this is the state at the last session's end. " + r.note;
    }
    // Data-quality tags, shown on every row.
    const tags = [];
    if (r.group === "vwap") tags.push(hasVol ? "true VWAP" : "proxy");
    if (!hasVol && r.group !== "expiry") tags.push("no volume");
    tags.push(vs && vs.ok ? (vs.blocked ? "VIX blocked" : "VIX ok") : "VIX n/a");
    if (r.group === "expiry") tags.push(ctx.chain ? "chain ok" : "no chain");
    r.tags = tags;
  }
  return {
    ...base,
    ltp: price,
    chgPct: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null,
    atm,
    liveISO,
    asOfTs: m.regularMarketTime || null,
    hasVolume: hasVol,
    rows,
  };
}

async function fetchIndex(ix, i) {
  let err = null;
  for (const sym of ix.yahoo) {
    try {
      const [r5, r15, r1h, rD] = await Promise.allSettled([
        yahooChart(sym, i, "5d", "5m"),
        yahooChart(sym, i + 1, "1mo", "15m"),
        yahooChart(sym, i, "3mo", "60m"),
        yahooChart(sym, i + 1, "1y", "1d"),
      ]);
      if (r5.status !== "fulfilled") throw r5.reason;
      return {
        sym,
        p5: parseIdx(r5.value),
        p15: r15.status === "fulfilled" ? parseIdx(r15.value) : null,
        p1h: r1h.status === "fulfilled" ? parseIdx(r1h.value) : null,
        pD: rD.status === "fulfilled" ? parseIdx(rD.value) : null,
      };
    } catch (e) {
      err = e;
    }
  }
  return { error: String((err && err.message) || err) };
}

async function handler(req, res) {
  const t0 = Date.now();
  const now = istParts();
  const nowSec = Math.floor(Date.now() / 1000);
  const marketOpen = sessionFraction(now) < 1;
  const expiry = {};
  for (const ix of INDICES) expiry[ix.key] = isExpiryDay(ix, now.iso);

  // India VIX once per run (cached for an hour), then each index.
  const vix = await indiaVix();
  const vs = vixState(vix, now.iso, true);
  const chains = {};
  if (broker.configured()) {
    await Promise.all(
      INDICES.filter((ix) => /^(NIFTY|BANKNIFTY)$/.test(ix.key) && expiry[ix.key]).map(async (ix) => {
        try {
          chains[ix.key] = await broker.fetchOptionChain(ix.key, now.iso);
        } catch (e) {
          chains[ix.key] = null;
        }
      })
    );
  }
  const ctx = { nowSec, todayISO: now.iso, marketOpen, expiry, vix: vs };

  const got = await mapPool(INDICES, 5, (ix, i) => fetchIndex(ix, i));
  const failed = [];
  let newest = 0;
  const indices = INDICES.map((ix, i) => {
    const d = got[i];
    if (!d || d.error) failed.push(`${ix.key}: ${d ? d.error.slice(0, 60) : "no response"}`);
    const a = analyse(ix, d && !d.error ? d : null, { ...ctx, chain: chains[ix.key] || null });
    if (a.asOfTs) newest = Math.max(newest, a.asOfTs);
    return a;
  });

  if (failed.length === INDICES.length) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({
      error: "Could not load prices for any index.",
      detail: failed.slice(0, 3).join(" | "),
      hint: "The price source may be rate-limiting this server. Try again in a minute.",
    });
  }
  const warnings = [];
  if (failed.length) warnings.push(`No data for ${failed.length} index(es): ${failed.map((x) => x.split(":")[0]).join(", ")}.`);
  const lagMin = newest ? Math.round((Date.now() / 1000 - newest) / 60) : 0;
  if (marketOpen && lagMin > 10) warnings.push(`The newest price is ${lagMin} minutes old, so the data source may be delayed.`);
  if (!vs.ok) warnings.push(`India VIX filter skipped: ${vs.note}.`);

  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
  return res.status(200).json({
    meta: {
      marketOpen,
      asOf: newest ? formatIST(newest) : null,
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - t0,
      source: "Yahoo Finance index prices",
      vix: vs.ok ? { value: vs.value, p60: vs.p60, blocked: vs.blocked, sessions: vs.n } : { unavailable: vs.note },
      brokerConfigured: broker.configured(),
      strategies: STRATS,
    },
    warnings,
    indices,
  });
}

module.exports = handler;
module.exports._internals = {
  INDICES,
  P,
  STRATS,
  parseIdx,
  closedOnly,
  pivots,
  orbSide,
  evalOrb,
  evalIchi,
  evalIchiSwing,
  evalVwap,
  evalMaxPain,
  maxPain,
  analyse,
  isExpiryDay,
  neg,
  to4h,
  IV_BLOCK_NOTE,
};
````

## `api/indexchart.js`

````js
// api/indexchart.js - 5-minute candles for one index and one session, with the rule levels drawn on the chart:
// opening range, session average price (VWAP when the feed has volume), previous close, and the signals the
// rules would have given during that session (replayed on finished candles only), with how each one played out.
// Strategy ids: orb_break, orb_retest, ichi, vwap_reclaim, vwap_pullback (ichi_swing and expiry_maxpain are not replayed).

const { istParts, sessionFraction, formatIST, indiaVix, vixState } = require("../lib/common");
const { _internals: I } = require("./indices");
const { fetchData, replayDay, sessionDates } = require("../lib/replay");

const { INDICES, P } = I;

module.exports = async function handler(req, res) {
  const key = String((req.query && req.query.index) || "NIFTY").toUpperCase();
  const ix = INDICES.find((x) => x.key === key);
  if (!ix) return res.status(400).json({ error: "Unknown index.", hint: INDICES.map((x) => x.key).join(", ") });

  const now = istParts();
  const nowSec = Math.floor(Date.now() / 1000);
  const marketOpen = sessionFraction(now) < 1;
  const [data, vixRaw] = await Promise.all([fetchData(ix, INDICES.indexOf(ix), false), indiaVix()]);
  if (data.error || !data.p5.bars.length) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Could not load prices for " + ix.name + ".", detail: String(data.error || "no bars").slice(0, 80) });
  }

  const b5 = data.p5.bars;
  const dates = sessionDates(b5);
  const want = String((req.query && req.query.date) || "");
  const date = dates.includes(want) ? want : dates[dates.length - 1];
  const day = b5.filter((b) => b.d === date);
  const isToday = date === dates[dates.length - 1] && date === now.iso && marketOpen;

  const hasVol = day.some((b) => b.vol > 0);
  let sv = 0;
  let sp = 0;
  const vwap = day.map((b, k) => {
    const tp = (b.hi + b.lo + b.cl) / 3;
    if (hasVol) {
      sp += tp * b.vol;
      sv += b.vol;
      return sv > 0 ? sp / sv : tp;
    }
    sp += tp;
    return sp / (k + 1);
  });

  const orBars = day.filter((b) => b.mm >= P.orStart && b.mm < P.orEnd);
  const orb = orBars.length === 3 ? { hi: Math.max(...orBars.map((b) => b.hi)), lo: Math.min(...orBars.map((b) => b.lo)) } : null;
  const prev = [...b5].reverse().find((b) => b.d < date);

  // India VIX as known at the start of that session (previous close vs the 60 sessions before it).
  const vs = vixState(vixRaw, date, false);
  const rep = replayDay(ix, data, date, isToday ? nowSec : null, { vix: vs.ok ? vs : null });

  res.setHeader("Cache-Control", isToday ? "public, s-maxage=20, stale-while-revalidate=40" : "public, s-maxage=300");
  return res.status(200).json({
    index: ix.key,
    name: ix.name,
    date,
    dates: dates.slice(-5).reverse(),
    live: isToday,
    nowSec,
    asOf: formatIST(day[day.length - 1].t),
    vwapLabel: hasVol ? "VWAP" : "Session average price",
    vwapIsProxy: !hasVol,
    prevClose: prev ? prev.cl : null,
    expiry: !!rep.expiry,
    orb,
    bars: day.map((b) => ({ t: b.t, mm: b.mm, o: b.o, hi: b.hi, lo: b.lo, cl: b.cl })),
    vwap,
    signals: rep.signals,
    blocked: rep.blocked || [],
    vix: vs.ok ? { value: vs.value, p60: vs.p60, blocked: vs.blocked } : { unavailable: vs.note },
    hasVolume: hasVol,
  });
};
````

## `api/backtest.js`

````js
// api/backtest.js - replays the rulebooks over the recent past for ONE index (?index=NIFTY).
// Yahoo only serves about 60 calendar days of 5m / 15m data, so this covers roughly 40 sessions. That is a
// small sample: it can show whether the rules behave sensibly, it cannot prove an edge. With a broker adapter
// (lib/broker.js) it asks for up to 2 years instead.
//
// Honest limits, stated here and on the page:
//   * "Index R" is measured on the index price. It has no spread, theta, slippage or costs.
//   * "Option P&L" is a BLACK-SCHOLES APPROXIMATION (India VIX as ATM IV, +2 vol points for 1-ITM, flat smile).
//     It is not real premium data. Expiry-week gamma and IV behaviour are not modelled; no assignment / pin risk.
//   * The India VIX filter uses the previous session's close vs the 60 sessions before it (no look-ahead).
//   * ichi_swing (Daily/4h) and expiry_maxpain (needs option-chain OI) are NOT backtested.
// Returns the trade list; the page computes the statistics from it.

const { _internals: I } = require("./indices");
const { fetchData, replayDay, sessionDates } = require("../lib/replay");
const { indiaVix, vixState } = require("../lib/common");
const { simOption, BS } = require("../lib/bs");
const broker = require("../lib/broker");

const { INDICES, P, STRATS } = I;
const NOT_BACKTESTED = ["ichi_swing", "expiry_maxpain"];

// Option P&L for one trade, for both plans (T1 / T2) and both strikes (ATM / 1-ITM), each with and without IV change.
// r values are multiplied by the size scale (half size counts half); pct is the premium change and is not scaled.
function optionPnl(ix, t, vixLevel) {
  if (!(vixLevel > 0)) return null;
  const out = {};
  for (const plan of ["x1", "x2"]) {
    const x = t[plan];
    if (!x || x.exitMM == null) {
      out[plan] = null;
      continue;
    }
    out[plan] = {};
    for (const [name, itm] of [["atm", false], ["itm", true]]) {
      const s = simOption({ side: t.side, date: t.date, entryMM: t.entryMM, entry: t.entry, sl: t.sl, exitMM: x.exitMM, exitPrice: x.exitPrice }, { ix, vix: vixLevel, itm });
      out[plan][name] = s
        ? {
            strike: s.strike,
            expiry: s.expiry,
            P0: round(s.P0, 2),
            riskFrac: round(s.riskFrac, 4),
            delta: round(s.delta, 3),
            noIv: { pct: round(s.noIv.pct, 2), r: round(s.noIv.r * t.scale, 3) },
            crush: { pct: round(s.crush.pct, 2), r: round(s.crush.r * t.scale, 3) },
          }
        : null;
    }
  }
  return out;
}
const round = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

// Optional: real historical option premiums from the broker adapter. Used for the premium % change only; the premium
// RISK (stop level) still comes from Black-Scholes because a premium history has no "stop-level" price.
async function brokerPremiums(ix, trades) {
  if (!broker.configured()) return { used: false };
  let used = 0;
  for (const t of trades) {
    if (!t.opt) continue;
    for (const plan of ["x1", "x2"]) {
      const x = t[plan];
      for (const name of ["atm", "itm"]) {
        const o = t.opt[plan] && t.opt[plan][name];
        if (!o || x.exitMM == null) continue;
        try {
          const day0 = Date.parse(t.date + "T00:00:00Z") / 1000 - 19800;
          const bars = await broker.fetchOptionPremium(ix.key, o.expiry, o.strike, t.side === "long" ? "CE" : "PE", day0 + t.entryMM * 60, day0 + x.exitMM * 60, "5m");
          if (bars && bars.length >= 2) {
            const p0 = bars[0].o != null ? bars[0].o : bars[0].cl;
            const p1 = bars[bars.length - 1].cl;
            if (p0 > 0 && p1 >= 0) {
              o.real = { pct: round(((p1 - p0) / p0) * 100, 2), r: round(((p1 - p0) / p0 / o.riskFrac) * t.scale, 3), P0: round(p0, 2) };
              used++;
            }
          }
        } catch (e) {
          // no premium for this contract: the Black-Scholes number stays
        }
      }
    }
  }
  return { used: used > 0, contracts: used };
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const key = String((req.query && req.query.index) || "NIFTY").toUpperCase();
  const ix = INDICES.find((x) => x.key === key);
  if (!ix) return res.status(400).json({ error: "Unknown index.", hint: INDICES.map((x) => x.key).join(", ") });

  const [data, vix] = await Promise.all([fetchData(ix, INDICES.indexOf(ix), true), indiaVix()]);
  if (data.error || !data.p5.bars.length) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Could not load history for " + ix.name + ".", detail: String(data.error || "no bars").slice(0, 80) });
  }

  const b5 = data.p5.bars;
  const dates = sessionDates(b5);
  // Only finished sessions: the last session counts only if its final candle (15:25) is there.
  const lastBars = b5.filter((b) => b.d === dates[dates.length - 1]);
  const lastDone = lastBars[lastBars.length - 1].mm >= 920;
  const usable = lastDone ? dates : dates.slice(0, -1);
  const skipHead = 2; // the opening-range check needs a couple of earlier sessions for its typical width

  const trades = [];
  const blocked = [];
  const notes = { sessions: 0, expiryDays: 0, tooFew: 0, vixUnknown: 0 };
  for (let d = skipHead; d < usable.length; d++) {
    const iso = usable[d];
    const n = b5.reduce((c, b) => c + (b.d === iso ? 1 : 0), 0);
    if (n < 60) {
      notes.tooFew++; // a half day or a data gap
      continue;
    }
    const vs = vixState(vix, iso, false);
    if (!vs.ok) notes.vixUnknown++;
    const rep = replayDay(ix, data, iso, null, { vix: vs.ok ? vs : null });
    notes.sessions++;
    if (rep.expiry) notes.expiryDays++;
    for (const s of rep.signals) {
      if (!s.valid) continue;
      s.opt = optionPnl(ix, s, s.vixValue);
      trades.push(s);
    }
    blocked.push(...rep.blocked);
    if (Date.now() - t0 > 50000) {
      notes.truncated = true;
      break;
    }
  }
  const prem = await brokerPremiums(ix, trades);

  const counts = {};
  for (const b of blocked) {
    const k = b.strategy;
    counts[k] = counts[k] || { vix: 0, size: 0 };
    counts[k][b.by] = (counts[k][b.by] || 0) + 1;
  }

  res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=1800");
  return res.status(200).json({
    index: ix.key,
    name: ix.name,
    step: ix.step,
    from: usable[skipHead] || null,
    to: usable[usable.length - 1] || null,
    sessions: notes.sessions,
    expiryDays: notes.expiryDays,
    skippedShort: notes.tooFew,
    truncated: !!notes.truncated,
    volumeInFeed: b5.some((b) => b.vol > 0),
    source: data.source || "yahoo",
    tookMs: Date.now() - t0,
    vix: { available: !!vix, sessionsWithoutVix: notes.vixUnknown, rule: `skip the day when India VIX (previous close) is above its ${P.vixPctlBlock}th percentile of the ${P.vixWindow} sessions before it` },
    option: {
      model: "Black-Scholes approximation",
      rate: BS.r,
      ivSource: "India VIX (previous close) as ATM IV, +2 vol points for the 1-ITM strike",
      crushScenario: "exit IV = 90% of entry IV",
      premiumSource: prem.used ? `broker premiums for ${prem.contracts} contracts, Black-Scholes for the rest` : broker.configured() ? "Black-Scholes only (the broker adapter returned no premiums)" : "Black-Scholes only (no broker adapter)",
      notModelled: "bid/ask spread, skew, IV change during the trade (except the crush scenario), assignment, pin risk, expiry-week gamma",
    },
    blocked: counts,
    blockedTotal: blocked.length,
    blockedList: blocked,
    notBacktested: NOT_BACKTESTED.map((id) => ({ strategy: id, label: STRATS[id].label, why: id === "expiry_maxpain" ? "needs option-chain open interest (no data source)" : "needs Daily/4h history beyond what the intraday replay holds" })),
    strategies: Object.fromEntries(Object.entries(STRATS).filter(([id]) => !NOT_BACKTESTED.includes(id) && id !== "vwap_info")),
    params: {
      maxRiskPct: P.maxRiskPct,
      orbCutoff: "14:00",
      vwapCutoff: "14:30",
      ichiWindow: "10:00 to 14:30",
      maxAge: P.maxAge,
      orbBreakTargets: "2R / 3R",
      orbRetestTargets: "1R / 2R",
      reclaimTargets: "2R / 3R",
      orbVolMult: P.orbVolMult,
      sizeRule: "full 0.5x to 2x typical range, half 2x to 3x, skip beyond",
    },
    trades,
  });
};
module.exports._optionPnl = optionPnl;
````

## `public/app.css`

````css
/* shared styles for the scanner pages */
  :root {
    --bg: #060b18; --card: #0e1628; --line: #1b2742; --text: #e6ecff; --muted: #8a97b8;
    --green: #22c55e; --red: #ef4444; --amber: #f59e0b; --blue: #3b82f6;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .page { max-width: 1180px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 20px; margin: 4px 0 2px; letter-spacing: .2px; }
  .sub { color: var(--muted); font-size: 13px; margin: 0 0 14px; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
  select, button {
    background: var(--card); color: var(--text); border: 1px solid var(--line);
    border-radius: 10px; padding: 9px 12px; font: inherit; min-height: 40px;
  }
  select[hidden] { display: none; }
  button { cursor: pointer; }
  button.primary { background: var(--blue); border-color: var(--blue); font-weight: 600; }
  button:disabled { opacity: .55; cursor: default; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .seg button { border: 0; border-radius: 0; background: var(--card); }
  .seg button.on { background: #1d2c52; color: #fff; font-weight: 600; }
  label.chk { color: var(--text); font-size: 14px; display: inline-flex; gap: 6px; align-items: center; min-height: 40px; }
  .status { color: var(--muted); font-size: 13px; margin: 6px 0 2px; min-height: 20px; }
  .status b { color: var(--text); font-weight: 600; }
  .liveinfo { color: var(--muted); font-size: 13px; margin: 0 0 10px; min-height: 20px; }
  .liveinfo .dot { color: var(--green); margin-right: 4px; animation: blink 1.6s ease-in-out infinite; }
  .liveinfo.stale .dot { color: var(--amber); animation: none; }
  .liveinfo.off .dot { color: var(--muted); animation: none; }
  @keyframes blink { 50% { opacity: .35; } }
  .banner { border-radius: 10px; padding: 10px 12px; margin: 8px 0; font-size: 14px; display: none; }
  .banner.err { background: #2a1114; border: 1px solid #5b1d24; color: #ffb4b4; display: block; }
  .banner.warn { background: #2a2110; border: 1px solid #5b4516; color: #ffd98a; display: block; }
  .wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
  table { border-collapse: collapse; width: 100%; min-width: 900px; }
  th, td { padding: 10px 12px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; position: sticky; top: 0; background: var(--card); }
  th:first-child, td:first-child { text-align: left; position: sticky; left: 0; background: var(--card); z-index: 1; }
  th.l, td.l { text-align: left; }
  tr:last-child td { border-bottom: 0; }
  td.num { font-variant-numeric: tabular-nums; }
  td.sector { text-align: left; color: var(--muted); font-size: 12.5px; }
  .sym { font-weight: 650; }
  .sym a { color: var(--blue); font-weight: 500; font-size: 12px; margin-left: 6px; text-decoration: none; }
  .subsec { display: none; font-size: 11.5px; color: var(--muted); font-weight: 400; margin-top: 1px; }
  .new { margin-left: 6px; font-size: 10px; font-weight: 700; color: #04210f; background: var(--green); border-radius: 4px; padding: 1px 5px; vertical-align: 1px; }
  .up { color: var(--green); } .down { color: var(--red); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .b-brk { background: rgba(34,197,94,.15); color: var(--green); }
  .b-bdn { background: rgba(239,68,68,.15); color: var(--red); }
  .b-near { background: rgba(245,158,11,.15); color: var(--amber); }
  .b-fade { background: rgba(138,151,184,.15); color: var(--muted); }
  .score { display: inline-flex; align-items: center; gap: 8px; justify-content: flex-end; }
  .bar { width: 46px; height: 6px; border-radius: 3px; background: #1a2440; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--blue); }
  td.notes { text-align: left; color: var(--muted); font-size: 13px; }
  .empty { padding: 28px 16px; text-align: center; color: var(--muted); }
  .legend { color: var(--muted); font-size: 12.5px; margin-top: 12px; line-height: 1.6; }
  .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--line); border-top-color: var(--blue);
    border-radius: 50%; animation: s .8s linear infinite; vertical-align: -2px; margin-right: 6px; }
  @keyframes s { to { transform: rotate(360deg); } }
  @keyframes fup { from { background: rgba(34,197,94,.45); } to { background: transparent; } }
  @keyframes fdn { from { background: rgba(239,68,68,.45); } to { background: transparent; } }
  td.flash-up { animation: fup .9s ease-out; }
  td.flash-dn { animation: fdn .9s ease-out; }
  @media (max-width: 700px) {
    .hide-sm { display: none; }
    .subsec { display: block; }
    table { min-width: 0; }
    th, td { padding: 9px 8px; }
  }
  @media (prefers-reduced-motion: reduce) {
    td.flash-up, td.flash-dn, .liveinfo .dot, .spin { animation: none; }
  }
  .tabs { display: flex; gap: 6px; margin: 0 0 10px; }
  .tabs a { color: var(--muted); text-decoration: none; font-size: 14px; font-weight: 600; padding: 8px 14px;
    border: 1px solid var(--line); border-radius: 999px; background: var(--card); }
  .tabs a[aria-current="page"] { color: #fff; background: #1d2c52; border-color: #2a3d6e; }

````

## `public/index.html`

````html
<!doctype html>
<html lang="en">
<head>
<link rel="icon" href="data:,">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#060b18">
<title>Breakout Scanner</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div class="page">
  <nav class="tabs" aria-label="Scanners">
    <a href="/" aria-current="page">Breakouts</a>
    <a href="/ichimoku.html">Ichimoku Cloud</a>
    <a href="/indices.html">Index Options</a>
    <a href="/journal.html">Journal</a>
  </nav>
  <h1>Breakout Scanner</h1>
  <p class="sub">NSE stocks breaking their 20-day high or low, with volume confirmation.</p>

  <div class="controls">
    <select id="index" aria-label="Stock universe">
      <option>NIFTY 500</option>
      <option>NIFTY 200</option>
      <option>NIFTY 100</option>
      <option>NIFTY NEXT 50</option>
      <option>NIFTY MIDCAP 100</option>
      <option>NIFTY SMALLCAP 100</option>
      <option value="SECURITIES IN F&amp;O">F&amp;O stocks</option>
    </select>
    <div class="seg" id="side" role="group" aria-label="Direction">
      <button data-v="long" class="on">Long</button>
      <button data-v="short">Short</button>
      <button data-v="both">Both</button>
    </div>
    <select id="rvol" aria-label="Minimum relative volume">
      <option value="1">Vol ≥ 1.0x</option>
      <option value="1.2" selected>Vol ≥ 1.2x</option>
      <option value="1.5">Vol ≥ 1.5x</option>
      <option value="2">Vol ≥ 2.0x</option>
    </select>
    <select id="sector" aria-label="Sector filter" hidden>
      <option value="">All sectors</option>
    </select>
    <button class="primary" id="scan">Scan</button>
    <label class="chk"><input type="checkbox" id="live" checked> Live prices</label>
  </div>

  <div class="status" id="status"></div>
  <div class="liveinfo" id="liveinfo"></div>
  <div class="banner" id="banner"></div>

  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th>Symbol</th><th class="l hide-sm">Sector</th><th class="hide-sm">Side</th><th>LTP</th><th>Chg %</th><th>Level</th><th>Dist %</th>
          <th>Rel vol</th><th>Range pos</th><th>Score</th><th>Status</th><th>Ref stop</th><th class="l hide-sm">Notes</th>
        </tr>
      </thead>
      <tbody id="rows"><tr><td colspan="13" class="empty">Press Scan to load stocks.</td></tr></tbody>
    </table>
  </div>

  <div class="legend">
    <b>Live prices</b> refresh every 10 seconds while the market is open: LTP, Chg %, Dist %, Rel vol, Range pos, Status and Ref stop update in place.
    The list of stocks and the Score are refreshed by a full scan every 3 minutes, and new entries are tagged NEW.
    <b>Level</b>: 20-day high (long) or low (short). <b>Dist %</b>: how far price is beyond it (negative = still below).
    <b>Status</b>: BREAKOUT/BREAKDOWN past the level, NEAR within 0.5% of it, FADED if it has dropped back more than 0.5% under it.
    <b>Rel vol</b>: today's volume vs the 20-day average, projected to a full day (rough during market hours).
    <b>Range pos</b>: 1.00 means price is at the day's extreme. <b>Ref stop</b>: today's low (long) or high (short), a reference only.
    Stock lists come from NSE; prices come from Yahoo Finance, polled rather than streamed, and may lag NSE. The "last tick" time shows how fresh the newest price is.
    This is a screening aid, not trading advice.
  </div>
</div>

<script>
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var POLL_MS = 10000;     // live price refresh
  var RESCAN_MS = 180000;  // full re-scan while live
  var state = {
    side: "long", busy: false, live: true, sector: "",
    rows: [], meta: null, share: 1, els: {},
    lastScanAt: 0, pollTimer: null, failures: 0, lastTick: 0, serverTime: 0
  };

  try {
    var saved = JSON.parse(localStorage.getItem("bs-prefs") || "{}");
    if (saved.index) $("index").value = saved.index;
    if (saved.rvol) $("rvol").value = saved.rvol;
    if (saved.side) state.side = saved.side;
    if (typeof saved.live === "boolean") state.live = saved.live;
  } catch (e) {}
  $("live").checked = state.live;

  // ---------- helpers ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function f(v, d) { return Number.isFinite(v) ? v.toFixed(d) : "–"; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function clock(ts) {
    return new Date(ts).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false });
  }
  function key(r) { return r.symbol + "|" + r.side; }
  function setText(node, v) {
    if (node.textContent === v) return false;
    node.textContent = v;
    return true;
  }
  function flash(node, dir) {
    node.classList.remove("flash-up", "flash-dn");
    void node.offsetWidth; // restart the animation
    node.classList.add(dir > 0 ? "flash-up" : "flash-dn");
  }
  function showBanner(kind, msg) { var b = $("banner"); b.className = "banner " + kind; b.textContent = msg; }
  function clearBanner() { var b = $("banner"); b.className = "banner"; b.textContent = ""; }

  // ---------- live values derived from the latest price ----------
  function derive(r) {
    var isLong = r.side === "long";
    var rng = r.dayHigh - r.dayLow;
    var dist = isLong ? (r.ltp - r.level) / r.level * 100 : (r.level - r.ltp) / r.level * 100;
    return {
      chg: (r.ltp - r.prevClose) / r.prevClose * 100,
      dist: dist,
      pos: rng > 0 ? (isLong ? (r.ltp - r.dayLow) / rng : (r.dayHigh - r.ltp) / rng) : 0.5,
      rvol: r.avgVol > 0 ? r.volume / (r.avgVol * state.share) : 0,
      stop: isLong ? r.dayLow : r.dayHigh,
      status: dist > 0 ? (isLong ? "BREAKOUT" : "BREAKDOWN") : dist >= -0.5 ? "NEAR" : "FADED"
    };
  }
  function badgeClass(s) {
    return s === "BREAKOUT" ? "b-brk" : s === "BREAKDOWN" ? "b-bdn" : s === "NEAR" ? "b-near" : "b-fade";
  }

  // ---------- table ----------
  function visibleRows() {
    return state.rows.filter(function (r) { return !state.sector || r.industry === state.sector; });
  }

  function paintRow(r, doFlash) {
    var e = state.els[key(r)];
    if (!e) return;
    var d = derive(r);
    if (setText(e.ltp, f(r.ltp, 2)) && doFlash && r._prev != null && r.ltp !== r._prev) {
      flash(e.ltp, r.ltp > r._prev ? 1 : -1);
    }
    r._prev = r.ltp;
    e.chg.className = "num " + (d.chg >= 0 ? "up" : "down");
    setText(e.chg, (d.chg >= 0 ? "+" : "") + f(d.chg, 2));
    setText(e.dist, (d.dist >= 0 ? "+" : "") + f(d.dist, 2));
    setText(e.rvol, f(d.rvol, 1) + "x");
    setText(e.pos, f(d.pos, 2));
    setText(e.stop, f(d.stop, 2));
    if (setText(e.badge, d.status)) {
      e.badge.className = "badge " + badgeClass(d.status);
      if (doFlash) flash(e.badgeCell, d.status === "FADED" || d.status === "NEAR" ? -1 : 1);
    }
  }

  function buildRow(r, isNew) {
    var tr = el("tr");
    var c0 = el("td", "sym", r.symbol);
    var a = el("a", null, "chart ↗");
    a.href = "https://www.tradingview.com/chart/?symbol=NSE%3A" + encodeURIComponent(r.symbol.replace(/[&-]/g, "_"));
    a.target = "_blank"; a.rel = "noopener noreferrer";
    c0.appendChild(a);
    if (isNew) c0.appendChild(el("span", "new", "NEW"));
    c0.appendChild(el("div", "subsec", (r.side === "long" ? "LONG" : "SHORT") + (r.industry ? " · " + r.industry : "")));
    tr.appendChild(c0);

    tr.appendChild(el("td", "sector hide-sm", r.industry || ""));
    tr.appendChild(el("td", "hide-sm " + (r.side === "long" ? "up" : "down"), r.side === "long" ? "LONG" : "SHORT"));

    var e = {
      ltp: el("td", "num"), chg: el("td", "num"), dist: el("td", "num"),
      rvol: el("td", "num"), pos: el("td", "num"), stop: el("td", "num"),
      badge: el("span", "badge"), badgeCell: el("td")
    };
    var level = el("td", "num", f(r.level, 2));
    tr.appendChild(e.ltp); tr.appendChild(e.chg); tr.appendChild(level); tr.appendChild(e.dist);
    tr.appendChild(e.rvol); tr.appendChild(e.pos);

    var sc = el("td"), box = el("span", "score");
    box.appendChild(el("span", "num", String(r.score)));
    var bar = el("span", "bar"), fill = el("i");
    fill.style.width = Math.min(100, r.score) + "%";
    bar.appendChild(fill); box.appendChild(bar); sc.appendChild(box);
    tr.appendChild(sc);

    e.badgeCell.appendChild(e.badge);
    tr.appendChild(e.badgeCell);
    tr.appendChild(e.stop);
    tr.appendChild(el("td", "notes hide-sm", r.notes || ""));

    state.els[key(r)] = e;
    paintRow(r, false);
    return tr;
  }

  function render(prevKeys) {
    var tb = $("rows");
    tb.textContent = "";
    state.els = {};
    var rows = visibleRows();
    if (!rows.length) {
      var tr = el("tr");
      var td = el("td", "empty", state.rows.length
        ? "No matches in this sector. Pick All sectors to see everything."
        : "No stocks meet the filters right now. Try a lower volume threshold, or scan again after 9:45 AM IST.");
      td.colSpan = 13; tr.appendChild(td); tb.appendChild(tr);
    } else {
      rows.forEach(function (r) { tb.appendChild(buildRow(r, !!prevKeys && !prevKeys[key(r)])); });
    }
    setScanStatus(rows.length);
  }

  function rebuildSectorOptions() {
    var sel = $("sector");
    var seen = {};
    state.rows.forEach(function (r) { if (r.industry) seen[r.industry] = 1; });
    var names = Object.keys(seen).sort();
    if (state.sector && !seen[state.sector]) state.sector = "";
    sel.textContent = "";
    var all = el("option", null, "All sectors"); all.value = ""; sel.appendChild(all);
    names.forEach(function (n) { var o = el("option", null, n); o.value = n; sel.appendChild(o); });
    sel.value = state.sector;
    sel.hidden = names.length === 0;
  }

  function setScanStatus(shown) {
    var m = state.meta;
    if (!m) return;
    var total = state.rows.length;
    var when = m.marketOpen ? "Market open (" + Number(m.sessionPct) + "% of session)" : "Market closed, showing last session";
    var count = state.sector && shown !== total ? shown + " of " + total : String(total);
    $("status").innerHTML = "<b>" + esc(count) + "</b> matches from " + Number(m.candidates) + " candidates in " +
      Number(m.universe) + " stocks · " + when + " · scanned at " + esc(m.asOf || "n/a");
  }

  // ---------- live prices ----------
  function applyQuotes(resp) {
    var q = resp.quotes || {};
    if (typeof resp.share === "number") state.share = resp.share;
    if (resp.serverTime) state.serverTime = resp.serverTime;
    state.rows.forEach(function (r) {
      var x = q[r.symbol];
      if (!x || !Number.isFinite(x.ltp)) return;
      r.ltp = x.ltp;
      r.dayHigh = Math.max(r.dayHigh, x.ltp, Number.isFinite(x.hi) ? x.hi : 0);
      r.dayLow = Math.min(r.dayLow, x.ltp, Number.isFinite(x.lo) ? x.lo : Infinity);
      if (Number.isFinite(x.vol)) r.volume = Math.max(r.volume, x.vol);
      if (Number.isFinite(x.t)) state.lastTick = Math.max(state.lastTick, x.t);
    });
    state.rows.forEach(function (r) { paintRow(r, true); });
  }

  function showLive() {
    var box = $("liveinfo");
    box.textContent = "";
    if (!state.live || !state.meta) { box.className = "liveinfo"; return; }
    var dot = el("span", "dot", "●");
    if (!state.meta.marketOpen) {
      box.className = "liveinfo off";
      box.appendChild(dot);
      box.appendChild(document.createTextNode("Market closed: prices are not updating."));
      return;
    }
    var age = state.serverTime && state.lastTick ? state.serverTime - state.lastTick : 0;
    var stale = state.failures > 0 || age > 120;
    box.className = "liveinfo" + (stale ? " stale" : "");
    box.appendChild(dot);
    var txt = state.failures > 0 ? "Live updates delayed, retrying" : "Live";
    if (state.lastTick) {
      txt += " · last tick " + clock(state.lastTick * 1000) + " IST";
      if (age > 120) txt += " (" + Math.round(age / 60) + " min old)";
    }
    txt += " · refreshed " + clock(Date.now());
    box.appendChild(document.createTextNode(txt));
  }

  function stopLive() { clearTimeout(state.pollTimer); state.pollTimer = null; }

  function startLive() {
    stopLive();
    showLive();
    if (state.live && !document.hidden && state.meta && state.meta.marketOpen && state.rows.length) {
      state.pollTimer = setTimeout(tick, 1500);
    }
  }

  async function tick() {
    state.pollTimer = null;
    if (!state.live || document.hidden || !state.meta || !state.meta.marketOpen || !state.rows.length) { showLive(); return; }
    if (Date.now() - state.lastScanAt > RESCAN_MS && !state.busy) { await scan(true); return; } // scan() restarts live mode
    var seen = {}, syms = [];
    state.rows.forEach(function (r) { if (!seen[r.symbol] && syms.length < 60) { seen[r.symbol] = 1; syms.push(r.symbol); } });
    try {
      var res = await fetch("/api/quotes?symbols=" + encodeURIComponent(syms.join(",")));
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
      state.failures = 0;
      applyQuotes(data);
      if (data.marketOpen === false) state.meta.marketOpen = false;
    } catch (e) {
      state.failures++;
    }
    showLive();
    if (state.live && !document.hidden && state.meta && state.meta.marketOpen) {
      state.pollTimer = setTimeout(tick, Math.min(60000, POLL_MS * (1 + state.failures)));
    }
  }

  // ---------- full scan ----------
  async function scan(silent) {
    if (state.busy) return;
    state.busy = true;
    if (silent) {
      state.lastScanAt = Date.now(); // avoid a retry storm if this scan fails
    } else {
      $("scan").disabled = true;
      clearBanner();
      $("status").innerHTML = '<span class="spin"></span>Scanning NSE stocks. This usually takes 5 to 20 seconds.';
    }
    try { localStorage.setItem("bs-prefs", JSON.stringify({ index: $("index").value, rvol: $("rvol").value, side: state.side, live: state.live })); } catch (e) {}
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, 75000);
    var ok = false;
    try {
      var url = "/api/scan?index=" + encodeURIComponent($("index").value) + "&side=" + state.side + "&minRvol=" + encodeURIComponent($("rvol").value);
      var res = await fetch(url, { signal: ctrl.signal });
      var data = await res.json();
      if (!res.ok) {
        if (!silent) {
          showBanner("err", (data.error || "Request failed") + (data.detail ? " [" + data.detail + "]" : "") + (data.hint ? " " + data.hint : ""));
          $("status").textContent = "";
        }
      } else {
        ok = true;
        var prevKeys = null;
        if (silent) { prevKeys = {}; state.rows.forEach(function (r) { prevKeys[key(r)] = 1; }); }
        state.meta = data.meta;
        state.share = typeof data.meta.volShare === "number" ? data.meta.volShare : 1;
        state.rows = data.results.map(function (r) { r._prev = r.ltp; return r; });
        state.lastScanAt = Date.now();
        state.failures = 0;
        rebuildSectorOptions();
        render(prevKeys);
        if (data.warnings && data.warnings.length) showBanner("warn", data.warnings.join(" ")); else clearBanner();
      }
    } catch (e) {
      if (!silent) {
        showBanner("err", e.name === "AbortError" ? "The scan took too long. Try again in a moment." : "Could not load results: " + e.message);
        $("status").textContent = "";
      }
    } finally {
      clearTimeout(to);
      state.busy = false;
      $("scan").disabled = false;
    }
    startLive();
    return ok;
  }

  // ---------- events ----------
  document.querySelectorAll("#side button").forEach(function (b) {
    b.classList.toggle("on", b.dataset.v === state.side);
    b.addEventListener("click", function () {
      state.side = b.dataset.v;
      document.querySelectorAll("#side button").forEach(function (x) { x.classList.toggle("on", x === b); });
      scan(false);
    });
  });
  $("index").addEventListener("change", function () { scan(false); });
  $("rvol").addEventListener("change", function () { scan(false); });
  $("scan").addEventListener("click", function () { scan(false); });
  $("sector").addEventListener("change", function () { state.sector = $("sector").value; render(null); });
  $("live").addEventListener("change", function () {
    state.live = $("live").checked;
    try { localStorage.setItem("bs-prefs", JSON.stringify({ index: $("index").value, rvol: $("rvol").value, side: state.side, live: state.live })); } catch (e) {}
    if (state.live) startLive(); else { stopLive(); showLive(); }
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopLive(); else startLive();
  });

  scan(false);
})();
</script>
</body>
</html>
````

## `public/ichimoku.html`

````html
<!doctype html>
<html lang="en">
<head>
<link rel="icon" href="data:,">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#060b18">
<title>Ichimoku Cloud Scanner</title>
<link rel="stylesheet" href="/app.css">
<style>
  .b-rec { background: rgba(59,130,246,.16); color: #7fb0ff; }
  .pips { display: inline-flex; gap: 3px; }
  .pips i { font-style: normal; font-size: 10.5px; font-weight: 700; letter-spacing: .2px; padding: 2px 5px;
    border-radius: 4px; background: #16203a; color: #52608a; cursor: default; }
  .pips.long i.on { background: rgba(34,197,94,.18); color: var(--green); }
  .pips.short i.on { background: rgba(239,68,68,.18); color: var(--red); }
  td.edge { cursor: help; }
  .page { max-width: 1360px; }
  td.call { text-align: left; white-space: normal; min-width: 150px; max-width: 215px; line-height: 1.3; }
  td.call small { display: block; margin-top: 3px; color: var(--muted); font-size: 11.5px; }
  .callsm { display: none; margin-top: 3px; }
  @media (max-width: 700px) { .callsm { display: inline-block; } }
  @media (min-width: 701px) { th, td { padding-left: 9px; padding-right: 9px; } }
  .legend p { margin: 0 0 8px; }
</style>
</head>
<body>
<div class="page">
  <nav class="tabs" aria-label="Scanners">
    <a href="/">Breakouts</a>
    <a href="/ichimoku.html" aria-current="page">Ichimoku Cloud</a>
    <a href="/indices.html">Index Options</a>
    <a href="/journal.html">Journal</a>
  </nav>
  <h1>Ichimoku Cloud Scanner</h1>
  <p class="sub">NSE stocks that have just closed above (or below) the Ichimoku cloud, with Tenkan/Kijun, Chikou and future-cloud confirmation.</p>
  <p class="sub"><b>Note:</b> the 15 min and 1 hour scans here are informational only. The Call is a checklist on the cloud, not a forecast; the intraday index rules (ADX trend filter, no entries before 10:00) live on the Index Options page.</p>

  <div class="controls">
    <select id="index" aria-label="Stock universe">
      <option>NIFTY 500</option>
      <option>NIFTY 200</option>
      <option>NIFTY 100</option>
      <option>NIFTY NEXT 50</option>
      <option>NIFTY MIDCAP 100</option>
      <option>NIFTY SMALLCAP 100</option>
      <option value="SECURITIES IN F&amp;O">F&amp;O stocks</option>
    </select>
    <div class="seg" id="tf" role="group" aria-label="Timeframe">
      <button data-v="1d" class="on">Daily</button>
      <button data-v="1h">1 hour</button>
      <button data-v="15m">15 min</button>
    </div>
    <div class="seg" id="side" role="group" aria-label="Direction">
      <button data-v="long" class="on">Long</button>
      <button data-v="short">Short</button>
      <button data-v="both">Both</button>
    </div>
    <select id="show" aria-label="How fresh the signal should be">
      <option value="fresh">Just broke (latest bar)</option>
      <option value="recent" selected>Broke within 3 bars</option>
      <option value="week">Broke within 5 bars</option>
      <option value="near">Plus near the cloud</option>
    </select>
    <select id="sector" aria-label="Sector filter" hidden>
      <option value="">All sectors</option>
    </select>
    <button class="primary" id="scan">Scan</button>
    <label class="chk"><input type="checkbox" id="live" checked> Live prices</label>
  </div>

  <div class="status" id="status"></div>
  <div class="liveinfo" id="liveinfo"></div>
  <div class="banner" id="banner"></div>

  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th>Symbol</th><th class="l hide-sm">Sector</th><th class="hide-sm">Side</th><th class="l hide-sm">Call</th><th>LTP</th><th>Chg %</th><th>Cloud edge</th><th>Dist %</th>
          <th>Confirms</th><th>Rel vol</th><th>Score</th><th>Status</th><th>Ref stop</th>
        </tr>
      </thead>
      <tbody id="rows"><tr><td colspan="13" class="empty">Press Scan to load stocks.</td></tr></tbody>
    </table>
  </div>

  <div class="legend">
    <p><b>What this finds</b>: stocks whose latest close is beyond the Ichimoku cloud (settings 9 / 26 / 52) after being at or inside it on the previous bar.
    <b>Cloud edge</b> is the top of the cloud for longs and the bottom for shorts, as drawn at the latest bar (hover for the full range).
    <b>Dist %</b> is how far price is beyond that edge; negative means still short of it.</p>
    <p><b>Status</b>: BREAKOUT / BREAKDOWN = the latest bar made the break. RECENT = broke 1 to 5 bars ago and is still beyond the cloud. NEAR = close to the edge but not through it. FADED = has dropped back since the scan.</p>
    <p><b>Confirms</b> (lit = agrees with the trade direction): <b>TK</b> Tenkan beyond Kijun, <b>KJ</b> price beyond Kijun, <b>CH</b> Chikou clear (today's close is beyond the candles and the cloud of 26 bars ago), <b>FC</b> the cloud 26 bars ahead is coloured the same way.
    <b>Score</b> weighs freshness and these confirmations, plus relative volume on Daily. <b>Rel vol</b> is Daily only; 1 hour and 15 min bars carry no volume reading here.
    <b>Ref stop</b>: for a fresh break, the Kijun or the far side of the cloud, whichever is closer; for NEAR, the last 5 bars' swing low or high. A reference only. Hover a Cloud edge value to see the whole cloud, its width and where the break came from.</p>
    <p><b>Call</b> is a checklist, not a forecast. It shows BUY (long) or SELL (short sale) only when all five checks pass, otherwise WAIT: (1) price is 0.3% to 2.5% beyond the cloud, (2) the break is 3 bars old or less, (3) at least 3 of the 4 confirms are lit, (4) Daily only: relative volume is 1.2x or more, (5) the reference stop is within 5% of price.
    The % is how many checks pass, and hovering the badge lists them. For BUY / SELL the line underneath gives the plan as % moves from the current price: SL at the reference stop, T1 at 2x and T2 at 3x that risk. For WAIT it says what is missing, or the close you are waiting for.
    The Call updates with the live price, so it can flip. It is built for the Daily timeframe; on 1 hour and 15 min the same rules apply to those bars. A SELL held overnight needs an F&amp;O stock, since cash-segment shorts must be closed the same day.</p>
    <p>The latest bar is still forming while the market is open, so a break can reverse before it closes. On Daily the latest bar is today's.
    <b>Live prices</b> refresh every 10 seconds and update LTP, Chg %, Dist %, Rel vol and Status against the cloud as drawn at the last scan. Confirmations and score refresh with a full scan every 3 minutes, and new entries are tagged NEW.</p>
    <p>Stock lists come from NSE; prices come from Yahoo Finance, polled rather than streamed, and may lag NSE. Only stocks priced at ₹50 or more with average daily turnover of ₹5 crore or more are scanned. This is a screening aid, not trading advice.</p>
  </div>
</div>

<script>
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var POLL_MS = 10000;     // live price refresh
  var RESCAN_MS = 180000;  // full re-scan while live
  var CHUNK = 60;          // /api/quotes limit per request
  var PREF_KEY = "bs-ich-prefs";
  var state = {
    side: "long", tf: "1d", show: "recent", busy: false, live: true, sector: "",
    rows: [], meta: null, share: 1, els: {},
    lastScanAt: 0, pollTimer: null, failures: 0, lastTick: 0, serverTime: 0
  };

  try {
    var saved = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    if (saved.index) $("index").value = saved.index;
    if (saved.show && /^(fresh|recent|week|near)$/.test(saved.show)) { state.show = saved.show; }
    if (saved.side) state.side = saved.side;
    if (saved.tf && /^(1d|1h|15m)$/.test(saved.tf)) state.tf = saved.tf;
    if (typeof saved.live === "boolean") state.live = saved.live;
  } catch (e) {}
  $("show").value = state.show;
  $("live").checked = state.live;

  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ index: $("index").value, show: state.show, side: state.side, tf: state.tf, live: state.live })); } catch (e) {}
  }

  // ---------- helpers ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function f(v, d) { return Number.isFinite(v) ? v.toFixed(d) : "–"; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function clock(ts) {
    return new Date(ts).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false });
  }
  function key(r) { return r.symbol + "|" + r.side; }
  function setText(node, v) {
    if (node.textContent === v) return false;
    node.textContent = v;
    return true;
  }
  function flash(node, dir) {
    node.classList.remove("flash-up", "flash-dn");
    void node.offsetWidth; // restart the animation
    node.classList.add(dir > 0 ? "flash-up" : "flash-dn");
  }
  function showBanner(kind, msg) { var b = $("banner"); b.className = "banner " + kind; b.textContent = msg; }
  function clearBanner() { var b = $("banner"); b.className = "banner"; b.textContent = ""; }
  function ageText(age) {
    if (state.meta && state.meta.unit === "d") return age + "d";
    return age + (age === 1 ? " bar" : " bars");
  }

  // ---------- live values derived from the latest price ----------
  function derive(r) {
    var isLong = r.side === "long";
    var edge = isLong ? r.top : r.bot;
    var dist = isLong ? (r.ltp - edge) / edge * 100 : (edge - r.ltp) / edge * 100;
    var near = state.meta ? state.meta.nearPct : 1;
    var status, label;
    if (dist > 0) {
      var age = r.age == null ? 0 : r.age; // was NEAR at scan time and has broken through since
      status = age === 0 ? (isLong ? "BREAKOUT" : "BREAKDOWN") : "RECENT";
      label = age === 0 ? status : "RECENT · " + ageText(age);
    } else if (dist >= -near) {
      status = label = "NEAR";
    } else {
      status = label = "FADED";
    }
    var d = {
      chg: (r.ltp - r.prevClose) / r.prevClose * 100,
      dist: dist,
      rvol: r.avgVol > 0 && r.volume != null ? r.volume / (r.avgVol * state.share) : null,
      status: status,
      label: label,
      age: dist > 0 ? (r.age == null ? 0 : r.age) : null
    };
    d.call = callFor(r, d, edge);
    return d;
  }

  // ---------- BUY / WAIT / SELL ----------
  // A checklist, not a forecast. BUY/SELL only when every check passes; the % is how many pass.
  var RULE = { minDist: 0.3, maxDist: 2.5, maxAge: 3, minConf: 3, minRvol: 1.2, maxRisk: 5 };

  function callFor(r, d, edge) {
    var isLong = r.side === "long";
    var intraday = !!(state.meta && state.meta.intraday);
    var conf = (r.tk ? 1 : 0) + (r.kj ? 1 : 0) + (r.chikou ? 1 : 0) + (r.future ? 1 : 0);
    var risk = Math.abs(r.ltp - r.refStop) / r.ltp * 100;
    var checks = [];
    var parts = [];

    var inZone = d.dist >= RULE.minDist && d.dist <= RULE.maxDist;
    checks.push({ ok: inZone, text: "Price " + RULE.minDist + "% to " + RULE.maxDist + "% beyond the cloud" });
    if (d.dist < 0) parts.push("Needs a close " + (isLong ? "above " : "below ") + f(edge, 2));
    else if (d.dist < RULE.minDist) parts.push("thin break (" + (d.dist >= 0 ? "+" : "") + f(d.dist, 2) + "%), needs follow-through");
    else if (d.dist > RULE.maxDist) parts.push("extended (+" + f(d.dist, 1) + "%), wait for a pullback");

    var fresh = d.age != null && d.age <= RULE.maxAge;
    checks.push({ ok: fresh, text: "Broke within the last " + RULE.maxAge + " bars" });
    if (!fresh && d.dist > 0) parts.push("break is " + ageText(d.age) + " old");

    var confOk = conf >= RULE.minConf;
    checks.push({ ok: confOk, text: "At least " + RULE.minConf + " of 4 confirms (" + conf + " now)" });
    if (!confOk) parts.push("only " + conf + " of 4 confirms");

    if (!intraday && d.rvol != null) {
      var vOk = d.rvol >= RULE.minRvol;
      checks.push({ ok: vOk, text: "Relative volume " + RULE.minRvol + "x or more (" + f(d.rvol, 1) + "x now)" });
      if (!vOk) parts.push("weak volume (" + f(d.rvol, 1) + "x)");
    }

    var riskOk = risk <= RULE.maxRisk;
    checks.push({ ok: riskOk, text: "Reference stop within " + RULE.maxRisk + "% (" + f(risk, 1) + "% now)" });
    if (!riskOk) parts.push("stop too wide (" + f(risk, 1) + "%)");

    var pass = checks.filter(function (c) { return c.ok; }).length;
    var pct = Math.round(pass / checks.length * 100);
    var action = pass === checks.length ? (isLong ? "BUY" : "SELL") : "WAIT";
    var plan;
    if (action === "WAIT") {
      plan = parts.slice(0, 3).join(" · ");
      plan = plan.charAt(0).toUpperCase() + plan.slice(1);
    } else {
      var s = isLong ? -1 : 1; // price moves against a long downward, against a short upward
      var sg = function (v) { return (v >= 0 ? "+" : "-") + f(Math.abs(v), 1) + "%"; };
      plan = "SL " + sg(s * risk) + " · T1 " + sg(-s * 2 * risk) + " · T2 " + sg(-s * 3 * risk);
    }
    var tip = action + " " + pct + "%: " + pass + " of " + checks.length + " checks pass\n" +
      checks.map(function (c) { return (c.ok ? "✓ " : "✗ ") + c.text; }).join("\n");
    return { action: action, pct: pct, label: action + " · " + pct + "%", plan: plan, tip: tip };
  }
  function callClass(a) { return a === "BUY" ? "b-brk" : a === "SELL" ? "b-bdn" : "b-near"; }
  function badgeClass(s) {
    return s === "BREAKOUT" ? "b-brk" : s === "BREAKDOWN" ? "b-bdn" : s === "RECENT" ? "b-rec" : s === "NEAR" ? "b-near" : "b-fade";
  }

  // ---------- table ----------
  function passShow(r) {
    if (state.show === "fresh") return r.age === 0;
    if (state.show === "recent") return r.age != null && r.age <= 3;
    if (state.show === "week") return r.age != null;
    return true; // near: everything, including NEAR
  }
  function visibleRows() {
    return state.rows.filter(function (r) { return passShow(r) && (!state.sector || r.industry === state.sector); });
  }

  function paintRow(r, doFlash) {
    var e = state.els[key(r)];
    if (!e) return;
    var d = derive(r);
    if (setText(e.ltp, f(r.ltp, 2)) && doFlash && r._prev != null && r.ltp !== r._prev) {
      flash(e.ltp, r.ltp > r._prev ? 1 : -1);
    }
    r._prev = r.ltp;
    e.chg.className = "num " + (d.chg >= 0 ? "up" : "down");
    setText(e.chg, (d.chg >= 0 ? "+" : "") + f(d.chg, 2));
    setText(e.dist, (d.dist >= 0 ? "+" : "") + f(d.dist, 2));
    setText(e.rvol, d.rvol == null ? "–" : f(d.rvol, 1) + "x");
    if (setText(e.badge, d.label) || e.badge.dataset.s !== d.status) {
      var changed = e.badge.dataset.s !== undefined && e.badge.dataset.s !== d.status;
      e.badge.dataset.s = d.status;
      e.badge.className = "badge " + badgeClass(d.status);
      if (doFlash && changed) flash(e.badgeCell, d.status === "FADED" || d.status === "NEAR" ? -1 : 1);
    }
    var c = d.call;
    setText(e.callPlan, c.plan);
    e.callBadge.title = c.tip;
    e.callSm.title = c.tip;
    setText(e.callSm, c.label);
    if (setText(e.callBadge, c.label) || e.callBadge.dataset.a !== c.action) {
      var cChanged = e.callBadge.dataset.a !== undefined && e.callBadge.dataset.a !== c.action;
      e.callBadge.dataset.a = c.action;
      e.callBadge.className = "badge " + callClass(c.action);
      e.callSm.className = "badge callsm " + callClass(c.action);
      if (doFlash && cChanged) flash(e.callCell, c.action === "WAIT" ? -1 : 1);
    }
  }

  function pip(text, on, title) {
    var i = el("i", on ? "on" : "", text);
    i.title = title + (on ? ": yes" : ": no");
    return i;
  }

  function buildRow(r, isNew) {
    var isLong = r.side === "long";
    var tr = el("tr");
    var c0 = el("td", "sym", r.symbol);
    var a = el("a", null, "chart ↗");
    a.href = "https://www.tradingview.com/chart/?symbol=NSE%3A" + encodeURIComponent(r.symbol.replace(/[&-]/g, "_"));
    a.target = "_blank"; a.rel = "noopener noreferrer";
    c0.appendChild(a);
    if (isNew) c0.appendChild(el("span", "new", "NEW"));
    c0.appendChild(el("div", "subsec", (isLong ? "LONG" : "SHORT") + (r.industry ? " · " + r.industry : "")));
    var e = {
      ltp: el("td", "num"), chg: el("td", "num"), dist: el("td", "num"), rvol: el("td", "num"),
      badge: el("span", "badge"), badgeCell: el("td"),
      callBadge: el("span", "badge"), callPlan: el("small"), callCell: el("td", "call hide-sm"),
      callSm: el("span", "badge callsm")
    };
    c0.appendChild(e.callSm); // phone layout: the call sits under the symbol
    tr.appendChild(c0);

    tr.appendChild(el("td", "sector hide-sm", r.industry || ""));
    tr.appendChild(el("td", "hide-sm " + (isLong ? "up" : "down"), isLong ? "LONG" : "SHORT"));
    e.callCell.appendChild(e.callBadge);
    e.callCell.appendChild(e.callPlan);
    tr.appendChild(e.callCell);
    tr.appendChild(e.ltp); tr.appendChild(e.chg);

    var edge = el("td", "num edge", f(isLong ? r.top : r.bot, 2));
    edge.title = "Cloud " + f(r.bot, 2) + " to " + f(r.top, 2) + " (" + f((r.top - r.bot) / r.ltp * 100, 1) + "% wide)" +
      (r.from ? ", broke from " + r.from + " the cloud" : "");
    tr.appendChild(edge);
    tr.appendChild(e.dist);

    var cf = el("td"), pips = el("span", "pips " + r.side);
    var dir = isLong ? "bullish" : "bearish";
    pips.appendChild(pip("TK", r.tk, "Tenkan vs Kijun " + dir));
    pips.appendChild(pip("KJ", r.kj, "Price vs Kijun " + dir));
    pips.appendChild(pip("CH", r.chikou, "Chikou span clear"));
    pips.appendChild(pip("FC", r.future, "Future cloud " + dir));
    cf.appendChild(pips);
    tr.appendChild(cf);

    tr.appendChild(e.rvol);

    var sc = el("td"), box = el("span", "score");
    box.appendChild(el("span", "num", String(r.score)));
    var bar = el("span", "bar"), fill = el("i");
    fill.style.width = Math.min(100, r.score) + "%";
    bar.appendChild(fill); box.appendChild(bar); sc.appendChild(box);
    tr.appendChild(sc);

    e.badgeCell.appendChild(e.badge);
    tr.appendChild(e.badgeCell);
    tr.appendChild(el("td", "num", f(r.refStop, 2)));

    state.els[key(r)] = e;
    paintRow(r, false);
    return tr;
  }

  function emptyMessage() {
    if (!state.rows.length) {
      return "No stocks have a cloud signal right now. Try another timeframe, or scan again when the market is open.";
    }
    if (state.sector) return "No matches in this sector. Pick All sectors to see everything.";
    return "Nothing matches this freshness setting. Try 'Broke within 5 bars' or 'Plus near the cloud'.";
  }

  function render(prevKeys) {
    var tb = $("rows");
    tb.textContent = "";
    state.els = {};
    var rows = visibleRows();
    if (!rows.length) {
      var tr = el("tr");
      var td = el("td", "empty", emptyMessage());
      td.colSpan = 13; tr.appendChild(td); tb.appendChild(tr);
    } else {
      rows.forEach(function (r) { tb.appendChild(buildRow(r, !!prevKeys && !prevKeys[key(r)])); });
    }
    setScanStatus(rows.length);
  }

  function rebuildSectorOptions() {
    var sel = $("sector");
    var seen = {};
    state.rows.forEach(function (r) { if (r.industry) seen[r.industry] = 1; });
    var names = Object.keys(seen).sort();
    if (state.sector && !seen[state.sector]) state.sector = "";
    sel.textContent = "";
    var all = el("option", null, "All sectors"); all.value = ""; sel.appendChild(all);
    names.forEach(function (n) { var o = el("option", null, n); o.value = n; sel.appendChild(o); });
    sel.value = state.sector;
    sel.hidden = names.length === 0;
  }

  function setScanStatus(shown) {
    var m = state.meta;
    if (!m) return;
    var total = state.rows.length;
    var when = m.marketOpen ? "Market open (" + Number(m.sessionPct) + "% of session)" : "Market closed, showing last session";
    var count = shown !== total ? shown + " of " + total : String(total);
    $("status").innerHTML = "<b>" + esc(count) + "</b> cloud signals in " + Number(m.universe) + " stocks · " +
      esc(m.tfLabel) + " · " + when + " · scanned at " + esc(m.asOf || "n/a");
  }

  // ---------- live prices ----------
  function applyQuotes(resp) {
    var q = resp.quotes || {};
    if (typeof resp.share === "number") state.share = resp.share;
    if (resp.serverTime) state.serverTime = resp.serverTime;
    state.rows.forEach(function (r) {
      var x = q[r.symbol];
      if (!x || !Number.isFinite(x.ltp)) return;
      r.ltp = x.ltp;
      if (r.volume != null && Number.isFinite(x.vol)) r.volume = Math.max(r.volume, x.vol);
      if (Number.isFinite(x.t)) state.lastTick = Math.max(state.lastTick, x.t);
    });
    visibleRows().forEach(function (r) { paintRow(r, true); });
  }

  function showLive() {
    var box = $("liveinfo");
    box.textContent = "";
    if (!state.live || !state.meta) { box.className = "liveinfo"; return; }
    var dot = el("span", "dot", "●");
    if (!state.meta.marketOpen) {
      box.className = "liveinfo off";
      box.appendChild(dot);
      box.appendChild(document.createTextNode("Market closed: prices are not updating."));
      return;
    }
    var age = state.serverTime && state.lastTick ? state.serverTime - state.lastTick : 0;
    var stale = state.failures > 0 || age > 120;
    box.className = "liveinfo" + (stale ? " stale" : "");
    box.appendChild(dot);
    var txt = state.failures > 0 ? "Live updates delayed, retrying" : "Live";
    if (state.lastTick) {
      txt += " · last tick " + clock(state.lastTick * 1000) + " IST";
      if (age > 120) txt += " (" + Math.round(age / 60) + " min old)";
    }
    txt += " · refreshed " + clock(Date.now());
    box.appendChild(document.createTextNode(txt));
  }

  function stopLive() { clearTimeout(state.pollTimer); state.pollTimer = null; }

  function startLive() {
    stopLive();
    showLive();
    if (state.live && !document.hidden && state.meta && state.meta.marketOpen && state.rows.length) {
      state.pollTimer = setTimeout(tick, 1500);
    }
  }

  async function fetchQuotes(syms) {
    var res = await fetch("/api/quotes?symbols=" + encodeURIComponent(syms.join(",")));
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  async function tick() {
    state.pollTimer = null;
    if (!state.live || document.hidden || !state.meta || !state.meta.marketOpen || !state.rows.length) { showLive(); return; }
    if (Date.now() - state.lastScanAt > RESCAN_MS && !state.busy) { await scan(true); return; } // scan() restarts live mode
    var seen = {}, syms = [];
    visibleRows().forEach(function (r) { if (!seen[r.symbol]) { seen[r.symbol] = 1; syms.push(r.symbol); } });
    try {
      if (syms.length) {
        var chunks = [];
        for (var i = 0; i < syms.length; i += CHUNK) chunks.push(syms.slice(i, i + CHUNK));
        var parts = await Promise.all(chunks.map(fetchQuotes));
        var merged = { quotes: {}, serverTime: 0, share: undefined, marketOpen: true };
        parts.forEach(function (p) {
          Object.keys(p.quotes || {}).forEach(function (k) { merged.quotes[k] = p.quotes[k]; });
          merged.serverTime = Math.max(merged.serverTime, p.serverTime || 0);
          if (typeof p.share === "number") merged.share = p.share;
          if (p.marketOpen === false) merged.marketOpen = false;
        });
        state.failures = 0;
        applyQuotes(merged);
        if (merged.marketOpen === false) state.meta.marketOpen = false;
      }
    } catch (e) {
      state.failures++;
    }
    showLive();
    if (state.live && !document.hidden && state.meta && state.meta.marketOpen) {
      state.pollTimer = setTimeout(tick, Math.min(60000, POLL_MS * (1 + state.failures)));
    }
  }

  // ---------- full scan ----------
  async function scan(silent) {
    if (state.busy) return;
    state.busy = true;
    if (silent) {
      state.lastScanAt = Date.now(); // avoid a retry storm if this scan fails
    } else {
      $("scan").disabled = true;
      clearBanner();
      $("status").innerHTML = '<span class="spin"></span>Scanning NSE stocks. This usually takes 5 to 25 seconds.';
    }
    savePrefs();
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, 75000);
    var ok = false;
    try {
      var url = "/api/ichimoku?index=" + encodeURIComponent($("index").value) + "&tf=" + state.tf + "&side=" + state.side;
      var res = await fetch(url, { signal: ctrl.signal });
      var data = await res.json();
      if (!res.ok) {
        if (!silent) {
          showBanner("err", (data.error || "Request failed") + (data.detail ? " [" + data.detail + "]" : "") + (data.hint ? " " + data.hint : ""));
          $("status").textContent = "";
        }
      } else {
        ok = true;
        var prevKeys = null;
        if (silent) { prevKeys = {}; state.rows.forEach(function (r) { prevKeys[key(r)] = 1; }); }
        state.meta = data.meta;
        state.share = typeof data.meta.volShare === "number" ? data.meta.volShare : 1;
        state.rows = data.results.map(function (r) { r._prev = r.ltp; return r; });
        state.lastScanAt = Date.now();
        state.failures = 0;
        rebuildSectorOptions();
        render(prevKeys);
        if (data.warnings && data.warnings.length) showBanner("warn", data.warnings.join(" ")); else clearBanner();
      }
    } catch (e) {
      if (!silent) {
        showBanner("err", e.name === "AbortError" ? "The scan took too long. Try again in a moment." : "Could not load results: " + e.message);
        $("status").textContent = "";
      }
    } finally {
      clearTimeout(to);
      state.busy = false;
      $("scan").disabled = false;
    }
    startLive();
    return ok;
  }

  // ---------- events ----------
  function wireSeg(id, prop) {
    document.querySelectorAll("#" + id + " button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.v === state[prop]);
      b.addEventListener("click", function () {
        state[prop] = b.dataset.v;
        document.querySelectorAll("#" + id + " button").forEach(function (x) { x.classList.toggle("on", x === b); });
        scan(false);
      });
    });
  }
  wireSeg("side", "side");
  wireSeg("tf", "tf");
  $("index").addEventListener("change", function () { scan(false); });
  $("scan").addEventListener("click", function () { scan(false); });
  $("show").addEventListener("change", function () {
    state.show = $("show").value;
    savePrefs();
    render(null);
    startLive();
  });
  $("sector").addEventListener("change", function () { state.sector = $("sector").value; render(null); startLive(); });
  $("live").addEventListener("change", function () {
    state.live = $("live").checked;
    savePrefs();
    if (state.live) startLive(); else { stopLive(); showLive(); }
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopLive(); else startLive();
  });

  scan(false);
})();
</script>
</body>
</html>
````

## `public/indices.html`

````html
<!doctype html>
<html lang="en">
<head>
<link rel="icon" href="data:,">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#060b18">
<title>Index Options Rulebook</title>
<link rel="stylesheet" href="/app.css">
<style>
  .page { max-width: 1360px; }
  .b-none { background: rgba(138,151,184,.15); color: var(--muted); }
  td.sig { text-align: left; white-space: normal; min-width: 210px; max-width: 330px; line-height: 1.3; }
  td.sig .st { display: block; margin-top: 4px; font-size: 11.5px; font-weight: 650; letter-spacing: .2px; }
  td.sig small { display: block; margin-top: 2px; color: var(--muted); font-size: 11.5px; }
  td.strat { text-align: left; color: var(--muted); font-size: 12.5px; }
  td.opt { text-align: left; font-size: 12.5px; }
  td.chk { cursor: help; font-size: 12.5px; }
  .ok { color: var(--green); } .no { color: var(--red); }
  tr.grp td { border-top: 2px solid #26365f; }
  tr.grp:first-child td { border-top: 0; }
  .subsec { display: block; }
  .sm { display: none; }
  .sm .plansm { display: block; margin-top: 3px; font-size: 11.5px; color: var(--muted); font-weight: 400; white-space: normal; }
  .sm .stsm { display: block; margin-top: 3px; font-size: 11px; font-weight: 650; color: var(--text); white-space: normal; }
  @media (max-width: 700px) { .sm { display: block; } }
  @media (min-width: 701px) { th, td { padding-left: 9px; padding-right: 9px; } }
  .exp { margin-left: 6px; font-size: 10px; font-weight: 700; color: #2b1b00; background: var(--amber); border-radius: 4px; padding: 1px 5px; vertical-align: 1px; }
  .legend p { margin: 0 0 8px; }
  .legend ul { margin: 0 0 8px; padding-left: 18px; }
  .notice { border: 1px solid #5b4516; background: #1c170b; color: #ffd98a; border-radius: 10px; padding: 9px 12px; font-size: 13px; margin: 0 0 10px; }
  .panel { border: 1px solid var(--line); border-radius: 12px; background: var(--card); padding: 10px 12px; margin: 0 0 12px; }
  .panel h2 { font-size: 14px; margin: 0 0 8px; letter-spacing: .2px; }
  .panel .controls { margin-bottom: 6px; }
  canvas.cv { display: block; width: 100%; height: 380px; touch-action: pan-y; }
  canvas.eq { display: block; width: 100%; height: 220px; }
  @media (max-width: 700px) { canvas.cv { height: 300px; } }
  .cinfo { color: var(--muted); font-size: 12.5px; min-height: 18px; margin: 6px 0 0; font-variant-numeric: tabular-nums; }
  .cleg { color: var(--muted); font-size: 12px; margin: 4px 0 0; line-height: 1.5; }
  ul.siglist { margin: 8px 0 0; padding-left: 18px; font-size: 13px; }
  ul.siglist li { margin: 0 0 5px; }
  .chain { font-size: 13px; }
  .chain a { color: var(--blue); }
  table.mini { min-width: 0; width: auto; }
  table.mini th, table.mini td { padding: 5px 14px; font-size: 13px; text-align: center; }
  table.bt { min-width: 0; }
  table.bt th, table.bt td { padding: 8px 10px; font-size: 13px; }
  table.bt th { white-space: normal; line-height: 1.25; vertical-align: bottom; }
  .lowN { color: var(--amber); font-size: 11px; margin-left: 4px; }
  .guide ul { padding-left: 18px; margin: 6px 0; }
  .guide li { margin: 0 0 6px; }
  .costin { width: 78px; background: var(--card); color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 8px; font: inherit; min-height: 40px; }
  .viewseg { margin: 0 0 10px; }
  #cix { max-width: 100%; overflow-x: auto; }
  #cix button { white-space: nowrap; }
  .dim { color: var(--muted); }
  .tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
  .tag { display: inline-block; font-size: 10.5px; font-weight: 650; border-radius: 5px; padding: 1px 6px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  .tag.good { color: var(--green); border-color: rgba(34,197,94,.45); }
  .tag.warn { color: var(--amber); border-color: rgba(245,158,11,.45); }
  .tag.bad { color: var(--red); border-color: rgba(239,68,68,.5); }
  tr.inforow td { opacity: .78; }
  .vixbar { border: 1px solid var(--line); border-radius: 10px; background: var(--card); padding: 8px 12px; font-size: 13px; margin: 0 0 10px; }
  .vixbar b.blk { color: var(--red); } .vixbar b.okk { color: var(--green); }
  .trailtxt { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; }
  .diaggrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
  .diaggrid h3 { font-size: 13px; margin: 0 0 6px; color: var(--muted); font-weight: 600; }
  .chk2 { color: var(--muted); font-size: 11.5px; margin: 4px 0 0; }
  tr.nobt td { color: var(--muted); }
  .labsel { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<div class="page">
  <nav class="tabs" aria-label="Scanners">
    <a href="/">Breakouts</a>
    <a href="/ichimoku.html">Ichimoku Cloud</a>
    <a href="/indices.html" aria-current="page">Index Options</a>
    <a href="/journal.html">Journal</a>
  </nav>
  <h1>Index Options Rulebook</h1>
  <p class="sub">NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY and NIFTYNXT50, checked against fixed rule sets (ORB, Ichimoku + Fib, VWAP, expiry-day max pain). Buy CE or buy PE only; nothing here sells options.</p>
  <div class="notice">These are rule checks on the index price. No option premium, spread or open-interest data is used (Yahoo has none; a broker adapter would be needed). The rules are not proven: the Backtest tab replays them on about 40 recent sessions, which is too few to establish an edge. This is a sanity check on behaviour, not proof. Treat BUY as "all the rules line up, now check the option chain yourself", and paper-trade first (see the Journal tab).</div>
  <div class="vixbar" id="vixbar">India VIX: loading…</div>

  <div class="seg viewseg" id="view" role="group" aria-label="View">
    <button data-v="live" class="on">Live rules and chart</button>
    <button data-v="bt">Backtest on past sessions</button>
  </div>

<div id="liveView">
  <div class="panel" id="chartPanel">
    <div class="controls">
      <div class="seg" id="cix" role="group" aria-label="Chart index"></div>
      <select id="cdate" aria-label="Session"></select>
      <label class="chk"><input type="checkbox" id="cOrb" checked> Opening range</label>
      <label class="chk"><input type="checkbox" id="cAvg" checked> <span id="cAvgName">Average price</span></label>
      <label class="chk"><input type="checkbox" id="cSig" checked> Signals</label>
    </div>
    <canvas class="cv" id="cv" aria-label="5 minute candles of the selected index"></canvas>
    <div class="cinfo" id="cinfo">Hover or touch the chart to read a candle.</div>
    <div class="cleg" id="cleg"></div>
    <ul class="siglist" id="siglist"></ul>
  </div>

  <div class="panel chain" id="chainPanel">
    <h2>Option chain</h2>
    <div id="chainInfo" class="dim">Loading…</div>
    <div class="wrap" style="margin-top:8px;display:inline-block;max-width:100%">
      <table class="mini"><thead><tr><th>Call (CE)</th><th>Strike</th><th>Put (PE)</th></tr></thead><tbody id="ladder"></tbody></table>
    </div>
    <p class="cleg">This ladder is strikes only, worked out from the index price. Premiums, bid/ask, volume and open interest are not shown because this app has no option-price feed: NSE blocks requests from cloud servers, and a broker data connection would be needed. Open the live chain, pick the strike above, and check the spread and open interest before using any signal.
      <a href="https://www.nseindia.com/option-chain" target="_blank" rel="noopener noreferrer">Open the NSE option chain ↗</a></p>
  </div>

  <div class="controls">
    <div class="seg" id="strat" role="group" aria-label="Strategy">
      <button data-v="all" class="on">All</button>
      <button data-v="orb">ORB</button>
      <button data-v="ichi">Ichimoku</button>
      <button data-v="vwap">VWAP</button>
      <button data-v="expiry">Expiry</button>
    </div>
    <select id="ixsel" aria-label="Index">
      <option value="">All indices</option>
    </select>
    <label class="chk"><input type="checkbox" id="act"> Actionable only</label>
    <button class="primary" id="scan">Refresh</button>
    <label class="chk"><input type="checkbox" id="live" checked> Auto refresh (60s)</label>
  </div>

  <div class="status" id="status"></div>
  <div class="liveinfo" id="liveinfo"></div>
  <div class="banner" id="banner"></div>

  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th>Index / strategy</th><th class="l hide-sm">Signal</th><th class="hide-sm">LTP</th><th class="hide-sm">Chg %</th>
          <th class="hide-sm">Entry / level</th><th class="hide-sm">Stop</th><th class="hide-sm">T1</th><th class="hide-sm">T2</th><th class="hide-sm">Risk %</th>
          <th class="l hide-sm">Option to look at</th><th class="hide-sm">Checks</th>
        </tr>
      </thead>
      <tbody id="rows"><tr><td colspan="11" class="empty">Loading…</td></tr></tbody>
    </table>
  </div>

  <div class="legend">
    <p><b>Signal</b>: <b>BUY CE</b> (bullish) or <b>BUY PE</b> (bearish) appears only when the setup has triggered on a finished candle, the trigger is no more than 2 bars old, every blocking rule passes and India VIX is not elevated. <b>WAIT</b> means a setup is forming; the line under it says what is needed. <b>NO TRADE</b> means a rule rules it out today. <b>INFO</b> rows are information only and never count as a signal. <b>CLOSED</b> shows the state at the end of the last session. Only finished candles are used, so a forming candle never triggers anything. "Actionable only" counts BUY rows and nothing else.</p>
    <p><b>Data-quality tags</b> on every row: <span class="tag good">true VWAP</span> volume exists so VWAP is real; <span class="tag warn">proxy</span> the line is only a session average; <span class="tag warn">no volume</span> the index feed has no volume, so volume filters are skipped (and say so in the checks); <span class="tag good">VIX ok</span> / <span class="tag bad">VIX blocked</span> / <span class="tag warn">VIX n/a</span> the India VIX filter; <span class="tag good">chain ok</span> / <span class="tag warn">no chain</span> option-chain open interest (needs a broker adapter). A skipped filter is always visible in the checks list (hover the check count) and in these tags.</p>
    <p><b>Stop, T1, T2</b> are levels on the <i>index</i>, not the option. An index stop does not give a fixed loss on the option: premium moves non-linearly, spreads widen and a stop can fill worse. <b>Risk %</b> is the index stop distance as a share of price. The multiples are starting points to test, not validated edges.</p>
    <ul>
      <li><b>ORB breakout (Track 1)</b> (5m): the opening range is the 9:15 to 9:30 high and low. A 5m close above the high plus a buffer of 10% of the range width (below the low for puts) is the trigger, with no retest. The breakout candle needs volume at least 1.5x the mean of up to 20 earlier bars of the session; with no index volume that filter is skipped and says so. Stop: the lowest low (highest high for puts) from the breakout candle to the latest bar, capped at 0.7% of price. Targets 2R and 3R. Trail (information only, not simulated): VWAP, or the 20 EMA when VWAP is only a proxy.</li>
      <li><b>ORB retest (Track 2)</b>: the earlier retest logic, unchanged: break, a retest within 10% of the width that holds, then a close beyond the retest candle. A close back inside the range cancels it, with no second attempt. Targets 1R and 2R. It is evaluated only when Track 1 has not fired. Both tracks: skipped on chop (both edges broken), after 14:00, or with a stop over 0.7%. The opening-range width no longer blocks; it sets the size hint: <b>full</b> from 0.5x to 2x the recent typical width, <b>half</b> from 2x to 3x (counts as 0.5R in the backtest), <b>skip</b> beyond 3x or under 0.5x (no trade).</li>
      <li><b>Ichimoku + Fib, intraday</b> (15m): the trend filter is ADX(14) on 15m at least 20 with +DI above -DI (long) or -DI above +DI (short); if ADX is unavailable the 5m 20-EMA slope over 10 bars is used. The 1h cloud is shown for information only and never blocks. On 15m, the last confirmed swing low then high (3 bars each side) is the leg; price must retrace 38.2% to 61.8% of it (deeper is PULLBACK TOO DEEP), then a candle must dip into the zone, close back beyond the 38.2% level and, when volume exists, have volume at least the mean of the prior 3 bars. No entries before 10:00 or after the 14:30 candle. Stop is the retrace extreme (cap 1.0%) and the prior swing must be at least 1R away.</li>
      <li><b>Ichimoku swing (Daily / 4h)</b>: the same logic one level up: Daily cloud and structure as the trend filter (cloud at least 0.25% wide), 4h pullback and trigger. Stop cap 4.0% (my assumption). It is shown here but not backtested, and it holds for days, so size it as a swing trade.</li>
      <li><b>VWAP reclaim</b> (5m, needs a true VWAP): at least 9 consecutive closes (45 minutes) on the trend side of VWAP, then 1 to 3 closes across it, then a close back with volume at least the mean of the prior 2 candles. Stop at the dip low, cap 0.5%, targets 2R and 3R. RSI(9) must be 38 to 58 at the dip low for calls (45 to 65 at the dip high for puts); skipped, with a note, if the dip is inside the first 15 bars.</li>
      <li><b>VWAP pullback</b> (5m, needs a true VWAP): price on the trend side with the last two 5m swing lows rising; a dip to within 0.1% of VWAP that holds after 3 of the previous 6 closes were clear of it; trigger a close beyond that candle. Skipped on 3 or more VWAP crossings, a stop over 0.5%, or after 14:30; starts 9:50. Every VWAP row carries a reliability tag (high, medium, low); low means NO TRADE.</li>
      <li><b>Expiry max pain</b> (NIFTY and BANKNIFTY, expiry days, 14:00 to 15:30): needs open interest from an option chain, which this app does not have. Without a broker adapter the row says NO TRADE and never guesses. With one: max pain is the strike where option writers lose least; a 5m close toward it while price is 0.5% to 1.5% away triggers; T1 is the max pain level.</li>
      <li><b>India VIX filter</b>: when India VIX is above its 60th percentile of the previous 60 sessions, every BUY is downgraded to WAIT ("IV elevated"): buying premium when implied volatility is high is a poor trade. If the VIX cannot be fetched the filter is skipped and shown as such.</li>
    </ul>
    <p><b>Expiry days</b> are flagged, and ORB, Ichimoku and VWAP stay blocked on them. Expiry is taken as Tuesday: every Tuesday for NIFTY (weekly), the last Tuesday of the month for the others. This follows the schedule NSE moved to in September 2025, but it does not know exchange holidays that shift an expiry, so check the NSE calendar. Lot sizes change from time to time, so none are shown; check the current lot and margin with your broker. Strike steps used for the ATM strike (NIFTY 50, BANKNIFTY 100, FINNIFTY 50, MIDCPNIFTY 25, NIFTYNXT50 100) are typical values; confirm them in the option chain.</p>
    <p><b>Before any trade</b>: look at the actual option's bid, ask, volume and open interest, and skip it if the spread is wide. Size so that a stop-out loses only a small, fixed share of your account (0.25% to 0.5% is a common simulation range). No averaging down, no revenge trades, a daily loss limit, and exit everything by 15:15. A long option can lose its whole premium. Log 20 to 30 paper-trading sessions in the Journal tab, including the signals you skip, before putting real money behind any of these rules.</p>
    <p>Prices come from Yahoo Finance index tickers, polled rather than streamed, and may lag NSE. The newest tick time is shown above. This is a screening aid, not trading advice.</p>
  </div>
</div>

<div id="btView" hidden>
  <div class="panel">
    <div class="controls">
      <select id="btix" aria-label="Index to test">
        <option value="ALL">All five indices</option>
        <option value="NIFTY">NIFTY 50</option>
        <option value="BANKNIFTY">NIFTY BANK</option>
        <option value="FINNIFTY">NIFTY FIN SERVICE</option>
        <option value="MIDCPNIFTY">NIFTY MIDCAP SELECT</option>
        <option value="NIFTYNXT50">NIFTY NEXT 50</option>
      </select>
      <button class="primary" id="btRun">Run backtest</button>
      <label class="labsel">Exit plan <select id="btPlan" aria-label="Exit plan"><option value="x1">Stop / T1 plan</option><option value="x2">Stop / T2 plan</option></select></label>
      <label class="labsel">Option strike <select id="btStrike" aria-label="Option strike"><option value="atm">ATM</option><option value="itm">1 ITM</option></select></label>
      <label class="chk">Index cost <input class="costin" id="btCost" type="number" min="0" max="1" step="0.05" value="0.10" aria-label="Index cost in R"> R</label>
      <label class="chk">Option cost <input class="costin" id="btOptCost" type="number" min="0" max="10" step="0.1" value="0.5" aria-label="Option cost in percent of premium"> % of premium</label>
    </div>
    <div class="status" id="btStatus">Replays the same rules as the live page over the past sessions the data source provides (about 40 per index). All five indices takes about a minute.</div>
    <div class="banner" id="btBanner"></div>
  </div>

  <div id="btOut" hidden>
    <div class="panel">
      <h2>Results by strategy (all tested indices together)</h2>
      <div class="wrap"><table class="bt" id="btSum"></table></div>
      <p class="cleg"><b>Read option R with care.</b> Option R divides the premium change by the premium you would lose at the stop. When the index stop is very tight (some breakout candles close almost on their low), that loss is tiny, so one trade can show &plusmn;40R and drag the average. The premium % beside each R figure is not affected by this. <b>Index R</b> is measured on the index: +1R means the index moved one stop-distance your way. <b>Option P&amp;L</b> columns are a <b>Black-Scholes approximation</b>, not real premiums: India VIX (previous close) stands in for ATM implied volatility, +2 vol points for the 1-ITM strike, 6.5% interest, flat smile, and the option is re-priced at the exit with the same volatility ("no IV change") and with volatility 10% lower ("-10% IV", a crude IV-crush case). Each shows the average in option R (premium change divided by the premium you would lose if the index reached the stop) with its 95% range, and the average % change in premium. Expiry-week gamma is not modelled; assignment and pin risk are not modelled; no bid/ask spread beyond the option-cost box. Half-size trades count 0.5R. "Blocked" counts BUY signals that were held back by the India VIX filter or the opening-range size rule: they are not trades. The range after each average is a 95% confidence range: if it includes zero, this test shows no evidence of an edge.</p>
    </div>
    <div class="panel">
      <h2>Cumulative index R, selected plan, after index cost</h2>
      <canvas class="eq" id="eq" aria-label="Cumulative R by trade"></canvas>
      <div class="cleg" id="eqLeg"></div>
    </div>
    <div class="panel">
      <h2>Backtest diagnostics <select id="dgStrat" aria-label="Strategy for diagnostics" style="margin-left:8px;min-height:32px;padding:4px 10px"></select></h2>
      <div class="diaggrid" id="dgOut"></div>
      <p class="cleg">Every table below adds up to the trade count shown above it. Outcomes are classed once per trade: stopped before T1, reached T2, reached T1 but not T2, or time exit at 15:15. Use these to see where the losses come from (wide stops, one side, a time of day or weekday), not to retune the rules on 40 sessions.</p>
    </div>
    <div class="panel">
      <h2>By index</h2>
      <div class="wrap"><table class="bt" id="btIdx"></table></div>
      <div class="cleg" id="btMeta"></div>
    </div>
    <div class="panel">
      <h2>Every trade <button id="btToggle" style="margin-left:8px;min-height:32px;padding:4px 10px">Show</button></h2>
      <div class="wrap" id="btTradesWrap" hidden><table class="bt" id="btTrades"></table></div>
    </div>
  </div>

  <div class="panel guide">
    <h2>How to read this, and what it cannot tell you</h2>
    <ul>
      <li><b>What is tested.</b> The exact live rules, replayed candle by candle. At each step the engine sees only candles that had finished by then (checked by scrambling every unfinished candle and confirming the rows do not change). One trade per strategy per session: the first BUY. Entry is the close of the trigger candle. Inside a candle the stop is assumed to hit before the target. Everything is flat by 15:15. Expiry days are skipped, as on the live page. The India VIX filter uses the previous session's close against the 60 sessions before it. Ichimoku swing (Daily/4h) and expiry max pain are <b>not backtested</b>: they need history and open-interest data this source does not have.</li>
      <li><b>The sample is small.</b> Yahoo only provides about 60 days of 5-minute data, roughly 40 sessions per index. Five indices move together, so they are not five independent tests. With under about 30 trades per strategy the confidence range is so wide that almost any result is consistent with luck. Rows with fewer than 30 trades are flagged. A flat or negative result is a valid result.</li>
      <li><b>Option P&amp;L is a model.</b> It captures the index move and time decay under a flat-volatility Black-Scholes world. It does not capture the real spread, skew, volatility changes, or how premiums behave in expiry week. Treat it as a better guide than index R, and still not as the truth.</li>
      <li><b>Do not tune on these sessions.</b> The parameters were fixed before testing. Changing them until this table looks good would only fit the noise in 40 sessions. The paper-trading sessions you log in the Journal are the only out-of-sample evidence you will have: 20 to 30 sessions is the minimum, 50 or more is better.</li>
      <li><b>Hit rate versus the reward.</b> With a 1R target, a strategy must hit more than about half the time just to cover costs; with a 2R target, more than about a third; with 3R, more than a quarter. Compare the hit rate with those break-evens, and look at the maximum drawdown in R against what you could actually tolerate.</li>
      <li><b>What would be convincing.</b> A few hundred trades per strategy over at least a year or two, covering trending, choppy and high-volatility periods, tested on real option premiums with costs. That needs intraday history longer than Yahoo gives, for example from a broker's historical data API (see lib/broker.js), and a train / test split. Treat this page as a sanity check on behaviour, not as proof.</li>
    </ul>
  </div>
</div>

<script>
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var REFRESH_MS = 60000;
  var PREF_KEY = "bs-idx-prefs";
  var LABEL = {
    orb_break: "ORB breakout (Track 1)", orb_retest: "ORB retest (Track 2)", ichi: "Ichimoku + Fib (intraday)", ichi_swing: "Ichimoku swing (Daily / 4h)",
    vwap_reclaim: "VWAP reclaim", vwap_pullback: "VWAP pullback", vwap_info: "Session average (proxy) — information only", expiry_maxpain: "Expiry max-pain"
  };
  function lab(id) { return LABEL[id] || id; }
  var state = { strat: "all", ix: "", actionable: false, live: true, busy: false, data: null, timer: null, failures: 0, last: {}, firstPaint: true };

  try {
    var saved = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    if (/^(all|orb|ichi|vwap|expiry)$/.test(saved.strat)) state.strat = saved.strat;
    if (typeof saved.actionable === "boolean") state.actionable = saved.actionable;
    if (typeof saved.live === "boolean") state.live = saved.live;
  } catch (e) {}
  $("act").checked = state.actionable;
  $("live").checked = state.live;
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ strat: state.strat, actionable: state.actionable, live: state.live })); } catch (e) {}
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function num(v, d) {
    return Number.isFinite(v) ? v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–";
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function clock(ts) { return new Date(ts).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false }); }
  function showBanner(kind, msg) { var b = $("banner"); b.className = "banner " + kind; b.textContent = msg; }
  function clearBanner() { var b = $("banner"); b.className = "banner"; b.textContent = ""; }
  function flash(node, dir) {
    node.classList.remove("flash-up", "flash-dn");
    void node.offsetWidth;
    node.classList.add(dir > 0 ? "flash-up" : "flash-dn");
  }
  function badgeClass(a) {
    return a === "BUY CE" ? "b-brk" : a === "BUY PE" ? "b-bdn" : a === "WAIT" ? "b-near" : "b-none";
  }
  function isActionable(a) { return a === "BUY CE" || a === "BUY PE"; }

  function flatten() {
    var out = [];
    if (!state.data) return out;
    state.data.indices.forEach(function (ix) {
      ix.rows.forEach(function (r) { out.push({ ix: ix, r: r }); });
    });
    return out;
  }
  function visible() {
    return flatten().filter(function (x) {
      if (state.strat !== "all" && x.r.group !== state.strat) return false;
      if (state.ix && x.ix.index !== state.ix) return false;
      if (state.actionable && !isActionable(x.r.action)) return false;
      return true;
    });
  }

  function planText(r) {
    var p = [];
    if (r.level != null) p.push((isActionable(r.action) || r.state === "TRIGGERED" ? "Entry " : "Level ") + num(r.level, 2));
    if (r.sl != null) p.push("SL " + num(r.sl, 2));
    if (r.t1 != null) p.push("T1 " + num(r.t1, 2));
    if (r.t2 != null) p.push("T2 " + num(r.t2, 2));
    if (r.option && isActionable(r.action)) p.push(r.option);
    return p.join(" · ");
  }
  function checksTip(r) {
    return (r.checks || []).map(function (c) { return (c.ok ? "✓ " : (c.info ? "– " : "✗ ")) + c.text; }).join("\n");
  }

  function tagClass(t) {
    if (t === "true VWAP" || t === "VIX ok" || t === "chain ok") return "good";
    if (t === "VIX blocked") return "bad";
    return "warn";
  }
  function tagsEl(r) {
    var d = el("div", "tags");
    (r.tags || []).forEach(function (t) { d.appendChild(el("span", "tag " + tagClass(t), t)); });
    if (r.reliability) d.appendChild(el("span", "tag " + (r.reliability === "high" ? "good" : r.reliability === "low" ? "bad" : "warn"), "reliability " + r.reliability));
    if (r.sizeHint === "skip") d.appendChild(el("span", "tag bad", "size skip"));
    else if (r.sizeHint && isActionable(r.action)) d.appendChild(el("span", "tag " + (r.sizeHint === "half" ? "warn" : "good"), "size " + r.sizeHint));
    if (r.trendSource) d.appendChild(el("span", "tag", "trend " + r.trendSource));
    if (r.blockedBy) d.appendChild(el("span", "tag bad", "held back by " + r.blockedBy));
    return d;
  }

  function buildRow(x, first) {
    var ix = x.ix, r = x.r;
    var tr = el("tr", (first ? "grp" : "") + (r.info ? " inforow" : ""));
    tr.dataset.strategy = r.strategy;
    var c0 = el("td", "sym", ix.name);
    if (ix.expiry) { var e = el("span", "exp", "EXPIRY"); e.title = "Expiry day: ORB, Ichimoku and VWAP entries are blocked"; c0.appendChild(e); }
    c0.appendChild(el("div", "subsec", r.label || lab(r.strategy)));
    var sm = el("div", "sm");
    var b2 = el("span", "badge " + badgeClass(r.action), r.action);
    b2.title = checksTip(r);
    sm.appendChild(b2);
    sm.appendChild(el("span", "stsm", r.state));
    var pl = planText(r);
    if (pl) sm.appendChild(el("span", "plansm", pl));
    else if (r.note) sm.appendChild(el("span", "plansm", r.note));
    sm.appendChild(tagsEl(r));
    c0.appendChild(sm);
    tr.appendChild(c0);

    var sg = el("td", "sig hide-sm");
    var bd = el("span", "badge " + badgeClass(r.action), r.action);
    bd.title = checksTip(r);
    sg.appendChild(bd);
    sg.appendChild(el("span", "st", r.state));
    if (r.note) sg.appendChild(el("small", null, r.note));
    if (r.levelNote) sg.appendChild(el("small", null, r.levelNote));
    if (r.trail && isActionable(r.action)) sg.appendChild(el("span", "trailtxt", "Trail (information only, not simulated): " + r.trail));
    sg.appendChild(tagsEl(r));
    tr.appendChild(sg);

    tr.appendChild(el("td", "num hide-sm", num(ix.ltp, 2)));
    var chg = el("td", "num hide-sm " + (ix.chgPct >= 0 ? "up" : "down"), Number.isFinite(ix.chgPct) ? (ix.chgPct >= 0 ? "+" : "") + num(ix.chgPct, 2) : "–");
    tr.appendChild(chg);
    tr.appendChild(el("td", "num hide-sm", r.level != null ? num(r.level, 2) : "–"));
    tr.appendChild(el("td", "num hide-sm", r.sl != null ? num(r.sl, 2) : "–"));
    tr.appendChild(el("td", "num hide-sm", r.t1 != null ? num(r.t1, 2) : "–"));
    tr.appendChild(el("td", "num hide-sm", r.t2 != null ? num(r.t2, 2) : "–"));
    tr.appendChild(el("td", "num hide-sm", r.riskPct != null ? num(r.riskPct, 2) : "–"));
    tr.appendChild(el("td", "opt hide-sm", r.option && isActionable(r.action) ? r.option : "–"));

    var cks = (r.checks || []).filter(function (c) { return !c.info; });
    var ok = cks.filter(function (c) { return c.ok; }).length;
    var ct = el("td", "chk hide-sm");
    if (cks.length) {
      var a = el("span", ok === cks.length ? "ok" : "no", ok + "/" + cks.length);
      ct.appendChild(a);
      ct.title = checksTip(r);
    } else { ct.textContent = "–"; }
    tr.appendChild(ct);

    var k = ix.index + "|" + r.strategy;
    var prev = state.last[k];
    if (!state.firstPaint && prev && prev !== r.action) {
      setTimeout(function () { flash(sg, isActionable(r.action) ? 1 : -1); }, 0);
    }
    return tr;
  }

  function showVix() {
    var m = state.data && state.data.meta, b = $("vixbar");
    if (!m) return;
    b.textContent = "";
    if (!m.vix || m.vix.unavailable) {
      b.appendChild(document.createTextNode("India VIX filter SKIPPED (" + ((m.vix && m.vix.unavailable) || "unavailable") + "). BUY signals are shown without the IV check, and every row is tagged VIX n/a."));
    } else {
      b.appendChild(document.createTextNode("India VIX " + num(m.vix.value, 2) + " vs its 60th percentile " + num(m.vix.p60, 2) + " over the last " + m.vix.sessions + " sessions: "));
      b.appendChild(el("b", m.vix.blocked ? "blk" : "okk", m.vix.blocked ? "ELEVATED, so every BUY is held back as WAIT" : "not elevated, the filter passes"));
    }
    b.appendChild(document.createTextNode(m.brokerConfigured ? " · Broker data adapter: configured." : " · Broker data adapter: not configured (no true VWAP, no option chain)."));
  }

  function render() {
    var tb = $("rows");
    tb.textContent = "";
    var rows = visible();
    if (!rows.length) {
      var tr = el("tr"), td = el("td", "empty", state.actionable
        ? "No rule set is signalling a buy right now. Waiting is a valid result; untick Actionable only to see where each setup stands."
        : "Nothing to show.");
      td.colSpan = 11; tr.appendChild(td); tb.appendChild(tr);
    } else {
      var lastIx = null;
      rows.forEach(function (x) { tb.appendChild(buildRow(x, x.ix.index !== lastIx)); lastIx = x.ix.index; });
    }
    var cur = {};
    flatten().forEach(function (x) { cur[x.ix.index + "|" + x.r.strategy] = x.r.action; });
    state.last = cur;
    state.firstPaint = false;
    setStatus(rows.length);
  }

  function setStatus(shown) {
    var m = state.data && state.data.meta;
    if (!m) return;
    var all = flatten();
    var buys = all.filter(function (x) { return isActionable(x.r.action); }).length;
    var when = m.marketOpen ? "Market open" : "Market closed, showing the last session";
    $("status").innerHTML = "<b>" + buys + "</b> buy signal" + (buys === 1 ? "" : "s") + " across " + state.data.indices.length + " indices · " +
      shown + " rows shown · " + when + " · latest tick " + esc(m.asOf || "n/a");
  }

  function showLive() {
    var box = $("liveinfo");
    box.textContent = "";
    var m = state.data && state.data.meta;
    if (!state.live || !m) { box.className = "liveinfo"; return; }
    var dot = el("span", "dot", "●");
    if (!m.marketOpen) {
      box.className = "liveinfo off";
      box.appendChild(dot);
      box.appendChild(document.createTextNode("Market closed: not refreshing."));
      return;
    }
    box.className = "liveinfo" + (state.failures > 0 ? " stale" : "");
    box.appendChild(dot);
    box.appendChild(document.createTextNode((state.failures > 0 ? "Refresh delayed, retrying" : "Live") + " · updated " + clock(Date.now()) + " IST"));
  }

  function rebuildIndexOptions() {
    var sel = $("ixsel");
    if (sel.options.length > 1 || !state.data) return;
    state.data.indices.forEach(function (ix) {
      var o = el("option", null, ix.name); o.value = ix.index; sel.appendChild(o);
    });
  }

  function schedule() {
    clearTimeout(state.timer);
    state.timer = null;
    var m = state.data && state.data.meta;
    if (state.live && !document.hidden && m && m.marketOpen) {
      state.timer = setTimeout(function () { load(true); }, Math.min(300000, REFRESH_MS * (1 + state.failures)));
    }
    showLive();
  }

  async function load(silent) {
    if (state.busy) return;
    state.busy = true;
    if (!silent) {
      $("scan").disabled = true;
      clearBanner();
      $("status").innerHTML = '<span class="spin"></span>Checking the rules on every index. This usually takes a few seconds.';
    }
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, 40000);
    try {
      var res = await fetch("/api/indices", { signal: ctrl.signal });
      var data = await res.json();
      if (!res.ok) {
        state.failures++;
        if (!silent || !state.data) {
          showBanner("err", (data.error || "Request failed") + (data.detail ? " [" + data.detail + "]" : "") + (data.hint ? " " + data.hint : ""));
          if (!state.data) $("status").textContent = "";
        }
      } else {
        state.failures = 0;
        state.data = data;
        rebuildIndexOptions();
        render();
        showVix();
        chartTick();
        if (data.warnings && data.warnings.length) showBanner("warn", data.warnings.join(" ")); else clearBanner();
      }
    } catch (e) {
      state.failures++;
      if (!silent || !state.data) {
        showBanner("err", e.name === "AbortError" ? "That took too long. Try again in a moment." : "Could not load results: " + e.message);
        if (!state.data) $("status").textContent = "";
      }
    } finally {
      clearTimeout(to);
      state.busy = false;
      $("scan").disabled = false;
    }
    schedule();
  }

  document.querySelectorAll("#strat button").forEach(function (b) {
    b.classList.toggle("on", b.dataset.v === state.strat);
    b.addEventListener("click", function () {
      state.strat = b.dataset.v;
      document.querySelectorAll("#strat button").forEach(function (x) { x.classList.toggle("on", x === b); });
      savePrefs();
      render();
    });
  });
  $("ixsel").addEventListener("change", function () { state.ix = $("ixsel").value; render(); });
  $("act").addEventListener("change", function () { state.actionable = $("act").checked; savePrefs(); render(); });
  $("scan").addEventListener("click", function () { load(false); });
  $("live").addEventListener("change", function () {
    state.live = $("live").checked;
    savePrefs();
    if (state.live) schedule(); else { clearTimeout(state.timer); showLive(); }
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { clearTimeout(state.timer); } else { schedule(); }
  });

  // =====================================================================
  // Chart: 5-minute candles of one index, rule levels and replayed signals
  // =====================================================================
  var IXS = [["NIFTY", "NIFTY 50"], ["BANKNIFTY", "BANKNIFTY"], ["FINNIFTY", "FINNIFTY"], ["MIDCPNIFTY", "MIDCPNIFTY"], ["NIFTYNXT50", "NXT 50"]];
  var STEP = { NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25, NIFTYNXT50: 100 };
  var SHORT = { orb_break: "ORB-1", orb_retest: "ORB-2", ichi: "ICHI", vwap_reclaim: "VWAP-R", vwap_pullback: "VWAP-P" };
  var chart = { ix: "NIFTY", date: "", data: null, busy: false, hover: -1, err: "", geo: null };
  var SLOTS = 75, OPEN_MM = 555;

  function hm(mm) { return ("0" + Math.floor(mm / 60)).slice(-2) + ":" + ("0" + (mm % 60)).slice(-2); }
  function fr(v) { return Number.isFinite(v) ? (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2) + "R" : "–"; }
  function css(name, dflt) { var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || dflt; }

  IXS.forEach(function (p) {
    var b = el("button", p[0] === chart.ix ? "on" : "", p[1]);
    b.dataset.v = p[0];
    b.addEventListener("click", function () {
      chart.ix = p[0]; chart.date = ""; chart.hover = -1;
      document.querySelectorAll("#cix button").forEach(function (x) { x.classList.toggle("on", x === b); });
      chartLoad(false);
    });
    $("cix").appendChild(b);
  });
  $("cdate").addEventListener("change", function () { chart.date = $("cdate").value; chartLoad(false); });
  ["cOrb", "cAvg", "cSig"].forEach(function (id) { $(id).addEventListener("change", drawChart); });

  async function chartLoad(silent) {
    if (chart.busy) return;
    chart.busy = true;
    if (!silent) $("cinfo").textContent = "Loading chart…";
    try {
      var res = await fetch("/api/indexchart?index=" + encodeURIComponent(chart.ix) + (chart.date ? "&date=" + encodeURIComponent(chart.date) : ""));
      var d = await res.json();
      if (!res.ok) throw new Error((d.error || "HTTP " + res.status) + (d.detail ? " [" + d.detail + "]" : ""));
      chart.data = d; chart.err = "";
      chart.date = d.date;
      var sel = $("cdate");
      sel.textContent = "";
      d.dates.forEach(function (x, i) { var o = el("option", null, x + (i === 0 ? " (latest)" : "")); o.value = x; sel.appendChild(o); });
      sel.value = d.date;
      $("cAvgName").textContent = d.vwapIsProxy ? "Session average price" : "VWAP";
      $("cinfo").textContent = "Hover or touch the chart to read a candle. Data to " + d.asOf + (d.live ? " (session in progress, last candle still forming)" : "") + (d.expiry ? " · EXPIRY DAY: signals are blocked" : "");
    } catch (e) {
      chart.err = e.name === "AbortError" ? "Timed out" : e.message;
      if (!chart.data || !silent) $("cinfo").textContent = "Could not load the chart: " + chart.err;
    } finally {
      chart.busy = false;
    }
    drawChart(); renderSignals(); renderChain();
  }
  function chartTick() {
    if (!$("liveView").hidden && state.live && chart.data && chart.data.live && !document.hidden) chartLoad(true);
  }

  function drawChart() {
    var cv = $("cv"), d = chart.data;
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    var g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    var C = { green: css("--green", "#22c55e"), red: css("--red", "#ef4444"), amber: css("--amber", "#f59e0b"), blue: css("--blue", "#3b82f6"), muted: css("--muted", "#8a97b8"), line: css("--line", "#1b2742"), text: css("--text", "#e6ecff") };
    g.font = "11px system-ui, sans-serif";
    if (!d || !d.bars || !d.bars.length) {
      g.fillStyle = C.muted; g.fillText(chart.err ? "Chart unavailable: " + chart.err : "No candles yet.", 12, 24);
      return;
    }
    var showOrb = $("cOrb").checked && d.orb, showAvg = $("cAvg").checked, showSig = $("cSig").checked;
    var L = 6, R = 66, T = 10, B = 22, pw = w - L - R, ph = h - T - B, slot = pw / SLOTS;
    var lo = Infinity, hi = -Infinity;
    function ext(v) { if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    d.bars.forEach(function (b) { ext(b.hi); ext(b.lo); });
    if (showOrb) { ext(d.orb.hi); ext(d.orb.lo); }
    if (showAvg) d.vwap.forEach(ext);
    if (showSig) d.signals.forEach(function (s) { ext(s.sl); ext(s.t1); });
    var pad = (hi - lo) * 0.05 || 1;
    var y0 = hi + pad, span = hi - lo + 2 * pad;
    function y(v) { return T + (y0 - v) / span * ph; }
    function xb(mm) { return L + (mm - OPEN_MM) / 5 * slot; }
    function xc(mm) { return xb(mm) + slot / 2; }
    chart.geo = { L: L, slot: slot, T: T, ph: ph, w: w, h: h };

    // grid and axes
    g.strokeStyle = C.line; g.fillStyle = C.muted; g.lineWidth = 1;
    g.textAlign = "left"; g.textBaseline = "middle";
    for (var k = 0; k <= 5; k++) {
      var v = y0 - span * k / 5, yy = Math.round(y(v)) + 0.5;
      g.beginPath(); g.moveTo(L, yy); g.lineTo(L + pw, yy); g.stroke();
      g.fillText(v.toLocaleString("en-IN", { maximumFractionDigits: 0 }), L + pw + 6, yy);
    }
    g.textAlign = "center"; g.textBaseline = "top";
    for (var m = 600; m <= 900; m += 60) {
      var xx = Math.round(xb(m)) + 0.5;
      g.beginPath(); g.moveTo(xx, T); g.lineTo(xx, T + ph); g.stroke();
      g.fillText(hm(m), xx, T + ph + 5);
    }
    // opening range
    if (showOrb) {
      g.fillStyle = "rgba(59,130,246,.10)";
      g.fillRect(xb(555), y(d.orb.hi), 3 * slot, y(d.orb.lo) - y(d.orb.hi));
      g.strokeStyle = C.blue; g.setLineDash([5, 4]); g.lineWidth = 1;
      [d.orb.hi, d.orb.lo].forEach(function (v) { g.beginPath(); g.moveTo(xb(555), y(v)); g.lineTo(L + pw, y(v)); g.stroke(); });
      g.setLineDash([]);
      g.fillStyle = C.blue; g.textAlign = "left"; g.textBaseline = "bottom";
      g.fillText("OR high", L + pw - 44, y(d.orb.hi) - 2);
      g.textBaseline = "top"; g.fillText("OR low", L + pw - 40, y(d.orb.lo) + 2);
    }
    // previous close
    if (Number.isFinite(d.prevClose) && d.prevClose >= y0 - span && d.prevClose <= y0) {
      g.strokeStyle = C.muted; g.setLineDash([2, 4]);
      g.beginPath(); g.moveTo(L, y(d.prevClose)); g.lineTo(L + pw, y(d.prevClose)); g.stroke(); g.setLineDash([]);
      g.fillStyle = C.muted; g.textAlign = "left"; g.textBaseline = "bottom"; g.fillText("prev close", L + 4, y(d.prevClose) - 2);
    }
    // candles
    var bw = Math.max(1, slot * 0.68);
    d.bars.forEach(function (b) {
      var cx = xc(b.mm), up = b.cl >= b.o, col = up ? C.green : C.red;
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
      g.beginPath(); g.moveTo(Math.round(cx) + 0.5, y(b.hi)); g.lineTo(Math.round(cx) + 0.5, y(b.lo)); g.stroke();
      var top = y(Math.max(b.o, b.cl)), bh = Math.max(1, Math.abs(y(b.o) - y(b.cl)));
      g.fillRect(cx - bw / 2, top, bw, bh);
    });
    // average price / VWAP
    if (showAvg) {
      g.strokeStyle = C.amber; g.lineWidth = 1.5; g.beginPath();
      d.bars.forEach(function (b, i) { var px = xc(b.mm), py = y(d.vwap[i]); if (i) g.lineTo(px, py); else g.moveTo(px, py); });
      g.stroke(); g.lineWidth = 1;
    }
    // signals
    if (showSig) d.signals.forEach(function (s) {
      var long = s.side === "long", col = long ? C.green : C.red;
      var endMM = Math.min(930, Math.max(s.x1.exitMM || 0, s.x2.exitMM || 0) || (d.bars[d.bars.length - 1].mm + 5));
      var xa = xb(s.entryMM), xe = xb(endMM);
      g.lineWidth = 1; g.setLineDash([4, 3]);
      [[s.sl, C.red, 1], [s.t1, C.green, 1], [s.t2, C.green, 0.45]].forEach(function (p) {
        g.globalAlpha = p[2]; g.strokeStyle = p[1];
        g.beginPath(); g.moveTo(xa, y(p[0])); g.lineTo(xe, y(p[0])); g.stroke();
      });
      g.globalAlpha = 1; g.setLineDash([]);
      g.fillStyle = col; g.beginPath();
      var ey = y(s.entry);
      if (long) { g.moveTo(xa, ey - 2); g.lineTo(xa - 6, ey + 9); g.lineTo(xa + 6, ey + 9); }
      else { g.moveTo(xa, ey + 2); g.lineTo(xa - 6, ey - 9); g.lineTo(xa + 6, ey - 9); }
      g.closePath(); g.fill();
      g.textAlign = "left"; g.textBaseline = long ? "top" : "bottom";
      g.fillText(SHORT[s.strategy] + (long ? " CE" : " PE"), xa + 8, long ? ey + 3 : ey - 3);
      [[s.x1, true], [s.x2, false]].forEach(function (p) {
        var x = p[0]; if (!x.exitMM || x.outcome === "OPEN") return;
        g.beginPath(); g.arc(xb(x.exitMM), y(x.exitPrice), p[1] ? 3.5 : 3, 0, 6.2832);
        g.strokeStyle = x.r > 0 ? C.green : C.red; g.fillStyle = x.r > 0 ? C.green : C.red;
        if (p[1]) g.fill(); else g.stroke();
      });
    });
    // crosshair
    if (chart.hover >= 0 && chart.hover < d.bars.length) {
      var hb = d.bars[chart.hover], hx = Math.round(xc(hb.mm)) + 0.5;
      g.strokeStyle = C.muted; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(hx, T); g.lineTo(hx, T + ph); g.stroke(); g.setLineDash([]);
    }
    // last price tag
    var lb = d.bars[d.bars.length - 1];
    g.fillStyle = lb.cl >= lb.o ? C.green : C.red;
    g.fillRect(L + pw + 2, y(lb.cl) - 8, R - 4, 16);
    g.fillStyle = "#04120a"; g.textAlign = "left"; g.textBaseline = "middle";
    g.fillText(lb.cl.toLocaleString("en-IN", { maximumFractionDigits: 1 }), L + pw + 5, y(lb.cl));
    var lg = $("cleg");
    lg.textContent = "";
    lg.appendChild(document.createTextNode("5-minute candles. Blue band: 9:15 to 9:30 opening range. Amber line: " + d.vwapLabel.toLowerCase() + ". "));
    if (d.vwapIsProxy) lg.appendChild(el("b", null, "This is NOT a true VWAP: the index feed has no volume, so the line is an equal-weighted session average (proxy), and the VWAP rules do not trade on it. "));
    lg.appendChild(document.createTextNode("Triangle: where a rule would have said BUY. Red dashed: stop. Green dashed: T1 (solid shade) and T2 (faint). Filled dot: exit under the T1 plan, ring: exit under the T2 plan."));
  }

  function chartPoint(ev) {
    var cv = $("cv"), r = cv.getBoundingClientRect(), d = chart.data, G = chart.geo;
    if (!d || !G) return;
    var i = Math.floor((ev.clientX - r.left - G.L) / G.slot);
    var idx = -1;
    for (var k = 0; k < d.bars.length; k++) if ((d.bars[k].mm - OPEN_MM) / 5 === i) { idx = k; break; }
    chart.hover = idx;
    if (idx >= 0) {
      var b = d.bars[idx], n = function (v) { return v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
      $("cinfo").textContent = hm(b.mm) + "  O " + n(b.o) + "  H " + n(b.hi) + "  L " + n(b.lo) + "  C " + n(b.cl) + "  · " + d.vwapLabel.toLowerCase() + " " + n(d.vwap[idx]);
    }
    drawChart();
  }
  $("cv").addEventListener("pointermove", chartPoint);
  $("cv").addEventListener("pointerdown", chartPoint);
  $("cv").addEventListener("pointerleave", function () { chart.hover = -1; drawChart(); });

  function outTxt(x) {
    if (!x) return "";
    var w = x.outcome === "TGT" ? "target hit" : x.outcome === "SL" ? "stopped out" : x.outcome === "EOD" ? "time exit" : "still open";
    return w + " " + fr(x.r) + (x.exitMM ? " at " + hm(x.exitMM) : "");
  }
  function renderSignals() {
    var ul = $("siglist"), d = chart.data;
    ul.textContent = "";
    if (!d) return;
    if (!d.signals.length) {
      ul.appendChild(el("li", "dim", "No BUY signal from any replayable rulebook " + (d.live ? "so far in this session." : "in this session.")));
    }
    if (d.vix) ul.appendChild(el("li", "dim", d.vix.unavailable ? "India VIX filter skipped (" + d.vix.unavailable + ")." : "India VIX (previous close) " + num(d.vix.value, 2) + " vs 60th percentile " + num(d.vix.p60, 2) + (d.vix.blocked ? ": ELEVATED, BUY signals are held back this session." : ": not elevated.")));
    (d.blocked || []).forEach(function (b) {
      ul.appendChild(el("li", "dim", lab(b.strategy) + " would have said BUY " + (b.side === "long" ? "CE" : "PE") + " at " + hm(b.entryMM) + " but was held back by " + (b.by === "vix" ? "the India VIX filter" : "the opening-range size rule") + "."));
    });
    if (!d.signals.length) return;
    d.signals.forEach(function (s) {
      var n = function (v) { return v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
      ul.appendChild(el("li", null,
        lab(s.strategy) + " · BUY " + (s.side === "long" ? "CE" : "PE") + (s.sizeHint === "half" ? " (HALF SIZE)" : "") + " at " + hm(s.entryMM) + ", index " + n(s.entry) +
        " · SL " + n(s.sl) + " · T1 " + n(s.t1) + " · T2 " + n(s.t2) +
        " → T1 plan: " + outTxt(s.x1) + " · T2 plan: " + outTxt(s.x2)));
    });
  }
  function renderChain() {
    var d = chart.data, info = $("chainInfo"), tb = $("ladder");
    tb.textContent = "";
    if (!d || !d.bars.length) { info.textContent = "No price yet."; return; }
    var step = STEP[chart.ix] || 50, px = d.bars[d.bars.length - 1].cl, atm = Math.round(px / step) * step;
    info.textContent = d.name + " last " + num(px, 2) + " · ATM strike " + num(atm, 0) + " · strike step " + step + (d.expiry ? " · expiry day (rules block entries)" : "") + (d.live ? "" : " · as of that session's close");
    for (var k = 3; k >= -3; k--) {
      var s = atm + k * step, tr = el("tr");
      tr.appendChild(el("td", null, s === atm ? "ATM" : s < px ? "ITM" : "OTM"));
      var sc = el("td", null, num(s, 0)); sc.style.fontWeight = s === atm ? "700" : "400"; tr.appendChild(sc);
      tr.appendChild(el("td", null, s === atm ? "ATM" : s > px ? "ITM" : "OTM"));
      tb.appendChild(tr);
    }
  }

  // =====================================================================
  // Backtest view
  // =====================================================================
  var BT = { rows: {}, running: false };
  var ALLKEYS = IXS.map(function (p) { return p[0]; });
  var BT_IDS = ["orb_break", "orb_retest", "ichi", "vwap_reclaim", "vwap_pullback"];
  var BT_COL = { orb_break: "#3b82f6", orb_retest: "#93c5fd", ichi: "#22c55e", vwap_reclaim: "#f59e0b", vwap_pullback: "#a78bfa" };
  var SUM_KEY = "bs-bt-summary";

  $("view").querySelectorAll("button").forEach(function (b) {
    b.addEventListener("click", function () {
      var bt = b.dataset.v === "bt";
      $("view").querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
      $("liveView").hidden = bt;
      $("btView").hidden = !bt;
      if (bt) btRender(); else { drawChart(); }
    });
  });
  window.addEventListener("resize", function () { if (!$("liveView").hidden) drawChart(); else btDrawEquity(); });

  function btShowBanner(kind, msg) { var b = $("btBanner"); b.className = "banner " + kind; b.textContent = msg; }
  function btClearBanner() { var b = $("btBanner"); b.className = "banner"; b.textContent = ""; }

  async function btRun() {
    if (BT.running) return;
    BT.running = true; BT.rows = {};
    btClearBanner();
    $("btRun").disabled = true;
    var sel = $("btix").value, keys = sel === "ALL" ? ALLKEYS : [sel], fails = [];
    for (var i = 0; i < keys.length; i++) {
      $("btStatus").innerHTML = '<span class="spin"></span>Replaying ' + esc(keys[i]) + " (" + (i + 1) + " of " + keys.length + "). Each index takes a few seconds to a minute.";
      var ctrl = new AbortController(), to = setTimeout(function () { ctrl.abort(); }, 70000);
      try {
        var res = await fetch("/api/backtest?index=" + encodeURIComponent(keys[i]), { signal: ctrl.signal });
        var d = await res.json();
        if (!res.ok) throw new Error((d.error || "HTTP " + res.status) + (d.detail ? " [" + d.detail + "]" : ""));
        BT.rows[keys[i]] = d;
        btRender();
      } catch (e) {
        fails.push(keys[i] + ": " + (e.name === "AbortError" ? "timed out" : e.message));
      } finally { clearTimeout(to); }
    }
    BT.running = false;
    $("btRun").disabled = false;
    var done = Object.keys(BT.rows).length;
    $("btStatus").textContent = done ? "Done: " + done + " of " + keys.length + " indices replayed." : "No index could be replayed.";
    var notes = [];
    if (fails.length) notes.push("Some indices failed: " + fails.join(" | "));
    var anyNoVix = Object.keys(BT.rows).some(function (k) { return !BT.rows[k].vix || !BT.rows[k].vix.available; });
    if (anyNoVix) notes.push("India VIX could not be fetched, so the VIX filter was skipped and option P&L could not be computed.");
    if (notes.length) btShowBanner("warn", notes.join(" "));
    btRender();
  }
  $("btRun").addEventListener("click", btRun);
  ["btCost", "btOptCost"].forEach(function (id) { $(id).addEventListener("input", btRender); });
  ["btPlan", "btStrike", "dgStrat"].forEach(function (id) { $(id).addEventListener("change", btRender); });
  $("btToggle").addEventListener("click", function () {
    var w = $("btTradesWrap"); w.hidden = !w.hidden; $("btToggle").textContent = w.hidden ? "Show" : "Hide";
  });

  function num0(id, d) { var c = parseFloat($(id).value); return Number.isFinite(c) && c >= 0 ? c : d; }
  function cost() { return num0("btCost", 0); }
  function optCost() { return num0("btOptCost", 0); }
  function plan() { return $("btPlan").value === "x2" ? "x2" : "x1"; }
  function strike() { return $("btStrike").value === "itm" ? "itm" : "atm"; }
  function allTrades() {
    var out = [];
    Object.keys(BT.rows).forEach(function (k) { (BT.rows[k].trades || []).forEach(function (t) { out.push(t); }); });
    return out;
  }
  function chrono(ts) {
    return ts.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.entryMM - b.entryMM; });
  }
  function meanCI(rs) {
    var n = rs.length;
    if (!n) return null;
    var sum = 0; rs.forEach(function (r) { sum += r; });
    var avg = sum / n, v = 0;
    rs.forEach(function (r) { v += (r - avg) * (r - avg); });
    var se = n > 1 ? Math.sqrt(v / (n - 1) / n) : null;
    return { n: n, avg: avg, lo: se == null ? null : avg - 1.96 * se, hi: se == null ? null : avg + 1.96 * se };
  }
  // Index-R statistics for a plan (x1 or x2). x.r already includes the half-size scaling.
  function stats(ts, which, c) {
    var n = ts.length;
    if (!n) return null;
    ts = chrono(ts);
    var rs = ts.map(function (t) { return t[which].r - c; });
    var sum = 0, gain = 0, loss = 0, hit = 0, cum = 0, peak = 0, dd = 0, run = 0, worst = 0;
    ts.forEach(function (t, i) {
      var r = rs[i];
      sum += r; if (r > 0) gain += r; else loss -= r;
      if (t[which].outcome === "TGT") hit++;
      cum += r; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum;
      if (r <= 0) { run++; if (run > worst) worst = run; } else run = 0;
    });
    var m = meanCI(rs);
    var p = hit / n, z = 1.96, den = 1 + z * z / n, ctr = (p + z * z / (2 * n)) / den;
    var half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
    return { n: n, avg: m.avg, lo: m.lo, hi: m.hi, total: sum,
      pf: loss > 0 ? gain / loss : null, dd: dd, worst: worst, hit: p, hitLo: Math.max(0, ctr - half), hitHi: Math.min(1, ctr + half) };
  }
  // Option statistics: Black-Scholes premium change, net of the option cost (percent of premium).
  function optList(ts, which, scen) {
    var st = strike(), cp = optCost(), out = [];
    ts.forEach(function (t) {
      var o = t.opt && t.opt[which] && t.opt[which][st];
      if (!o || !o[scen]) return;
      var src = scen === "noIv" && o.real ? o.real : o[scen]; // real broker premium when the adapter supplied one
      out.push({ r: src.r - (cp / 100) / o.riskFrac * t.scale, pct: src.pct - cp, real: src === o.real });
    });
    return out;
  }
  function optStats(ts, which, scen) {
    var l = optList(ts, which, scen);
    if (!l.length) return null;
    var m = meanCI(l.map(function (x) { return x.r; }));
    var pc = 0; l.forEach(function (x) { pc += x.pct; });
    m.pct = pc / l.length;
    m.real = l.filter(function (x) { return x.real; }).length;
    m.of = ts.length;
    return m;
  }
  function pct(v) { return Number.isFinite(v) ? Math.round(v * 100) + "%" : "–"; }
  function rng(s) { return s.lo == null ? "" : " (" + fr(s.lo).replace("R", "") + " to " + fr(s.hi).replace("R", "") + ")"; }
  function th(tr, labels) { labels.forEach(function (t) { tr.appendChild(el("th", null, t)); }); }
  function td(tr, text, cls) { var c = el("td", cls || "num", text); tr.appendChild(c); return c; }
  function lowN(c, n) { if (n < 30) c.appendChild(el("span", "lowN", "few trades")); }
  function tone(m) { return m && m.lo != null && m.lo > 0 ? "num up" : m && m.hi != null && m.hi < 0 ? "num down" : "num"; }
  function optCell(tr, ts, which, scen) {
    var m = optStats(ts, which, scen);
    if (!m) { td(tr, ts.length ? "n/a (no VIX)" : "–"); return; }
    var c = td(tr, fr(m.avg) + rng(m) + " · " + (m.pct >= 0 ? "+" : "−") + Math.abs(m.pct).toFixed(1) + "% premium", tone(m));
    if (m.n < m.of) c.appendChild(el("span", "lowN", m.n + " of " + m.of + " priced"));
    if (m.real) c.appendChild(el("span", "lowN", m.real + " with real broker premium"));
  }
  function ctable(parent, head, rows, foot) {
    var t = el("table", "bt mini"), hr = el("tr");
    th(hr, head); t.appendChild(el("thead")).appendChild(hr);
    var tb = el("tbody");
    rows.forEach(function (r) { var tr = el("tr"); r.forEach(function (v, i) { td(tr, v, i === 0 ? "l" : "num"); }); tb.appendChild(tr); });
    if (foot) { var f = el("tr"); foot.forEach(function (v, i) { var c = td(f, v, i === 0 ? "l" : "num"); c.style.fontWeight = "700"; }); tb.appendChild(f); }
    t.appendChild(tb);
    var w = el("div", "wrap"); w.appendChild(t); parent.appendChild(w);
  }

  function btRender() {
    var keys = Object.keys(BT.rows), all = allTrades(), c = cost(), W = plan();
    $("btOut").hidden = !keys.length;
    if (!keys.length) return;
    var first = BT.rows[keys[0]];

    var sum = $("btSum"); sum.textContent = "";
    var hr = el("tr"); th(hr, ["Strategy", "Trades", "Target hit", "Index R", "Option P&L (BS, no IV change)", "Option P&L (BS, −10% IV)", "Profit factor (index)", "Max drawdown R", "Longest losing run", "Blocked (VIX / size)"]);
    sum.appendChild(el("thead")).appendChild(hr);
    var sb = el("tbody");
    BT_IDS.forEach(function (s) {
      var ts = all.filter(function (t) { return t.strategy === s; }), a = stats(ts, W, c), tr = el("tr");
      tr.dataset.strategy = s;
      td(tr, lab(s), "l");
      var bl = 0, bz = 0;
      keys.forEach(function (k) { var b = (BT.rows[k].blocked || {})[s]; if (b) { bl += b.vix || 0; bz += b.size || 0; } });
      if (!a) { td(tr, "0"); td(tr, "–"); td(tr, "–"); td(tr, "–"); td(tr, "–"); td(tr, "–"); td(tr, "–"); td(tr, "–"); td(tr, bl + " / " + bz); sb.appendChild(tr); return; }
      lowN(td(tr, String(a.n)), a.n);
      td(tr, pct(a.hit) + " (" + pct(a.hitLo) + " to " + pct(a.hitHi) + ")");
      td(tr, fr(a.avg) + rng(a), tone(a));
      optCell(tr, ts, W, "noIv");
      optCell(tr, ts, W, "crush");
      td(tr, a.pf == null ? "–" : a.pf.toFixed(2));
      td(tr, a.dd.toFixed(2) + "R");
      td(tr, String(a.worst));
      td(tr, bl + " / " + bz);
      sb.appendChild(tr);
    });
    (first.notBacktested || []).forEach(function (nb) {
      var tr = el("tr", "nobt"); tr.dataset.strategy = nb.strategy;
      td(tr, nb.label, "l");
      var cc = td(tr, "Not backtested: " + nb.why, "l"); cc.colSpan = 9; cc.style.whiteSpace = "normal";
      sb.appendChild(tr);
    });
    sum.appendChild(sb);

    var ix = $("btIdx"); ix.textContent = "";
    var h2 = el("tr"); th(h2, ["Index", "Strategy", "Trades", "Target hit", "Index R", "Option P&L (BS, no IV change)"]);
    ix.appendChild(el("thead")).appendChild(h2);
    var ib = el("tbody");
    keys.forEach(function (k) {
      BT_IDS.forEach(function (s) {
        var ts = (BT.rows[k].trades || []).filter(function (t) { return t.strategy === s; }), a = stats(ts, W, c), tr = el("tr");
        td(tr, BT.rows[k].name, "l"); td(tr, lab(s), "l");
        if (!a) { td(tr, "0"); td(tr, "–"); td(tr, "–"); td(tr, "–"); ib.appendChild(tr); return; }
        td(tr, String(a.n)); td(tr, pct(a.hit));
        td(tr, fr(a.avg), a.avg >= 0 ? "num up" : "num down");
        optCell(tr, ts, W, "noIv");
        ib.appendChild(tr);
      });
    });
    ix.appendChild(ib);
    $("btMeta").textContent = keys.map(function (k) {
      var r = BT.rows[k];
      return r.name + ": " + r.sessions + " sessions " + (r.from || "?") + " to " + (r.to || "?") + ", " + r.expiryDays + " expiry days skipped" +
        (r.skippedShort ? ", " + r.skippedShort + " short or incomplete days skipped" : "") + (r.truncated ? ", STOPPED EARLY (time limit)" : "") +
        (r.volumeInFeed ? "" : ", no volume in the feed (VWAP rules cannot trade, volume filters skipped)") +
        (r.vix && r.vix.available ? "" : ", India VIX unavailable (filter skipped, no option P&L)") + ", data: " + r.source + ", option P&L: " + (r.option && r.option.premiumSource);
    }).join(" · ");

    var tt = $("btTrades"); tt.textContent = "";
    var h3 = el("tr"); th(h3, ["Date", "Index", "Strategy", "Side", "Entry time", "Entry", "Stop", "Size", "Exit", "Index R", "Option R (BS, no IV change)", "Option R (BS, −10% IV)"]);
    tt.appendChild(el("thead")).appendChild(h3);
    var tbd = el("tbody"), cp = optCost();
    chrono(all).reverse().slice(0, 400).forEach(function (t) {
      var tr = el("tr"), x = t[W], o = t.opt && t.opt[W] && t.opt[W][strike()];
      td(tr, t.date, "l"); td(tr, t.index, "l"); td(tr, lab(t.strategy), "l"); td(tr, t.side === "long" ? "CE" : "PE", "l");
      td(tr, hm(t.entryMM)); td(tr, num(t.entry, 2)); td(tr, num(t.sl, 2)); td(tr, t.sizeHint || "full", "l");
      td(tr, outTxt(x), "l");
      td(tr, fr(x.r - c), x.r - c > 0 ? "num up" : "num down");
      [["noIv"], ["crush"]].forEach(function (sc) {
        if (!o || !o[sc[0]]) { td(tr, "–"); return; }
        var v = (sc[0] === "noIv" && o.real ? o.real.r : o[sc[0]].r) - (cp / 100) / o.riskFrac * t.scale;
        td(tr, fr(v), v > 0 ? "num up" : "num down");
      });
      tbd.appendChild(tr);
    });
    tt.appendChild(tbd);
    btDiag(all);
    btDrawEquity();
    saveSummary(all);
  }

  // ---- diagnostics: every table adds up to the trade count ----
  var HB = ["9:30–10:30", "10:30–11:30", "11:30–13:00", "13:00–14:30"];
  var WD = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  function hourBucket(mm) { return mm < 630 ? 0 : mm < 690 ? 1 : mm < 780 ? 2 : 3; }
  function weekday(iso) { var d = new Date(iso + "T00:00:00Z").getUTCDay(); return Math.min(4, Math.max(0, d - 1)); }
  function klass(t) { return t.x1.outcome === "SL" ? "Stopped before T1" : t.x2.outcome === "TGT" ? "Reached T2" : t.x1.outcome === "TGT" ? "Reached T1, not T2" : t.x1.outcome === "EOD" ? "Time exit (15:15)" : "Still open"; }
  function btDiag(all) {
    var sel = $("dgStrat");
    if (!sel.options.length) {
      var o0 = el("option", null, "All strategies"); o0.value = "all"; sel.appendChild(o0);
      BT_IDS.forEach(function (id) { var o = el("option", null, lab(id)); o.value = id; sel.appendChild(o); });
    }
    var ts = sel.value === "all" ? all : all.filter(function (t) { return t.strategy === sel.value; });
    var out = $("dgOut"); out.textContent = "";
    var W = plan(), c = cost(), N = ts.length;
    function block(title, head, rows, foot, check) {
      var d = el("div"); d.appendChild(el("h3", null, title));
      ctable(d, head, rows, foot);
      d.appendChild(el("div", "chk2", check));
      out.appendChild(d);
    }
    function avgR(a) { return a.length ? fr(a.reduce(function (s, t) { return s + t[W].r - c; }, 0) / a.length) : "–"; }
    function hitR(a) { return a.length ? pct(a.filter(function (t) { return t[W].r - c > 0; }).length / a.length) : "–"; }
    function group(names, key) {
      var g = names.map(function () { return []; });
      ts.forEach(function (t) { g[key(t)].push(t); });
      return g;
    }
    // outcomes
    var oc = ["Stopped before T1", "Reached T1, not T2", "Reached T2", "Time exit (15:15)", "Still open"], og = {};
    oc.forEach(function (k) { og[k] = []; });
    ts.forEach(function (t) { og[klass(t)].push(t); });
    var cnt = oc.map(function (k) { return og[k].length; }), tot = cnt.reduce(function (a, b) { return a + b; }, 0);
    block("Outcomes", ["Outcome", "Trades", "Share", "Avg R (" + (W === "x1" ? "T1" : "T2") + " plan)"], oc.map(function (k) { return [k, String(og[k].length), N ? pct(og[k].length / N) : "–", avgR(og[k])]; }), ["Total", String(tot), N ? "100%" : "–", avgR(ts)], "Adds up: " + tot + " of " + N);
    // stops
    var sp = 0, spp = 0; ts.forEach(function (t) { sp += Math.abs(t.entry - t.sl); spp += t.riskPct; });
    var byIx = {}; ts.forEach(function (t) { (byIx[t.index] = byIx[t.index] || []).push(t); });
    var ixr = Object.keys(byIx).map(function (k) { var a = byIx[k]; var p = 0, q = 0; a.forEach(function (t) { p += Math.abs(t.entry - t.sl); q += t.riskPct; }); return [k, String(a.length), num(p / a.length, 1), num(q / a.length, 2) + "%"]; });
    var ixt = Object.keys(byIx).reduce(function (s, k) { return s + byIx[k].length; }, 0);
    block("Average stop distance", ["Index", "Trades", "Avg stop (points)", "Avg stop (% of price)"], ixr, ["All", String(N), N ? num(sp / N, 1) : "–", N ? num(spp / N, 2) + "%" : "–"], "Adds up: " + ixt + " of " + N);
    // side
    var sg = group(["CE", "PE"], function (t) { return t.side === "long" ? 0 : 1; });
    block("By side", ["Side", "Trades", "Win rate", "Avg index R"], [["CE (long)", String(sg[0].length), hitR(sg[0]), avgR(sg[0])], ["PE (short)", String(sg[1].length), hitR(sg[1]), avgR(sg[1])]], ["Total", String(sg[0].length + sg[1].length), hitR(ts), avgR(ts)], "Adds up: " + (sg[0].length + sg[1].length) + " of " + N);
    // hour
    var hg = group(HB, function (t) { return hourBucket(t.entryMM); }), hn = hg.reduce(function (s, a) { return s + a.length; }, 0);
    block("By entry time", ["Entry time (IST)", "Trades", "Win rate", "Avg index R"], HB.map(function (k, i) { return [k, String(hg[i].length), hitR(hg[i]), avgR(hg[i])]; }), ["Total", String(hn), hitR(ts), avgR(ts)], "Adds up: " + hn + " of " + N);
    // weekday
    var wg = group(WD, function (t) { return weekday(t.date); }), wn = wg.reduce(function (s, a) { return s + a.length; }, 0);
    block("By day of week", ["Day", "Trades", "Win rate", "Avg index R"], WD.map(function (k, i) { return [k, String(wg[i].length), hitR(wg[i]), avgR(wg[i])]; }), ["Total", String(wn), hitR(ts), avgR(ts)], "Adds up: " + wn + " of " + N);
    out.dataset.total = String(N);
  }

  // The Journal page compares these numbers with your paper trades.
  function saveSummary(all) {
    try {
      var c = cost(), o = { at: new Date().toISOString(), indices: Object.keys(BT.rows), strike: strike(), indexCostR: c, optCostPct: optCost(), byStrategy: {} };
      BT_IDS.forEach(function (s) {
        var ts = all.filter(function (t) { return t.strategy === s; }), e = { n: ts.length };
        ["x1", "x2"].forEach(function (w) {
          var a = stats(ts, w, c), m = optStats(ts, w, "noIv");
          e[w] = { idxR: a ? a.avg : null, optR: m ? m.avg : null, optN: m ? m.n : 0 };
        });
        o.byStrategy[s] = e;
      });
      localStorage.setItem(SUM_KEY, JSON.stringify(o));
    } catch (e) {}
  }

  function btDrawEquity() {
    var cv = $("eq");
    if (!cv || $("btView").hidden || $("btOut").hidden) return;
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    var g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    g.font = "11px system-ui, sans-serif";
    var muted = css("--muted", "#8a97b8"), line = css("--line", "#1b2742"), c = cost(), W = plan();
    var series = {}, lo = 0, hi = 0, maxN = 1;
    BT_IDS.forEach(function (s) {
      var cum = 0, arr = [0];
      chrono(allTrades().filter(function (t) { return t.strategy === s; })).forEach(function (t) { cum += t[W].r - c; arr.push(cum); });
      series[s] = arr; maxN = Math.max(maxN, arr.length - 1);
      arr.forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; });
    });
    var L = 36, R = 8, T = 8, B = 20, pw = w - L - R, ph = h - T - B, span = (hi - lo) || 1;
    function px(i) { return L + (maxN ? i / maxN : 0) * pw; }
    function py(v) { return T + (hi - v) / span * ph; }
    g.strokeStyle = line; g.fillStyle = muted; g.textAlign = "right"; g.textBaseline = "middle";
    for (var k = 0; k <= 4; k++) {
      var v = hi - span * k / 4, yy = Math.round(py(v)) + 0.5;
      g.beginPath(); g.moveTo(L, yy); g.lineTo(L + pw, yy); g.stroke(); g.fillText(v.toFixed(1), L - 4, yy);
    }
    g.strokeStyle = muted; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(L, py(0)); g.lineTo(L + pw, py(0)); g.stroke(); g.setLineDash([]);
    g.textAlign = "center"; g.textBaseline = "top"; g.fillText("trade number (oldest to newest, per strategy)", L + pw / 2, T + ph + 5);
    var lg = $("eqLeg"); lg.textContent = "";
    BT_IDS.forEach(function (s) {
      var a = series[s];
      var sp = el("span", null, "● "); sp.style.color = BT_COL[s];
      lg.appendChild(sp); lg.appendChild(document.createTextNode(lab(s) + " " + fr(a[a.length - 1]) + " in " + (a.length - 1) + " trades   "));
      if (a.length < 2) return;
      g.strokeStyle = BT_COL[s]; g.lineWidth = 2; g.beginPath();
      a.forEach(function (v, i) { if (i) g.lineTo(px(i), py(v)); else g.moveTo(px(i), py(v)); });
      g.stroke(); g.lineWidth = 1;
    });
  }

  chartLoad(false);
  load(false);
})();
</script>
</body>
</html>
````

## `public/journal.html`

````html
<!doctype html>
<html lang="en">
<head>
<link rel="icon" href="data:,">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#060b18">
<title>Paper Trade Journal</title>
<link rel="stylesheet" href="/app.css">
<style>
  .page { max-width: 1180px; }
  .panel { border: 1px solid var(--line); border-radius: 12px; background: var(--card); padding: 12px; margin: 0 0 12px; }
  .panel h2 { font-size: 14px; margin: 0 0 8px; letter-spacing: .2px; }
  .notice { border: 1px solid #5b4516; background: #1c170b; color: #ffd98a; border-radius: 10px; padding: 9px 12px; font-size: 13px; margin: 0 0 10px; }
  form.jf { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; align-items: end; }
  form.jf label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  form.jf input[type=text], form.jf input[type=date], form.jf input[type=number], form.jf select {
    background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; font: inherit; min-height: 40px; width: 100%; }
  form.jf .wide { grid-column: 1 / -1; }
  form.jf label.chkl { flex-direction: row; align-items: center; gap: 8px; color: var(--text); font-size: 14px; min-height: 40px; }
  .bar { height: 8px; border-radius: 4px; background: #1a2440; overflow: hidden; margin: 6px 0 2px; max-width: 420px; }
  .bar i { display: block; height: 100%; background: var(--blue); }
  table.jt { min-width: 0; }
  table.jt th, table.jt td { padding: 8px 10px; font-size: 13px; }
  table.jt th { white-space: normal; line-height: 1.25; vertical-align: bottom; }
  table.jt td.l { text-align: left; white-space: normal; }
  tr.skipped td { color: var(--muted); }
  .cleg { color: var(--muted); font-size: 12.5px; margin: 6px 0 0; line-height: 1.5; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 0 0 8px; }
  .stat { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; }
  .stat b { display: block; font-size: 17px; font-variant-numeric: tabular-nums; }
  .stat span { color: var(--muted); font-size: 11.5px; }
  .lowN { color: var(--amber); font-size: 11px; margin-left: 4px; }
  .labsel { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
  .tiny { min-height: 32px; padding: 4px 10px; }
</style>
</head>
<body>
<div class="page">
  <nav class="tabs" aria-label="Scanners">
    <a href="/">Breakouts</a>
    <a href="/ichimoku.html">Ichimoku Cloud</a>
    <a href="/indices.html">Index Options</a>
    <a href="/journal.html" aria-current="page">Journal</a>
  </nav>
  <h1>Paper Trade Journal</h1>
  <p class="sub">Log the option trades you would take from the Index Options page, using the real option premiums you see in your broker. Everything stays in this browser (local storage); nothing is sent anywhere.</p>
  <div class="notice" id="honest"><b>Paper results are the only out-of-sample evidence you will have.</b> 20–30 sessions is the minimum; 50+ is better. Log the signals you skipped too, otherwise the record only shows the trades you liked. This is a record of your own trades, not proof of an edge.</div>
  <div class="banner" id="banner"></div>

  <div class="panel">
    <h2>Add an entry</h2>
    <form class="jf" id="jf" autocomplete="off">
      <label>Date (IST)<input type="date" id="fDate" required></label>
      <label>Index
        <select id="fIx"><option>NIFTY</option><option>BANKNIFTY</option><option>FINNIFTY</option><option>MIDCPNIFTY</option><option>NIFTYNXT50</option></select></label>
      <label>Strategy
        <select id="fStrat">
          <option value="orb_break">ORB breakout (Track 1)</option>
          <option value="orb_retest">ORB retest (Track 2)</option>
          <option value="ichi">Ichimoku + Fib (intraday)</option>
          <option value="ichi_swing">Ichimoku swing (Daily / 4h)</option>
          <option value="vwap_reclaim">VWAP reclaim</option>
          <option value="vwap_pullback">VWAP pullback</option>
          <option value="expiry_maxpain">Expiry max-pain</option>
          <option value="manual">Other / manual</option>
        </select></label>
      <label>Side<select id="fSide"><option value="CE">Buy CE</option><option value="PE">Buy PE</option></select></label>
      <label>Strike<input type="number" id="fStrike" step="any" min="0" placeholder="e.g. 24500"></label>
      <label>Entry premium (₹)<input type="number" id="fEntry" step="any" min="0"></label>
      <label>Planned stop premium (₹)<input type="number" id="fStop" step="any" min="0"></label>
      <label>Exit premium (₹)<input type="number" id="fExit" step="any" min="0"></label>
      <label class="chkl"><input type="checkbox" id="fSkip"> Skipped signal (I did not take it)</label>
      <label class="wide">Notes<input type="text" id="fNote" maxlength="200" placeholder="Why taken or skipped, spread seen, anything odd"></label>
      <div class="wide"><button class="primary" type="submit">Save entry</button> <span id="fMsg" class="dim" style="color:var(--muted);font-size:13px;margin-left:8px"></span></div>
    </form>
    <p class="cleg">Option R = (exit − entry) ÷ (entry − planned stop premium). Leave the stop blank if you have none; the % result still counts. Leave the exit blank while a trade is open. For a skipped signal only the date, index, strategy and side are needed.</p>
  </div>

  <div class="panel">
    <h2>Progress and statistics (option premium)</h2>
    <div id="prog"></div>
    <div class="stats" id="stats"></div>
    <p class="cleg" id="statNote"></p>
  </div>

  <div class="panel">
    <h2>Backtest vs paper <label class="labsel" style="margin-left:10px">Exit plan <select id="cmpPlan" class="tiny"><option value="x1">Stop / T1 plan</option><option value="x2">Stop / T2 plan</option></select></label></h2>
    <div id="cmp"></div>
    <p class="cleg">Backtest index R and option R (Black-Scholes approximation, no IV change) come from the last backtest run in this browser on the Index Options page. Paper option R comes from your entries above. They are not the same thing: the backtest is a model over about 40 sessions, and a paper log of a few trades is mostly noise. Do not read a gap as proof either way; read it as a prompt to look at your trades one by one.</p>
  </div>

  <div class="panel">
    <h2>Entries <button id="exp" class="tiny" style="margin-left:8px">Export CSV</button> <button id="clr" class="tiny">Clear all</button></h2>
    <div class="wrap"><table class="jt" id="tbl"></table></div>
  </div>
</div>

<script>
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var KEY = "bs-journal-v1", SUM_KEY = "bs-bt-summary";
  var NAMES = { orb_break: "ORB breakout (Track 1)", orb_retest: "ORB retest (Track 2)", ichi: "Ichimoku + Fib (intraday)", ichi_swing: "Ichimoku swing (Daily / 4h)", vwap_reclaim: "VWAP reclaim", vwap_pullback: "VWAP pullback", expiry_maxpain: "Expiry max-pain", manual: "Other / manual" };
  var mem = [], memOnly = false;

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function nf(v, d) { return Number.isFinite(v) ? v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–"; }
  function sgn(v, d, suf) { return Number.isFinite(v) ? (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d) + (suf || "") : "–"; }
  function banner(msg) { var b = $("banner"); b.className = msg ? "banner warn" : "banner"; b.textContent = msg || ""; }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      var a = raw ? JSON.parse(raw) : [];
      return Array.isArray(a) ? a : [];
    } catch (e) { memOnly = true; return mem; }
  }
  function save(a) {
    mem = a;
    try { localStorage.setItem(KEY, JSON.stringify(a)); memOnly = false; } catch (e) { memOnly = true; }
    banner(memOnly ? "This browser is blocking local storage (private window or blocked site data). Entries are kept only until you close or reload the page: export the CSV before leaving." : "");
  }
  function istToday() { try { return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); } catch (e) { return new Date().toISOString().slice(0, 10); } }
  $("fDate").value = istToday();

  // ---- per-entry results ----
  function calc(e) {
    if (e.skipped) return { kind: "skipped" };
    var en = e.entry, ex = e.exit;
    if (!(en > 0)) return { kind: "incomplete" };
    if (!(ex >= 0) || ex === null) return { kind: "open" };
    var pct = (ex - en) / en * 100;
    var r = e.stop != null && en - e.stop > 0 ? (ex - en) / (en - e.stop) : null;
    return { kind: "closed", pct: pct, r: r };
  }
  function meanCI(a) {
    var n = a.length; if (!n) return null;
    var s = 0; a.forEach(function (x) { s += x; });
    var m = s / n, v = 0; a.forEach(function (x) { v += (x - m) * (x - m); });
    var se = n > 1 ? Math.sqrt(v / (n - 1) / n) : null;
    return { n: n, avg: m, lo: se == null ? null : m - 1.96 * se, hi: se == null ? null : m + 1.96 * se };
  }
  function sorted(a) { return a.slice().sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : x.id - y.id; }); }

  function stats(entries) {
    var closed = sorted(entries).map(function (e) { return { e: e, c: calc(e) }; }).filter(function (x) { return x.c.kind === "closed"; });
    var o = { traded: closed.length };
    if (!closed.length) return o;
    var pcts = closed.map(function (x) { return x.c.pct; });
    var rs = closed.filter(function (x) { return x.c.r != null; }).map(function (x) { return x.c.r; });
    var gain = 0, loss = 0, cum = 0, peak = 0, dd = 0, run = 0, worst = 0, wins = 0;
    pcts.forEach(function (p) {
      if (p > 0) { gain += p; wins++; } else loss -= p;
      cum += p; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum;
      if (p <= 0) { run++; if (run > worst) worst = run; } else run = 0;
    });
    o.win = wins / closed.length; o.pctM = meanCI(pcts); o.rM = meanCI(rs);
    o.total = cum; o.pf = loss > 0 ? gain / loss : null; o.dd = dd; o.worst = worst;
    return o;
  }

  // ---- rendering ----
  function render() {
    var all = load(), s = stats(all);
    // progress
    var dates = {}; all.forEach(function (e) { dates[e.date] = 1; });
    var nd = Object.keys(dates).length, skipped = all.filter(function (e) { return e.skipped; }).length;
    var prog = $("prog"); prog.textContent = "";
    prog.appendChild(el("div", null, nd + " session" + (nd === 1 ? "" : "s") + " logged · " + s.traded + " closed trade" + (s.traded === 1 ? "" : "s") + " · " + skipped + " skipped signal" + (skipped === 1 ? "" : "s") + " · " + all.filter(function (e) { return calc(e).kind === "open"; }).length + " open"));
    var bar = el("div", "bar"), fill = el("i"); fill.style.width = Math.min(100, nd / 50 * 100) + "%"; bar.appendChild(fill); prog.appendChild(bar);
    prog.appendChild(el("div", "cleg", nd < 20 ? "Under 20 sessions: too few to say anything. Keep logging." : nd < 30 ? "20 to 29 sessions: still thin. The minimum is 30." : nd < 50 ? "30 to 49 sessions: the minimum is met; 50 or more is better." : "50 or more sessions logged."));

    var st = $("stats"); st.textContent = "";
    function box(v, l) { var d = el("div", "stat"); d.appendChild(el("b", null, v)); d.appendChild(el("span", null, l)); st.appendChild(d); }
    if (!s.traded) {
      box("–", "No closed trades yet");
    } else {
      box(Math.round(s.win * 100) + "%", "Win rate (premium up)");
      box(sgn(s.pctM.avg, 1, "%"), "Average premium change per trade" + (s.pctM.lo != null ? " (95% range " + sgn(s.pctM.lo, 1) + " to " + sgn(s.pctM.hi, 1) + ")" : ""));
      box(sgn(s.total, 1, "%"), "Sum of premium changes");
      box(s.rM ? sgn(s.rM.avg, 2, "R") : "–", "Average option R" + (s.rM ? " (" + s.rM.n + " with a stop)" : " (add stop premiums)"));
      box(s.pf == null ? "–" : s.pf.toFixed(2), "Profit factor (on % moves)");
      box(s.dd.toFixed(1) + "%", "Max drawdown (sum of % moves)");
      box(String(s.worst), "Longest losing run");
    }
    $("statNote").textContent = s.traded && s.traded < 30 ? "Fewer than 30 closed trades: the ranges are wide and almost any result is consistent with luck. Percent moves are added up, not compounded, and ignore position size." : "Percent moves are added up, not compounded, and ignore position size.";

    // table
    var t = $("tbl"); t.textContent = "";
    var hr = el("tr");
    ["Date", "Index", "Strategy", "Side", "Strike", "Entry ₹", "Stop ₹", "Exit ₹", "Premium %", "Option R", "Notes", ""].forEach(function (h) { hr.appendChild(el("th", null, h)); });
    t.appendChild(el("thead")).appendChild(hr);
    var tb = el("tbody");
    if (!all.length) {
      var er = el("tr"), ec = el("td", "empty", "No entries yet. Add one above."); ec.colSpan = 12; er.appendChild(ec); tb.appendChild(er);
    }
    sorted(all).reverse().forEach(function (e) {
      var c = calc(e), tr = el("tr", e.skipped ? "skipped" : "");
      function cell(v, cls) { var d = el("td", cls || "num", v); tr.appendChild(d); return d; }
      cell(e.date, "l"); cell(e.ix, "l"); cell(NAMES[e.strat] || e.strat, "l"); cell(e.side === "CE" ? "CE" : "PE", "l");
      if (e.skipped) {
        cell("–"); cell("–"); cell("–"); cell("–");
        cell("skipped signal", "l"); cell("–");
      } else {
        cell(e.strike != null ? nf(e.strike, 0) : "–"); cell(nf(e.entry, 2)); cell(e.stop != null ? nf(e.stop, 2) : "–"); cell(e.exit != null ? nf(e.exit, 2) : "–");
        cell(c.kind === "closed" ? sgn(c.pct, 1, "%") : c.kind === "open" ? "open" : "–", c.kind === "closed" ? (c.pct >= 0 ? "num up" : "num down") : "num");
        cell(c.kind === "closed" && c.r != null ? sgn(c.r, 2, "R") : "–", c.kind === "closed" && c.r != null ? (c.r >= 0 ? "num up" : "num down") : "num");
      }
      cell(e.note || "", "l");
      var del = el("button", "tiny", "Delete"); del.type = "button"; del.setAttribute("aria-label", "Delete entry " + e.date + " " + e.ix);
      del.addEventListener("click", function () { save(load().filter(function (x) { return x.id !== e.id; })); render(); });
      var dc = el("td", "num"); dc.appendChild(del); tr.appendChild(dc);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    renderCmp(all);
  }

  function renderCmp(all) {
    var box = $("cmp"); box.textContent = "";
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(SUM_KEY) || "null"); } catch (e) {}
    if (!raw || !raw.byStrategy) {
      box.appendChild(el("div", "empty", "No backtest summary in this browser yet. Open Index Options, run the backtest, then come back."));
      return;
    }
    var W = $("cmpPlan").value === "x2" ? "x2" : "x1";
    var t = el("table", "jt"), hr = el("tr");
    ["Strategy", "Backtest: index R (avg, n)", "Backtest: option R (BS, no IV change, " + (raw.strike === "itm" ? "1 ITM" : "ATM") + ")", "Paper: option R (avg, n)", "Paper: avg premium %"].forEach(function (h) { hr.appendChild(el("th", null, h)); });
    t.appendChild(el("thead")).appendChild(hr);
    var tb = el("tbody");
    ["orb_break", "orb_retest", "ichi", "vwap_reclaim", "vwap_pullback"].forEach(function (id) {
      var b = raw.byStrategy[id], tr = el("tr");
      var mine = all.filter(function (e) { return e.strat === id; }), s = stats(mine);
      function cell(v, cls) { tr.appendChild(el("td", cls || "num", v)); }
      cell(NAMES[id], "l");
      cell(b && b[W] && b[W].idxR != null ? sgn(b[W].idxR, 2, "R") + "  (n=" + b.n + ")" : "–  (n=" + (b ? b.n : 0) + ")");
      cell(b && b[W] && b[W].optR != null ? sgn(b[W].optR, 2, "R") + "  (n=" + b[W].optN + ")" : "–");
      cell(s.rM ? sgn(s.rM.avg, 2, "R") + "  (n=" + s.rM.n + ")" : "–  (n=0)");
      cell(s.pctM ? sgn(s.pctM.avg, 1, "%") + "  (n=" + s.pctM.n + ")" : "–");
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    var w = el("div", "wrap"); w.appendChild(t); box.appendChild(w);
    box.appendChild(el("div", "cleg", "Backtest saved " + (raw.at ? raw.at.replace("T", " ").slice(0, 16) + " UTC" : "earlier") + " for " + (raw.indices || []).join(", ") + ". Index cost " + raw.indexCostR + "R, option cost " + raw.optCostPct + "% of premium."));
  }

  // ---- form ----
  function setSkipUi() {
    var sk = $("fSkip").checked;
    ["fStrike", "fEntry", "fStop", "fExit"].forEach(function (id) { $(id).disabled = sk; });
  }
  $("fSkip").addEventListener("change", setSkipUi);
  $("cmpPlan").addEventListener("change", function () { renderCmp(load()); });
  function numOrNull(id) { var v = $(id).value; if (v === "" || v == null) return null; var x = parseFloat(v); return Number.isFinite(x) ? x : NaN; }

  $("jf").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var msg = $("fMsg"); msg.textContent = "";
    var e = { id: Date.now() + Math.floor(Math.random() * 1000), date: $("fDate").value, ix: $("fIx").value, strat: $("fStrat").value, side: $("fSide").value, skipped: $("fSkip").checked, note: $("fNote").value.trim().slice(0, 200) };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) { msg.textContent = "Pick a date."; return; }
    if (!e.skipped) {
      e.strike = numOrNull("fStrike"); e.entry = numOrNull("fEntry"); e.stop = numOrNull("fStop"); e.exit = numOrNull("fExit");
      if (![e.strike, e.entry, e.stop, e.exit].every(function (v) { return v === null || Number.isFinite(v); })) { msg.textContent = "Numbers only in the price boxes."; return; }
      if (!(e.entry > 0)) { msg.textContent = "Enter the entry premium, or tick \"Skipped signal\"."; return; }
      if (e.stop != null && e.stop >= e.entry) { msg.textContent = "The planned stop premium must be below the entry premium."; return; }
    }
    var a = load(); a.push(e); save(a);
    msg.textContent = e.skipped ? "Skipped signal saved." : "Entry saved.";
    $("fEntry").value = ""; $("fStop").value = ""; $("fExit").value = ""; $("fNote").value = ""; $("fSkip").checked = false; setSkipUi();
    render();
  });

  // ---- CSV export (Blob) ----
  function csvCell(v, isText) {
    var s = v == null ? "" : String(v);
    if (isText && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // do not let a spreadsheet run a note as a formula (numbers stay numbers)
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(all) {
    var head = ["date", "index", "strategy", "side", "skipped_signal", "strike", "entry_premium", "stop_premium", "exit_premium", "premium_change_pct", "option_R", "notes"];
    var lines = [head.join(",")];
    sorted(all).forEach(function (e) {
      var c = calc(e);
      lines.push([e.date, e.ix, e.strat, e.side, e.skipped ? "yes" : "no", e.strike, e.entry, e.stop, e.exit,
        c.kind === "closed" ? c.pct.toFixed(2) : "", c.kind === "closed" && c.r != null ? c.r.toFixed(3) : "", e.note].map(function (v, i) { return csvCell(v, i === 11 || i < 4); }).join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }
  $("exp").addEventListener("click", function () {
    var blob = new Blob([toCsv(load())], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "paper-trades-" + istToday() + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
  $("clr").addEventListener("click", function () {
    if (!load().length) return;
    if (window.confirm("Delete every entry in this journal? Export the CSV first if you want a copy.")) { save([]); render(); }
  });

  window.__journal = { toCsv: toCsv, calc: calc, stats: stats };
  setSkipUi();
  render();
})();
</script>
</body>
</html>
````

