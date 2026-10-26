// lib/sip.js - Opening Range Breakout on "Stocks in Play" (pure functions, no network).
//
// Source rule: Zarattini, Barbon & Aziz, "A Profitable Day Trading Strategy For The U.S. Equity Market"
// (Swiss Finance Institute Research Paper 24-98, 2024), Section 4, adapted to NSE F&O stocks:
//   * Relative volume : the 09:15 five-minute candle's volume divided by the mean volume of the SAME candle over the
//                       previous 14 full sessions. Only stocks at 1.0x (100% of normal) or more are "in play"; they
//                       are ranked by it and the paper trades the top 20.
//   * Direction       : the first five-minute candle decides. Bullish = long only, bearish = short only, doji = no call.
//   * Entry           : a STOP order at the first candle's high (long) or low (short). It fills when price touches the
//                       level, with no confirmation or retest. If it is never touched there is no trade.
//   * Stop loss       : 10% of the 14-day ATR from the entry price.
//   * Exit            : no target. Flat at the end of the day (here 15:15 IST, the repo's flat time, which also stays
//                       ahead of broker intraday square-off).
//   * Size            : 1% of capital at risk per name (the stop distance is exposed as riskPerShare).
//
// Honesty rules, all enforced here:
//   * Only finished five-minute candles are used. A touch inside a forming candle is unknown until it closes.
//   * A gap through the level fills at the open, not at the level. A stop that gaps fills at the open, not the stop.
//   * Entry and stop touched inside one candle is scored stop-first (pessimistic) and flagged.
//   * The paper's numbers are US equities, 2016-2023, 20 names a day, share trades. None of it is tested on NSE here.
//     Listing a call is not a claim of an edge; see research/strategy-audit-2026-10-21.md.

const SIP = {
  firstBarMM: 555, // 09:15 IST, minutes after midnight
  firstBarEndMM: 560,
  fullSessionBars: 60, // a prior session counts only with at least this many 5m bars (drops half sessions)
  baselineDays: 14, // relative-volume baseline
  minBaselineDays: 10, // need this many earlier first candles with volume
  atrDays: 14,
  minHistory: 15, // 14 true ranges need 15 earlier sessions (the first uses the close before it)
  stopAtrFrac: 0.1, // stop loss = 10% of ATR from the entry
  minRvol: 1, // 1.0x = "100%" in the paper's Figure 4 scale (3,000% = 30x)
  topN: 20,
  exitMM: 915, // flat by 15:15 IST
  sessionEndMM: 930,
  lateMM: 870, // a trigger from 14:30 on is a caution
  gapWarnPct: 12, // overnight gap that may be a corporate action (intraday data is unadjusted)
  costPerSidePct: 0.05, // assumed underlying cost per side, the same assumption the repo's studies use
  costCautionR: 0.25, // warn when the round-trip cost alone is this many R
};

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// Group closed bars by date, ascending. Returns [{ d, bars }].
function bySession(bars) {
  const out = [];
  for (const b of bars) {
    const last = out[out.length - 1];
    if (last && last.d === b.d) last.bars.push(b);
    else out.push({ d: b.d, bars: [b] });
  }
  return out;
}

function isFull(s) {
  return s.bars.length >= SIP.fullSessionBars && s.bars[0].mm === SIP.firstBarMM;
}

// Daily H/L/C of a session built from its five-minute bars.
function daily(s) {
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of s.bars) {
    if (b.hi > hi) hi = b.hi;
    if (b.lo < lo) lo = b.lo;
  }
  return { d: s.d, hi, lo, cl: s.bars[s.bars.length - 1].cl };
}

// Mean of the last `n` true ranges; needs n+1 daily rows.
function atrOf(days, n) {
  if (days.length < n + 1) return null;
  const tr = [];
  for (let i = days.length - n; i < days.length; i++) {
    const d = days[i];
    const pc = days[i - 1].cl;
    tr.push(Math.max(d.hi - d.lo, Math.abs(d.hi - pc), Math.abs(d.lo - pc)));
  }
  return mean(tr);
}

const hhmm = (mm) => String(Math.floor(mm / 60)).padStart(2, "0") + ":" + String(mm % 60).padStart(2, "0");

// Evaluate one stock. bars: ascending 5m bars {t, d, mm, o, hi, lo, cl, vol} (prior sessions plus today, forming bar allowed).
// nowSec: unix seconds "now" (only bars finished by then are used).
// Returns { ok: false, skip: "reason" } or { ok: true, call }.
function evaluate(sym, bars, nowSec, opts = {}) {
  const cost = Number.isFinite(opts.costPerSidePct) ? opts.costPerSidePct : SIP.costPerSidePct;
  const closed = (bars || []).filter((b) => b && b.t + 300 <= nowSec && Number.isFinite(b.o) && Number.isFinite(b.hi) && Number.isFinite(b.lo) && Number.isFinite(b.cl));
  if (!closed.length) return { ok: false, skip: "no closed candles" };
  const sessions = bySession(closed);
  const today = sessions[sessions.length - 1];
  const priorAll = sessions.slice(0, -1).filter(isFull);
  if (priorAll.length < SIP.minHistory) return { ok: false, skip: `needs ${SIP.minHistory} earlier full sessions (have ${priorAll.length})` };

  const first = today.bars.find((b) => b.mm === SIP.firstBarMM);
  // Before 09:20 IST the newest closed candles are the previous session's, so that session is what gets evaluated
  // (call.session says which). A latest session with no 09:15 candle means the feed is missing it.
  if (!first) return { ok: false, skip: "no 09:15 candle in the latest session" };

  // Relative volume of the first candle against the same candle on the previous sessions. rankBy "range" is a fallback for
  // a feed whose 09:15 volume history is unusable (Yahoo's is): the first candle's high-low against its own normal instead.
  const rankBy = opts.rankBy === "range" ? "range" : "volume";
  const recent = priorAll.slice(-SIP.baselineDays);
  let rvol;
  if (rankBy === "range") {
    const baseR = recent.map((s) => s.bars[0].hi - s.bars[0].lo).filter((v) => v > 0);
    if (baseR.length < SIP.minBaselineDays) return { ok: false, skip: "first-candle range history missing" };
    rvol = (first.hi - first.lo) / mean(baseR);
  } else {
    const base = recent.map((s) => s.bars[0].vol).filter((v) => Number.isFinite(v) && v > 0);
    if (base.length < SIP.minBaselineDays) return { ok: false, skip: "first-candle volume history missing" };
    if (!(first.vol > 0)) return { ok: false, skip: "first candle has no volume" };
    rvol = first.vol / mean(base);
  }

  if (!(first.cl !== first.o)) return { ok: false, skip: "doji first candle" };
  const sg = first.cl > first.o ? 1 : -1;
  const level = sg > 0 ? first.hi : first.lo;

  const days = priorAll.slice(-(SIP.atrDays + 1)).map(daily);
  const atr = atrOf(days, SIP.atrDays);
  const riskDist = atr == null ? 0 : SIP.stopAtrFrac * atr;
  if (!(riskDist > 0)) return { ok: false, skip: "ATR unavailable" };

  // Walk the later closed candles: the stop order fills on the first touch, then the stop loss, then the 15:15 flat.
  const post = today.bars.filter((b) => b.mm >= SIP.firstBarEndMM);
  let entry = null;
  let entryMM = null;
  let stop = null;
  let exit = null;
  let exitMM = null;
  let status = null;
  let ambiguous = false;
  for (const b of post) {
    if (entry == null) {
      if (b.mm >= SIP.exitMM) {
        status = "NOT TRIGGERED";
        break;
      }
      const touched = sg > 0 ? b.hi >= level : b.lo <= level;
      if (!touched) continue;
      entry = sg > 0 ? Math.max(level, b.o) : Math.min(level, b.o); // a gap through the level fills at the open
      entryMM = b.mm;
      stop = entry - sg * riskDist;
      if (sg > 0 ? b.lo <= stop : b.hi >= stop) {
        ambiguous = true; // entry and stop inside one candle: scored stop-first
        exit = stop;
        exitMM = b.mm + 5;
        status = "STOPPED";
        break;
      }
      continue;
    }
    if (b.mm >= SIP.exitMM) {
      exit = b.o;
      exitMM = b.mm;
      status = "EXITED";
      break;
    }
    if (sg > 0 ? b.lo <= stop : b.hi >= stop) {
      exit = sg > 0 ? Math.min(b.o, stop) : Math.max(b.o, stop); // a gap through the stop fills at the open
      exitMM = b.mm + 5;
      status = "STOPPED";
      break;
    }
  }
  const lastBar = today.bars[today.bars.length - 1];
  const sessionDone = lastBar.mm + 5 >= SIP.sessionEndMM;
  if (!status) {
    if (entry == null) status = sessionDone ? "NOT TRIGGERED" : "PENDING";
    else if (sessionDone) {
      exit = lastBar.cl;
      exitMM = lastBar.mm + 5;
      status = "EXITED";
    } else status = "OPEN";
  }

  const mark = exit != null ? exit : lastBar.cl;
  const r = entry == null ? null : (sg * (mark - entry)) / riskDist;
  const ref = entry != null ? entry : level;
  const riskPct = (riskDist / ref) * 100;
  const costR = (2 * cost) / riskPct; // round-trip cost in R

  const prevClose = days[days.length - 1].cl;
  const gapPct = (first.o / prevClose - 1) * 100;

  const cautions = [];
  if (riskPct < 0.3) {
    cautions.push(`The stop is only ${riskPct.toFixed(2)}% of price. At an assumed ${(2 * cost).toFixed(2)}% round-trip cost that is about ${costR.toFixed(2)}R before the trade moves, and an option's bid/ask spread can be wider than the stop distance.`);
  } else if (costR >= SIP.costCautionR) {
    cautions.push(`At an assumed ${(2 * cost).toFixed(2)}% round-trip cost, costs alone are about ${costR.toFixed(2)}R on this stop (${riskPct.toFixed(2)}% of price).`);
  }
  if (Math.abs(gapPct) > SIP.gapWarnPct) cautions.push(`Overnight gap of ${gapPct.toFixed(1)}%: this may be a corporate action (intraday prices are unadjusted), which also distorts the ATR. Check before trading.`);
  if (entryMM != null && entryMM >= SIP.lateMM) cautions.push(`Triggered at ${hhmm(entryMM + 5)}, after 14:30; there is little time to the 15:15 exit.`);
  if (ambiguous) cautions.push("Entry and the stop loss were both reached inside one candle; it is scored as a stop-out (pessimistic).");
  if (rankBy === "range") cautions.push("Ranked by the first candle's range against its normal, NOT by volume: Yahoo's history has no usable 09:15 volume. This is not the paper's rule; in a 45-session test it ranked slightly better names to the top but showed no profit after costs.");

  return {
    ok: true,
    call: {
      sym,
      session: today.d,
      side: sg > 0 ? "long" : "short",
      action: sg > 0 ? "BUY CE" : "BUY PE",
      status,
      rankBy,
      rvol,
      firstBar: { o: first.o, hi: first.hi, lo: first.lo, cl: first.cl, vol: first.vol },
      level, // the stop-entry order price
      atr,
      atrPct: (atr / ref) * 100,
      riskPerShare: riskDist,
      riskPct,
      plannedStop: level - sg * riskDist, // where the stop loss sits if the order fills exactly at the level
      entry,
      entryMM: entryMM == null ? null : entryMM + 5, // the candle that touched it, known once it has closed
      stop,
      exit,
      exitMM,
      r,
      costR,
      ltp: lastBar.cl,
      ltpMM: lastBar.mm + 5,
      gapPct,
      ambiguous,
      cautions,
    },
  };
}

// A call whose first-candle volume is under the paper's 1.0x threshold is not "in play". It is still shown when the
// filter is off (or when a single stock is asked for), but flagged.
const belowCaution = (c) => `Relative ${c.rankBy === "range" ? "range" : "volume"} ${c.rvol.toFixed(2)}x is under the paper's 1.0x threshold; it found this group a slow loser (about -0.02R a trade). Listed only because the filter is switched off.`;

// One stock on its own (no ranking against the others): rank and top-N are unknown, and "in play" is just the threshold.
function standalone(c) {
  const play = c.rvol >= SIP.minRvol;
  return { ...c, rank: null, inPlay: play, inTopN: null, cautions: play ? c.cautions : [belowCaution(c), ...c.cautions] };
}

// Rank calls by relative volume. Calls under opts.minRvol (default 1.0x) are dropped unless minRvol is 0.
// Every call that remains is kept; inTopN marks the paper's portfolio of the best opts.topN names at or above 1.0x.
function rankCalls(calls, opts = {}) {
  const minRvol = Number.isFinite(opts.minRvol) ? opts.minRvol : SIP.minRvol;
  const topN = Number.isFinite(opts.topN) ? opts.topN : SIP.topN;
  const sorted = calls.filter((c) => c.rvol >= minRvol).sort((a, b) => b.rvol - a.rvol || (a.sym < b.sym ? -1 : 1));
  let inPlay = 0;
  return sorted.map((c, i) => {
    const play = c.rvol >= SIP.minRvol;
    if (play) inPlay++;
    const out = { ...c, rank: i + 1, inPlay: play, inTopN: play && inPlay <= topN };
    if (!play) out.cautions = [belowCaution(c), ...c.cautions];
    return out;
  });
}

// What the volume baseline actually looks like for one stock, for diagnosing "first-candle volume history missing".
// Shows each recent session's first candle as parsed (time, volume, whether the session counts as full), so a zero or
// missing 09:15 volume in the feed is visible instead of being folded into one skip reason.
function diagnose(bars, nowSec) {
  const closed = (bars || []).filter((b) => b && b.t + 300 <= nowSec && Number.isFinite(b.o) && Number.isFinite(b.hi) && Number.isFinite(b.lo) && Number.isFinite(b.cl));
  const sessions = bySession(closed);
  const priorFull = sessions.slice(0, -1).filter(isFull);
  const baseline = priorFull.slice(-SIP.baselineDays).map((s) => s.bars[0].vol);
  return {
    sessions: sessions.slice(-16).map((s) => ({ d: s.d, bars: s.bars.length, firstMM: s.bars[0].mm, firstVol: s.bars[0].vol, full: isFull(s) })),
    priorFullSessions: priorFull.length,
    needFullSessions: SIP.minHistory,
    baselineSessions: baseline.length,
    baselineWithVolume: baseline.filter((v) => Number.isFinite(v) && v > 0).length,
    needBaselineWithVolume: SIP.minBaselineDays,
    zeroVolumeFirstCandles: baseline.filter((v) => !(v > 0)).length,
  };
}

module.exports = { SIP, evaluate, rankCalls, standalone, diagnose, bySession, daily, atrOf, hhmm };
