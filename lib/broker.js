// lib/broker.js - the ONE place a broker data adapter plugs in. No adapter is configured, so every call throws.
//
// Why it exists: Yahoo Finance has no index volume, no option chain and no option premium history. Without a
// broker feed the app cannot compute a true VWAP, show live open interest / max pain, or back-test real premiums.
// The rest of the code calls these functions inside try/catch and shows "no broker data" instead of guessing.
//
// To enable one, replace the bodies below (and set configured() to true) using your broker's historical-data and
// option-chain API. Keep any credentials in Vercel environment variables, never in this repository.
//
// Contract (all times IST, bars oldest first):
//   fetchBars(symbol, interval, range)   -> [{ t (unix s), o, hi, lo, cl, vol }]   e.g. ("NIFTY", "5m", "2y")
//   fetchOptionChain(underlying, expiry) -> { underlying, expiry, spot, strikes: [{ strike, ce: {oi, ltp, iv}, pe: {oi, ltp, iv} }] }
//   fetchOptionPremium(underlying, expiry, strike, type, fromSec, toSec, interval) -> [{ t, o, hi, lo, cl }]   (optional)

const NONE = "No broker adapter configured";

function configured() {
  return false;
}

async function fetchBars(symbol, interval, range) {
  throw new Error(NONE);
}

async function fetchOptionChain(underlying, expiry) {
  throw new Error(NONE);
}

async function fetchOptionPremium(underlying, expiry, strike, type, fromSec, toSec, interval) {
  throw new Error(NONE);
}

module.exports = { configured, fetchBars, fetchOptionChain, fetchOptionPremium };
