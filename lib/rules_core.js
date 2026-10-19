// lib/rules_core.js - shared pieces of the index rulebooks (v2). Pure functions, no network.
// Honesty rules: only finished candles; swing points are only known n bars after they formed; every filter that
// cannot run is SKIPPED VISIBLY (it appears in the checks list), never silently passed.

const { ema } = require("./indicators");

// Strike steps are typical ATM steps; confirm against your broker's option chain.
// Note: ^NSMIDCP is Yahoo Finance's ticker for NIFTY NEXT 50 (not Midcap, despite the symbol name).
// Verified against Yahoo's API response which returns longName: "NIFTY NEXT 50".
const INDICES = [
  { key: "NIFTY", name: "NIFTY 50", yahoo: ["^NSEI"], step: 50, weekly: true },
  { key: "BANKNIFTY", name: "NIFTY BANK", yahoo: ["^NSEBANK"], step: 100, weekly: false },
  { key: "FINNIFTY", name: "NIFTY FIN SERVICE", yahoo: ["NIFTY_FIN_SERVICE.NS"], step: 50, weekly: false },
  { key: "MIDCPNIFTY", name: "NIFTY MIDCAP SELECT", yahoo: ["NIFTY_MID_SELECT.NS"], step: 25, weekly: false },
  { key: "NIFTYNXT50", name: "NIFTY NEXT 50", yahoo: ["^NSMIDCP"], step: 100, weekly: false },
];

// NSE trading holidays (ISO date strings). When a scheduled expiry Tuesday falls on one of these,
// expiry shifts to the previous trading day. Update this list at the start of each calendar year
// from the NSE circulars: https://www.nseindia.com/regulations/exchanges-background-holidays
// FY 2025-26 and 2026-27 holidays (source: NSE circular dated Dec 2024 and Dec 2025).
const NSE_HOLIDAYS = new Set([
  // 2025
  "2025-02-26", "2025-03-14", "2025-03-31", "2025-04-10", "2025-04-14",
  "2025-04-18", "2025-05-01", "2025-08-15", "2025-08-27", "2025-10-02",
  "2025-10-20", "2025-10-21", "2025-10-22", "2025-11-05", "2025-11-26",
  "2025-12-25",
  // 2026
  "2026-01-26", "2026-02-17", "2026-03-10", "2026-03-19", "2026-03-20",
  "2026-03-30", "2026-04-03", "2026-04-14", "2026-05-01", "2026-05-25",
  "2026-07-17", "2026-08-14", "2026-08-15", "2026-10-02", "2026-10-09",
  "2026-10-20", "2026-10-26", "2026-11-25", "2026-12-25",
  // 2027 (update when NSE publishes the circular)
  "2027-01-26", "2027-03-11", "2027-03-29", "2027-03-30", "2027-04-14",
  "2027-05-01", "2027-05-13", "2027-08-15", "2027-08-16", "2027-10-02",
  "2027-10-28", "2027-10-29", "2027-11-15", "2027-12-25",
]);

// Rule parameters (v2). Fixed in advance. NOT optimised on any data. Do not change them to improve a backtest.
const P = {
  orStart: 555, // 09:15 in minutes after midnight
  orEnd: 570, // 09:30
  sessionEnd: 930, // 15:30
  bufW: 0.1, // breakout buffer = 10% of the opening range width
  retestW: 0.1, // a retest counts when the low comes within 10% of the width above the level
  orWidthLo: 0.5, // opening range vs the recent typical width: full size 0.5x to 2x
  orWidthHi: 2,
  orbSizeHalfMax: 3, // 2x to 3x typical = half size; beyond 3x or under 0.5x = skip
  orbVolMult: 1.5, // Track 1: breakout candle volume >= 1.5x the mean of up to 20 prior bars of the session
  orbVolBars: 20,
  orbVolMinBars: 3,
  orbBreak: { t1: 2, t2: 3 }, // Track 1 targets in R
  orbRetest: { t1: 1, t2: 2 }, // Track 2 targets in R
  maxAge: 2, // a trigger is only actionable for this many closed bars
  orbCutoff: 840, // no new ORB entries after 14:00
  // Ichimoku (intraday)
  ichiTrendADX: 20,
  ichiEMASlopeBars: 10,
  ichiStart: 600, // no intraday entries 9:15 to 10:00
  ichiCutoff: 870, // trigger candle must start before 14:30 (so no entries 14:45 to 15:30)
  ichiMaxRetrace: 0.618,
  ichiMinRetrace: 0.382,
  ichiMinLegPct: 0.4,
  ichiVolMult: 1.0,
  ichiVolBars: 3,
  cloudMinPct: 0.25, // Daily cloud thinner than this = chop (ichi_swing only)
  swingMaxRiskPct: 4.0, // ichi_swing underlying stop cap, % of price (assumption: the spec gave no number)
  // VWAP
  vwapStart: 590, // 09:50
  vwapCutoff: 870, // no new entries after 14:30
  vwapEvalEnd: 885, // evaluation window ends 14:45
  vwapTolPct: 0.1, // "at VWAP" = within 0.1% of price
  vwapMaxCross: 3, // this many VWAP crossings since 09:30 = chop (pullback only)
  vwapReclaimAboveMin: 45, // minutes above VWAP before the dip = 9 five-minute closes
  vwapReclaimDipMax: 3,
  vwapReclaimVolMult: 1.0,
  vwapReclaimVolBars: 2,
  vwapRSIPeriod: 9,
  vwapRSIMinBars: 15,
  vwapRSILong: [38, 58],
  vwapRSIShort: [45, 65],
  // Options filters
  vixPctlBlock: 60,
  vixWindow: 60,
  maxPainMinDist: 0.5,
  maxPainMaxDist: 1.5,
  maxPainSkipNear: 0.2,
  maxPainStart: 840,
  maxPainEnd: 930,
  maxRiskPct: { orb: 0.7, vwap: 0.5, ichi: 1.0 }, // underlying stop distance, % of price
};

const STRATS = {
  orb_break: { label: "ORB breakout (Track 1)", group: "orb" },
  orb_retest: { label: "ORB retest (Track 2)", group: "orb" },
  ichi: { label: "Ichimoku + Fib (intraday)", group: "ichi" },
  ichi_swing: { label: "Ichimoku swing (Daily / 4h)", group: "ichi" },
  vwap_reclaim: { label: "VWAP reclaim", group: "vwap" },
  vwap_pullback: { label: "VWAP pullback", group: "vwap" },
  vwap_info: { label: "Session average (proxy) — information only", group: "vwap" },
  expiry_maxpain: { label: "Expiry max-pain", group: "expiry" },
};

const f2 = (v) => (Math.round(v * 100) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hhmm = (mm) => String(Math.floor(mm / 60)).padStart(2, "0") + ":" + String(mm % 60).padStart(2, "0");
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// Only bars that have finished. A bar ends at its start + step, but never later than the 15:30 close.
function closedOnly(bars, step, nowSec) {
  return bars.filter((b) => b.t + Math.min(step, Math.max(60, (P.sessionEnd - b.mm) * 60)) <= nowSec);
}

// Swing points: a bar is a pivot when it beats `n` bars on each side. A pivot is only known n bars later,
// so only bars with n closed bars after them are returned (no look-ahead).
function pivots(bars, n) {
  const hi = [];
  const lo = [];
  for (let i = n; i < bars.length - n; i++) {
    let isH = true;
    let isL = true;
    for (let k = 1; k <= n; k++) {
      if (!(bars[i].hi > bars[i - k].hi) || !(bars[i].hi >= bars[i + k].hi)) isH = false;
      if (!(bars[i].lo < bars[i - k].lo) || !(bars[i].lo <= bars[i + k].lo)) isL = false;
    }
    if (isH) hi.push({ i, p: bars[i].hi });
    if (isL) lo.push({ i, p: bars[i].lo });
  }
  return { hi, lo };
}

// Mirror a bar so every strategy can be written once for the long side. Prices are negated, so a short
// setup is a long setup in negative space; sg * value maps a level back to real prices.
const neg = (b) => ({ ...b, o: -b.o, hi: -b.lo, lo: -b.hi, cl: -b.cl });

// Shift a date backward to the previous trading day (skip weekends and NSE holidays).
function prevTradingDay(d) {
  let dt = new Date(d.getTime() - 864e5); // go back one day
  while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6 || NSE_HOLIDAYS.has(dt.toISOString().slice(0, 10))) {
    dt = new Date(dt.getTime() - 864e5);
  }
  return dt;
}

function isExpiryDay(ix, iso) {
  // Find the scheduled Tuesday expiry.
  const d = new Date(iso + "T00:00:00Z");
  const dow = d.getUTCDay();

  // Determine which Tuesday is the candidate expiry.
  let expTue;
  if (ix.weekly) {
    // Weekly: every Tuesday is a potential expiry.
    // Check if `iso` is the effective expiry for this week's Tuesday.
    // Find this week's Tuesday (or the previous one if iso is Mon/Sun).
    const daysSinceTue = (dow + 5) % 7; // 0 = Tue, 1 = Wed, ..., 6 = Mon
    expTue = new Date(d.getTime() - daysSinceTue * 864e5);
    // Only check the Tuesday that `iso` could be the shifted expiry of.
    // Also check the next Tuesday in case iso is a shifted expiry for it.
    for (const candidate of [expTue, new Date(expTue.getTime() + 7 * 864e5)]) {
      const cIso = candidate.toISOString().slice(0, 10);
      if (NSE_HOLIDAYS.has(cIso)) {
        const shifted = prevTradingDay(candidate);
        if (shifted.toISOString().slice(0, 10) === iso) return true;
      } else if (cIso === iso) {
        return true; // normal Tuesday, not a holiday
      }
    }
    return false;
  } else {
    // Monthly: last Tuesday of the month.
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    expTue = new Date(lastDay);
    while (expTue.getUTCDay() !== 2) expTue = new Date(expTue.getTime() - 864e5);

    const expIso = expTue.toISOString().slice(0, 10);
    if (NSE_HOLIDAYS.has(expIso)) {
      const shifted = prevTradingDay(expTue);
      return shifted.toISOString().slice(0, 10) === iso;
    }
    return expIso === iso;
  }
}

function res(strategy, state, action, o = {}) {
  const s = STRATS[strategy] || { label: strategy, group: strategy };
  return {
    strategy,
    label: o.label || s.label,
    group: s.group,
    state,
    action, // BUY CE | BUY PE | WAIT | NO TRADE | NO DATA | CLOSED | INFO
    side: o.side || null,
    note: o.note || "",
    level: o.level == null ? null : o.level,
    levelNote: o.levelNote || "",
    sl: o.sl == null ? null : o.sl,
    t1: o.t1 == null ? null : o.t1,
    t2: o.t2 == null ? null : o.t2,
    riskPct: o.riskPct == null ? null : o.riskPct,
    checks: o.checks || [],
    info: !!o.info, // information-only row: never counted as actionable
    sizeHint: o.sizeHint || null, // ORB: full | half | skip
    trail: o.trail || null, // information only, not simulated
    trendSource: o.trendSource || null, // Ichimoku: ADX15 | EMA5 | none
    reliability: o.reliability || null, // VWAP rows: high | medium | low
    blockedBy: null, // "vix" | "size" when a BUY was downgraded
    tags: [],
  };
}

// Turn a triggered setup into a final call, applying the blocking rules. Checks flagged info:true never block.
function settle(r, ctx, blockers) {
  const bad = blockers.filter((b) => !b.ok && !b.info);
  r.checks = r.checks.concat(blockers);
  if (bad.length) {
    r.action = "NO TRADE";
    r.note = bad.map((b) => b.text).join(" · ");
    return r;
  }
  r.action = r.side === "long" ? "BUY CE" : "BUY PE";
  return r;
}

function expiryBlock(ix, ctx) {
  return [{ ok: !ctx.expiry[ix.key], text: "Not an expiry day (expiry-day trading is outside this ruleset)" }];
}

// True when the recent bars carry volume (at least 80% of the last 40 bars have vol > 0). Index feeds usually do not.
function hasVolOf(bars) {
  const a = bars.slice(-40);
  return a.length > 0 && a.filter((b) => b.vol > 0).length >= 0.8 * a.length;
}

// Volume confirmation: bars[k].vol >= mult x mean of the `back` bars before k. Returns {ok, skipped, ...}.
function volCheck(bars, k, back, mult, hasVol, minBars) {
  if (!hasVol) return { ok: true, skipped: true };
  const prev = bars.slice(Math.max(0, k - back), k);
  if (prev.length < (minBars || back)) return { ok: false, skipped: false, short: true, prevN: prev.length };
  const m = mean(prev.map((b) => b.vol));
  return { ok: m <= 0 ? bars[k].vol > 0 : bars[k].vol >= mult * m, skipped: false, vol: bars[k].vol, mean: m };
}

// Fibonacci pullback trigger shared by the intraday and swing Ichimoku rules (long side on mirrored bars).
// bars: mirrored closed bars; opts: { tfMin, startMM, cutoffMM (null for no time rule), maxRisk, volMult, volBars, hasVol, ctx, ix }
function fibEngine(S, side, bars, price, base, o) {
  const sg = side === "long" ? 1 : -1;
  const pv = pivots(bars, 3);
  const Hp = pv.hi[pv.hi.length - 1];
  const Lp = Hp ? [...pv.lo].reverse().find((x) => x.i < Hp.i) : null;
  if (!Hp || !Lp) return res(S, "NO SWING LEG", "WAIT", { ...base, note: `No confirmed ${o.tfName} swing low then swing high yet.` });
  const leg = Hp.p - Lp.p;
  const n = bars.length;
  if ((leg / Math.abs(price)) * 100 < P.ichiMinLegPct) {
    return res(S, "SWING LEG TOO SMALL", "WAIT", { ...base, note: `Last ${o.tfName} swing leg is under ${P.ichiMinLegPct}% of price.` });
  }
  let rl = Infinity;
  for (let k = Hp.i + 1; k < n; k++) rl = Math.min(rl, bars[k].lo);
  const l382 = Hp.p - P.ichiMinRetrace * leg;
  const l618 = Hp.p - P.ichiMaxRetrace * leg;
  const zone = `${f2(sg * l382)} to ${f2(sg * l618)} (38.2% to 61.8%)`;
  base.levelNote = `${base.levelNote ? base.levelNote + " · " : ""}Swing ${f2(sg * Lp.p)} to ${f2(sg * Hp.p)}; zone ${zone}`;
  if (rl < Lp.p) return res(S, "STRUCTURE BROKEN", "NO TRADE", { ...base, note: "Price has gone below the swing the leg started from." });
  const depth = (Hp.p - rl) / leg;
  if (depth < P.ichiMinRetrace) {
    return res(S, "TREND OK, AWAITING PULLBACK", "WAIT", { ...base, level: sg * l382, note: `Wait for a pullback into ${zone}.` });
  }
  if (depth > P.ichiMaxRetrace) {
    return res(S, "PULLBACK TOO DEEP", "NO TRADE", { ...base, note: `Retraced ${(depth * 100).toFixed(0)}% of the leg (limit 61.8%): not a shallow continuation.` });
  }
  const deepest = depth >= 0.5 ? "50%" : "38.2%";

  let touch = -1;
  for (let k = Hp.i + 1; k < n; k++) {
    if (bars[k].lo <= l382) {
      touch = k;
      break;
    }
  }
  let trig = -1;
  let volWhy = null;
  let volSkipped = false;
  for (let k = touch; k < n; k++) {
    const b = bars[k];
    if (o.startMM != null && b.mm < o.startMM) continue; // no entries before the start time
    if (!(b.lo <= l382 && b.cl > l382)) continue; // dips into the zone and closes back beyond the 38.2% level
    const v = volCheck(bars, k, o.volBars, o.volMult, o.hasVol, o.volBars);
    if (v.skipped) volSkipped = true;
    if (!v.ok) {
      volWhy = v;
      continue;
    }
    trig = k;
    break;
  }
  const volTxt = volSkipped ? "Volume clause skipped (no index volume)" : `Trigger candle volume at least ${o.volMult}x the mean of the prior ${o.volBars} bars`;
  base.checks = base.checks.concat([{ ok: true, text: volTxt, info: volSkipped }]);
  if (trig < 0) {
    return res(S, "IN FIB ZONE, AWAITING REJECTION", "WAIT", {
      ...base,
      level: sg * l382,
      note: volWhy
        ? `Pulled back to the ${deepest} level and closed back ${side === "long" ? "above" : "below"} it, but volume was too low. Needs the volume clause.`
        : `Pulled back to the ${deepest} level. Needs a ${o.tfName} candle that dips in and closes back ${side === "long" ? "above" : "below"} ${f2(sg * l382)}${o.hasVol ? " on volume" : ""}.`,
    });
  }
  const slT = Math.min(...bars.slice(touch, trig + 1).map((b) => b.lo));
  const trigMM = bars[trig].mm;
  const trigTime = o.tfMin >= 240 ? `${bars[trig].d.slice(5)} ${hhmm(trigMM)}` : hhmm(trigMM + o.tfMin);
  for (let k = trig + 1; k < n; k++) {
    if (bars[k].cl < slT) return res(S, "STOPPED OUT", "NO TRADE", { ...base, note: `Triggered ${trigTime}, then closed under the retrace low.` });
  }
  if (o.cutoffMM != null && trigMM >= o.cutoffMM) return res(S, "PAST ENTRY CUTOFF", "NO TRADE", { ...base, note: `Triggered ${trigTime}, after the entry cutoff.` });
  const age = n - 1 - trig;
  if (age > P.maxAge) return res(S, "TRIGGER STALE", "WAIT", { ...base, note: `Triggered ${trigTime}, ${age} bars ago. Do not chase.` });

  const entryT = sg * price;
  const R = entryT - slT;
  const riskPct = (R / Math.abs(price)) * 100;
  const t1T = Hp.p;
  const t2T = Lp.p + 1.272 * leg;
  const out = res(S, "TRIGGERED", "WAIT", {
    ...base,
    level: price,
    sl: sg * slT,
    t1: sg * t1T,
    t2: sg * t2T,
    riskPct,
    note: `Rejection at the ${deepest} level, trigger ${trigTime}. Stop under the retrace low; T1 is the prior swing, T2 the 127.2% extension.`,
  });
  const blockers = [
    { ok: R > 0, text: "Stop is on the right side of price" },
    { ok: riskPct <= o.maxRisk, text: `Underlying stop ${riskPct.toFixed(2)}% of price (max ${o.maxRisk}%)` },
    { ok: t1T - entryT >= R, text: "Room to the prior swing is at least 1x the risk" },
  ];
  if (o.expiryBlock) blockers.push(...expiryBlock(o.ix, o.ctx));
  return settle(out, o.ctx, blockers);
}

module.exports = { INDICES, P, STRATS, NSE_HOLIDAYS, f2, hhmm, mean, ema, closedOnly, pivots, neg, prevTradingDay, isExpiryDay, res, settle, expiryBlock, hasVolOf, volCheck, fibEngine };
