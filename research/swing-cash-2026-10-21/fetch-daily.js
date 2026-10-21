"use strict";

// Fetch only the free public daily bars needed for the cash-swing research.
// Usage: node research/swing-cash-2026-10-21/fetch-daily.js

const { getUniverse, FO_INDEX, yahooChart, mapPool, istParts } = require("../../lib/common");
const { cleanDaily, writeSnapshot } = require("./run-study");

async function main() {
  const universe = await getUniverse(FO_INDEX);
  const today = istParts().iso;
  const failures = [];
  const stocks = (await mapPool(universe, 4, async (u, i) => {
    try {
      const raw = await yahooChart(u.sym, i, "5y", "1d");
      const bars = cleanDaily(raw).filter((b) => b.date < today);
      if (bars.length < 500) throw new Error(`only ${bars.length} completed daily bars`);
      return { sym: u.sym, industry: u.industry || "", bars };
    } catch (e) {
      failures.push({ sym: u.sym, reason: String(e.message || e).slice(0, 100) });
      return null;
    }
  })).filter(Boolean);
  const indexRaw = await yahooChart("^NSEI", 0, "5y", "1d");
  const nifty = cleanDaily(indexRaw).filter((b) => b.date < today);
  if (stocks.length < 150 || nifty.length < 500) throw new Error(`Insufficient daily data: ${stocks.length} stocks, ${nifty.length} Nifty sessions.`);
  const snapshot = {
    fetchedAt: new Date().toISOString(),
    source: "Yahoo Finance chart API, 5y/1d",
    universeSource: "NSE F&O list downloaded at snapshot time",
    completedThrough: nifty.at(-1).date,
    failedSymbols: failures,
    stocks,
    nifty,
  };
  writeSnapshot(snapshot);
  console.log(`Saved ${stocks.length}/${universe.length} symbols and ${nifty.length} completed Nifty sessions through ${snapshot.completedThrough}.`);
  if (failures.length) console.log(`Unavailable symbols: ${failures.map((x) => x.sym).join(", ")}`);
}

main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
