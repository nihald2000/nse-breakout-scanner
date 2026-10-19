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

const { adx } = require("./indicators");

// ---- Candlestick patterns on closed bars (fact list, not a forecast) --------
// The evidence-backed set: engulfing (ranked #1 in two large backtests), hammer /
// shooting star (rejection candles), marubozu (one-sided range), plus inside/outside
// bars (compression / expansion) and doji (no decision candle).
function patternAt(bars, i) {
  const b = bars[i];
  const p = i > 0 ? bars[i - 1] : null;
  const body = Math.abs(b.cl - b.o);
  const rng = Math.max(b.hi - b.lo, 1e-9);
  const upper = b.hi - Math.max(b.cl, b.o);
  const lower = Math.min(b.cl, b.o) - b.lo;
  const out = [];
  if (p) {
    const pBody = Math.abs(p.cl - p.o);
    if (b.cl > b.o && p.cl < p.o && b.cl >= p.o && b.o <= p.cl && body > pBody * 1.05) out.push({ name: "bullish engulfing", dir: "up" });
    if (b.cl < b.o && p.cl > p.o && b.o >= p.cl && b.cl <= p.o && body > pBody * 1.05) out.push({ name: "bearish engulfing", dir: "down" });
    if (b.hi <= p.hi && b.lo >= p.lo) out.push({ name: "inside bar", dir: null });
    else if (b.hi >= p.hi && b.lo <= p.lo) out.push({ name: "outside bar", dir: b.cl > b.o ? "up" : "down" });
  }
  if (body / rng <= 0.1) out.push({ name: "doji", dir: null });
  else if (lower >= body * 2 && upper <= body * 0.8) out.push({ name: "hammer", dir: "up" });
  else if (upper >= body * 2 && lower <= body * 0.8) out.push({ name: "shooting star", dir: "down" });
  else if (body / rng >= 0.9) out.push({ name: b.cl > b.o ? "bull marubozu" : "bear marubozu", dir: b.cl > b.o ? "up" : "down" });
  return out;
}

function candlePatterns(bars, scan = 12, pick = 3) {
  const pri = (n) => (n.indexOf("engulfing") >= 0 ? 5 : n.indexOf("marubozu") >= 0 ? 4 : n === "hammer" || n === "shooting star" ? 3 : n === "outside bar" ? 2 : 1);
  const res = [];
  const start = Math.max(0, bars.length - scan);
  for (let i = bars.length - 1; i >= start && res.length < pick; i--) {
    const ps = patternAt(bars, i);
    if (!ps.length) continue;
    ps.sort((a, b) => pri(b.name) - pri(a.name));
    res.push({ mm: bars[i].mm, name: ps[0].name, dir: ps[0].dir });
  }
  return res;
}

// ---- 30-minute swing structure: are highs and lows rising or falling? -------
function swingStructure(bars, bucket = 6) {
  const bh = [];
  const bl = [];
  for (let i = 0; i + bucket <= bars.length; i += bucket) {
    let h = -Infinity;
    let l = Infinity;
    for (let k = i; k < i + bucket; k++) {
      if (bars[k].hi > h) h = bars[k].hi;
      if (bars[k].lo < l) l = bars[k].lo;
    }
    bh.push(h);
    bl.push(l);
  }
  let up = 0;
  let down = 0;
  for (let i = 1; i < bh.length; i++) {
    if (bh[i] > bh[i - 1] && bl[i] > bl[i - 1]) up++;
    else if (bh[i] < bh[i - 1] && bl[i] < bl[i - 1]) down++;
  }
  return { up, down, dir: up > down ? "up" : down > up ? "down" : null };
}

// ---- Opening range of the day (9:15-9:30) and whether/where it broke --------
function orStats(bars) {
  const or = bars.filter((b) => b.mm >= 555 && b.mm < 570);
  if (or.length < 3) return null;
  const hi = Math.max(...or.map((b) => b.hi));
  const lo = Math.min(...or.map((b) => b.lo));
  let brokeUp = null;
  let brokeDown = null;
  for (const b of bars) {
    if (b.mm < 570) continue;
    if (!brokeUp && b.cl > hi) brokeUp = b.mm;
    if (!brokeDown && b.cl < lo) brokeDown = b.mm;
  }
  return { hi, lo, brokeUp, brokeDown };
}

// ---- VWAP slope: rising / falling / flat over the last `look` candles -------
function vwapTrend(vwap, look = 12) {
  if (!vwap || vwap.length < look + 1) return null;
  const a = vwap[vwap.length - 1 - look];
  const b = vwap[vwap.length - 1];
  if (!(a > 0)) return null;
  const pct = ((b - a) / a) * 100;
  return { pct, dir: pct > 0.05 ? "up" : pct < -0.05 ? "down" : "flat" };
}

// ---- Today's range vs the recent normal (is there room for a trend move?) ---
function rangeVsNormal(tfBars) {
  if (!tfBars || !tfBars.length) return null;
  const byDay = new Map();
  for (const b of tfBars) {
    if (!byDay.has(b.d)) byDay.set(b.d, { hi: -Infinity, lo: Infinity });
    const d = byDay.get(b.d);
    if (b.hi > d.hi) d.hi = b.hi;
    if (b.lo < d.lo) d.lo = b.lo;
  }
  const days = [...byDay.values()];
  if (days.length < 6) return null;
  const last = days[days.length - 1];
  const prev = days.slice(-21, -1);
  const avg = prev.reduce((s, d) => s + (d.hi - d.lo), 0) / prev.length;
  const today = last.hi - last.lo;
  return { today, avg, ratio: avg > 0 ? today / avg : null };
}

// ---- Biggest 5m volume of today vs the same clock slot on earlier sessions --
function volSpike(day, prevMap) {
  const byMM = new Map();
  for (const bars of prevMap.values()) {
    for (const b of bars) {
      if (!byMM.has(b.mm)) byMM.set(b.mm, []);
      byMM.get(b.mm).push(b.vol);
    }
  }
  let best = null;
  for (const b of day) {
    const arr = byMM.get(b.mm);
    if (!arr || arr.length < 3) continue;
    const m = arr.reduce((s, x) => s + x, 0) / arr.length;
    if (m > 0) {
      const f = b.vol / m;
      if (!best || f > best.f) best = { mm: b.mm, f };
    }
  }
  return best && best.f >= 1.8 ? { mm: best.mm, mult: best.f } : null;
}

// ---- ADX / DI on the chosen timeframe: trend strength and side --------------
function adxRead(tfBars) {
  if (!tfBars || tfBars.length < 40) return null;
  const a = adx(tfBars);
  const i = tfBars.length - 1;
  if (a.adx[i] == null) return null;
  return {
    v: a.adx[i],
    pdi: a.pdi[i],
    mdi: a.mdi[i],
    dir: a.pdi[i] > a.mdi[i] ? "up" : a.pdi[i] < a.mdi[i] ? "down" : null,
  };
}

// ---- One-sided trend verdict: which side the checks lean (CE = up facts, PE =
// down facts) and how one-sided they are. This is arithmetic on the checks shown
// in the read, not a probability of profit: "strong" = most checks agree AND ADX
// and structure point the same way. It tells you the side to look at; you decide.
function trendVerdict(rd) {
  if (!rd || !rd.lean) return null;
  const up = rd.lean.up;
  const down = rd.lean.down;
  const total = rd.lean.total;
  const side = up > down ? "up" : down > up ? "down" : null;
  const agree = Math.max(up, down);
  if (!side || agree < 3 || agree / Math.max(total, 1) < 0.6) {
    return { side: null, tier: "none", agree: side ? agree : 0, total, label: total < 3 ? "too few checks yet" : "two-way / mixed" };
  }
  const adxOn = !!(rd.adx && rd.adx.v >= 18 && rd.adx.dir === side);
  const structOn = !!(rd.structure && rd.structure.dir === side);
  const volOn = !!rd.volSpike;
  const rangeOn = !!(rd.range && rd.range.ratio != null && rd.range.ratio >= 1.15);
  const orOn = !!(rd.or && (side === "up"
    ? rd.or.brokeUp && (!rd.or.brokeDown || rd.or.brokeUp < rd.or.brokeDown)
    : rd.or.brokeDown && (!rd.or.brokeUp || rd.or.brokeDown < rd.or.brokeUp)));
  const helpers = [adxOn, structOn, volOn, rangeOn, orOn].filter(Boolean).length;
  let tier = "weak";
  if (agree >= 4 && adxOn && structOn && helpers >= 3) tier = "strong";
  else if (agree >= 3 && (adxOn || structOn) && helpers >= 2) tier = "moderate";
  return { side, tier, agree, total, adxOn, structOn, volOn, rangeOn, orOn, helpers };
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
  patternAt,
  candlePatterns,
  swingStructure,
  orStats,
  vwapTrend,
  rangeVsNormal,
  volSpike,
  adxRead,
  trendVerdict,
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

