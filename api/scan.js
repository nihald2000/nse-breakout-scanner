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
