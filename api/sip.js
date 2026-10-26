// api/sip.js - "Stocks in Play" opening range breakout calls for the NSE F&O universe.
//
//   GET /api/sip                -> every F&O stock whose 09:15 five-minute candle traded at least 1.0x its normal volume
//   GET /api/sip?minRvol=0      -> also list names under the threshold (flagged; the paper found them a slow loser)
//   GET /api/sip?sym=RELIANCE&debug=1 -> the same, plus how its first-candle volume baseline was read (diagnostics)
//   GET /api/sip?sym=RELIANCE   -> one stock only (what the chart pages use): its call or the reason it has none, plus the
//                                  session's closed 5m bars for drawing. One Yahoo request; not ranked against the others.
//
// The rule is lib/sip.js (Zarattini, Barbon & Aziz 2024, adapted to NSE): relative volume of the first candle ranks the
// stocks, the first candle's colour sets the side, a stop order sits at its high (long) or low (short), the stop loss is
// 10% of the 14-day ATR, no target, flat at 15:15. Every call is listed and ranked; the paper trades the top 20, which
// is marked (inTopN) but not enforced. One Yahoo request per stock (1 month of 5m bars gives the 14-session baseline and
// the ATR). Underlying levels only: nothing here is an option price, a fill or a promise.

const { yahooChart } = require("../lib/common");
const { parseIdx } = require("./indices")._internals;
const { SIP, evaluate, standalone, diagnose } = require("../lib/sip");
const { istClock, reasonKey, feedMeta, scanAll } = require("../lib/sipscan");

// The rule, as shown to the reader (same in the list and in the one-stock reply).
const RULE = {
  firstCandle: "09:15-09:20 IST",
  relativeVolume: `first-candle volume / mean of the same candle over the last ${SIP.baselineDays} full sessions`,
  entry: "stop order at the first candle's high (long) or low (short); no retest, no confirmation",
  stopLoss: `${SIP.stopAtrFrac * 100}% of the ${SIP.atrDays}-day ATR from the entry`,
  exit: "no target; flat at 15:15 IST",
  assumedCostPerSidePct: SIP.costPerSidePct,
};

const NOTES = [
  "Adapted from Zarattini, Barbon & Aziz (2024), a US-equity study (2016-2023, a portfolio of 20 names, share trades, costs of about 0.007% per side). It has not been tested on NSE here, and an option trade is a different bet from the paper's.",
  "The paper's edge per trade is small (about +0.08R above 1.0x relative volume) and its stop is tight. At the assumed NSE cost each call shows its round-trip cost in R; a tight stop can lose most of an R to costs before the trade moves.",
  "Relative volume uses Yahoo's 09:15 candle, which can be revised shortly after it closes. Re-check it a minute later, and against your broker's feed, before placing the order.",
  "A touch inside a candle that has not closed yet is not shown; PENDING can lag a real fill by up to five minutes. Place the stop order yourself at the level; this page never does.",
  "Levels are for the underlying share. Option contract, premium, spread and liquidity are separate checks. F&O ban status is not checked.",
  "Screening aid, not trading advice, and not proof of an edge.",
];

async function oneStock(symRaw, nowSec, t0, res, debug) {
  const sym = String(symRaw).trim().toUpperCase();
  if (!/^[A-Z0-9&-]{1,20}$/.test(sym)) return res.status(400).json({ error: "Pass ?sym= with an NSE symbol such as RELIANCE." });
  let parsed;
  try {
    parsed = parseIdx(await yahooChart(sym + ".NS", 0, "1mo", "5m"));
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    const missing = e && e.message === "HTTP 404";
    return res.status(missing ? 404 : 502).json({ error: missing ? "No 5-minute data for that symbol." : "Could not load that stock's 5-minute data.", hint: "Check the symbol or try again in a minute." });
  }
  const out = evaluate(sym, parsed.bars, nowSec);
  const ts = parsed.meta && Number.isFinite(parsed.meta.regularMarketTime) ? parsed.meta.regularMarketTime : 0;
  const call = out.ok ? standalone(out.call) : null;
  const bars = call
    ? parsed.bars.filter((b) => b.d === call.session && b.t + 300 <= nowSec).map((b) => ({ mm: b.mm, o: b.o, hi: b.hi, lo: b.lo, cl: b.cl, vol: b.vol }))
    : [];
  res.setHeader("Cache-Control", "public, s-maxage=45, stale-while-revalidate=90");
  return res.status(200).json({
    meta: { ...feedMeta(call && call.session, ts, nowSec), sym, rule: RULE, notes: NOTES, source: "Yahoo Finance 5m (1 month)", generatedAt: new Date().toISOString(), tookMs: Date.now() - t0 },
    call,
    skip: out.ok ? null : reasonKey(out.skip),
    bars,
    ...(debug ? { debug: diagnose(parsed.bars, nowSec) } : {}),
  });
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const q = (req && req.query) || {};
  const asked = parseFloat(q.minRvol);
  const minRvol = Number.isFinite(asked) ? Math.min(50, Math.max(0, asked)) : SIP.minRvol;
  const nowSec = Math.floor(Date.now() / 1000);
  // Two more routes live behind this one so the project stays inside the Hobby plan's 12-function limit.
  // vercel.json rewrites /api/notify and /api/orbstudy to these modes.
  if (q.mode === "notify") return require("../lib/notifyroute")(req, res);
  if (q.mode === "study") return require("../lib/orbstudyroute")(req, res);
  if (q.sym != null && String(q.sym).trim() !== "") return oneStock(q.sym, nowSec, t0, res, q.debug != null && String(q.debug) !== "" && String(q.debug) !== "0");

  const rankParam = q.rank === "volume" || q.rank === "range" ? q.rank : "auto";
  const scan = await scanAll(nowSec, minRvol, rankParam);
  if (scan.error) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(scan.error.code).json({ error: scan.error.error, hint: scan.error.hint });
  }
  const { universe, evaluated, ranked, skipped, failed, newestTs, sessionDate, byStatus, rankBy } = scan;

  res.setHeader("Cache-Control", "public, s-maxage=45, stale-while-revalidate=90");
  return res.status(200).json({
    meta: {
      ...feedMeta(sessionDate, newestTs, nowSec),
      rankBy,
      rankNote: rankBy === "range" ? "Ranked by first-candle range vs its normal, not volume: Yahoo has no usable 09:15 volume history. Not the paper's rule." : null,
      minRvol,
      topN: SIP.topN,
      universe: universe.length,
      evaluated: evaluated.length,
      failed,
      skipped,
      inPlay: evaluated.filter((c) => c.rvol >= SIP.minRvol).length,
      listed: ranked.length,
      inTopN: ranked.filter((c) => c.inTopN).length,
      byStatus,
      rule: RULE,
      notes: NOTES,
      source: "Yahoo Finance 5m (1 month)",
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - t0,
    },
    calls: ranked,
  });
};

module.exports._internals = { istClock, reasonKey, scanAll, feedMeta, SIP_RULE: RULE };
