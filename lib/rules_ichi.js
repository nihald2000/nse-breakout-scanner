// lib/rules_ichi.js - Ichimoku + Fibonacci continuation, v2.
//   ichi       : intraday. Trend filter = ADX(14) on 15m (+DI/-DI), falling back to the 5m 20-EMA slope. The 1h cloud is
//                shown as information only and never blocks. Entries only from 10:00 to 14:30 (trigger candle start).
//   ichi_swing : Daily cloud trend + 4h pullback (the v1 1h-cloud logic moved up one level). Not time-of-day limited.

const { ichimoku, FIRST_CLOUD } = require("../api/ichimoku")._internals;
const { adx, ema } = require("./indicators");
const { P, f2, neg, pivots, res, fibEngine, hasVolOf } = require("./rules_core");

function cloudInfo(c1h) {
  if (c1h.length < FIRST_CLOUD + 2) return null;
  const ich = ichimoku(c1h);
  const last = c1h.length - 1;
  const top = ich.top[last];
  const bot = ich.bot[last];
  if (top == null || bot == null) return null;
  const c = c1h[last].cl;
  const pos = c > top ? "above" : c < bot ? "below" : "inside";
  const future = ich.spanA[last] > ich.spanB[last] ? "green" : ich.spanA[last] < ich.spanB[last] ? "red" : "flat";
  const tk = ich.tenkan[last] == null || ich.kijun[last] == null ? null : ich.tenkan[last] > ich.kijun[last] ? "Tenkan above Kijun" : ich.tenkan[last] < ich.kijun[last] ? "Tenkan below Kijun" : "Tenkan on Kijun";
  const widthPct = ((top - bot) / c) * 100;
  return { ich, last, top, bot, c, pos, future, tk, widthPct, cloudTxt: `1h cloud ${f2(bot)} to ${f2(top)} (${widthPct.toFixed(2)}% wide)` };
}

function evalIchi(ix, c1h, c15, c5, price, ctx) {
  const S = "ichi";
  if (c15.length < 12 && c5.length < 12) return res(S, "NO DATA", "NO DATA", { note: "Not enough 15m or 5m history.", trendSource: "none" });
  const ci = cloudInfo(c1h);
  const infoChecks = ci
    ? [
        { ok: true, info: true, text: `1h cloud is ${ci.pos} price; future cloud ${ci.future}; ${ci.tk || "Tenkan/Kijun n/a"} (information only, not a filter)` },
      ]
    : [{ ok: true, info: true, text: "1h cloud not available (information only)" }];
  const cloudTxt = ci ? ci.cloudTxt : "";

  // Trend filter: ADX(14) on 15m first, then the 5m 20-EMA slope.
  let side = null;
  let trendSource = "none";
  let trendTxt = "";
  const a15 = c15.length >= 28 ? adx(c15, 14) : null;
  const li = c15.length - 1;
  if (a15 && a15.adx[li] != null) {
    trendSource = "ADX15";
    const A = a15.adx[li];
    const pd = a15.pdi[li];
    const md = a15.mdi[li];
    trendTxt = `15m ADX(14) ${A.toFixed(1)}, +DI ${pd.toFixed(1)}, -DI ${md.toFixed(1)} (needs ADX at least ${P.ichiTrendADX} and the right DI on top)`;
    if (A >= P.ichiTrendADX && pd > md) side = "long";
    else if (A >= P.ichiTrendADX && md > pd) side = "short";
  } else if (c5.length >= 20 + P.ichiEMASlopeBars) {
    trendSource = "EMA5";
    const e = ema(c5.map((b) => b.cl), 20);
    const slope = e[e.length - 1] - e[e.length - 1 - P.ichiEMASlopeBars];
    trendTxt = `ADX unavailable, so 5m 20-EMA slope over ${P.ichiEMASlopeBars} bars is ${slope >= 0 ? "+" : ""}${f2(slope)}`;
    if (slope > 0) side = "long";
    else if (slope < 0) side = "short";
  }
  if (trendSource === "none") {
    return res(S, "NO DATA", "NO DATA", { note: "Not enough history for the ADX or the EMA trend filter.", trendSource, levelNote: cloudTxt, checks: infoChecks });
  }
  const trendCheck = { ok: !!side, text: trendTxt };
  if (!side) {
    return res(S, "NO TREND", "NO TRADE", { note: `No intraday trend: ${trendTxt}.`, trendSource, levelNote: cloudTxt, checks: [trendCheck, ...infoChecks] });
  }
  const sg = side === "long" ? 1 : -1;
  const base = { side, levelNote: cloudTxt, trendSource, checks: [trendCheck, ...infoChecks] };
  if (c15.length < 12) return res(S, "NO SWING LEG", "WAIT", { ...base, note: "Not enough 15m bars to find a swing leg." });
  const bars = (side === "long" ? c15 : c15.map(neg)).slice(-200);
  return fibEngine(S, side, bars, price, base, {
    tfName: "15m",
    tfMin: 15,
    startMM: P.ichiStart,
    cutoffMM: P.ichiCutoff,
    maxRisk: P.maxRiskPct.ichi,
    volMult: P.ichiVolMult,
    volBars: P.ichiVolBars,
    hasVol: hasVolOf(c15),
    expiryBlock: true,
    ix,
    ctx,
    sgFix: sg,
  });
}

// ichi_swing: the v1 trend logic on the Daily cloud with a 4h trigger.
function evalIchiSwing(ix, cD, c4h, price, ctx) {
  const S = "ichi_swing";
  if (cD.length < FIRST_CLOUD + 2 || c4h.length < 12) return res(S, "NO DATA", "NO DATA", { note: "Not enough Daily or 4h history." });
  const ci = cloudInfo(cD);
  if (!ci) return res(S, "NO DATA", "NO DATA", { note: "No Daily cloud yet." });
  const pv = pivots(cD, 2);
  const two = (a) => (a.length >= 2 ? [a[a.length - 2].p, a[a.length - 1].p] : null);
  const ph = two(pv.hi);
  const pl = two(pv.lo);
  const up = ph && pl && ph[1] > ph[0] && pl[1] > pl[0];
  const down = ph && pl && ph[1] < ph[0] && pl[1] < pl[0];
  const cloudTxt = ci.cloudTxt.replace("1h", "Daily");
  let side = null;
  if (ci.c > ci.top && up) side = "long";
  else if (ci.c < ci.bot && down) side = "short";
  if (!side) {
    const why = ci.pos === "inside" ? "Price is inside the Daily cloud." : ci.pos === "above" ? "Above the Daily cloud but no higher-high / higher-low structure." : "Below the Daily cloud but no lower-high / lower-low structure.";
    return res(S, "NO DAILY TREND", "NO TRADE", { note: why, levelNote: cloudTxt });
  }
  const checks = [
    { ok: true, text: `Daily close ${side === "long" ? "above" : "below"} the cloud and ${side === "long" ? "higher highs / higher lows" : "lower highs / lower lows"}` },
    { ok: ci.widthPct >= P.cloudMinPct, text: `Daily cloud ${ci.widthPct.toFixed(2)}% wide (min ${P.cloudMinPct}% or it is chop)` },
    { ok: true, info: true, text: `Future cloud ${ci.future}; ${ci.tk || "Tenkan/Kijun n/a"} (information only)` },
  ];
  const base = { side, levelNote: cloudTxt, checks };
  if (ci.widthPct < P.cloudMinPct) return res(S, "THIN CLOUD (CHOP)", "NO TRADE", { ...base, note: "Daily cloud is too thin to trust the trend." });
  const bars = side === "long" ? c4h.slice(-200) : c4h.slice(-200).map(neg);
  return fibEngine(S, side, bars, price, base, {
    tfName: "4h",
    tfMin: 240,
    startMM: null,
    cutoffMM: null,
    maxRisk: P.swingMaxRiskPct,
    volMult: P.ichiVolMult,
    volBars: P.ichiVolBars,
    hasVol: hasVolOf(c4h),
    expiryBlock: false,
    ix,
    ctx,
  });
}

// 60-minute bars -> 4-hour bars: [09:15 to 13:15] and [13:15 to 15:30]. Finished-ness is decided by closedOnly(, 14400).
function to4h(b1h) {
  const out = [];
  let cur = null;
  for (const b of b1h) {
    const key = b.d + (b.mm < 795 ? "a" : "b");
    if (!cur || cur.key !== key) {
      cur = { key, t: b.t, d: b.d, mm: b.mm, o: b.o, hi: b.hi, lo: b.lo, cl: b.cl, vol: b.vol };
      out.push(cur);
    } else {
      cur.hi = Math.max(cur.hi, b.hi);
      cur.lo = Math.min(cur.lo, b.lo);
      cur.cl = b.cl;
      cur.vol += b.vol;
    }
  }
  return out.map(({ key, ...r }) => r);
}

module.exports = { evalIchi, evalIchiSwing, to4h, cloudInfo };
