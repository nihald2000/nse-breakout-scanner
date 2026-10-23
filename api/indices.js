// api/indices.js - rule status for the NSE index-derivative underlyings (buy CE / buy PE only).
//   Underlyings : NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50 (Yahoo Finance index tickers)
//   Strategies  : ORB (breakout + retest tracks), Ichimoku + Fibonacci (intraday and Daily/4h swing),
//                 VWAP (reclaim, pullback; needs true VWAP), expiry-day max pain (needs an option chain).
// Rules live in lib/rules_*.js. India VIX is displayed as an option-cost caution; it does not gate triggers.
// Listing policy: every call whose trigger fired is listed (BUY CE / BUY PE). Filters of the tested ruleset (risk cap,
// expiry day, RSI band, entry cutoff, ORB size band, chop) show up as `cautions` on the row instead of hiding the call.
// ?strict=1 restores the tested ruleset exactly (a failed filter becomes NO TRADE); the Backtest replay always runs strict.
// It evaluates the INDEX price only. No option premium, bid/ask or open interest comes from Yahoo.
// Screening aid only, not trading advice, and none of this is proof of an edge.

const { yahooChart, mapPool, istParts, sessionFraction, formatIST, indiaVix, vixState } = require("../lib/common");
const core = require("../lib/rules_core");
const { evalOrb, orbSide } = require("../lib/rules_orb");
const { evalIchi, evalIchiSwing, to4h } = require("../lib/rules_ichi");
const { evalVwap } = require("../lib/rules_vwap");
const { evalMaxPain, maxPain } = require("../lib/rules_maxpain");
const broker = require("../lib/broker");

const { INDICES, P, STRATS, closedOnly, pivots, neg, isExpiryDay, res, hasVolOf } = core;

// Index charts often carry no volume, so unlike lib/common.parseChart this keeps bars with missing volume.
function parseIdx(r) {
  const m = r.meta || {};
  const off = Number.isFinite(m.gmtoffset) ? m.gmtoffset : 19800;
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const hi = q.high && q.high[i];
    const lo = q.low && q.low[i];
    const cl = q.close && q.close[i];
    if (![hi, lo, cl].every(Number.isFinite)) continue;
    const op = q.open && q.open[i];
    const v = q.volume && q.volume[i];
    const lt = ts[i] + off;
    bars.push({
      t: ts[i],
      d: new Date(lt * 1000).toISOString().slice(0, 10),
      mm: Math.floor((lt % 86400) / 60),
      o: Number.isFinite(op) ? op : cl,
      hi,
      lo,
      cl,
      vol: Number.isFinite(v) ? v : 0,
    });
  }
  return { bars, meta: m };
}

// --------------------------------------------------------------------------
// Per-index analysis (pure: no network, easy to test)
//   ctx: { nowSec, todayISO, marketOpen, expiry:{KEY:bool}, vix?:vixState, chain?, skipSwing?, skipMaxPain? }
// --------------------------------------------------------------------------
function analyse(ix, data, ctx) {
  const base = { index: ix.key, name: ix.name, step: ix.step, expiry: !!ctx.expiry[ix.key] };
  if (!data || !data.p5 || !data.p5.bars.length) {
    const ids = ["orb_break", "orb_retest", "ichi", "ichi_swing", "vwap_reclaim", "vwap_pullback"];
    return { ...base, ltp: null, chgPct: null, rows: ids.map((s) => res(s, "NO DATA", "NO DATA", { note: "No price data from the source for this index." })) };
  }
  const all5 = data.p5.bars;
  const liveISO = all5[all5.length - 1].d;
  const c5 = closedOnly(all5, 300, ctx.nowSec);
  const c15 = data.p15 ? closedOnly(data.p15.bars, 900, ctx.nowSec) : [];
  const c1h = data.p1h ? closedOnly(data.p1h.bars, 3600, ctx.nowSec) : [];
  const cD = data.pD ? closedOnly(data.pD.bars, 86400, ctx.nowSec) : [];
  const c4h = data.p1h ? closedOnly(to4h(data.p1h.bars), 14400, ctx.nowSec) : [];
  const m = data.p5.meta || {};
  const lastClose = all5[all5.length - 1].cl;
  const price = Number.isFinite(m.regularMarketPrice) ? m.regularMarketPrice : lastClose;
  const prevDay = [...all5].reverse().find((b) => b.d < liveISO);
  const prevClose = prevDay ? prevDay.cl : m.chartPreviousClose;
  const live = ctx.todayISO === liveISO && ctx.marketOpen;
  const hasVol = hasVolOf(c5.filter((b) => b.d === liveISO));
  const c = { ...ctx, liveISO, live, hasVol };
  const atm = Math.round(price / ix.step) * ix.step;

  const rows = [...evalOrb(ix, c5, price, c), evalIchi(ix, c1h, c15, c5, price, c)];
  if (!ctx.skipSwing) rows.push(evalIchiSwing(ix, cD, c4h, price, c));
  rows.push(...evalVwap(ix, c5, price, c));
  if (!ctx.skipMaxPain) {
    const mp = evalMaxPain(ix, c5, price, c);
    if (mp) rows.push(mp);
  }

  const vs = ctx.vix || null;
  for (const r of rows) {
    // VIX is context for option premium cost, not an evidence-backed directional veto.
    if (vs && vs.ok) {
      r.checks = r.checks.concat([{ ok: true, info: true, text: `India VIX ${vs.value.toFixed(2)} vs its 60th percentile ${vs.p60.toFixed(2)} over the last ${vs.n} sessions${vs.elevated ? "; elevated option-cost caution only, not a trigger blocker" : "; below the elevated-cost threshold"}` }]);
    } else {
      r.checks = r.checks.concat([{ ok: true, info: true, text: `India VIX unavailable; option implied-volatility cost cannot be assessed (${(vs && vs.note) || "no data"})` }]);
    }
    if (r.side) r.option = r.side === "long" ? `${atm} CE (1 ITM ${atm - ix.step})` : `${atm} PE (1 ITM ${atm + ix.step})`;
    if (!live && /^BUY|^WAIT$/.test(r.action)) {
      r.action = "CLOSED";
      r.note = "Market is closed; this is the state at the last session's end. " + r.note;
    }
    // Data-quality tags, shown on every row.
    const tags = [];
    if (r.group === "vwap") tags.push(hasVol ? "true VWAP" : "proxy");
    if (!hasVol && r.group !== "expiry") tags.push("no volume");
    tags.push(vs && vs.ok ? (vs.elevated ? "VIX elevated" : "VIX below p60") : "VIX n/a");
    if (r.group === "expiry") tags.push(ctx.chain ? "chain ok" : "no chain");
    r.tags = tags;
  }
  return {
    ...base,
    ltp: price,
    chgPct: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null,
    atm,
    liveISO,
    asOfTs: m.regularMarketTime || null,
    hasVolume: hasVol,
    rows,
  };
}

async function fetchIndex(ix, i) {
  let err = null;
  for (const sym of ix.yahoo) {
    try {
      const [r5, r15, r1h, rD] = await Promise.allSettled([
        yahooChart(sym, i, "5d", "5m"),
        yahooChart(sym, i + 1, "1mo", "15m"),
        yahooChart(sym, i, "3mo", "60m"),
        yahooChart(sym, i + 1, "1y", "1d"),
      ]);
      if (r5.status !== "fulfilled") throw r5.reason;
      return {
        sym,
        p5: parseIdx(r5.value),
        p15: r15.status === "fulfilled" ? parseIdx(r15.value) : null,
        p1h: r1h.status === "fulfilled" ? parseIdx(r1h.value) : null,
        pD: rD.status === "fulfilled" ? parseIdx(rD.value) : null,
      };
    } catch (e) {
      err = e;
    }
  }
  return { error: String((err && err.message) || err) };
}

async function handler(req, res) {
  const t0 = Date.now();
  const strict = String(((req && req.query) || {}).strict || "") === "1";
  const now = istParts();
  const nowSec = Math.floor(Date.now() / 1000);
  const marketOpen = sessionFraction(now) < 1;
  const expiry = {};
  for (const ix of INDICES) expiry[ix.key] = isExpiryDay(ix, now.iso);

  // India VIX once per run (cached for an hour), then each index.
  const vix = await indiaVix();
  const vs = vixState(vix, now.iso, true);
  const chains = {};
  if (broker.configured()) {
    await Promise.all(
      INDICES.filter((ix) => /^(NIFTY|BANKNIFTY)$/.test(ix.key) && expiry[ix.key]).map(async (ix) => {
        try {
          chains[ix.key] = await broker.fetchOptionChain(ix.key, now.iso);
        } catch (e) {
          chains[ix.key] = null;
        }
      })
    );
  }
  const ctx = { nowSec, todayISO: now.iso, marketOpen, expiry, vix: vs, strict };

  const got = await mapPool(INDICES, 5, (ix, i) => fetchIndex(ix, i));
  const failed = [];
  let newest = 0;
  const indices = INDICES.map((ix, i) => {
    const d = got[i];
    if (!d || d.error) failed.push(`${ix.key}: ${d ? d.error.slice(0, 60) : "no response"}`);
    const a = analyse(ix, d && !d.error ? d : null, { ...ctx, chain: chains[ix.key] || null });
    if (a.asOfTs) newest = Math.max(newest, a.asOfTs);
    return a;
  });

  if (failed.length === INDICES.length) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({
      error: "Could not load prices for any index.",
      detail: failed.slice(0, 3).join(" | "),
      hint: "The price source may be rate-limiting this server. Try again in a minute.",
    });
  }
  const warnings = [];
  if (failed.length) warnings.push(`No data for ${failed.length} index(es): ${failed.map((x) => x.split(":")[0]).join(", ")}.`);
  const lagMin = newest ? Math.round((Date.now() / 1000 - newest) / 60) : 0;
  if (marketOpen && lagMin > 10) warnings.push(`The newest price is ${lagMin} minutes old, so the data source may be delayed.`);
  if (!vs.ok) warnings.push(`India VIX unavailable; option implied-volatility cost cannot be assessed: ${vs.note}.`);

  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
  return res.status(200).json({
    meta: {
      marketOpen,
      strict,
      asOf: newest ? formatIST(newest) : null,
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - t0,
      source: "Yahoo Finance index prices",
      vix: vs.ok ? { value: vs.value, p60: vs.p60, elevated: vs.elevated, sessions: vs.n } : { unavailable: vs.note },
      brokerConfigured: broker.configured(),
      strategies: STRATS,
    },
    warnings,
    indices,
  });
}

module.exports = handler;
module.exports._internals = {
  INDICES,
  P,
  STRATS,
  parseIdx,
  closedOnly,
  pivots,
  orbSide,
  evalOrb,
  evalIchi,
  evalIchiSwing,
  evalVwap,
  evalMaxPain,
  maxPain,
  analyse,
  isExpiryDay,
  neg,
  to4h,
};
