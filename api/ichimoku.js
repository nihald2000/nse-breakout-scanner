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
