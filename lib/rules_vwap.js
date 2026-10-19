// lib/rules_vwap.js - VWAP strategies, v2 (5-minute candles, finished candles only).
//   vwap_reclaim : 9+ closes above VWAP, a 1 to 3 close dip below, then a close back above on volume.
//   vwap_pullback: the v1 pullback + continuation, gated on a TRUE VWAP.
//   vwap_info    : the v1 logic on the session-average proxy, INFORMATION ONLY, never an action.
// Index feeds carry no volume, so on them there is no true VWAP: the two real strategies say NO TRADE and never BUY.

const { P, f2, hhmm, neg, pivots, res, settle, expiryBlock, volCheck, ema } = require("./rules_core");
const { rsi } = require("./indicators");

const NEED_TRUE = "Needs true VWAP; this feed has no volume. See the session-average state below.";

function vwapSeries(day, hasVol) {
  let sv = 0;
  let sp = 0;
  let cnt = 0;
  return day.map((b) => {
    const tp = (b.hi + b.lo + b.cl) / 3;
    if (hasVol) {
      sp += tp * b.vol;
      sv += b.vol;
      return sv > 0 ? sp / sv : tp;
    }
    sp += tp;
    cnt++;
    return sp / cnt;
  });
}

// Reliability of the VWAP itself (my definition; fixed in advance):
//   low    = no volume in the feed (the line is only a session average)        -> NO TRADE
//   medium = volume present but less than 60 minutes of session, or gaps in it
//   high   = volume on at least 95% of the bars and 60+ minutes of session
function reliabilityOf(hasVol, day) {
  if (!hasVol) return "low";
  const cov = day.filter((b) => b.vol > 0).length / Math.max(1, day.length);
  return day.length >= 12 && cov >= 0.95 ? "high" : "medium";
}

// ---- reclaim, long side on mirrored bars B / mirrored vwap V; raw `day` is only used for volumes ----
function reclaimScan(B, V, day) {
  const need = Math.round(P.vwapReclaimAboveMin / 5);
  let above = 0;
  let prevAbove = 0;
  let dip = 0;
  let dipLow = Infinity;
  let dipK = -1;
  let rec = null;
  let volFail = null;
  for (let k = 0; k < B.length; k++) {
    const b = B[k];
    if (b.cl > V[k]) {
      if (dip >= 1 && dip <= P.vwapReclaimDipMax && prevAbove >= need) {
        if (b.mm >= P.vwapStart) {
          const v = volCheck(day, k, P.vwapReclaimVolBars, P.vwapReclaimVolMult, true, P.vwapReclaimVolBars);
          if (v.ok) rec = { k, dipLow, dipK, dipN: dip, prevAbove };
          else volFail = { k };
        }
        above = 1;
        prevAbove = 0;
        dip = 0;
        dipLow = Infinity;
      } else if (dip > 0) {
        above = 1; // the dip was too long or there was no real run before it: start counting again
        prevAbove = 0;
        dip = 0;
        dipLow = Infinity;
      } else above++;
    } else {
      if (dip === 0) prevAbove = above;
      dip++;
      above = 0;
      if (b.lo < dipLow) {
        dipLow = b.lo;
        dipK = k;
      }
    }
  }
  const inDip = dip >= 1 && dip <= P.vwapReclaimDipMax && prevAbove >= need;
  return { rec, volFail, inDip, dip, prevAbove, dipLow, dipK };
}

function evalReclaim(ix, day, vw, price, ctx, rel) {
  const S = "vwap_reclaim";
  const n = day.length;
  const rs = rsi(day.map((b) => b.cl), P.vwapRSIPeriod);
  const mk = (state, action, o) => res(S, state, action, { reliability: rel, ...o });
  const out = {};
  for (const side of ["long", "short"]) {
    const sg = side === "long" ? 1 : -1;
    const B = side === "long" ? day : day.map(neg);
    const V = vw.map((x) => sg * x);
    out[side] = { sg, B, ...reclaimScan(B, V, day) };
  }
  const L = out.long;
  const Sh = out.short;
  const pick = [L, Sh].filter((x) => x.rec).sort((a, b) => b.rec.k - a.rec.k)[0];
  const lbl = "VWAP " + f2(vw[n - 1]);
  if (!pick) {
    const dipSide = L.inDip ? L : Sh.inDip ? Sh : null;
    const failed = [L, Sh].filter((x) => x.volFail && n - 1 - x.volFail.k <= P.maxAge)[0];
    if (failed) {
      return mk("RECLAIM WITHOUT VOLUME", "WAIT", {
        side: failed.sg > 0 ? "long" : "short",
        levelNote: lbl,
        note: `Closed back ${failed.sg > 0 ? "above" : "below"} VWAP but volume was under the prior ${P.vwapReclaimVolBars}-candle mean. No entry on a weak reclaim.`,
      });
    }
    if (dipSide) {
      const sd = dipSide.sg > 0 ? "long" : "short";
      return mk("DIP, AWAITING RECLAIM", "WAIT", {
        side: sd,
        levelNote: lbl,
        level: vw[n - 1],
        note: `${dipSide.dip} close${dipSide.dip > 1 ? "s" : ""} ${sd === "long" ? "below" : "above"} VWAP after ${dipSide.prevAbove} on the other side. Needs a close back ${sd === "long" ? "above" : "below"} ${f2(vw[n - 1])} on volume (at least the mean of the prior ${P.vwapReclaimVolBars} candles).`,
      });
    }
    return mk("NO RECLAIM SETUP", "WAIT", { levelNote: lbl, note: `Needs ${Math.round(P.vwapReclaimAboveMin / 5)}+ closes on one side of VWAP, a 1 to ${P.vwapReclaimDipMax} close dip across it, then a close back on volume.` });
  }
  const { sg, B, rec } = pick;
  const side = sg > 0 ? "long" : "short";
  const base = { side, levelNote: lbl };
  const trigTime = hhmm(day[rec.k].mm + 5);
  const slT = rec.dipLow;
  for (let k = rec.k + 1; k < n; k++) {
    if (B[k].cl < slT) return mk("STOPPED OUT", "NO TRADE", { ...base, note: `Reclaimed at ${trigTime}, then closed under the dip ${side === "long" ? "low" : "high"}.` });
  }
  if (day[rec.k].mm >= P.vwapCutoff) return mk("PAST ENTRY CUTOFF", "NO TRADE", { ...base, note: `Reclaimed at ${trigTime}, after the 14:30 cutoff for new entries.` });
  const age = n - 1 - rec.k;
  if (age > P.maxAge) return mk("TRIGGER STALE", "WAIT", { ...base, note: `Reclaimed at ${trigTime}, ${age} bars ago. Do not chase.` });

  const entryT = sg * price;
  const R = entryT - slT;
  const riskPct = (R / Math.abs(price)) * 100;
  const r = mk("TRIGGERED", "WAIT", {
    ...base,
    level: price,
    sl: sg * slT,
    t1: sg * (entryT + 2 * R),
    t2: sg * (entryT + 3 * R),
    riskPct,
    note: `${rec.dipN}-candle dip then a close back ${side === "long" ? "above" : "below"} VWAP at ${trigTime} on volume. Stop at the dip ${side === "long" ? "low" : "high"}; targets 2R and 3R.`,
  });
  // RSI(9) at the dip extreme: 38 to 58 at the dip low (long), 45 to 65 at the dip high (short).
  const rv = rs[rec.dipK];
  const [lo, hi] = side === "long" ? P.vwapRSILong : P.vwapRSIShort;
  const rsiBlock =
    rec.dipK + 1 < P.vwapRSIMinBars || rv == null
      ? { ok: true, info: true, text: `RSI(${P.vwapRSIPeriod}) filter skipped (fewer than ${P.vwapRSIMinBars} 5m bars in the session at the dip)` }
      : { ok: rv >= lo && rv <= hi, text: `RSI(${P.vwapRSIPeriod}) at the dip ${side === "long" ? "low" : "high"} is ${rv.toFixed(1)} (needs ${lo} to ${hi})` };
  return settle(r, ctx, [
    { ok: true, text: `At least ${Math.round(P.vwapReclaimAboveMin / 5)} closes on the trend side before the dip`, info: true },
    rsiBlock,
    { ok: R > 0, text: "Stop is on the right side of price" },
    { ok: riskPct <= P.maxRiskPct.vwap, text: `Underlying stop ${riskPct.toFixed(2)}% of price (max ${P.maxRiskPct.vwap}%)` },
    ...expiryBlock(ix, ctx),
  ]);
}

// ---- v1 pullback + continuation (works on a true VWAP or, for the information row, on the session average) ----
function pullbackCore(S, ix, c5, day, vw, price, ctx, lbl, rel) {
  const n = day.length;
  const em = ema(c5.map((b) => b.cl), 20).slice(-n);
  const lastC = day[n - 1].cl;
  const side = lastC >= vw[n - 1] ? "long" : "short";
  const sg = side === "long" ? 1 : -1;
  let cross = 0;
  let prevSign = 0;
  for (let k = 0; k < n; k++) {
    if (day[k].mm < P.orEnd) continue;
    const s = Math.sign(day[k].cl - vw[k]);
    if (s !== 0 && prevSign !== 0 && s !== prevSign) cross++;
    if (s !== 0) prevSign = s;
  }
  const bars = side === "long" ? day : day.map(neg);
  const vT = vw.map((x) => sg * x);
  const eT = em.map((x) => sg * x);
  const tol = (P.vwapTolPct / 100) * Math.abs(price);
  const lowsT = pivots(bars, 2).lo;
  const structure = lowsT.length >= 2 && lowsT[lowsT.length - 1].p > lowsT[lowsT.length - 2].p;
  const emaOk = bars[n - 1].cl > eT[n - 1];
  const checks = [
    { ok: cross < P.vwapMaxCross, text: `${cross} crossings of ${lbl} since 9:30 (chop at ${P.vwapMaxCross}+)` },
    { ok: structure, text: `Last two 5m swing ${side === "long" ? "lows rising" : "highs falling"}` },
    { ok: emaOk, text: `Price on the ${side === "long" ? "upper" : "lower"} side of the 20 EMA (optional filter)`, info: true },
  ];
  const base = { side, checks, levelNote: `${lbl} ${f2(vw[n - 1])}`, reliability: rel };
  if (cross >= P.vwapMaxCross) return res(S, "CHOPPY AROUND VWAP", "NO TRADE", { ...base, note: `Price has crossed ${lbl.toLowerCase()} ${cross} times today. Skip.` });

  let touch = -1;
  let trig = -1;
  let trigTouch = -1;
  for (let k = 0; k < n; k++) {
    if (bars[k].mm < P.vwapStart) continue;
    const b = bars[k];
    if (touch >= 0 && b.cl < vT[k] - tol) touch = -1; // closed through VWAP: pullback failed
    if (touch >= 0 && k > touch && b.cl > bars[touch].hi && b.cl > vT[k]) {
      trig = k;
      trigTouch = touch;
      touch = -1;
      continue;
    }
    if (touch < 0 && b.lo <= vT[k] + tol && b.cl >= vT[k] - tol) {
      let on = 0;
      for (let j = Math.max(0, k - 6); j < k; j++) if (bars[j].cl > vT[j] + tol) on++;
      if (on >= 3) touch = k;
    }
  }
  if (trig < 0) {
    if (touch >= 0) {
      return res(S, "PULLBACK AT VWAP, AWAITING TRIGGER", "WAIT", {
        ...base,
        level: sg * bars[touch].hi,
        note: `Needs a 5m close ${side === "long" ? "above" : "below"} ${f2(sg * bars[touch].hi)} (the touch candle).`,
      });
    }
    const gap = Math.abs(lastC - vw[n - 1]);
    if (!structure) {
      return res(S, "NO CLEAR STRUCTURE", "WAIT", {
        ...base,
        note: `Price is ${side === "long" ? "above" : "below"} ${lbl.toLowerCase()} but the last two 5m swing ${side === "long" ? "lows are not rising" : "highs are not falling"}.`,
      });
    }
    return res(S, "TREND, NO PULLBACK YET", "WAIT", {
      ...base,
      note: `${((gap / lastC) * 100).toFixed(2)}% ${side === "long" ? "above" : "below"} ${lbl.toLowerCase()}. Wait for a pullback to ${f2(vw[n - 1])}.`,
    });
  }
  const slT = Math.min(...bars.slice(trigTouch, trig + 1).map((b) => b.lo));
  const trigTime = hhmm(day[trig].mm + 5);
  for (let k = trig + 1; k < n; k++) {
    if (bars[k].cl < slT) return res(S, "STOPPED OUT", "NO TRADE", { ...base, note: `Triggered ${trigTime}, then closed under the pullback low.` });
  }
  if (day[trig].mm >= P.vwapCutoff) return res(S, "PAST ENTRY CUTOFF", "NO TRADE", { ...base, note: `Triggered ${trigTime}, after the 14:30 cutoff for new entries.` });
  const age = n - 1 - trig;
  if (age > P.maxAge) return res(S, "TRIGGER STALE", "WAIT", { ...base, note: `Triggered ${trigTime}, ${age} bars ago. Do not chase.` });

  const entryT = sg * price;
  const R = entryT - slT;
  const riskPct = (R / Math.abs(price)) * 100;
  const out = res(S, "TRIGGERED", "WAIT", {
    ...base,
    level: price,
    sl: sg * slT,
    t1: sg * (entryT + R),
    t2: sg * (entryT + 2 * R),
    riskPct,
    note: `Pullback to ${lbl.toLowerCase()} held and closed through at ${trigTime}. Stop under the pullback low.`,
    checks: [checks[0], checks[2]],
  });
  return settle(out, ctx, [
    checks[1],
    { ok: R > 0, text: "Stop is on the right side of price" },
    { ok: riskPct <= P.maxRiskPct.vwap, text: `Underlying stop ${riskPct.toFixed(2)}% of price (max ${P.maxRiskPct.vwap}%)` },
    ...expiryBlock(ix, ctx),
  ]);
}

// Returns [vwap_reclaim, vwap_pullback, (vwap_info when there is no true VWAP)].
function evalVwap(ix, c5, price, ctx) {
  const liveISO = ctx.liveISO;
  const day = c5.filter((b) => b.d === liveISO && b.mm < P.vwapEvalEnd);
  const hasVol = !!ctx.hasVol;
  const rel = reliabilityOf(hasVol, day);
  const young = (id, extra) => res(id, "SESSION TOO YOUNG", "WAIT", { note: "Needs about 40 minutes of 5m bars.", reliability: rel, ...extra });
  if (day.length < 8) {
    const rows = [young("vwap_reclaim"), young("vwap_pullback", hasVol ? {} : { label: "Session average pullback" })];
    if (!hasVol) rows.push(young("vwap_info", { info: true }));
    return rows;
  }
  const vw = vwapSeries(day, hasVol);
  if (!hasVol) {
    const needTrue = (id, label) => res(id, "NO TRADE (needs true VWAP)", "NO TRADE", { note: NEED_TRUE, reliability: "low", ...(label ? { label } : {}) });
    const info = pullbackCore("vwap_info", ix, c5, day, vw, price, ctx, "Session average price (no index volume)", "low");
    info.info = true;
    info.state = info.state + " (proxy)";
    info.note = "Information only: this is the session-average proxy, not a signal. " + info.note;
    info.action = "INFO";
    info.sl = info.t1 = info.t2 = info.riskPct = null;
    info.checks = info.checks.map((c) => ({ ...c, info: true }));
    return [needTrue("vwap_reclaim"), needTrue("vwap_pullback", "Session average pullback"), info];
  }
  const reclaim = evalReclaim(ix, day, vw, price, ctx, rel);
  const pull = pullbackCore("vwap_pullback", ix, c5, day, vw, price, ctx, "VWAP", rel);
  return [reclaim, pull];
}

module.exports = { evalVwap, vwapSeries, reliabilityOf, reclaimScan };
