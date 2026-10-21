// api/backtest.js - replays the rulebooks over the recent past for ONE index (?index=NIFTY).
// Yahoo only serves about 60 calendar days of 5m / 15m data, so this covers roughly 40 sessions. That is a
// small sample: it can show whether the rules behave sensibly, it cannot prove an edge. With a broker adapter
// (lib/broker.js) it asks for up to 2 years instead.
//
// Honest limits, stated here and on the page:
//   * "Index R" is measured on the index price. It has no spread, theta, slippage or costs.
//   * "Option P&L" is a BLACK-SCHOLES APPROXIMATION (India VIX as ATM IV, +2 vol points for 1-ITM, flat smile).
//     It is not real premium data. Expiry-week gamma and IV behaviour are not modelled; no assignment / pin risk.
//   * India VIX uses the previous session's close vs the prior 60 sessions as a premium-model reference; it does not block signals.
//   * ichi_swing (Daily/4h) and expiry_maxpain (needs option-chain OI) are NOT backtested.
// Returns the trade list; the page computes the statistics from it.

const { _internals: I } = require("./indices");
const { fetchData, replayDay, sessionDates } = require("../lib/replay");
const { indiaVix, vixState } = require("../lib/common");
const { simOption, BS } = require("../lib/bs");
const broker = require("../lib/broker");

const { INDICES, P, STRATS } = I;
const NOT_BACKTESTED = ["ichi_swing", "expiry_maxpain"];

// Option P&L for one trade, for both plans (T1 / T2) and both strikes (ATM / 1-ITM), each with and without IV change.
// r values are multiplied by the size scale (half size counts half); pct is the premium change and is not scaled.
function optionPnl(ix, t, vixLevel) {
  if (!(vixLevel > 0)) return null;
  const out = {};
  for (const plan of ["x1", "x2"]) {
    const x = t[plan];
    if (!x || x.exitMM == null) {
      out[plan] = null;
      continue;
    }
    out[plan] = {};
    for (const [name, itm] of [["atm", false], ["itm", true]]) {
      const s = simOption({ side: t.side, date: t.date, entryMM: t.entryMM, entry: t.entry, sl: t.sl, exitMM: x.exitMM, exitPrice: x.exitPrice }, { ix, vix: vixLevel, itm });
      out[plan][name] = s
        ? {
            strike: s.strike,
            expiry: s.expiry,
            P0: round(s.P0, 2),
            riskFrac: round(s.riskFrac, 4),
            delta: round(s.delta, 3),
            noIv: { pct: round(s.noIv.pct, 2), r: round(s.noIv.r * t.scale, 3) },
            crush: { pct: round(s.crush.pct, 2), r: round(s.crush.r * t.scale, 3) },
          }
        : null;
    }
  }
  return out;
}
const round = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

// Optional: real historical option premiums from the broker adapter. Used for the premium % change only; the premium
// RISK (stop level) still comes from Black-Scholes because a premium history has no "stop-level" price.
async function brokerPremiums(ix, trades) {
  if (!broker.configured()) return { used: false };
  let used = 0;
  for (const t of trades) {
    if (!t.opt) continue;
    for (const plan of ["x1", "x2"]) {
      const x = t[plan];
      for (const name of ["atm", "itm"]) {
        const o = t.opt[plan] && t.opt[plan][name];
        if (!o || x.exitMM == null) continue;
        try {
          const day0 = Date.parse(t.date + "T00:00:00Z") / 1000 - 19800;
          const bars = await broker.fetchOptionPremium(ix.key, o.expiry, o.strike, t.side === "long" ? "CE" : "PE", day0 + t.entryMM * 60, day0 + x.exitMM * 60, "5m");
          if (bars && bars.length >= 2) {
            const p0 = bars[0].o != null ? bars[0].o : bars[0].cl;
            const p1 = bars[bars.length - 1].cl;
            if (p0 > 0 && p1 >= 0) {
              o.real = { pct: round(((p1 - p0) / p0) * 100, 2), r: round(((p1 - p0) / p0 / o.riskFrac) * t.scale, 3), P0: round(p0, 2) };
              used++;
            }
          }
        } catch (e) {
          // no premium for this contract: the Black-Scholes number stays
        }
      }
    }
  }
  return { used: used > 0, contracts: used };
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const key = String((req.query && req.query.index) || "NIFTY").toUpperCase();
  const ix = INDICES.find((x) => x.key === key);
  if (!ix) return res.status(400).json({ error: "Unknown index.", hint: INDICES.map((x) => x.key).join(", ") });

  const [data, vix] = await Promise.all([fetchData(ix, INDICES.indexOf(ix), true), indiaVix()]);
  if (data.error || !data.p5.bars.length) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Could not load history for " + ix.name + ".", detail: String(data.error || "no bars").slice(0, 80) });
  }

  const b5 = data.p5.bars;
  const dates = sessionDates(b5);
  // Only finished sessions: the last session counts only if its final candle (15:25) is there.
  const lastBars = b5.filter((b) => b.d === dates[dates.length - 1]);
  const lastDone = lastBars[lastBars.length - 1].mm >= 920;
  const usable = lastDone ? dates : dates.slice(0, -1);
  const skipHead = 2; // the opening-range check needs a couple of earlier sessions for its typical width

  const trades = [];
  const blocked = [];
  const notes = { sessions: 0, expiryDays: 0, tooFew: 0, vixUnknown: 0 };
  for (let d = skipHead; d < usable.length; d++) {
    const iso = usable[d];
    const n = b5.reduce((c, b) => c + (b.d === iso ? 1 : 0), 0);
    if (n < 60) {
      notes.tooFew++; // a half day or a data gap
      continue;
    }
    const vs = vixState(vix, iso, false);
    if (!vs.ok) notes.vixUnknown++;
    const rep = replayDay(ix, data, iso, null, { vix: vs.ok ? vs : null });
    notes.sessions++;
    if (rep.expiry) notes.expiryDays++;
    for (const s of rep.signals) {
      if (!s.valid) continue;
      s.opt = optionPnl(ix, s, s.vixValue);
      trades.push(s);
    }
    blocked.push(...rep.blocked);
    if (Date.now() - t0 > 50000) {
      notes.truncated = true;
      break;
    }
  }
  const prem = await brokerPremiums(ix, trades);

  const counts = {};
  for (const b of blocked) {
    const k = b.strategy;
    counts[k] = counts[k] || { size: 0 };
    counts[k][b.by] = (counts[k][b.by] || 0) + 1;
  }

  res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=1800");
  return res.status(200).json({
    index: ix.key,
    name: ix.name,
    step: ix.step,
    from: usable[skipHead] || null,
    to: usable[usable.length - 1] || null,
    sessions: notes.sessions,
    expiryDays: notes.expiryDays,
    skippedShort: notes.tooFew,
    truncated: !!notes.truncated,
    volumeInFeed: b5.some((b) => b.vol > 0),
    source: data.source || "yahoo",
    tookMs: Date.now() - t0,
    vix: { available: !!vix, sessionsWithoutVix: notes.vixUnknown, cautionRule: `show a premium-cost caution when prior-close India VIX is above its ${P.vixPctlCaution}th percentile of the ${P.vixWindow} sessions before it; this does not block an index trigger` },
    option: {
      model: "Black-Scholes approximation",
      rate: BS.r,
      ivSource: "India VIX (previous close) as ATM IV, +2 vol points for the 1-ITM strike",
      crushScenario: "exit IV = 90% of entry IV",
      premiumSource: prem.used ? `broker premiums for ${prem.contracts} contracts, Black-Scholes for the rest` : broker.configured() ? "Black-Scholes only (the broker adapter returned no premiums)" : "Black-Scholes only (no broker adapter)",
      notModelled: "bid/ask spread, skew, IV change during the trade (except the crush scenario), assignment, pin risk, expiry-week gamma",
    },
    blocked: counts,
    blockedTotal: blocked.length,
    blockedList: blocked,
    notBacktested: NOT_BACKTESTED.map((id) => ({ strategy: id, label: STRATS[id].label, why: id === "expiry_maxpain" ? "needs option-chain open interest (no data source)" : "needs Daily/4h history beyond what the intraday replay holds" })),
    strategies: Object.fromEntries(Object.entries(STRATS).filter(([id]) => !NOT_BACKTESTED.includes(id) && id !== "vwap_info")),
    params: {
      maxRiskPct: P.maxRiskPct,
      orbCutoff: "14:00",
      vwapCutoff: "14:30",
      ichiWindow: "10:00 to 14:30",
      maxAge: P.maxAge,
      orbBreakTargets: "2R / 3R",
      orbRetestTargets: "1R / 2R",
      reclaimTargets: "2R / 3R",
      orbVolMult: P.orbVolMult,
      sizeRule: "full 0.5x to 2x typical range, half 2x to 3x, skip beyond",
    },
    trades,
  });
};
module.exports._optionPnl = optionPnl;
