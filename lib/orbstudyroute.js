// lib/orbstudyroute.js (served as /api/orbstudy through a rewrite to /api/sip?mode=study) - a historical study of the Stocks in Play opening range breakout over the last ~60 days of Yahoo
// 5-minute bars for the NSE F&O universe. Read-only and heavy (one Yahoo request per stock); the reply is cached for an hour.
//
//   GET /api/orbstudy                    -> rank by first-candle volume (the paper's rule)
//   GET /api/orbstudy?rank=range         -> rank by first-candle range instead, for a feed without a usable 09:15 volume
//   GET /api/orbstudy?top=10&limit=40    -> top-N names per day (default 10); limit = only the first N stocks (testing)
//   GET /api/orbstudy?debug=1            -> only the data-quality counts, no study
//
// See lib/orbstudy.js for the exact trade rules and what the numbers cannot tell. Descriptive only: not a forecast.

const { FO_INDEX, getUniverse, yahooChart, mapPool } = require("./common");
const { parseIdx } = require("../api/indices")._internals;
const S = require("./orbstudy");

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const q = (req && req.query) || {};
  const mode = q.rank === "range" ? "range" : "volume";
  const topN = Math.min(50, Math.max(1, parseInt(q.top, 10) || 10));
  const limit = Math.max(0, parseInt(q.limit, 10) || 0);
  const debug = q.debug != null && String(q.debug) !== "" && String(q.debug) !== "0";
  let universe;
  try {
    universe = await getUniverse(FO_INDEX);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Could not load the F&O universe.", hint: "Try again in a minute." });
  }
  if (limit) universe = universe.slice(0, limit);

  const got = await mapPool(universe, 20, async (u, i) => {
    try {
      const parsed = parseIdx(await yahooChart(u.sym + ".NS", i, "60d", "5m"));
      return { ok: true, ...S.candidates(u.sym, parsed.bars, mode), bars: parsed.bars.length, zeroVol: parsed.bars.filter((b) => b.mm === 555 && !(b.vol > 0)).length, firstBars: parsed.bars.filter((b) => b.mm === 555).length };
    } catch (e) {
      return { ok: false };
    }
  });

  const skips = {};
  let failed = 0;
  let zeroVol = 0;
  let firstBars = 0;
  const all = [];
  for (const g of got) {
    if (!g || !g.ok) {
      failed++;
      continue;
    }
    zeroVol += g.zeroVol;
    firstBars += g.firstBars;
    for (const [k, v] of Object.entries(g.skips)) skips[k] = (skips[k] || 0) + v;
    for (const c of g.cands) all.push(c);
  }
  const quality = {
    universe: universe.length,
    failedFetches: failed,
    candidateStockSessions: all.length,
    first0915Bars: firstBars,
    first0915BarsWithZeroOrMissingVolume: zeroVol,
    skipReasons: skips,
    range: "60d of 5m bars",
    mode,
  };
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=7200");
  if (debug || !all.length) {
    return res.status(200).json({ meta: { quality, tookMs: Date.now() - t0, generatedAt: new Date().toISOString() }, note: all.length ? "debug only" : "No usable stock-sessions; see skipReasons." });
  }
  const built = S.buildTrades(all, { topN });
  const study = S.summarise(built, { topN });
  return res.status(200).json({
    meta: {
      title: "Stocks in Play opening range breakout: historical study",
      quality,
      topN,
      rules: {
        entry: "buy-stop at the first candle's high (long) / sell-stop at its low (short); first closed candle that touches it; gap fills at the open",
        stops: S.STUDY.stops,
        targets: S.STUDY.targets,
        conflict: "stop is checked first when stop and target are both reachable in one candle; the entry candle's adverse extreme counts",
        exit: "15:15 open if neither is reached",
        costPerSidePct: S.STUDY.costPerSidePct,
        control: "'against' = the same rule on the opposite side of the first candle",
        intervals: `95% by resampling whole sessions (${S.STUDY.bootstrap} resamples)`,
      },
      limits: [
        "About 60 calendar days of Yahoo data: roughly 25 testable sessions in one market regime. Results can change with the regime.",
        "Underlying share prices only. There is no historical option price data here; the option table is a Black-Scholes model with flat IV and no spread.",
        "Uses today's F&O list (survivorship) and Yahoo's unadjusted intraday bars; fills at the level are assumed, with no slippage.",
        "Trades on the same day are correlated; the intervals resample days, but the number of independent days is small.",
        "A sample result is not proof of an edge, and not a forecast. Screening aid, not trading advice.",
      ],
      tookMs: Date.now() - t0,
      generatedAt: new Date().toISOString(),
    },
    study,
    optionModel: S.premiumModel(),
  });
};
