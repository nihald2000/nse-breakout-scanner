// lib/rules_orb.js - Opening Range Breakout, two independent tracks (5-minute candles, finished candles only).
//   Track 1 orb_break : a 5m close beyond the range edge plus buffer is the trigger (no retest), with a volume filter.
//   Track 2 orb_retest: the v1 logic, unchanged: break, retest that holds, then a close above the retest candle.
// Track 2 is only evaluated when Track 1 has not fired. The range-width check is information; it sets sizeHint.

const { P, f2, hhmm, mean, neg, res, settle, expiryBlock, volCheck, firstWick, ageNote } = require("./rules_core");

// Long-side state machine on mirrored bars (Track 2, v1 logic). H = range high, W = range width.
function orbSide(post, H, W) {
  const buf = P.bufW * W;
  const tol = P.retestW * W;
  let brk = -1;
  let ret = -1;
  let trig = -1;
  let failed = -1;
  let stop = -1;
  for (let k = 0; k < post.length; k++) {
    const b = post[k];
    if (brk < 0) {
      if (b.cl > H + buf) brk = k; // first 5m close beyond the level plus buffer
      continue;
    }
    if (trig < 0) {
      if (b.cl < H) {
        failed = k; // closed back inside the range: one attempt per side per day
        break;
      }
      if (ret < 0) {
        if (b.lo <= H + tol) ret = k; // revisited the level and held above it
        continue;
      }
      if (b.cl > post[ret].hi) trig = k; // continuation: closes above the retest candle's high
    } else if (b.cl < H) {
      stop = k;
      break;
    }
  }
  return { brk, ret, trig, failed, stop };
}

// Track 1: the first close beyond the level plus buffer that passes the volume filter is the trigger.
// `day` is the raw session (only its volumes are used); post/off locate the bar inside it.
function breakSide(day, post, H, W, hasVol) {
  const buf = P.bufW * W;
  const off = day.length - post.length;
  let first = -1;
  let trig = -1;
  let stop = -1;
  let volWhy = null;
  let volSkipped = false;
  for (let k = 0; k < post.length; k++) {
    const b = post[k];
    if (trig < 0) {
      if (b.cl > H + buf) {
        if (first < 0) first = k;
        const v = volCheck(day, off + k, P.orbVolBars, P.orbVolMult, hasVol, P.orbVolMinBars);
        if (v.ok) {
          trig = k;
          volSkipped = !!v.skipped;
        } else volWhy = v;
      }
    } else if (b.cl < H) {
      stop = k;
      break;
    }
  }
  return { first, trig, stop, volWhy, volSkipped };
}

function sizeOf(wPct, typ) {
  if (typ == null) return { hint: "full", ratio: null };
  const ratio = wPct / typ;
  if (ratio > P.orbSizeHalfMax || ratio < P.orWidthLo) return { hint: "skip", ratio };
  if (ratio > P.orWidthHi) return { hint: "half", ratio };
  return { hint: "full", ratio };
}

// Returns [orb_break row, orb_retest row].
function evalOrb(ix, c5, price, ctx) {
  const liveISO = ctx.liveISO;
  const day = c5.filter((b) => b.d === liveISO);
  const hasVol = !!ctx.hasVol;
  const trail = hasVol ? "VWAP" : "20 EMA";
  const mk = (id, state, action, o) => res(id, state, action, { trail, ...o });
  const both = (state, action, o) => [mk("orb_break", state, action, o), mk("orb_retest", state, action, o)];

  const orBars = day.filter((b) => b.mm >= P.orStart && b.mm < P.orEnd);
  if (orBars.length < 3) return both("OPENING RANGE FORMING", "WAIT", { note: "The 9:15 to 9:30 range is not complete yet." });
  const H = Math.max(...orBars.map((b) => b.hi));
  const L = Math.min(...orBars.map((b) => b.lo));
  const W = H - L;
  if (!(W > 0)) return both("NO DATA", "NO DATA", { note: "Flat opening range." });

  // Typical opening-range width from earlier sessions (known before today's range completes).
  const byDay = new Map();
  for (const b of c5) {
    if (b.d < liveISO && b.mm >= P.orStart && b.mm < P.orEnd) {
      if (!byDay.has(b.d)) byDay.set(b.d, []);
      byDay.get(b.d).push(b);
    }
  }
  const widths = [...byDay.values()]
    .filter((a) => a.length === 3)
    .map((a) => {
      const h = Math.max(...a.map((b) => b.hi));
      const l = Math.min(...a.map((b) => b.lo));
      return ((h - l) / ((h + l) / 2)) * 100;
    });
  const wPct = (W / ((H + L) / 2)) * 100;
  const typ = widths.length >= 2 ? mean(widths) : null;
  const sz = sizeOf(wPct, typ);
  const rangeTxt = `Opening range ${wPct.toFixed(2)}% wide${typ == null ? " (no history to compare)" : `, ${sz.ratio.toFixed(2)}x the typical ${typ.toFixed(2)}%`} → size: ${sz.hint} (information; full ${P.orWidthLo}x to ${P.orWidthHi}x, half up to ${P.orbSizeHalfMax}x)`;
  const rangeCheck = { ok: sz.hint !== "skip", text: rangeTxt, info: true };
  const volCheckRow = hasVol
    ? { ok: true, text: `Volume filter: breakout candle at least ${P.orbVolMult}x the mean of up to ${P.orbVolBars} prior bars`, info: true }
    : { ok: true, text: "volume filter skipped (no index volume)", info: true };
  const checks = [rangeCheck, volCheckRow];
  const baseAll = { checks, sizeHint: sz.hint };

  const post = day.filter((b) => b.mm >= P.orEnd);
  const postN = post.map(neg);
  const A = orbSide(post, H, W);
  const B = orbSide(postN, -L, W);
  const A1 = breakSide(day, post, H, W, hasVol);
  const B1 = breakSide(day, postN, -L, W, hasVol);
  const levels = `Range ${f2(L)} to ${f2(H)}`;
  const buf = P.bufW * W;

  if (A.brk >= 0 && B.brk >= 0) {
    return both("CHOPPY: BOTH EDGES BROKEN", "NO TRADE", { ...baseAll, note: "Price has closed beyond both edges of the range today. Skip.", levelNote: levels });
  }
  if (A.brk < 0 && B.brk < 0) {
    return both("INSIDE RANGE", "WAIT", { ...baseAll, note: `Waiting for a 5m close above ${f2(H + buf)} (CE) or below ${f2(L - buf)} (PE).`, levelNote: levels });
  }
  const side = A.brk >= 0 ? "long" : "short";
  const sg = side === "long" ? 1 : -1;
  const T = side === "long" ? post : postN; // mirrored bars
  const Hl = side === "long" ? H : -L; // the level, in mirrored space
  const r2 = side === "long" ? A : B;
  const r1 = side === "long" ? A1 : B1;
  const base = { ...baseAll, side, levelNote: levels };

  // Shared finishing: risk, cutoff, staleness, targets, blockers, size.
  function finish(id, k, slT, tg, trigNote, stopK) {
    const trigTime = hhmm(post[k].mm + 5);
    const wk = firstWick(T, k, slT); // a wick through the stop counts, as in the backtest
    if (stopK >= 0 || wk >= 0) {
      const byWick = wk >= 0 && (stopK < 0 || wk <= stopK);
      const at = byWick ? wk : stopK;
      return mk(id, "STOPPED OUT", "NO TRADE", { ...base, note: `Triggered ${trigTime}, then ${byWick ? "traded through the stop (a wick counts, as in the backtest)" : "closed back through the level"} at ${hhmm(post[at].mm + 5)}.` });
    }
    if (post[k].mm >= P.orbCutoff) return mk(id, "PAST ENTRY CUTOFF", "NO TRADE", { ...base, note: `Triggered ${trigTime}, after the 14:00 cutoff for new entries.` });
    const age = post.length - 1 - k;
    if (age > P.maxAge) return mk(id, "TRIGGER STALE", "WAIT", { ...base, note: `Triggered ${trigTime}, ${age} bars ago. Do not chase; wait for a fresh setup.` });
    const entryT = T[k].cl; // the trigger candle's close: the same entry the backtest uses
    const entry = sg * entryT;
    const R = entryT - slT;
    const riskPct = (R / Math.abs(entryT)) * 100;
    const out = mk(id, "TRIGGERED", "WAIT", {
      ...base,
      level: entry,
      age,
      levelNote: `Entry ${f2(entry)} (trigger close) · ${levels}`,
      sl: sg * slT,
      t1: sg * (entryT + tg.t1 * R),
      t2: sg * (entryT + tg.t2 * R),
      riskPct,
      note: `${trigNote(trigTime)} Trail (information only): ${trail}.${ageNote(price, age)}`,
      checks: [],
    });
    settle(out, ctx, [
      rangeCheck,
      { ok: R > 0, text: "Stop is on the right side of price" },
      { ok: riskPct <= P.maxRiskPct.orb, text: `Underlying stop ${riskPct.toFixed(2)}% of price (max ${P.maxRiskPct.orb}%)` },
      ...expiryBlock(ix, ctx),
    ]);
    out.checks.push(volCheckRow);
    if (/^BUY/.test(out.action)) {
      if (sz.hint === "skip") {
        out.action = "NO TRADE";
        out.blockedBy = "size";
        out.note = `Opening range is ${sz.ratio.toFixed(2)}x the typical width (outside ${P.orWidthLo}x to ${P.orbSizeHalfMax}x). Skip. ${out.note}`;
      } else if (sz.hint === "half") {
        out.note += " HALF SIZE: the opening range is 2x to 3x the typical width.";
      }
    }
    return out;
  }

  // ---- Track 1: break ----
  let row1;
  if (r1.trig < 0) {
    if (r1.first >= 0) {
      const v = r1.volWhy;
      row1 = mk("orb_break", "BROKE OUT, VOLUME NOT CONFIRMED", "WAIT", {
        ...base,
        level: sg * Hl,
        note: v && v.short
          ? `Closed beyond the range but there are too few prior bars to confirm volume. Waiting.`
          : `Closed beyond the range but volume was under ${P.orbVolMult}x the prior mean. Waiting for a high-volume close; no entry on a weak breakout.`,
      });
    } else {
      row1 = mk("orb_break", "INSIDE RANGE", "WAIT", { ...base, note: `Waiting for a 5m close ${side === "long" ? "above" : "below"} ${f2(sg * (Hl + buf))}.` });
    }
  } else {
    const slT = T[r1.trig].lo; // the breakout candle's low, fixed at the trigger (the same stop the backtest uses)
    row1 = finish("orb_break", r1.trig, slT, P.orbBreak, (t) => `Closed beyond the range at ${t}${r1.volSkipped ? " (volume filter skipped)" : " on volume"}. Stop at the breakout candle's ${side === "long" ? "low" : "high"}; targets 2R and 3R.`, r1.stop);
  }

  // ---- Track 2: retest (only when Track 1 has not fired) ----
  let row2;
  if (r1.trig >= 0) {
    row2 = mk("orb_retest", "TRACK 1 FIRED", "NO TRADE", { ...base, note: `The breakout track already fired at ${hhmm(post[r1.trig].mm + 5)}, so the retest track is not evaluated.` });
  } else if (r2.failed >= 0) {
    row2 = mk("orb_retest", "FAILED BREAKOUT", "NO TRADE", { ...base, note: `Closed back inside the range at ${hhmm(post[r2.failed].mm + 5)} after breaking out. No second attempt.` });
  } else if (r2.trig < 0) {
    if (r2.ret < 0) {
      const ext = side === "long" ? price - H : L - price;
      row2 = mk("orb_retest", "BROKE OUT, AWAITING RETEST", "WAIT", {
        ...base,
        level: sg * Hl,
        note: ext > W ? "Already extended with no retest. Do not chase." : `Waiting for a pullback to ${f2(sg * Hl)} that holds, then a close ${side === "long" ? "above" : "below"} the retest candle.`,
      });
    } else {
      row2 = mk("orb_retest", "RETEST HELD, AWAITING TRIGGER", "WAIT", {
        ...base,
        level: sg * T[r2.ret].hi,
        note: `Needs a 5m close ${side === "long" ? "above" : "below"} ${f2(sg * T[r2.ret].hi)} (the retest candle).`,
      });
    }
  } else {
    const slT = Math.min(...T.slice(r2.ret, r2.trig + 1).map((b) => b.lo));
    row2 = finish("orb_retest", r2.trig, slT, P.orbRetest, (t) => `Retest held and closed through at ${t}. Stop under the retest candle; targets 1R and 2R.`, r2.stop);
  }
  return [row1, row2];
}

module.exports = { orbSide, breakSide, sizeOf, evalOrb };
