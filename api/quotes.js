// api/quotes.js - lightweight live price refresh for a handful of symbols.
// GET /api/quotes?symbols=TCS,INFY,RELIANCE   (max 60)
// Prices come from Yahoo Finance (NSE symbols as SYMBOL.NS). Not an exchange feed.

const { UA, istParts, sessionFraction, expectedVolumeShare, mapPool } = require("../lib/common");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fin = (x) => (Number.isFinite(x) ? x : null);

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
