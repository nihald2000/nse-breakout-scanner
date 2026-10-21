// api/candlebacktest.js - Candlestick backtest of the Sector Scope read on F&O stocks.
//   ?symbols=NBCC,LT&h=3&target=0.5&stop=0.5
// For each symbol: one Yahoo 15m fetch (about a month of closed bars), then lib/candlebacktest
// replays the read candle by candle (no look-ahead) and records each side-change signal with
// what the underlying did next. Facts about the past, not a forecast:
//   * underlying moves only - no option premium, no spread, no costs, no slippage;
//   * if one candle touches both target and stop the order is unknowable -> row says "both";
//   * 15m series only (the live read uses 5m for volume detail), so values can differ slightly;
//   * one month is a small in-sample window; this checks the read, it does not prove an edge.

const { mapPool, yahooChart, formatIST } = require("../lib/common");
const { parseIdx } = require("./indices")._internals;
const { replayRead } = require("../lib/candlebacktest");

const SYM_RE = /^[A-Z0-9&.-]{1,20}$/;
const MAX_SYMS = 10;

function clampNum(v, dflt, lo, hi) {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
}

module.exports = async function handler(req, res) {
  const q = (req && req.query) || {};
  const syms = [];
  for (const raw of String(q.symbols || "").split(",")) {
    const s = raw.trim().toUpperCase().replace(/\.NS$/, "");
    if (!s || !SYM_RE.test(s) || syms.includes(s)) continue;
    syms.push(s);
    if (syms.length >= MAX_SYMS) break;
  }
  if (!syms.length) {
    return res.status(400).json({ error: `Pass ?symbols=NBCC,LT with 1 to ${MAX_SYMS} NSE symbols (no .NS).` });
  }
  const h = Math.round(clampNum(q.h, 3, 1, 6));
  const target = clampNum(q.target, 0.5, 0.05, 20);
  const stop = clampNum(q.stop, 0.5, 0.05, 20);
  const nowSec = Math.floor(Date.now() / 1000);

  const got = await mapPool(syms, 4, async (sym, i) => {
    try {
      const r = await yahooChart(sym + ".NS", i, "1mo", "15m");
      const bars = parseIdx(r).bars.filter((b) => b.mm != null && b.t + 900 <= nowSec); // closed bars only
      return { sym, bars };
    } catch (e) {
      return { sym, error: String((e && e.message) || e).slice(0, 80) };
    }
  });

  const rows = [];
  const missing = [];
  let sessions = 0;
  for (const g of got) {
    if (g.error || !g.bars || g.bars.length < 90) {
      missing.push({ sym: g.sym, why: g.error || "not enough closed 15m bars in the fetch" });
      continue;
    }
    const r = replayRead(g.bars, { h, target, stop, warmup: 45 });
    if (r.days > sessions) sessions = r.days;
    for (const ev of r.events) rows.push({ sym: g.sym, ...ev });
  }
  rows.sort((a, b) => (a.d === b.d ? b.mm - a.mm : a.d < b.d ? 1 : -1)); // newest first

  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
  return res.status(200).json({
    meta: {
      asOf: formatIST(nowSec),
      tf: "15m",
      h,
      target,
      stop,
      symbols: syms,
      sessions,
      signals: rows.length,
      basis: "Closed 15-minute candles only; every value at bar i uses bars up to i, fill at the next bar open. VWAP, Tenkan/Kijun, ADX, 30-minute structure, opening range and volume slots are computed on the same 15m series (the live read uses 5m for volume detail), so numbers can differ slightly from the page. Underlying only; no option premium, spread, slippage or costs.",
      limits: "Underlying moves only: no option premium, no spread, no costs, no slippage. If one candle touches both target and stop the order is unknowable and the row says both (counted as neither a win nor a loss). One month of sessions is a small in-sample window: this checks the read, it does not prove an edge.",
      missing,
    },
    rows,
  });
};
