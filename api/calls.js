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
// The board also attaches the ATM CE/PE quote from NSE's option-chain snapshot. That is
// market data, not a modelled premium; the F&O ban list is a separate NSE publication and
// is still not checked here.

const { FO_INDEX, getUniverse, formatIST, mapPool } = require("../lib/common");
const { OTHER } = require("../lib/sector");
const opts = require("../lib/options");
const { TFS, computeRows } = require("./sectorstocks")._internals;

const MAX_SECTORS = 8;
const MAX_SYMBOLS = 100; // one request at concurrency 16 stays inside the 30s budget
const MAX_PER_SECTOR = 40; // same cap as the sector panel

// Build the ATM quote for one listed signal. The read side decides the contract:
// up -> ATM CE, down -> ATM PE. Keeping this pure makes the label and the quote
// impossible to drift apart.
function optionForSummary(sum, side) {
  if (!sum || !sum.atm || sum.atm.iv == null) return null;
  const kind = side === "up" ? "call" : "put";
  const q = sum.atm[kind];
  if (!q || !(q.px > 0)) return null;
  return {
    expiry: sum.expiry,
    dte: sum.dte,
    asOf: opts.asOfIST(sum.asOfTs),
    spot: sum.spot,
    strike: sum.atm.strike,
    type: side === "up" ? "CE" : "PE",
    premium: q.px,
    bid: q.bid,
    ask: q.ask,
    spreadPct: q.spreadPct,
    iv: q.iv,
    delta: q.delta,
    oi: q.oi,
    oiChg: q.oiChg,
    vol: q.vol,
    quality: q.spreadPct != null && q.spreadPct <= 0.15 && q.oi > 0 ? "ok" : "thin",
    skewRaw: sum.rawSkew,
    skewNorm: sum.normSkew,
    flags: sum.flags,
  };
}


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

  // One NSE chain per listed signal, at the front expiry. This is deliberately after the
  // board's own filters: we quote only the rows a reader can see, not all 100 scanned names.
  const optionMeta = {
    source: "NSE option-chain v3",
    expiry: null,
    asOf: null,
    loaded: 0,
    failed: 0,
    note: "ATM CE for CE reads, ATM PE for PE reads. NSE snapshot, not a fill; F&O ban is not checked.",
  };
  if (signals.length) {
    let front = null;
    try {
      const ref = await opts.getReferenceExpiries();
      front = opts.pickExpiry(ref.expiries, 2);
      optionMeta.expiry = front ? front.label : null;
    } catch (e) {
      // Every per-symbol fetch below still has its own fallback; no need to fail the board.
    }
    const quotes = await mapPool(signals, 8, async (s) => {
      try {
        const got = await opts.fetchChainForSymbol(s.sym, 2);
        if (!got.chain || !got.chain.rows.length) return null;
        const sum = opts.summarizeChain(got.chain);
        return optionForSummary(sum, s.read.trend.side);
      } catch (e) {
        return null;
      }
    });
    for (let i = 0; i < signals.length; i++) signals[i].option = quotes[i] || null;
    const have = quotes.filter(Boolean);
    optionMeta.loaded = have.length;
    optionMeta.failed = signals.length - have.length;
    const expiries = [...new Set(have.map((q) => q.expiry).filter(Boolean))];
    if (expiries.length === 1) optionMeta.expiry = expiries[0];
    else if (expiries.length > 1) optionMeta.expiry = expiries.join(", ");
    const asOf = have.map((q) => q.asOf).filter(Boolean).sort().slice(-1)[0];
    optionMeta.asOf = asOf || null;
  } else {
    for (const s of signals) s.option = null;
  }

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
      option: optionMeta,
      notes: [
        "CE / PE is the side the closed-candle checks lean - a count of agreeing facts, not a probability of profit and not a buy or sell order.",
        "Only strong and moderate reads are listed; weak ones are counted but hidden.",
        "The replay behind this page measured +/-0.5% on the stock; option premium, spread and costs are not modeled in that number.",
        "The ATM option column is NSE's option-chain snapshot at the front expiry: real bid/ask, IV and OI when quoted. It is not a fill.",
        "F&O ban is a separate NSE list and is NOT checked here; the board never shows it as checked.",
        "Screening aid, not trading advice.",
      ],
      source: "Yahoo Finance + NSE option chain",
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - t0,
    },
    signals,
  });
};

module.exports._internals = { MAX_SECTORS, MAX_SYMBOLS, MAX_PER_SECTOR, optionForSummary };
