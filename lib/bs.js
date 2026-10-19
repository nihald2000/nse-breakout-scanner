// lib/bs.js - Black-Scholes APPROXIMATION of option premium on an index. Zero dependencies.
// This is a model, not market data. It uses India VIX as a stand-in for ATM implied volatility, assumes a flat
// smile, European exercise and a fixed risk-free rate. It does not model the bid/ask spread, skew, the IV
// change during the trade, assignment, pin risk, or the gamma/IV behaviour of expiry week.

const BS = {
  r: 0.065, // risk-free rate
  itmBumpVol: 0.02, // +2 volatility points for the 1-ITM strike
  crush: 0.9, // exit IV = 90% of entry IV in the "-10% IV" scenario
  minutesPerYear: 525600,
};

// Standard normal CDF, Abramowitz & Stegun 26.2.17 (absolute error below 7.5e-8).
function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upper = d * poly;
  return x >= 0 ? 1 - upper : upper;
}

function d1d2(S, K, T, r, sigma) {
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / v;
  return [d1, d1 - v];
}

// type: "call" | "put". T in years. At or past expiry the price is the intrinsic value.
function price(S, K, T, r, sigma, type) {
  if (!(S > 0) || !(K > 0)) return NaN;
  if (!(T > 0) || !(sigma > 0)) return Math.max(type === "call" ? S - K : K - S, 0);
  const [d1, d2] = d1d2(S, K, T, r, sigma);
  const disc = Math.exp(-r * T);
  return type === "call" ? S * ncdf(d1) - K * disc * ncdf(d2) : K * disc * ncdf(-d2) - S * ncdf(-d1);
}

function delta(S, K, T, r, sigma, type) {
  if (!(T > 0) || !(sigma > 0)) return type === "call" ? (S > K ? 1 : 0) : S < K ? -1 : 0;
  const [d1] = d1d2(S, K, T, r, sigma);
  return type === "call" ? ncdf(d1) : ncdf(d1) - 1;
}

// --------------------------------------------------------------------------
// Expiry calendar (same assumption as the rules engine: Tuesday; NIFTY weekly, the rest last Tuesday of the month).
// When a Tuesday falls on an NSE holiday, the expiry shifts to the previous trading day.
// --------------------------------------------------------------------------
const { NSE_HOLIDAYS, prevTradingDay } = require("./rules_core");

const DAY = 864e5;
const toDate = (iso) => new Date(iso + "T00:00:00Z");
const toISO = (d) => d.toISOString().slice(0, 10);

function lastTuesday(y, m) {
  let d = new Date(Date.UTC(y, m + 1, 0)); // last day of month m
  while (d.getUTCDay() !== 2) d = new Date(d.getTime() - DAY);
  return d;
}

// Shift a Tuesday to its effective expiry date (previous trading day if it's a holiday).
function effectiveExpiry(tue) {
  const iso = toISO(tue);
  return NSE_HOLIDAYS.has(iso) ? toISO(prevTradingDay(tue)) : iso;
}

// The effective expiry date on or after `iso`.
function expiryOnOrAfter(ix, iso) {
  const d = toDate(iso);
  if (ix.weekly) {
    let x = d;
    while (x.getUTCDay() !== 2) x = new Date(x.getTime() + DAY);
    const eff = effectiveExpiry(x);
    // If the effective expiry has already passed (shifted before `iso`), try the next Tuesday.
    if (eff < iso) {
      x = new Date(x.getTime() + 7 * DAY);
      return effectiveExpiry(x);
    }
    return eff;
  }
  let lt = lastTuesday(d.getUTCFullYear(), d.getUTCMonth());
  if (toISO(lt) < iso) lt = lastTuesday(d.getUTCFullYear() + (d.getUTCMonth() === 11 ? 1 : 0), (d.getUTCMonth() + 1) % 12);
  return effectiveExpiry(lt);
}

// Years from (date, minutes after midnight IST) to the 15:30 expiry close.
function yearsTo(expiryISO, iso, mm) {
  const days = Math.round((toDate(expiryISO) - toDate(iso)) / DAY);
  return Math.max((days * 1440 + (930 - mm)) / BS.minutesPerYear, 0);
}

// --------------------------------------------------------------------------
// Option P&L of one index trade.
//   t: { side, date, entryMM, entry, sl, exitMM, exitPrice }
//   o: { ix, vix (India VIX level, e.g. 14.2), itm (bool), expiryISO? }
// Returns null when it cannot be priced. Costs are applied by the caller (they are an input on the page).
// optPnlPct = premium change in %, optR = premium change / premium risk (entry to the stop-level premium).
// --------------------------------------------------------------------------
function simOption(t, o) {
  if (!(o.vix > 0) || t.exitMM == null || !(t.exitPrice > 0)) return null;
  const step = o.ix.step;
  const atm = Math.round(t.entry / step) * step;
  const long = t.side === "long";
  const K = o.itm ? (long ? atm - step : atm + step) : atm;
  const type = long ? "call" : "put";
  const sigma = o.vix / 100 + (o.itm ? BS.itmBumpVol : 0);
  const exp = o.expiryISO || expiryOnOrAfter(o.ix, t.date);
  const T0 = yearsTo(exp, t.date, t.entryMM);
  const T1 = yearsTo(exp, t.date, Math.min(t.exitMM, 930));
  const P0 = price(t.entry, K, T0, BS.r, sigma, type);
  const Pstop = price(t.sl, K, T0, BS.r, sigma, type);
  if (!(P0 > 0.05)) return null; // a few paise: not a real trade
  const riskPrem = P0 - Pstop;
  if (!(riskPrem > 0)) return null;
  const mk = (sig1) => {
    const P1 = price(t.exitPrice, K, T1, BS.r, sig1, type);
    return { P1, pct: ((P1 - P0) / P0) * 100, r: (P1 - P0) / riskPrem };
  };
  const a = mk(sigma);
  const b = mk(sigma * BS.crush);
  return {
    strike: K,
    type,
    expiry: exp,
    sigma,
    P0,
    riskFrac: riskPrem / P0,
    delta: delta(t.entry, K, T0, BS.r, sigma, type),
    noIv: { P1: a.P1, pct: a.pct, r: a.r },
    crush: { P1: b.P1, pct: b.pct, r: b.r },
  };
}

module.exports = { BS, ncdf, price, delta, expiryOnOrAfter, yearsTo, simOption };
