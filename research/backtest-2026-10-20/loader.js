"use strict";
// loader.js - reads a data directory (written by fetch_data.js or synth.js) and prepares the universe:
// session calendar (validated against NSE bhavcopy dates), corporate-action flags, missing-symbol list,
// delivery % and market-trend lookups. Nothing here looks at prices after a decision time.

const fs = require("fs");
const path = require("path");
const E = require("./engine");

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}

function loadDataset(dir, opts = {}) {
  const meta = readJson(path.join(dir, "meta.json"));
  if (!meta) throw new Error(`no meta.json in ${dir} - run fetch_data.js first`);
  const bhav = readJson(path.join(dir, "bhav.json"));
  const stocks = [];
  const missing = [];
  const limit = opts.limit || Infinity;
  for (const u of meta.universe) {
    if (stocks.length + missing.length >= limit) break;
    const raws = {};
    for (const iv of ["5m", "15m", "60m", "1d"]) raws[iv] = readJson(path.join(dir, "raw", iv, u.sym + ".json"));
    const st = E.prepStock(u.sym, raws, u.industry);
    if (st.ok) stocks.push(st);
    else missing.push({ sym: u.sym, why: st.why });
  }
  const okStocks = stocks;

  // --- session calendar: a date is a full session when the median stock has >= 72 of 75 five-minute bars
  const cnt = new Map();
  for (const s of okStocks) {
    for (let k = 0; k < s.idx5.dates.length; k++) {
      const a = cnt.get(s.idx5.dates[k]) || [];
      a.push(s.idx5.ends[k] - s.idx5.starts[k] + 1);
      cnt.set(s.idx5.dates[k], a);
    }
  }
  const yahooDates = [];
  const calendar = new Set();
  const shortDates = [];
  for (const [d, a] of [...cnt.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    a.sort((x, y) => x - y);
    const med = a[a.length >> 1];
    yahooDates.push(d);
    if (med >= E.FULL_5M) calendar.add(d);
    else shortDates.push({ date: d, medianBars5m: med });
  }
  // --- validation against NSE bhavcopy trading dates
  const cal = { yahooSessions: yahooDates.length, fullSessions: calendar.size, shortDates, bhavValidated: false, onlyInYahoo: [], onlyInNSE: [] };
  if (bhav && bhav.tradingDates && bhav.tradingDates.length) {
    cal.bhavValidated = true;
    const nse = new Set(bhav.tradingDates);
    const first = yahooDates[0];
    cal.onlyInYahoo = yahooDates.filter((d) => !nse.has(d));
    cal.onlyInNSE = bhav.tradingDates.filter((d) => d >= first && !cnt.has(d));
    for (const d of [...calendar]) if (!nse.has(d)) calendar.delete(d); // never trade a date the exchange did not
    cal.fullSessions = calendar.size;
  }

  // --- corporate actions: NSE's PREV_CLOSE (adjusted) must equal the previous session's CLOSE_PRICE
  const corp = new Map();
  const corpNotes = [];
  const addCorp = (sym, d, why) => {
    if (!corp.has(sym)) corp.set(sym, []);
    if (!corp.get(sym).includes(d)) corp.get(sym).push(d);
    if (!corpNotes.some((x) => x.sym === sym && x.date === d)) corpNotes.push({ sym, date: d, why });
  };
  if (bhav && bhav.rows) {
    const ds = bhav.tradingDates.slice().sort();
    for (let k = 1; k < ds.length; k++) {
      const a = bhav.rows[ds[k - 1]] || {};
      const b = bhav.rows[ds[k]] || {};
      for (const sym of Object.keys(b)) {
        if (!a[sym]) continue;
        const prevAdj = b[sym][0];
        const prevClose = a[sym][1];
        if (prevAdj > 0 && prevClose > 0 && Math.abs(prevAdj / prevClose - 1) > 0.005) addCorp(sym, ds[k], `NSE PREV_CLOSE ${prevAdj} != previous CLOSE ${prevClose}`);
      }
    }
  }
  // --- second, data-only detector (works without bhavcopy): a >12% overnight gap in the intraday feed
  for (const s of okStocks) {
    for (let k = 1; k < s.idx5.dates.length; k++) {
      const prev = s.b5[s.idx5.ends[k - 1]];
      const cur = s.b5[s.idx5.starts[k]];
      if (prev && cur && Math.abs(cur.o / prev.cl - 1) > 0.12) addCorp(s.sym, s.idx5.dates[k], `overnight gap ${(100 * (cur.o / prev.cl - 1)).toFixed(1)}% in the intraday feed`);
    }
  }

  const delivDates = bhav && bhav.rows ? Object.keys(bhav.rows).sort() : [];
  const delivPrev = (sym, iso) => {
    let lo = 0;
    let hi = delivDates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (delivDates[mid] < iso) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo - 1; k >= 0 && k >= lo - 3; k--) {
      const r = bhav.rows[delivDates[k]][sym];
      if (r && Number.isFinite(r[3])) return r[3];
    }
    return null;
  };

  const nseiRaw = readJson(path.join(dir, "raw", "index", "NSEI_1d.json"));
  let nseiBars = [];
  if (nseiRaw) nseiBars = require(path.join(__dirname, "..", "..", "api", "indices"))._internals.parseIdx(nseiRaw).bars;
  const mktTrend = (iso) => E.dailyTrendSign(nseiBars, iso);

  return { dir, meta, stocks: okStocks, stockBySym: new Map(okStocks.map((s) => [s.sym, s])), missing, calendar, cal, corp, corpNotes, delivPrev, mktTrend, bhavLoaded: !!bhav };
}

module.exports = { loadDataset, readJson };
