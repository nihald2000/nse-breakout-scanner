// api/sectors.js - Sector Scope screen: all F&O stocks grouped by their NSE industry.
//   Universe : NSE's own F&O market-lots CSV (bogus rows are dropped in lib/common.parseSymbols),
//              industries from the Nifty 500 constituent CSV.
//   Prices   : Yahoo Finance chart API, ONE 2-month daily call per stock (213 stocks, parallel).
// Facts only, not advice. The sector % here is the turnover-weighted average of the F&O stocks
// in the group - it is NOT the NSE sector index level. Cloud servers cannot reach NSE's live
// sector page, so the group's own prices are the source. Ban list and live option liquidity
// have no free source and are never faked.

const {
  FO_INDEX, mapPool, istParts, sessionFraction, expectedVolumeShare, formatIST,
  getUniverse, yahooChart, parseChart,
} = require("../lib/common");
const { sectorRows, OTHER, loadDeliveryMap } = require("../lib/sector");

const LOOKBACK = 20; // prior sessions for the "normal" turnover baseline

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const now = istParts();
  const nowSec = Math.floor(Date.now() / 1000);
  const frac = sessionFraction(now);
  const share = expectedVolumeShare(frac);

  let universe = null;
  let delivery = { key: now.iso, map: {}, date: null };
  try {
    [universe, delivery] = await Promise.all([
      getUniverse(FO_INDEX),
      loadDeliveryMap(now.iso).catch(() => delivery),
    ]);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Could not load the F&O stock list.", detail: String((e && e.message) || e), hint: "Try again in a minute." });
  }

  // Industry tags come from the Nifty 500 constituent CSV (same source the scanner uses).
  let industryOf = new Map();
  try {
    const n500 = await getUniverse("NIFTY 500");
    industryOf = new Map(n500.map((u) => [u.sym, u.industry]));
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Could not load the industry list.", detail: String((e && e.message) || e) });
  }

  const symbols = universe.map((u) => u.sym);
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
      if (errSamples.length < 3) errSamples.push(`${sym}: ${String((e && e.message) || e).slice(0, 50)}`);
      return null;
    }
  });
  const got = charts.filter(Boolean);
  if (got.length === 0) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Could not load prices for any stock.", detail: errSamples.join(" | ") || "no responses", hint: "The price source may be rate-limiting this server. Try again in a minute." });
  }

  // Live session date = the most common last-trade date across stocks.
  const tally = new Map();
  for (const { p } of got) tally.set(p.liveISO, (tally.get(p.liveISO) || 0) + 1);
  const liveISO = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const stocks = [];
  const noData = [];
  for (const { sym, p } of got) {
    if (p.liveISO !== liveISO) {
      noData.push(sym); // suspended or not traded on the live date
      continue;
    }
    const prior = p.bars.filter((b) => b.d < liveISO);
    if (prior.length < Math.max(10, Math.floor(LOOKBACK / 2))) {
      noData.push(sym); // thin history: the "normal" baseline would be a guess
      continue;
    }
    const m = p.meta;
    const ltp = m.regularMarketPrice;
    const vol = Number.isFinite(m.regularMarketVolume) ? m.regularMarketVolume : p.bars[p.bars.length - 1].vol;
    const prevClose = prior[prior.length - 1].cl;
    if (!(ltp > 0) || !(prevClose > 0)) {
      noData.push(sym);
      continue;
    }
    const win = prior.slice(-LOOKBACK);
    const avgTurnover = win.reduce((s, b) => s + b.vol * b.cl, 0) / win.length;
    stocks.push({
      sym,
      industry: industryOf.get(sym) || OTHER,
      ltp,
      pchg: ((ltp - prevClose) / prevClose) * 100,
      vol,
      avgTurnover,
      dayHigh: m.regularMarketDayHigh,
      dayLow: m.regularMarketDayLow,
      hi2M: Math.max(...p.bars.map((b) => b.hi)),
      deliveryPct: null, // filled after the delivery file, below
    });
  }

  for (const s of stocks) s.deliveryPct = delivery.map[s.sym] == null ? null : delivery.map[s.sym];

  const rows = sectorRows(stocks, share);
  const stockMap = {};
  for (const s of stocks) stockMap[s.sym] = s;

  const newestTs = got.reduce((a, { p }) => Math.max(a, p.liveTs), 0);
  const warnings = [];
  if (failed > symbols.length * 0.3) warnings.push(`Prices missing for ${failed} of ${symbols.length} stocks; results may be incomplete.`);
  if (partial) warnings.push("Stopped early to stay within the time limit; some stocks were not checked.");
  const lagMin = newestTs ? Math.round((Date.now() / 1000 - newestTs) / 60) : 0;
  if (frac < 1 && lagMin > 10) warnings.push(`The newest price is ${lagMin} minutes old, so the data source may be delayed.`);
  if (!delivery.date) warnings.push("Delivery % (previous day) could not be loaded; that column is empty, not zero.");

  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
  return res.status(200).json({
    meta: {
      asOf: newestTs ? formatIST(newestTs) : null,
      marketOpen: frac < 1,
      sessionPct: Math.round(frac * 100),
      volShare: share,
      universe: stocks.length,
      universeSize: symbols.length,
      noData: noData.slice(0, 20),
      historyFailed: failed,
      deliveryDate: delivery.date,
      notes: [
        "Sector % change is the turnover-weighted average of the F&O stocks in the group, not the NSE sector index level.",
        "F&O ban and live option liquidity have no free source here, so they are never shown as checked.",
        "Screening aid, not trading advice.",
      ],
      source: "NSE F&O list + Nifty 500 industries + Yahoo prices",
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - t0,
    },
    warnings,
    sectors: rows,
    stocks: stockMap,
  });
};

module.exports._internals = { sectorRows, OTHER, LOOKBACK };
