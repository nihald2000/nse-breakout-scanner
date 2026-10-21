// lib/chart_setup.js - the simple chart setup used by the Full Chart page.
//
// This is deliberately separate from the backtested index rulebooks. It reads
// the same closed 5-minute bars and opening range, but it does not stop when
// both edges of the range have been broken. It tracks the latest edge, waits
// for a retest, and enters on the confirmation close. If an attempt fails, it
// can re-arm and take a later retest instead of ending the day.
//
// Honesty rules:
//   * only closed bars are supplied by the caller;
//   * the entry, stop and targets use bars up to the trigger close only;
//   * later bars are used only to report what happened afterwards;
//   * a stale trigger is shown as history, never as a fresh entry;
//   * the India VIX premium filter is reported as a warning, not a silent pass.

const { P, f2, hhmm } = require("./rules_core");

const ID = "chart_retest";
const LABEL = "ORB retest (chart setup)";

function finite(v) {
  return typeof v === "number" && isFinite(v);
}

function openingRange(bars) {
  const orBars = (bars || []).filter((b) => b.mm >= P.orStart && b.mm < P.orEnd);
  if (orBars.length < 3) return null;
  return {
    hi: Math.max(...orBars.map((b) => b.hi)),
    lo: Math.min(...orBars.map((b) => b.lo)),
  };
}

function base(o) {
  return {
    strategy: ID,
    label: LABEL,
    state: "NO TRADE",
    action: "NO TRADE",
    side: null,
    entryMM: null,
    entry: null,
    sl: null,
    t1: null,
    t2: null,
    riskPct: null,
    rr: "1:2",
    retestMM: null,
    breakMM: null,
    outcome: null,
    r: null,
    exitMM: null,
    fresh: false,
    vixWarning: false,
    note: "",
    checks: [],
    ...o,
  };
}

function outcomeAfter(bars, triggerIndex, side, sl, t1, t2) {
  let t1Hit = false;
  let t1MM = null;
  for (let i = triggerIndex + 1; i < bars.length; i++) {
    const b = bars[i];
    // Pessimistic inside a candle: stop is checked before targets.
    if (side === "long") {
      if (b.lo <= sl) return { outcome: t1Hit ? "T1 then stop" : "SL", r: t1Hit ? null : -1, exitMM: b.mm + 5, t1Hit };
      if (!t1Hit && b.hi >= t1) { t1Hit = true; t1MM = b.mm + 5; }
      if (b.hi >= t2) return { outcome: "T2", r: 2, exitMM: b.mm + 5, t1Hit: true, t1MM };
    } else {
      if (b.hi >= sl) return { outcome: t1Hit ? "T1 then stop" : "SL", r: t1Hit ? null : -1, exitMM: b.mm + 5, t1Hit };
      if (!t1Hit && b.lo <= t1) { t1Hit = true; t1MM = b.mm + 5; }
      if (b.lo <= t2) return { outcome: "T2", r: 2, exitMM: b.mm + 5, t1Hit: true, t1MM };
    }
  }
  return { outcome: "OPEN", r: null, exitMM: null, t1Hit, t1MM };
}

function computeChartSetup(bars, opts = {}) {
  const list = (bars || [])
    .filter((b) => b && finite(b.mm) && finite(b.cl) && finite(b.hi) && finite(b.lo))
    .slice()
    .sort((a, b) => a.mm - b.mm);
  const orb = opts.orb || openingRange(list);
  if (list.length < 4) return base({ state: "NO DATA", action: "NO TRADE", note: "Not enough closed 5-minute bars yet." });
  if (!orb || !finite(orb.hi) || !finite(orb.lo)) {
    return base({ state: "OPENING RANGE FORMING", action: "WAIT", note: "The 09:15 to 09:30 opening range is not complete yet." });
  }
  const H = orb.hi;
  const L = orb.lo;
  const W = H - L;
  if (!(W > 0)) return base({ state: "NO DATA", action: "NO TRADE", note: "The opening range is flat." });

  const buf = P.bufW * W;
  const tol = P.retestW * W;
  const post = list.filter((b) => b.mm >= P.orEnd);
  if (!post.length) return base({ state: "OPENING RANGE FORMING", action: "WAIT", note: "Waiting for the first close after 09:30." });

  const checks = [
    { ok: true, info: true, text: `Opening range ${f2(L)} to ${f2(H)}` },
    { ok: true, info: true, text: `Break buffer ${f2(buf)} points; retest tolerance ${f2(tol)} points` },
  ];
  const vixWarning = !!(opts.vix && opts.vix.ok && opts.vix.blocked);
  if (vixWarning) {
    checks.push({
      ok: false,
      info: true,
      text: `India VIX ${opts.vix.value.toFixed(2)} is above its 60th percentile ${opts.vix.p60.toFixed(2)}; option premium may be expensive. Chart setup is still shown.`,
    });
  }

  let phase = "idle"; // idle | broke | retest | triggered
  let side = null;
  let brk = -1;
  let ret = -1;
  let triggerStop = null;
  let lastTriggered = null;
  let lastActive = null;
  let lastFailed = null;

  function startBreak(i) {
    const b = post[i];
    if (b.cl > H + buf) {
      phase = "broke";
      side = "long";
      brk = i;
      ret = -1;
      return true;
    }
    if (b.cl < L - buf) {
      phase = "broke";
      side = "short";
      brk = i;
      ret = -1;
      return true;
    }
    return false;
  }

  function makeTriggered(i) {
    const trigBar = post[i];
    const retBar = post[ret];
    const entry = trigBar.cl;
    const sl = side === "long"
      ? Math.min(...post.slice(ret, i + 1).map((b) => b.lo))
      : Math.max(...post.slice(ret, i + 1).map((b) => b.hi));
    const risk = Math.abs(entry - sl);
    if (!(risk > 0)) {
      return base({
        side,
        state: "INVALID RISK",
        action: "NO TRADE",
        entryMM: trigBar.mm + 5,
        entry,
        sl,
        breakMM: post[brk].mm + 5,
        retestMM: retBar.mm + 5,
        note: "The stop distance is zero; the setup cannot be risked.",
        checks,
      });
    }
    const target1 = side === "long" ? entry + risk : entry - risk;
    const target2 = side === "long" ? entry + 2 * risk : entry - 2 * risk;
    const riskPct = (risk / Math.abs(entry)) * 100;
    const triggerMM = trigBar.mm + 5;
    const age = post.length - 1 - i;
    const after = outcomeAfter(post, i, side, sl, target1, target2);
    const fresh = opts.live !== false && !after.t1Hit && age <= P.maxAge && triggerMM < P.orbCutoff && riskPct <= P.maxRiskPct.orb && after.outcome === "OPEN";
    const action = fresh ? (side === "long" ? "BUY CE" : "BUY PE") : "NO NEW ENTRY";
    const state = fresh ? "LIVE SETUP" : age > P.maxAge ? "TRIGGERED, STALE" : triggerMM >= P.orbCutoff ? "PAST ENTRY CUTOFF" : riskPct > P.maxRiskPct.orb ? "TRIGGERED, RISK TOO WIDE" : after.t1Hit && after.outcome === "OPEN" ? "TRIGGERED, T1 ALREADY HIT" : "TRIGGERED";
    const setupChecks = checks.slice();
    setupChecks.push({ ok: riskPct <= P.maxRiskPct.orb, text: `Underlying stop ${riskPct.toFixed(2)}% of price (max ${P.maxRiskPct.orb}%)` });
    setupChecks.push({ ok: triggerMM < P.orbCutoff, text: `Trigger ${hhmm(triggerMM)} is before the 14:00 cutoff` });
    if (after.t1Hit && after.outcome !== "T2") {
      setupChecks.push({ ok: true, info: true, text: `T1 was touched at ${hhmm(after.t1MM)}; T2 was not reached before the stop/session end. R is n/a because a partial exit at T1 is not modelled.` });
    }
    const why = [
      `${side === "long" ? "Upside" : "Downside"} break at ${hhmm(post[brk].mm + 5)}, retest at ${hhmm(retBar.mm + 5)} held ${f2(side === "long" ? H : L)}.`,
      `Entry on the confirmation close at ${hhmm(triggerMM)}.`,
      `Stop ${side === "long" ? "below" : "above"} the retest/trigger extreme (${f2(sl)}); targets 1R and 2R.`
    ].join(" ");
    return base({
      side,
      state,
      action,
      entryMM: triggerMM,
      entry,
      sl,
      t1: target1,
      t2: target2,
      riskPct,
      rr: "1:2",
      breakMM: post[brk].mm + 5,
      retestMM: retBar.mm + 5,
      outcome: after.outcome,
      r: after.r,
      exitMM: after.exitMM,
      fresh,
      vixWarning,
      note: why,
      checks: setupChecks,
      triggerMM,
      retestHigh: retBar.hi,
      retestLow: retBar.lo,
    });
  }

  for (let i = 0; i < post.length; i++) {
    const b = post[i];

    if (phase === "idle") {
      if (!startBreak(i)) continue;
      lastActive = { side, state: "BROKE OUT, AWAITING RETEST", brk };
    }

    if (phase === "triggered") {
      const stopped = side === "long" ? b.lo <= triggerStop : b.hi >= triggerStop;
      if (!stopped) continue;
      phase = "idle";
      side = null;
      triggerStop = null;
      if (!startBreak(i)) continue;
      lastActive = { side, state: "BROKE OUT, AWAITING RETEST", brk };
    }

    if (phase === "broke" || phase === "retest") {
      const failed = side === "long" ? b.cl < H : b.cl > L;
      if (failed) {
        lastFailed = { side, mm: b.mm + 5, brk };
        phase = "idle";
        side = null;
        brk = -1;
        ret = -1;
        if (!startBreak(i)) continue;
        lastActive = { side, state: "BROKE OUT, AWAITING RETEST", brk };
      }

      if (ret < 0) {
        const touched = side === "long" ? b.lo <= H + tol : b.hi >= L - tol;
        if (touched) {
          ret = i;
          phase = "retest";
          lastActive = { side, state: "RETEST HELD, AWAITING TRIGGER", brk, ret };
        }
        continue;
      }

      if (i > ret) {
        const triggered = side === "long" ? b.cl > post[ret].hi : b.cl < post[ret].lo;
        if (triggered) {
          const setup = makeTriggered(i);
          if (setup.state === "INVALID RISK") return setup;
          lastTriggered = setup;
          triggerStop = setup.sl;
          phase = "triggered";
          lastActive = null;
        }
      }
    }
  }

  if (phase === "broke") {
    return base({
      side,
      state: "BROKE OUT, AWAITING RETEST",
      action: "WAIT",
      breakMM: post[brk].mm + 5,
      note: `Waiting for a pullback to ${f2(side === "long" ? H : L)} that holds, then a close ${side === "long" ? "above" : "below"} the retest candle.`,
      checks,
      vixWarning,
    });
  }
  if (phase === "retest") {
    const triggerLevel = side === "long" ? post[ret].hi : post[ret].lo;
    return base({
      side,
      state: "RETEST HELD, AWAITING TRIGGER",
      action: "WAIT",
      breakMM: post[brk].mm + 5,
      retestMM: post[ret].mm + 5,
      note: `Retest at ${hhmm(post[ret].mm + 5)} held ${f2(side === "long" ? H : L)}. Needs a 5-minute close ${side === "long" ? "above" : "below"} ${f2(triggerLevel)}.`,
      checks,
      vixWarning,
    });
  }
  if (lastTriggered) return lastTriggered;
  if (lastFailed) {
    return base({
      side: lastFailed.side,
      state: "FAILED BREAK",
      action: "NO TRADE",
      breakMM: post[lastFailed.brk] ? post[lastFailed.brk].mm + 5 : null,
      note: `Price closed back through the range at ${hhmm(lastFailed.mm)} before a valid retest. No chase.`,
      checks,
      vixWarning,
    });
  }
  return base({
    state: "INSIDE RANGE",
    action: "WAIT",
    note: `No 5-minute close beyond ${f2(H + buf)} (CE) or ${f2(L - buf)} (PE) yet.`,
    checks,
    vixWarning,
  });
}

module.exports = {
  ID,
  LABEL,
  openingRange,
  computeChartSetup,
  outcomeAfter,
  _internals: { base, finite },
};
