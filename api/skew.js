// api/skew.js - Options Skew Map for NSE F&O stocks.
//
// ?expiry=23-Nov-2026   optional; defaults to the nearest monthly expiry at least 21 days out
// ?symbol=RELIANCE      optional; returns one stock's chain points for the smile detail panel
//
// Data is NSE's own option-chain v3 snapshot, read directly. No broker key, no US/SPY logic.
// IV is a Black-Scholes inversion of the quoted mid, not NSE's displayed IV; see lib/options.js.
// Descriptive positioning only. No F&O ban check, no order, no forecast.

const { getUniverse, FO_INDEX, istParts } = require("../lib/common");
const o = require("../lib/options");

const MIN_DTE = 21;

function round(v, n) {
  return Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : null;
}

function notesFor(meta) {
  return [
    "India only: NSE F&O stocks, NSE monthly expiry. No index, US or SPY comparison.",
    `Expiry is the nearest monthly contract at least ${MIN_DTE} days away; after the close the chain is the last session's, not a live quote.`,
    "IV is computed from the bid/ask mid with Black-Scholes (r=6.5%, no dividend). It is a model output, not a forecast.",
    "25Δ put/call IVs are linearly interpolated by Black-Scholes delta. Normalised skew = (put25 IV − call25 IV) / ATM IV.",
    "Positive skew means puts are richer than calls (downside demand); negative means calls are richer. Thin quotes are marked, never zero-filled.",
    "Sector medians and agreement use stocks with both 25Δ points; the liquid count is shown separately. No F&O ban check here.",
    "Screening aid, not trading advice.",
  ];
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const q = (req && req.query) || {};
  let ref;
  try {
    ref = await o.getReferenceExpiries();
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({
      error: "NSE expiry list unavailable right now.",
      hint: "The page will retry. Nothing is shown rather than a guessed expiry.",
    });
  }
  const expiries = ref.expiries
    .map((e) => ({ label: e.label, iso: e.iso, dte: round(o.dteDays(e.label), 1) }))
    .filter((e) => e.dte != null && e.dte > 0);
  const fallback = o.pickExpiry(ref.expiries, MIN_DTE);
  const wanted = String(q.expiry || "").trim();
  const selected = expiries.find((e) => e.label === wanted) || (fallback && expiries.find((e) => e.label === fallback.label));
  if (!selected) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "No valid NSE stock expiry found.", hint: "Try again after NSE publishes the next contract." });
  }

  if (q.symbol) {
    const symbol = String(q.symbol).trim().toUpperCase();
    if (!/^[A-Z0-9&-]{1,20}$/.test(symbol)) {
      return res.status(400).json({ error: "Pass ?symbol=RELIANCE with an NSE symbol." });
    }
    try {
      const chain = await o.fetchChain(symbol, selected.label, 45 * 1000);
      if (!chain.rows.length || !(chain.spot > 0)) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(404).json({ error: `No ${selected.label} option chain for ${symbol}.`, symbol, expiry: selected.label });
      }
      const stock = o.summarizeChain(chain, { includePoints: true });
      const symbolMeta = {
        expiry: selected.label,
        expiryISO: selected.iso,
        dte: round(o.dteDays(selected.label), 1),
        asOf: o.asOfIST(stock.asOfTs),
        live: !!(stock.asOfTs && o.isMarketOpen() && istParts(new Date(stock.asOfTs)).iso === istParts().iso),
        source: "NSE option-chain v3",
        generatedAt: new Date().toISOString(),
        tookMs: Date.now() - t0,
      };
      if (stock.normSkew == null) {
        return res.status(200).json({ meta: symbolMeta, stock, warning: "Not enough usable quotes for a 25Δ skew." });
      }
      res.setHeader("Cache-Control", "public, s-maxage=45, stale-while-revalidate=90");
      return res.status(200).json({ meta: symbolMeta, stock });
    } catch (e) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(502).json({ error: "NSE option chain unavailable for this stock right now.", symbol, expiry: selected.label });
    }
  }

  let universe;
  let n500;
  try {
    [universe, n500] = await Promise.all([getUniverse(FO_INDEX), getUniverse("NIFTY 500")]);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Could not load the NSE F&O universe.", hint: "Try again in a minute." });
  }
  const industryOf = new Map(n500.map((u) => [u.sym, u.industry]));

  let map;
  try {
    map = await o.buildSkewMap({ universe, industryOf, expiry: selected.label });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "NSE option chain unavailable right now.", hint: "The page will retry. Nothing is shown rather than a stale or made-up chain." });
  }
  if (!map.meta.valid) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({
      error: "NSE returned no usable stock option quotes.",
      hint: "This can happen before the first contract is quoted. The page will retry.",
      expiry: selected.label,
    });
  }

  const meta = {
    title: "Options Skew Map",
    universe: "NSE F&O stocks",
    universeCount: map.universe,
    source: "NSE option-chain v3",
    expiry: selected.label,
    expiryISO: selected.iso,
    expiries,
    dte: round(o.dteDays(selected.label), 1),
    asOf: map.asOf,
    asOfTs: map.asOfTs,
    live: map.live,
    marketOpen: o.isMarketOpen(),
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - t0,
    ...map.meta,
    notes: notesFor(),
  };
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
  return res.status(200).json({
    meta,
    stocks: map.stocks,
    sectors: map.sectors,
    missingStocks: map.missing.map((x) => ({ sym: x.sym, flags: x.flags, n: x.n })),
    failedStocks: map.failed.map((x) => ({ sym: x.sym, error: x.error })),
  });
};

module.exports._internals = { MIN_DTE, notesFor };
