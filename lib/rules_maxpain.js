// lib/rules_maxpain.js - expiry-day max-pain drift (NIFTY and BANKNIFTY only, 14:00 to 15:30 on expiry days).
// It needs OPEN INTEREST from an option chain. Yahoo has none, so without a broker adapter this row says NO TRADE and
// never guesses. Max pain = the settlement price at which option WRITERS lose the least in total.

const { P, f2, hhmm, res, settle, stopSideCheck } = require("./rules_core");

const S = "expiry_maxpain";
const ONLY = /^(NIFTY|BANKNIFTY)$/;

// chain: { strikes: [{ strike, ce: { oi }, pe: { oi } }] }
function maxPain(chain) {
  const rows = (chain && chain.strikes) || [];
  if (rows.length < 3) return null;
  let best = null;
  for (const t of rows) {
    const s = t.strike;
    let loss = 0;
    for (const u of rows) {
      loss += ((u.ce && u.ce.oi) || 0) * Math.max(s - u.strike, 0) + ((u.pe && u.pe.oi) || 0) * Math.max(u.strike - s, 0);
    }
    if (!best || loss < best.loss) best = { strike: s, loss };
  }
  return best;
}

// Returns a row, or null when the strategy does not apply (not NIFTY / BANKNIFTY, or not an expiry day).
function evalMaxPain(ix, c5, price, ctx) {
  if (!ONLY.test(ix.key) || !ctx.expiry[ix.key]) return null;
  if (!ctx.chain) return res(S, "NO OPTION CHAIN", "NO TRADE", { note: "Needs option-chain OI; configure a broker adapter." });
  const mp = maxPain(ctx.chain);
  if (!mp) return res(S, "NO OPTION CHAIN", "NO TRADE", { note: "Needs option-chain OI; the chain from the adapter had too few strikes." });
  const day = c5.filter((b) => b.d === ctx.liveISO);
  const n = day.length;
  if (n < 2) return res(S, "WAITING", "WAIT", { note: "Not enough bars yet." });
  const levelNote = `Max pain ${f2(mp.strike)}`;
  const nowMM = day[n - 1].mm + 5;
  if (nowMM < P.maxPainStart) return res(S, "ACTIVE FROM 14:00", "WAIT", { levelNote, note: `Max pain is ${f2(mp.strike)}. The rule is only active from 14:00 on expiry day.` });
  const dist = (p) => (Math.abs(p - mp.strike) / p) * 100;

  let trig = -1;
  let side = null;
  for (let k = Math.max(1, day.findIndex((b) => b.mm >= P.maxPainStart)); k < n; k++) {
    if (day[k].mm < P.maxPainStart || day[k].mm >= P.maxPainEnd) continue;
    const d = dist(day[k].cl);
    if (d < P.maxPainMinDist || d > P.maxPainMaxDist) continue;
    const above = day[k].cl > mp.strike;
    const toward = above ? day[k].cl < day[k - 1].cl : day[k].cl > day[k - 1].cl;
    if (toward) {
      trig = k;
      side = above ? "short" : "long";
      break;
    }
  }
  const d0 = dist(price);
  if (trig < 0) {
    if (d0 > P.maxPainMaxDist) return res(S, "TOO FAR FROM MAX PAIN", "NO TRADE", { levelNote, note: `Price is ${d0.toFixed(2)}% from max pain (limit ${P.maxPainMaxDist}%). Skip.` });
    if (d0 < P.maxPainMinDist) {
      return res(S, "TOO CLOSE TO MAX PAIN", "NO TRADE", { levelNote, note: `Price is ${d0.toFixed(2)}% from max pain (needs ${P.maxPainMinDist}% to ${P.maxPainMaxDist}%${d0 < P.maxPainSkipNear ? "; under 0.2% is skipped outright" : ""}).` });
    }
    return res(S, "AWAITING 5M CLOSE TOWARD MAX PAIN", "WAIT", { levelNote, level: mp.strike, note: `Price is ${d0.toFixed(2)}% from max pain. Needs a 5m close toward ${f2(mp.strike)}.` });
  }
  const sg = side === "long" ? 1 : -1;
  const prior = day.slice(Math.max(0, trig - 3), trig);
  const slT = side === "long" ? Math.min(...prior.map((b) => b.lo)) : Math.max(...prior.map((b) => b.hi));
  const trigTime = hhmm(day[trig].mm + 5);
  const age = n - 1 - trig;
  const base = { side, levelNote };
  if (age > P.maxAge) return res(S, "TRIGGER STALE", "WAIT", { ...base, note: `Triggered ${trigTime}, ${age} bars ago. Do not chase.` });
  const R = sg * (price - slT);
  const riskPct = (R / price) * 100;
  const out = res(S, "TRIGGERED", "WAIT", {
    ...base,
    level: price,
    sl: slT,
    t1: mp.strike,
    t2: null,
    riskPct,
    note: `5m close toward max pain ${f2(mp.strike)} at ${trigTime}, ${dist(day[trig].cl).toFixed(2)}% away. Stop beyond the prior 3 candles; the only target is max pain.`,
  });
  return settle(out, ctx, [
    stopSideCheck(R),
    { ok: sg * (mp.strike - price) >= R, text: "Room to max pain is at least 1x the risk", info: true },
  ]);
}

module.exports = { maxPain, evalMaxPain };
