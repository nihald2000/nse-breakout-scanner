"use strict";
// synth.js - synthetic NSE-like market written in the SAME on-disk layout and Yahoo `result` shape that
// fetch_data.js produces, so the whole pipeline (parseIdx -> replay -> grid -> report) is exercised end to end.
//
//   edge = 0      NULL market: returns are a driftless random walk, so any "edge" the harness reports is a
//                 false positive and the false-positive rate can be measured.
//   edge > 0      PLANTED market: a share of stock-days carries a persistent intraday drift of `edge` % per 5m bar,
//                 so a working harness must detect a gross edge, with the correct sign for shorts.
//
// Also injects the data problems the harness must survive: holidays, a half-day, a short-history stock, a split,
// a symbol with no file, out-of-session and duplicate bars, null bars and zero-volume bars.

const fs = require("fs");
const path = require("path");

function rng(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const n = () => {
    if (spare != null) {
      const s = spare;
      spare = null;
      return s;
    }
    let x;
    let y;
    let r;
    do {
      x = u() * 2 - 1;
      y = u() * 2 - 1;
      r = x * x + y * y;
    } while (r >= 1 || r === 0);
    const f = Math.sqrt((-2 * Math.log(r)) / r);
    spare = y * f;
    return x * f;
  };
  return { u, n };
}

const INDUSTRIES = ["Financial Services", "Information Technology", "Automobile and Auto Components", "Healthcare", "Fast Moving Consumer Goods", "Metals & Mining", "Oil Gas & Consumable Fuels", "Capital Goods"];

function weekdays(endISO, calDays) {
  const out = [];
  const end = new Date(endISO + "T00:00:00Z");
  for (let k = calDays - 1; k >= 0; k--) {
    const d = new Date(end.getTime() - k * 86400000);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const tsOf = (iso, k) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), 3, 45) / 1000 + k * 300; // 09:15 IST + k*5m

function toRaw(sym, bars) {
  const last = bars[bars.length - 1];
  return {
    meta: { symbol: sym + ".NS", gmtoffset: 19800, timezone: "IST", exchangeTimezoneName: "Asia/Kolkata", regularMarketPrice: last ? last.c : null, regularMarketTime: last ? last.t : null },
    timestamp: bars.map((b) => b.t),
    indicators: { quote: [{ open: bars.map((b) => b.o), high: bars.map((b) => b.h), low: bars.map((b) => b.l), close: bars.map((b) => b.c), volume: bars.map((b) => b.v) }] },
  };
}

function agg(bars, groupOf) {
  const out = [];
  let cur = null;
  let g = null;
  for (const b of bars) {
    const k = groupOf(b);
    if (k !== g) {
      if (cur) out.push(cur);
      cur = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      g = k;
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function generate(opts) {
  const { outDir, seed = 7, nStocks = 40, endDate = "2026-10-16", calDays = 60, edge = 0, specials = true } = opts;
  const R = rng(seed);
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const sub of ["5m", "15m", "60m", "1d", "index"]) fs.mkdirSync(path.join(outDir, "raw", sub), { recursive: true });

  let dates = weekdays(endDate, calDays);
  const holidays = new Set([dates[6], dates[19]]);
  const halfDay = dates[27];
  dates = dates.filter((d) => !holidays.has(d));

  const syms = [];
  const stockInfo = [];
  for (let i = 0; i < nStocks; i++) {
    const sym = "SYN" + String(i + 1).padStart(2, "0");
    syms.push(sym);
    stockInfo.push({ sym, industry: INDUSTRIES[i % INDUSTRIES.length], beta: 0.6 + R.u() * 0.8, vol: 0.7 + R.u() * 0.8, px: 100 + R.u() * 2400, base: 20000 + R.u() * 400000 });
  }
  const special = specials ? { short: syms[3], split: syms[5], nodata: syms[7], oos: syms[9], nullz: syms[11] } : {};
  const splitDate = dates[30];

  // market and per-stock-day regimes
  const dayVol = {};
  const mkt = {};
  for (const d of dates) {
    dayVol[d] = Math.exp(0.25 * R.n());
    const nBars = d === halfDay ? 39 : 75;
    mkt[d] = Array.from({ length: nBars }, () => R.n());
  }
  const tod = (k) => 0.8 + 1.0 * Math.exp(-k / 8) + 0.5 * Math.exp(-(74 - k) / 10);

  const bhav = { tradingDates: dates.slice(), rows: {} };
  for (const d of dates) bhav.rows[d] = {};
  const corp = {};
    const nseiDaily = new Map();

  for (const si of stockInfo) {
    const bars5 = [];
    const daily = [];
    let px = si.px;
    let fac = 1; // unadjusted feed: a split steps every later price by the same factor
    const startIdx = special.short === si.sym ? dates.length - 9 : 0;
    let prevClose = null;
    for (let di = startIdx; di < dates.length; di++) {
      const d = dates[di];
      px *= 1 + 0.005 * (si.beta * R.n() * 0.7 + 0.7 * R.n());
      let adjPrev = prevClose;
      if (special.split === si.sym && d === splitDate) {
        fac = 0.5;
        corp[si.sym] = [d];
        adjPrev = prevClose == null ? null : prevClose * 0.5; // NSE's PREV_CLOSE is adjusted for the action
      }
      const regime = edge > 0 ? (R.u() < 0.15 ? 1 : R.u() < 0.18 ? -1 : 0) : 0;
      const nBars = mkt[d].length;
      const dayBars = [];
      let dv = 0;
      for (let k = 0; k < nBars; k++) {
        const sig = 0.001 * tod(k) * dayVol[d] * si.vol;
        const o = px;
        let p = px;
        let hi = p;
        let lo = p;
        const mret = 0.0007 * tod(k) * dayVol[d] * si.beta * mkt[d][k];
        const drift = k >= 3 ? (edge / 100) * regime : 0;
        let absr = 0;
        for (let s = 0; s < 5; s++) {
          const r = (mret + sig * R.n() * 0.9 + drift) / 5 + (sig * R.n() * 0.45) / Math.sqrt(5);
          p *= 1 + r;
          absr += Math.abs(r);
          if (p > hi) hi = p;
          if (p < lo) lo = p;
        }
        px = p;
        const v = Math.round(si.base * tod(k) * Math.exp(0.45 * R.n()) * (1 + 40 * absr));
        dayBars.push({ d, k, t: tsOf(d, k), o: o * fac, h: hi * fac, l: lo * fac, c: p * fac, v });
        dv += v;
      }
      for (const b of dayBars) bars5.push(b);
      const cl = dayBars[dayBars.length - 1].c;
      daily.push({ t: tsOf(d, 0), o: dayBars[0].o, h: Math.max(...dayBars.map((b) => b.h)), l: Math.min(...dayBars.map((b) => b.l)), c: cl, v: dv });
      bhav.rows[d][si.sym] = [adjPrev == null ? dayBars[0].o : adjPrev, cl, dv, +(30 + 40 * R.u()).toFixed(2)];
      prevClose = cl;
      const x = nseiDaily.get(d);
      if (x) {
        x.c += cl / si.px;
        x.n++;
      } else nseiDaily.set(d, { t: tsOf(d, 0), c: cl / si.px, n: 1 });
    }

    // 15m / 60m are aggregated from the clean 5m bars (as the venue does); the 5m file then gets the data faults
    const bars15 = agg(bars5, (b) => b.d + "|" + Math.floor(b.k / 3));
    const bars60 = agg(bars5, (b) => b.d + "|" + Math.floor(b.k / 12));
    const b5 = bars5.map((b) => ({ ...b, nullit: R.u() < 0.0008, v: R.u() < 0.001 ? 0 : b.v }));
    if (special.oos === si.sym) {
      const k = Math.floor(b5.length / 2);
      b5.splice(k, 0, { ...b5[k], t: b5[k].t - 3600 }); // an 08:15 IST bar, outside the session
      const last = b5[b5.length - 1];
      b5.push({ ...last, t: last.t + 300 }); // a 15:30 bar
      b5.push({ ...b5[b5.length - 1] }); // duplicate timestamp
    }
    // pre-history daily bars (random walk back from the first intraday open) so the SMA(20) regime exists
    const pre = [];
    let pp = bars5[0].o;
    for (let k = 0; k < 230; k++) {
      pp /= 1 + 0.012 * R.n();
      pre.unshift({ t: bars5[0].t - (k + 1) * 86400, o: pp, h: pp * 1.01, l: pp * 0.99, c: pp, v: 1e6 });
    }
    if (special.nodata === si.sym) continue;
    if (syms.indexOf(si.sym) < 5) {
      // 1-minute bars for the last 6 sessions: each 5m bar is split into 5 minutes that start at its open, end at its
      // close and touch its high and low (in random minutes), so the 5m series is exactly the aggregate of the 1m one.
      const last6 = new Set(dates.slice(-6));
      const m1 = [];
      for (const b of bars5) {
        if (!last6.has(b.d)) continue;
        const hiAt = Math.floor(R.u() * 5);
        let loAt = Math.floor(R.u() * 5);
        if (loAt === hiAt) loAt = (loAt + 1) % 5;
        let prev = b.o;
        for (let j = 0; j < 5; j++) {
          let c = b.o + ((b.c - b.o) * (j + 1)) / 5 + (b.h - b.l) * 0.15 * (R.u() - 0.5);
          c = Math.min(b.h, Math.max(b.l, c));
          if (j === 4) c = b.c;
          let hi = Math.max(prev, c);
          let lo = Math.min(prev, c);
          if (j === hiAt) hi = b.h;
          if (j === loAt) lo = b.l;
          m1.push({ t: b.t + 60 * j, o: prev, h: Math.max(hi, prev, c), l: Math.min(lo, prev, c), c, v: Math.round(b.v / 5) });
          prev = c;
        }
      }
      fs.mkdirSync(path.join(outDir, "raw", "1m"), { recursive: true });
      fs.writeFileSync(path.join(outDir, "raw", "1m", si.sym + ".json"), JSON.stringify(toRaw(si.sym, m1)));
    }
    const raw5 = toRaw(si.sym, b5);
    b5.forEach((b, i) => {
      if (b.nullit) for (const f of ["open", "high", "low", "close", "volume"]) raw5.indicators.quote[0][f][i] = null;
    });
    fs.writeFileSync(path.join(outDir, "raw", "5m", si.sym + ".json"), JSON.stringify(raw5));
    fs.writeFileSync(path.join(outDir, "raw", "15m", si.sym + ".json"), JSON.stringify(toRaw(si.sym, bars15)));
    fs.writeFileSync(path.join(outDir, "raw", "60m", si.sym + ".json"), JSON.stringify(toRaw(si.sym, bars60)));
    fs.writeFileSync(path.join(outDir, "raw", "1d", si.sym + ".json"), JSON.stringify(toRaw(si.sym, pre.concat(daily))));
  }

  const nsei = [...nseiDaily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, x]) => ({ t: x.t, o: x.c / x.n, h: x.c / x.n, l: x.c / x.n, c: x.c / x.n, v: 0 }));
  // 230 days of pre-history for the index too
  let ip = nsei[0].c;
  const ipre = [];
  for (let k = 0; k < 230; k++) {
    ip /= 1 + 0.007 * R.n();
    ipre.unshift({ t: nsei[0].t - (k + 1) * 86400, o: ip, h: ip, l: ip, c: ip, v: 0 });
  }
  fs.writeFileSync(path.join(outDir, "raw", "index", "NSEI_1d.json"), JSON.stringify(toRaw("^NSEI", ipre.concat(nsei))));

  fs.writeFileSync(path.join(outDir, "bhav.json"), JSON.stringify(bhav));
  const meta = {
    synthetic: true,
    snapshotDate: endDate,
    fetchedAt: endDate + "T18:00:00Z",
    asOfISO: endDate,
    universe: stockInfo.map((s) => ({ sym: s.sym, industry: s.industry })),
    corpActions: corp,
    note: "SYNTHETIC DATA - for harness validation only. edge=" + edge,
    injected: { holidays: [...holidays], halfDay, special, splitDate },
  };
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 1));
  return meta;
}

module.exports = { generate, rng };

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, "harness-data");
  const edge = Number(process.argv[3] || 0);
  const m = generate({ outDir: out, edge });
  console.log("wrote", out, "edge", edge, "universe", m.universe.length);
}
