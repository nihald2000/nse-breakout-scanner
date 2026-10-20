// lib/elliott.js - mechanical Elliott impulse candidates on CLOSED bars.
// Pure functions, no network, no dependencies. Phase 1 research only: no live
// page imports this file.
//
// What this does:
//   * ZigZag pivots from bar highs/lows. A pivot is only confirmed after price
//     reverses by the chosen threshold, so a label cannot use a future extreme.
//   * Slide a six-pivot window (low-high-low-high-low-high, or the mirror) and
//     test the four hard impulse rules:
//       1. wave 2 never retraces all of wave 1;
//       2. wave 3 moves beyond the end of wave 1;
//       3. wave 4 does not enter wave 1's price territory;
//       4. wave 3 is not the shortest of waves 1, 3 and 5.
//   * A wave 5 that stops short of wave 3 is allowed (a truncated fifth) and
//     flagged as a guideline, not used to reject the count.
//
// What this does NOT do:
//   * It does not forecast the next move. A valid count is a mechanical fit to
//     four rules, not evidence of an edge.
//   * It does not label corrections (A-B-C), diagonals, or multiple degrees.
//   * It does not choose the "right" threshold. Different thresholds produce
//     different pivots and therefore different counts; the scan reports this.

const DEFAULT_PCT = 2;

function thresholdOf(opts) {
  const raw = typeof opts === "number" ? opts : opts && opts.pct;
  const pct = Number(raw);
  return Number.isFinite(pct) && pct > 0 ? pct : DEFAULT_PCT;
}

function pivotAt(bars, type, i, confirmedAt) {
  const b = bars[i];
  return {
    type,
    i,
    t: b.t,
    d: b.d,
    mm: b.mm,
    price: type === "high" ? b.hi : b.lo,
    confirmedAt,
  };
}

// ZigZag pivots. Returns { pivots, pending, pct }. Pivots alternate high/low and
// carry the bar that confirmed them (`confirmedAt`); `pending` is the current
// unconfirmed extreme and is deliberately not used by findImpulses().
function zigzag(bars, opts = {}) {
  const pct = thresholdOf(opts);
  const th = pct / 100;
  if (!Array.isArray(bars) || bars.length < 2) return { pivots: [], pending: null, pct };
  const ok = bars.every((b) => Number.isFinite(b.hi) && Number.isFinite(b.lo));
  if (!ok) return { pivots: [], pending: null, pct };

  let loI = 0;
  let hiI = 0;
  let lo = bars[0].lo;
  let hi = bars[0].hi;
  let dir = 0;
  let startType = null;
  let startI = 0;
  let seedAt = 0;

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    if (b.lo < lo) { lo = b.lo; loI = i; }
    if (b.hi > hi) { hi = b.hi; hiI = i; }
    const upTrigger = b.hi >= lo * (1 + th);
    const downTrigger = b.lo <= hi * (1 - th);
    if (!upTrigger && !downTrigger) continue;
    if (upTrigger && downTrigger) {
      // One bar spans both thresholds: the earlier extreme started the leg.
      if (loI < hiI) { dir = 1; startType = "low"; startI = loI; }
      else if (hiI < loI) { dir = -1; startType = "high"; startI = hiI; }
      else if (b.cl >= b.o) { dir = 1; startType = "low"; startI = loI; }
      else { dir = -1; startType = "high"; startI = hiI; }
    } else if (upTrigger) { dir = 1; startType = "low"; startI = loI; }
    else { dir = -1; startType = "high"; startI = hiI; }
    seedAt = i;
    break;
  }
  if (!dir) return { pivots: [], pending: null, pct };

  const pivots = [pivotAt(bars, startType, startI, seedAt)];
  // The current leg starts at the seed pivot, so its extreme must be searched
  // from that bar forward. The opposite global extreme can predate the pivot
  // when the first leg did not move far enough to trigger on its own.
  let extI = startI;
  let ext = dir === 1 ? bars[startI].hi : bars[startI].lo;
  for (let k = startI + 1; k <= seedAt; k++) {
    if (dir === 1 ? bars[k].hi > ext : bars[k].lo < ext) {
      ext = dir === 1 ? bars[k].hi : bars[k].lo;
      extI = k;
    }
  }

  for (let j = seedAt + 1; j < bars.length; j++) {
    const b = bars[j];
    if (dir === 1) {
      if (b.hi > ext) { ext = b.hi; extI = j; }
      if (b.lo <= ext * (1 - th)) {
        pivots.push(pivotAt(bars, "high", extI, j));
        dir = -1;
        ext = b.lo;
        extI = j;
      }
    } else {
      if (b.lo < ext) { ext = b.lo; extI = j; }
      if (b.hi >= ext * (1 + th)) {
        pivots.push(pivotAt(bars, "low", extI, j));
        dir = 1;
        ext = b.hi;
        extI = j;
      }
    }
  }

  return {
    pivots,
    pending: { type: dir === 1 ? "high" : "low", i: extI, price: ext, confirmedAt: null },
    pct,
  };
}

// A six-pivot window. Returns null when the window does not alternate from a
// low (up impulse) or a high (down impulse).
function labelWindow(w, dir) {
  const up = dir === "up";
  const p = w.map((x) => x.price);
  // Waves 2 and 4 are counter-trend, so each leg is measured in its own
  // direction rather than with one signed distance.
  const w1 = up ? p[1] - p[0] : p[0] - p[1];
  const w2 = up ? p[1] - p[2] : p[2] - p[1];
  const w3 = up ? p[3] - p[2] : p[2] - p[3];
  const w4 = up ? p[3] - p[4] : p[4] - p[3];
  const w5 = up ? p[5] - p[4] : p[4] - p[5];
  if (!(w1 > 0 && w2 > 0 && w3 > 0 && w4 > 0 && w5 > 0)) return null;

  const rules = {
    w2NotFullRetrace: up ? p[2] > p[0] : p[2] < p[0],
    w3BeyondW1: up ? p[3] > p[1] : p[3] < p[1],
    w4NoW1Overlap: up ? p[4] > p[1] : p[4] < p[1],
    w3NotShortest: w3 >= Math.min(w1, w5),
  };
  const rulesPassed = Object.values(rules).filter(Boolean).length;
  const guidelines = {
    w5BeyondW3: up ? p[5] > p[3] : p[5] < p[3], // false = truncated fifth, still allowed
    w2RetraceOfW1: w2 / w1,
    w4RetraceOfW3: w4 / w3,
    w3ExtensionOfW1: w3 / w1,
  };

  return {
    dir,
    valid: rulesPassed === 4,
    rulesPassed,
    rules,
    guidelines,
    waves: { w1, w2, w3, w4, w5 },
    start: w[0],
    end: w[5],
    pivots: w,
    from: w[0].d,
    to: w[5].d,
    spanBars: w[5].i - w[0].i,
  };
}

// All six-pivot impulse candidates in a pivot list, valid and invalid.
function findImpulses(pivots) {
  if (!Array.isArray(pivots) || pivots.length < 6) return [];
  const out = [];
  for (let k = 0; k + 5 < pivots.length; k++) {
    const w = pivots.slice(k, k + 6);
    const types = w.map((x) => x.type).join(",");
    const dir = types === "low,high,low,high,low,high" ? "up"
      : types === "high,low,high,low,high,low" ? "down"
        : null;
    if (!dir) continue;
    const c = labelWindow(w, dir);
    if (c) out.push(c);
  }
  return out;
}

// The analysed read at the end of `bars`. `latest` is the most recent VALID
// completed five-wave window; `position` only describes where the last close
// sits relative to it. Neither is a signal.
function analyseElliott(bars, opts = {}) {
  const { pivots, pending, pct } = zigzag(bars, opts);
  const impulses = findImpulses(pivots);
  const valid = impulses.filter((c) => c.valid);
  const latest = valid.length ? valid.reduce((a, b) => (b.end.i > a.end.i ? b : a)) : null;
  const last = Array.isArray(bars) && bars.length ? bars[bars.length - 1] : null;
  let position = null;
  if (latest && last) {
    const total = Math.abs(latest.end.price - latest.start.price);
    const up = latest.dir === "up";
    const since = up ? last.cl - latest.end.price : latest.end.price - last.cl;
    const givenBack = up ? latest.end.price - last.cl : last.cl - latest.end.price;
    position = {
      close: last.cl,
      sinceEndPct: latest.end.price ? (since / latest.end.price) * 100 : null,
      retracePctOfImpulse: total > 0 ? (Math.max(0, givenBack) / total) * 100 : null,
      beyondEnd: since > 0,
    };
  }

  return {
    ok: pivots.length >= 6,
    pct,
    pivots,
    pending,
    impulses,
    valid,
    latest,
    position,
    notes: [
      `ZigZag pivots use a ${pct}% reversal threshold; a different threshold can produce a different count.`,
      "A valid count fits the four hard impulse rules. It is not a forecast and has no measured edge.",
      "Pivots are confirmed only after the reversal threshold; the pending extreme is not part of a count.",
    ],
  };
}

module.exports = { DEFAULT_PCT, zigzag, findImpulses, analyseElliott };
