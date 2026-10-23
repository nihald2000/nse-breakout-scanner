// lib/replay.js - replays the index rulebooks bar by bar over past sessions (used by the chart and the backtest).
// v2 notes: strategy ids are orb_break, orb_retest, ichi, vwap_reclaim, vwap_pullback. ichi_swing and expiry_maxpain are
// NOT replayed (they need Daily/4h history and option-chain OI), so they are shown as "not backtested".
// A setup blocked by the ORB size rule is counted as BLOCKED, not as a trade. VIX is an option-cost caution only.
// The replay always runs the rules in STRICT mode (filters block). The live list shows those same filters as cautions,
// so a listed call that carries cautions is outside this replay's sample.
// Honesty rules, all enforced here:
//   * At each step the engine only sees bars that had finished by that moment (same code path as the live page).
//   * One trade per strategy per session (the first BUY), so the sample is not inflated by repeat signals.
//   * A closed-candle signal fills at the next 5m bar's open. Gaps through the stop/first target are not chased.
//     Stops are checked before targets inside a candle (pessimistic).
//   * Everything is measured on the INDEX in R multiples. No option premium, theta, spread or costs.

const { yahooChart } = require("./common");
const broker = require("./broker");
const { _internals: I } = require("../api/indices");

const { P, STRATS, analyse, isExpiryDay, parseIdx } = I;
const EXIT_MM = 915; // flat by 15:15
const HIST5 = 374; // the live page sees about 5 sessions of 5m bars; keep the same window

function lowerBound(arr, t) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].t < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

// Fetch the three timeframes. 5m and 15m reach back about 60 days on Yahoo; 1h reaches much further.
async function fetchData(ix, i, long) {
  let err = null;
  if (long && broker.configured()) {
    // A broker adapter can serve up to 2 years of 5m / 15m bars (with volume). Fall back to Yahoo if it fails.
    try {
      const shape = (arr) =>
        arr.map((b) => {
          const lt = b.t + 19800;
          return { t: b.t, d: new Date(lt * 1000).toISOString().slice(0, 10), mm: Math.floor((lt % 86400) / 60), o: b.o, hi: b.hi, lo: b.lo, cl: b.cl, vol: b.vol || 0 };
        });
      const [b5, b15, b1h] = await Promise.all([broker.fetchBars(ix.key, "5m", "2y"), broker.fetchBars(ix.key, "15m", "2y"), broker.fetchBars(ix.key, "60m", "2y")]);
      if (b5 && b5.length) return { sym: ix.key, source: "broker", p5: { bars: shape(b5), meta: {} }, p15: { bars: shape(b15 || []), meta: {} }, p1h: { bars: shape(b1h || []), meta: {} } };
    } catch (e) {
      err = e;
    }
  }
  for (const sym of ix.yahoo) {
    try {
      const [r5, r15, r1h] = await Promise.allSettled([
        yahooChart(sym, i, long ? "60d" : "5d", "5m"),
        yahooChart(sym, i + 1, long ? "60d" : "1mo", "15m"),
        yahooChart(sym, i, long ? "6mo" : "3mo", "60m"),
      ]);
      if (r5.status !== "fulfilled") throw r5.reason;
      return {
        sym,
        p5: parseIdx(r5.value),
        p15: r15.status === "fulfilled" ? parseIdx(r15.value) : null,
        p1h: r1h.status === "fulfilled" ? parseIdx(r1h.value) : null,
      };
    } catch (e) {
      err = e;
    }
  }
  return { error: String((err && err.message) || err) };
}

// Walk the bars after entry. Returns the R result for a given target, stop checked first inside a bar.
function walk(sig, bars, target) {
  const sg = sig.side === "long" ? 1 : -1;
  const R = Math.abs(sig.entry - sig.sl);
  const rOf = (px) => (sg * (px - sig.entry)) / R;
  let last = null;
  for (const b of bars) {
    if (b.mm >= EXIT_MM) return { r: rOf(b.o), outcome: "EOD", exitMM: b.mm, exitPrice: b.o };
    last = b;
    const stopHit = sg > 0 ? b.lo <= sig.sl : b.hi >= sig.sl;
    const tgtHit = sg > 0 ? b.hi >= target : b.lo <= target;
    if (stopHit) {
      const px = sg > 0 ? Math.min(b.o, sig.sl) : Math.max(b.o, sig.sl); // a gap through the stop fills at the open
      return { r: rOf(px), outcome: "SL", exitMM: b.mm + 5, exitPrice: px };
    }
    if (tgtHit) return { r: rOf(target), outcome: "TGT", exitMM: b.mm + 5, exitPrice: target };
  }
  if (!last) return { r: 0, outcome: "OPEN", exitMM: null, exitPrice: sig.entry };
  const done = last.mm + 5 >= EXIT_MM;
  return { r: rOf(last.cl), outcome: done ? "EOD" : "OPEN", exitMM: last.mm + 5, exitPrice: last.cl };
}

// Model the first executable price after a closed-candle signal. The stop and
// target prices remain those published by the signal; a gap changes realized R.
function fillAtNextOpen(signal, signalBar, fillBar, maxRiskPct) {
  const miss = (reason) => ({ ok: false, reason });
  if (!signalBar || !fillBar || fillBar.d !== signalBar.d || fillBar.t <= signalBar.t) return miss("no same-session next bar");
  if (!Number.isFinite(fillBar.o) || !Number.isFinite(signal.sl) || !Number.isFinite(signal.t1)) return miss("missing fill or risk levels");
  if (fillBar.mm >= P.vwapCutoff) return miss("next-bar fill is after the entry cutoff");
  const entry = fillBar.o;
  const long = signal.side === "long";
  if (long ? entry <= signal.sl : entry >= signal.sl) return miss("next-bar open gapped through the stop");
  if (long ? entry >= signal.t1 : entry <= signal.t1) return miss("next-bar open already reached T1; do not chase");
  const risk = Math.abs(entry - signal.sl);
  const riskPct = (risk / Math.abs(entry)) * 100;
  if (!(risk > 0) || (Number.isFinite(maxRiskPct) && riskPct > maxRiskPct)) return miss("next-bar fill makes the stop wider than the rule limit");
  return {
    ok: true,
    entry,
    entryMM: fillBar.mm,
    signalMM: signalBar.mm,
    riskPct,
    rr1: Math.abs(signal.t1 - entry) / risk,
    rr2: Number.isFinite(signal.t2) ? Math.abs(signal.t2 - entry) / risk : null,
  };
}

// Replay one session. nowCap (unix seconds) stops the replay at "now" when the session is still running.
// opts.vix: the India VIX state known at the start of that session; used for premium-model metadata, never as a trade gate.
const SIZE_SCALE = { full: 1, half: 0.5, skip: 0 };

function replayDay(ix, data, iso, nowCap, opts = {}) {
  const b5 = data.p5.bars;
  const b15 = data.p15 ? data.p15.bars : [];
  const b1h = data.p1h ? data.p1h.bars : [];
  const first = b5.findIndex((b) => b.d === iso);
  if (first < 0) return { signals: [], blocked: [], unfilled: [], skipped: "no bars" };
  const expiry = { [ix.key]: isExpiryDay(ix, iso) };
  const found = {};
  const blockedSeen = {};
  const blocked = [];
  const unfilled = [];
  let steps = 0;
  for (let k = first; k < b5.length && b5[k].d === iso; k++) {
    const bar = b5[k];
    if (bar.mm < P.orEnd) continue; // the opening range is not complete before 9:30
    if (bar.mm >= P.vwapCutoff) break; // no strategy takes entries from 14:30 on
    const nowSec = bar.t + 300;
    if (nowCap && nowSec > nowCap) break;
    const j15 = lowerBound(b15, nowSec);
    const j1h = lowerBound(b1h, nowSec);
    const view = {
      p5: { bars: b5.slice(Math.max(0, k + 1 - HIST5), k + 1), meta: {} },
      p15: b15.length ? { bars: b15.slice(Math.max(0, j15 - 400), j15), meta: {} } : null,
      p1h: b1h.length ? { bars: b1h.slice(Math.max(0, j1h - 600), j1h), meta: {} } : null,
    };
    // strict: the replay measures the TESTED ruleset, so a filter that is only a caution on the live list still blocks here.
    const out = analyse(ix, view, { nowSec, todayISO: iso, marketOpen: true, expiry, vix: opts.vix || null, skipSwing: true, skipMaxPain: true, strict: true });
    steps++;
    for (const r of out.rows) {
      if (r.info) continue;
      const signalEntry = view.p5.bars[view.p5.bars.length - 1].cl;
      if (r.blockedBy && !found[r.strategy] && !blockedSeen[r.strategy + r.blockedBy]) {
        blockedSeen[r.strategy + r.blockedBy] = true;
        blocked.push({ strategy: r.strategy, index: ix.key, date: iso, by: r.blockedBy, side: r.side, entryMM: bar.mm + 5, entry: signalEntry, sizeHint: r.sizeHint });
        continue;
      }
      if (found[r.strategy] || !/^BUY/.test(r.action)) continue;
      found[r.strategy] = {
        strategy: r.strategy,
        index: ix.key,
        date: iso,
        side: r.side,
        cut: k,
        signalMM: bar.mm,
        signalEntry,
        sl: r.sl,
        t1: r.t1,
        t2: r.t2,
        riskPct: r.riskPct,
        option: r.option,
        state: r.state,
        sizeHint: r.sizeHint || "full",
        trail: r.trail || null,
        trendSource: r.trendSource || null,
        reliability: r.reliability || null,
        vixValue: opts.vix && opts.vix.ok ? opts.vix.value : null,
      };
    }
  }
  const signals = Object.values(found).flatMap((s) => {
    const signalBar = b5[s.cut];
    const fillBar = b5[s.cut + 1];
    const group = STRATS[s.strategy] && STRATS[s.strategy].group;
    const fill = fillAtNextOpen(s, signalBar, fillBar, P.maxRiskPct[group]);
    if (!fill.ok) {
      unfilled.push({ strategy: s.strategy, index: s.index, date: s.date, side: s.side, signalMM: s.signalMM, entryMM: fillBar && fillBar.d === iso ? fillBar.mm : null, reason: fill.reason });
      return [];
    }
    const R = Math.abs(fill.entry - s.sl);
    const after = [];
    for (let k = s.cut + 1; k < b5.length && b5[k].d === iso; k++) after.push(b5[k]);
    const t = { ...s, ...fill };
    delete t.cut;
    delete t.signalEntry;
    if (!(R > 0)) return [{ ...t, valid: false }];
    t.valid = true;
    t.scale = SIZE_SCALE[s.sizeHint] == null ? 1 : SIZE_SCALE[s.sizeHint];
    for (const [key, tg] of [["x1", s.t1], ["x2", s.t2]]) {
      const x = walk(t, after, tg);
      x.rRaw = x.r;
      x.r = x.rRaw * t.scale; // half size counts as 0.5 of the R
      t[key] = x;
    }
    return [t];
  });
  signals.sort((a, b) => a.entryMM - b.entryMM);
  return { signals, blocked, unfilled, steps, expiry: expiry[ix.key] };
}

function sessionDates(bars) {
  const seen = [];
  for (const b of bars) if (seen[seen.length - 1] !== b.d) seen.push(b.d);
  return seen;
}

module.exports = { fetchData, replayDay, walk, fillAtNextOpen, sessionDates, lowerBound, EXIT_MM, SIZE_SCALE };
