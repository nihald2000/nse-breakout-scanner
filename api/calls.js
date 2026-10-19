// api/calls.js - Live Calls board: ONE list of the side the closed-candle checks lean
// (CE = up facts, PE = down facts) across the hottest F&O sectors, strong + moderate
// reads only. Same per-stock maths as /api/sectorstocks (computeRows), so a stock is
// described here exactly as it is inside its sector panel.
//
// ?sectors=Construction,Banks&tf=15m   (sector names from /api/sectors; the board page
// picks today's hottest groups by |% change| and passes them in)
//
// Facts from closed candles only - a count of agreeing checks, never a probability,
// never an order. Weak reads are counted (meta.weakHidden) but not listed.
// F&O ban and live option liquidity are not checked anywhere (no free source).

const { FO_INDEX, getUniverse, formatIST } = require("../lib/common");
const { OTHER } = require("../lib/sector");
const { TFS, computeRows } = require("./sectorstocks")._internals;

const MAX_SECTORS = 8;
const MAX_SYMBOLS = 100; // one request at concurrency 16 stays inside the 30s budget
const MAX_PER_SECTOR = 40; // same cap as the sector panel

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const q = (req && req.query) || {};
  const tfKey = TFS[q.tf] ? q.tf : "15m";
  const names = [...new Set(String(q.sectors || "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, MAX_SECTORS);

  if (!names.length) {
    return res.status(400).json({ error: "Pass ?sectors=A,B,C with names from /api/sectors.", hint: "The board page picks today's hottest groups and calls this route the same way." });
  }

  let universe;
  let industryOf;
  try {
    universe = await getUniverse(FO_INDEX);
    const n500 = await getUniverse("NIFTY 500");
    industryOf = new Map(n500.map((u) => [u.sym, u.industry]));
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Could not load the F&O universe.", detail: String((e && e.message) || e), hint: "Try again in a minute." });
  }

  const inSector = new Map(names.map((n) => [n, []]));
  for (const u of universe) {
    const ind = industryOf.get(u.sym) || OTHER;
    const arr = inSector.get(ind);
    if (arr && arr.length < MAX_PER_SECTOR) arr.push(u.sym);
  }

  const symbols = [];
  const selected = new Set();
  let truncated = false;
  const scanned = names.map((n) => {
    const list = inSector.get(n) || [];
    let added = 0;
    for (const s of list) {
      if (selected.has(s)) continue;
      if (symbols.length >= MAX_SYMBOLS) { truncated = true; break; }
      selected.add(s);
      symbols.push(s);
      added++;
    }
    return { sector: n, stocks: list.length, scanned: added };
  });

  if (!symbols.length) {
    return res.status(400).json({ error: "No F&O stocks found for those sectors.", scanned, hint: "Use exact sector names from /api/sectors." });
  }

  const labelOf = (sym) => industryOf.get(sym) || OTHER;
  const { rows, failed, newestTs } = await computeRows(symbols, tfKey, labelOf);

  const rank = { strong: 0, moderate: 1, weak: 2 };
  const leaning = rows.filter((r) => r.read && r.read.trend && r.read.trend.side);
  const signals = leaning
    .filter((r) => r.read.trend.tier === "strong" || r.read.trend.tier === "moderate")
    .sort((a, b) =>
      rank[a.read.trend.tier] - rank[b.read.trend.tier] ||
      b.read.trend.agree - a.read.trend.agree ||
      (b.read.trend.helpers || 0) - (a.read.trend.helpers || 0) ||
      (b.rvol == null ? -1 : b.rvol) - (a.rvol == null ? -1 : a.rvol)
    );

  res.setHeader("Cache-Control", "public, s-maxage=45, stale-while-revalidate=90");
  return res.status(200).json({
    meta: {
      tf: tfKey,
      sectors: names,
      scanned,
      truncated,
      wanted: symbols.length,
      loaded: rows.length,
      failed,
      signals: signals.length,
      strong: signals.filter((r) => r.read.trend.tier === "strong").length,
      moderate: signals.filter((r) => r.read.trend.tier === "moderate").length,
      weakHidden: leaning.length - signals.length,
      asOf: newestTs ? formatIST(newestTs) : null,
      notes: [
        "CE / PE is the side the closed-candle checks lean - a count of agreeing facts, not a probability of profit and not a buy or sell order.",
        "Only strong and moderate reads are listed; weak ones are counted but hidden.",
        "The replay behind this page measured +/-0.5% on the stock; option premium, spread and costs are not modeled.",
        "F&O ban and live option liquidity are not checked anywhere here (no free source); they are never shown as checked.",
        "Screening aid, not trading advice.",
      ],
      source: "Yahoo Finance",
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - t0,
    },
    signals,
  });
};

module.exports._internals = { MAX_SECTORS, MAX_SYMBOLS, MAX_PER_SECTOR };
