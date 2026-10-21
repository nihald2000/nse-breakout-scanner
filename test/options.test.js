const test = require("node:test");
const assert = require("node:assert/strict");
const bs = require("../lib/bs");
const o = require("../lib/options");

const EXPIRY = "23-Nov-2026";
const TS = "19-Oct-2026 15:40:00";
const R = 0.065;
const DAY = 864e5;

function near(actual, expected, tol, msg) {
  assert.ok(Number.isFinite(actual), `${msg}: not finite (${actual})`);
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} vs ${expected} (tol ${tol})`);
}

test("impliedVol round-trips a call and a put", () => {
  const S = 100, T = 30 / 365;
  for (const [type, K, sigma] of [["call", 105, 0.25], ["put", 95, 0.31]]) {
    const px = bs.price(S, K, T, R, sigma, type);
    const iv = bs.impliedVol(px, S, K, T, R, type);
    near(iv, sigma, 1e-5, `${type} IV`);
  }
});

test("impliedVol rejects a price at or below intrinsic", () => {
  assert.equal(bs.impliedVol(0.01, 110, 100, 20 / 365, R, "call"), null);
  assert.equal(bs.impliedVol(0.01, 90, 100, 20 / 365, R, "put"), null);
});

test("NSE dates and timestamps stay in IST", () => {
  assert.equal(o.nseToIso("23-Nov-2026"), "2026-11-23");
  assert.equal(o.isoToNse("2026-11-23"), "23-Nov-2026");
  assert.equal(o.parseNseTimestamp(TS), Date.UTC(2026, 9, 19, 10, 10, 0));
  assert.equal(o.expiryMs(EXPIRY), Date.UTC(2026, 10, 23, 10, 0, 0));
});

test("pickExpiry skips the front month when 21 DTE are required", () => {
  const now = Date.UTC(2026, 9, 21, 3, 30, 0); // 21-Oct-2026 09:00 IST
  const list = ["27-Oct-2026", "23-Nov-2026", "29-Dec-2026"];
  assert.equal(o.pickExpiry(list, 21, now).label, "23-Nov-2026");
  assert.equal(o.pickExpiry(list, 2, now).label, "27-Oct-2026");
  assert.equal(o.pickExpiry([], 21, now), null);
});

test("interpAtDelta interpolates linearly and marks wide gaps", () => {
  const pts = [
    { delta: 0.2, iv: 0.22, strike: 110, spreadPct: 0.02, oi: 10, src: "mid" },
    { delta: 0.3, iv: 0.26, strike: 115, spreadPct: 0.04, oi: 20, src: "mid" },
  ];
  const mid = o.interpAtDelta(pts, 0.25);
  near(mid.iv, 0.24, 1e-12, "interpolated IV");
  near(mid.strike, 112.5, 1e-12, "interpolated strike");
  near(mid.gap, 0.1, 1e-12, "delta gap");
  assert.equal(mid.mode, "interp");
  assert.equal(o.interpAtDelta([{ delta: 0.4, iv: 0.2, strike: 120 }], 0.25), null);
  assert.equal(o.interpAtDelta([{ delta: 0.249, iv: 0.2, strike: 120 }], 0.25).mode, "exact");
});

test("markOf uses the mid, then falls back to the last price", () => {
  const mid = o.markOf({ bid: 9, ask: 11, last: 10, oi: 5, oiChg: 1, vol: 2 });
  assert.equal(mid.px, 10);
  assert.equal(mid.src, "mid");
  near(mid.spreadPct, 0.2, 1e-12, "spread");
  const last = o.markOf({ bid: 0, ask: 0, last: 7, oi: 5, oiChg: 1, vol: 2 });
  assert.equal(last.px, 7);
  assert.equal(last.src, "last");
  assert.equal(last.spreadPct, null);
  assert.equal(o.markOf(null), null);
});

test("summarizeChain finds ATM and 25Δ IVs, raw and normalised skew", () => {
  const spot = 100;
  const ts = o.parseNseTimestamp(TS);
  const exp = o.expiryMs(EXPIRY);
  const T = (exp - ts) / (365 * DAY);
  const rows = [];
  for (let K = 80; K <= 120; K += 1.25) {
    const call = bs.price(spot, K, T, R, 0.22, "call");
    const put = bs.price(spot, K, T, R, 0.28, "put");
    const q = (px) => ({ bid: px * 0.99, ask: px * 1.01, last: px, ivNse: 0, oi: 100, oiChg: 5, vol: 50 });
    rows.push({ strike: K, ce: q(call), pe: q(put) });
  }
  const s = o.summarizeChain({ sym: "TEST", expiry: EXPIRY, ts: TS, spot, rows });
  assert.equal(s.atm.strike, 100);
  near(s.atm.iv, 0.25, 0.002, "ATM IV");
  near(s.call25.iv, 0.22, 0.002, "25Δ call IV");
  near(s.put25.iv, 0.28, 0.002, "25Δ put IV");
  near(s.rawSkew, 0.06, 0.003, "raw skew");
  near(s.normSkew, 0.24, 0.01, "normalised skew");
  assert.equal(s.quality, "ok");
  assert.ok(s.n.calls >= 5 && s.n.puts >= 5);
});

test("summarizeChain never invents a skew without both 25Δ brackets", () => {
  const spot = 100;
  const ts = o.parseNseTimestamp(TS);
  const exp = o.expiryMs(EXPIRY);
  const T = (exp - ts) / (365 * DAY);
  const rows = [];
  for (let K = 100; K <= 110; K += 5) {
    const call = bs.price(spot, K, T, R, 0.22, "call");
    rows.push({ strike: K, ce: { bid: call * 0.99, ask: call * 1.01, last: call, oi: 100 }, pe: null });
  }
  const s = o.summarizeChain({ sym: "TEST", expiry: EXPIRY, ts: TS, spot, rows });
  assert.equal(s.normSkew, null);
  assert.equal(s.quality, "missing");
  assert.ok(s.flags.includes("no 25Δ put bracket"));
});

test("summarizeChain marks a last-price fallback as thin", () => {
  const spot = 100;
  const ts = o.parseNseTimestamp(TS);
  const exp = o.expiryMs(EXPIRY);
  const T = (exp - ts) / (365 * DAY);
  const rows = [];
  for (let K = 80; K <= 120; K += 1.25) {
    const call = bs.price(spot, K, T, R, 0.22, "call");
    const put = bs.price(spot, K, T, R, 0.28, "put");
    rows.push({
      strike: K,
      ce: { bid: 0, ask: 0, last: call, oi: 100, oiChg: 5, vol: 50 },
      pe: { bid: put * 0.99, ask: put * 1.01, last: put, oi: 100, oiChg: 5, vol: 50 },
    });
  }
  const s = o.summarizeChain({ sym: "TEST", expiry: EXPIRY, ts: TS, spot, rows });
  assert.equal(s.quality, "thin");
  assert.ok(s.flags.some((f) => f.includes("last price")), "last-price flag is present");
});

test("sectorSkew uses a median and reports agreement and sample size", () => {
  const universe = [{ sym: "A" }, { sym: "B" }, { sym: "C" }, { sym: "D" }];
  const industryOf = new Map([["A", "Banks"], ["B", "Banks"], ["C", "IT"], ["D", "Banks"]]);
  const stocks = [
    { sym: "A", normSkew: 0.1, rawSkew: 0.02, quality: "ok", atm: { iv: 0.25 } },
    { sym: "B", normSkew: 0.3, rawSkew: 0.06, quality: "ok", atm: { iv: 0.25 } },
    { sym: "C", normSkew: -0.2, rawSkew: -0.04, quality: "thin", atm: { iv: 0.2 } },
    { sym: "D", normSkew: null, quality: "missing", atm: null },
  ];
  const sec = o.sectorSkew(stocks, universe, industryOf);
  const banks = sec.find((s) => s.sector === "Banks");
  const it = sec.find((s) => s.sector === "IT");
  assert.equal(banks.n, 2);
  assert.equal(banks.total, 3);
  assert.equal(banks.ok, 2);
  near(banks.medianNormSkew, 0.2, 1e-12, "banks median");
  near(banks.agreement, 1, 1e-12, "banks agreement");
  near(banks.medianOkNormSkew, 0.2, 1e-12, "banks liquid median");
  assert.equal(it.lowSample, true);
  near(it.medianNormSkew, -0.2, 1e-12, "IT median");
});

test("market hours are IST and respect the NSE holiday list", () => {
  assert.equal(o.isMarketOpen(new Date("2026-10-21T04:00:00Z")), true); // 09:30 IST Wednesday
  assert.equal(o.isMarketOpen(new Date("2026-10-20T04:00:00Z")), false); // Dussehra
  assert.equal(o.isMarketOpen(new Date("2026-10-21T11:00:00Z")), false); // 16:30 IST
  assert.equal(o.isMarketOpen(new Date("2026-10-24T04:00:00Z")), false); // Saturday
});
