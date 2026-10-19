// lib/sector.js - Sector Scope data layer. Pure functions, no network, zero dependencies.
//
//   * Sector groups = the NSE "Industry" column of the F&O stocks (Nifty-500 constituent file).
//     The sector % shown is the TURNOVER-WEIGHTED AVERAGE of those stocks - it is NOT the NSE
//     sector index level, which has its own construction and weight caps. Pages must say so.
//   * "Money now vs normal" compares today's turnover-so-far against the mean daily turnover of
//     the prior 20 sessions scaled by the expected share of the day elapsed (front-loaded curve).
//   * Tenkan (9) / Kijun (26) are computed on CLOSED bars only, evaluated with the last closed
//     bar's close. Purely a description of where price sits; never an instruction to buy.
//   * Intraday RVOL compares cumulative volume-so-far with the same clock-minute cumulative
//     volume of earlier sessions - not a wall-clock guess.

const OTHER = "Other / no industry tag";

function normalizeIndustry(ind) {
  const s = String(ind || "").trim();
  return s ? s : OTHER;
}

// ---- Sector screen ---------------------------------------------------------
// stocks: [{ sym, industry, ltp, pchg, vol, avgTurnover }]
//   pchg: % vs previous close; vol: today's volume so far; avgTurnover: mean daily turnover
//   (qty x price) of the PRIOR sessions, in the same units as vol x ltp.
// share: expected share of the day's volume elapsed (lib/common.expectedVolumeShare).
function sectorRows(stocks, share) {
  const bySector = new Map();
  for (const s of stocks) {
    const key = normalizeIndustry(s.industry);
    if (!bySector.has(key)) bySector.set(key, []);
    bySector.get(key).push(s);
  }
  const rows = [];
  for (const [sector, list] of bySector) {
    let wsum = 0;
    let wtot = 0;
    let up = 0;
    let turnoverNow = 0;
    let turnoverNorm = 0;
    for (const s of list) {
      const t = s.vol * s.ltp;
      turnoverNow += t;
      turnoverNorm += s.avgTurnover || 0;
      if (!Number.isFinite(s.pchg)) continue;
      const w = t > 0 ? t : 1; // no volume yet: equal weight, honest fallback
      wsum += s.pchg * w;
      wtot += w;
      if (s.pchg > 0) up++;
    }
    if (!(wtot > 0)) continue;
    const shareF = share || 1;
    const biggest = list.reduce((a, b) => (Math.abs(b.pchg || 0) > Math.abs(a.pchg || 0) ? b : a));
    rows.push({
      sector,
      n: list.length,
      pct: wsum / wtot,
      turnoverNow,
      turnoverNorm: turnoverNorm * shareF,
      rvol: turnoverNorm > 0 ? turnoverNow / (turnoverNorm * shareF) : null,
      breadth: list.length ? up / list.length : null,
      leader: biggest.sym,
      leaderPct: biggest.pchg,
    });
  }
  rows.sort((a, b) => b.pct - a.pct);
  return rows;
}

// ---- True VWAP over a bar series (needs volume; stocks have it) --------------
function vwapSeries(bars) {
  let sv = 0;
  let sp = 0;
  return bars.map((b) => {
    const tp = (b.hi + b.lo + b.cl) / 3;
    if (b.vol > 0) {
      sp += tp * b.vol;
      sv += b.vol;
      return sp / sv;
    }
    return tp;
  });
}

// ---- Ichimoku two lines -----------------------------------------------------
const TENKAN = 9;
const KIJUN = 26;

function midRange(bars, i, p) {
  let h = -Infinity;
  let l = Infinity;
  for (let k = i - p + 1; k <= i; k++) {
    if (bars[k].hi > h) h = bars[k].hi;
    if (bars[k].lo < l) l = bars[k].lo;
  }
  return (h + l) / 2;
}

// Lines at every bar index where they exist; null before the lookback fills.
function tenkanKijun(bars) {
  const out = { tenkan: [], kijun: [] };
  for (let i = 0; i < bars.length; i++) {
    out.tenkan.push(i >= TENKAN - 1 ? midRange(bars, i, TENKAN) : null);
    out.kijun.push(i >= KIJUN - 1 ? midRange(bars, i, KIJUN) : null);
  }
  return out;
}

// Describe where the last closed price sits relative to the two lines, and whether the pullback
// seen in the last `look` closed bars held on one of them. Tags are FACTS, not advice.
// Returns { ok:false, why } when there is not enough closed history.
function lineState(bars, look = 2) {
  const i = bars.length - 1;
  if (!bars.length || i < KIJUN - 1) return { ok: false, why: `needs ${KIJUN} closed bars` };
  const tenkan = midRange(bars, i, TENKAN);
  const kijun = midRange(bars, i, KIJUN);
  const px = bars[i].cl;
  let pos;
  if (px > tenkan && px > kijun) pos = "above both (up lean)";
  else if (px < tenkan && px < kijun) pos = "below both (down lean)";
  else pos = "between the lines (no lean)";
  const linePos = tenkan > kijun ? "Tenkan above Kijun" : tenkan < kijun ? "Tenkan below Kijun" : "Tenkan on Kijun";
  let held = null;
  for (let k = Math.max(i - look + 1, 0); k <= i && !held; k++) {
    if (tenkan > kijun && bars[k].lo <= tenkan && bars[k].cl >= tenkan) held = "held at Tenkan";
    else if (tenkan < kijun && bars[k].hi >= tenkan && bars[k].cl <= tenkan) held = "rejected at Tenkan";
    else if (tenkan > kijun && bars[k].lo <= kijun && bars[k].cl >= kijun) held = "held at Kijun";
    else if (tenkan < kijun && bars[k].hi >= kijun && bars[k].cl <= kijun) held = "rejected at Kijun";
  }
  return {
    ok: true,
    tenkan,
    kijun,
    pos,
    linePos,
    held,
    stop: kijun, // the line traders usually trail from; reference only
    dTenkan: px - tenkan,
    dKijun: px - kijun,
  };
}

// ---- Intraday "running volume so far vs the same time on earlier days" ------
// day: today's closed intraday bars (any tf, oldest first). prevMap: Map(date -> same-tf bars).
// The bar's minute (or the series' own clock) does not need to align exactly; we compare the
// cumulative volume up to each bar index against earlier sessions' cumulative volume up to the
// same cumulative-bar-count, which is the same clock position for an NSE session.
function intradayRvol(day, prevMap) {
  if (!day.length) return null;
  const cuts = [];
  let acc = 0;
  for (const b of day) {
    acc += b.vol;
    cuts.push(acc);
  }
  const at = cuts.length - 1;
  const bases = [];
  for (const bars of prevMap.values()) {
    if (!bars.length) continue;
    const k = Math.min(at, bars.length - 1);
    let cum = 0;
    for (let j = 0; j <= k; j++) cum += bars[j].vol;
    if (cum > 0) bases.push(cum);
  }
  if (bases.length < 3) return null;
  return cuts[at] / (bases.reduce((s, x) => s + x, 0) / bases.length);
}

module.exports = {
  OTHER,
  TENKAN,
  KIJUN,
  normalizeIndustry,
  sectorRows,
  vwapSeries,
  midRange,
  tenkanKijun,
  lineState,
  intradayRvol,
  loadDeliveryMap,
};

// --------------------------------------------------------------------------
// Previous completed session's delivery %, from NSE's own sec_bhavdata_full CSV
// (plain text, one line per symbol). Cached in memory for the lifetime of the
// value; when no file can be fetched the caller gets date=null and must show
// the column as empty, never as zero.
// --------------------------------------------------------------------------
const { getText, splitCsvLine } = require("./common");
let delivCache = null; // { key, map, date }

function bhavCandidates(nowIso, max) {
  const out = [];
  const d = new Date(nowIso + "T00:00:00Z");
  for (let k = 0; out.length < max && k < max + 4; k++) {
    const dt = new Date(d.getTime() - k * 864e5);
    if (dt.getUTCDay() === 0 || dt.getUTCDay() === 6) continue;
    const p = (n) => String(n).padStart(2, "0");
    out.push(`${p(dt.getUTCDate())}${p(dt.getUTCMonth() + 1)}${dt.getUTCFullYear()}`);
  }
  return out;
}

async function loadDeliveryMap(nowIso, tries = 3) {
  const key = nowIso;
  if (delivCache && delivCache.key === key) return delivCache;
  for (const ds of bhavCandidates(nowIso, tries)) {
    try {
      const csv = await getText(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${ds}.csv`, 1);
      const lines = csv.split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) continue;
      const head = splitCsvLine(lines[0]).map((x) => x.trim().toUpperCase());
      const si = head.indexOf("SYMBOL");
      const sei = head.indexOf("SERIES");
      const di = head.indexOf("DELIV_PER");
      if (si < 0 || di < 0) continue;
      const map = {};
      for (const line of lines.slice(1)) {
        const c = splitCsvLine(line);
        const sym = (c[si] || "").trim().toUpperCase();
        if (!sym || (sei >= 0 && (c[sei] || "").trim() !== "EQ")) continue;
        const v = parseFloat((c[di] || "").trim());
        if (Number.isFinite(v)) map[sym] = v;
      }
      if (Object.keys(map).length > 500) {
        delivCache = { key, map, date: ds };
        return delivCache;
      }
    } catch (e) {
      // try the next date
    }
  }
  delivCache = { key, map: {}, date: null };
  return delivCache;
}

