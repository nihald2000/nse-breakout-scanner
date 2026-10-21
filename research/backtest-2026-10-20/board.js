"use strict";
// board.js - research-only replay of the Live Calls *selection* layer.
//
// The component backtest in run_backtest.js measures every per-stock decision. This module
// measures the board that a user actually sees:
//   * sectors are the NSE Industry groups used by /api/sectors
//   * sector % is the turnover-weighted member average at the decision time (closed bars only)
//   * only sectors with at least 2 stocks with a finite day change are eligible
//   * only strong/moderate rows are listed
//   * rows are ordered exactly as api/calls.js orders them: tier, agreeing checks, helpers, RVOL
//   * the live API scan caps (8 sectors, 40 per sector, 100 symbols) and the UI row cap are
//     optional switches, so the effect of removing each cap can be measured separately.
//
// Nothing here is imported by lib/ or api/. It never sees a bar after the decision time.

const { normalizeIndustry } = require("../../lib/sector");

function sectorRowsForGroup(dec, idxs) {
  const bySec = new Map();
  for (const i of idxs) {
    const d = dec[i];
    if (!Number.isFinite(d.pchg)) continue;
    const sec = normalizeIndustry(d.ind);
    let list = bySec.get(sec);
    if (!list) bySec.set(sec, (list = []));
    list.push(i);
  }
  const rows = [];
  for (const [sector, list] of bySec) {
    let wsum = 0;
    let wtot = 0;
    let up = 0;
    let n = 0;
    for (const i of list) {
      const d = dec[i];
      const w = d.turn > 0 ? d.turn : 1; // no turnover yet: equal weight, as sectorRows does
      wsum += d.pchg * w;
      wtot += w;
      n++;
      if (d.pchg > 0) up++;
    }
    if (!(wtot > 0) || !(n > 0)) continue;
    rows.push({ sector, n, pct: wsum / wtot, breadth: up / n, idxs: list });
  }
  rows.sort((a, b) => b.pct - a.pct || a.sector.localeCompare(b.sector));
  return rows;
}

// Adds current-time sector fields to every decision. Grouping is by (date, decision close minute),
// so all stocks in one cross-section are ranked with information available at that instant.
function annotateCurrentSectors(dec) {
  const groups = new Map();
  for (let i = 0; i < dec.length; i++) {
    const d = dec[i];
    const key = d.d + "|" + d.tm;
    let a = groups.get(key);
    if (!a) groups.set(key, (a = []));
    a.push(i);
  }
  let eligibleCount = 0;
  for (const idxs of groups.values()) {
    const rows = sectorRowsForGroup(dec, idxs);
    const eligible = rows.filter((r) => r.n >= 2);
    const byAbs = eligible.slice().sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct) || a.sector.localeCompare(b.sector));
    byAbs.forEach((r, k) => (r.rankAbs = k + 1));
    const bySigned = eligible.slice().sort((a, b) => b.pct - a.pct || a.sector.localeCompare(b.sector));
    bySigned.forEach((r, k) => {
      r.rankUp = k + 1;
      r.rankDown = bySigned.length - k;
    });
    for (const r of rows) {
      const isEligible = r.n >= 2;
      if (isEligible) eligibleCount++;
      for (const i of r.idxs) {
        const d = dec[i];
        d.secPct = r.pct;
        d.secN = r.n;
        d.secBreadth = r.breadth;
        d.secEligible = isEligible;
        d.secRankAbs = isEligible ? r.rankAbs : null;
        d.secRankUp = isEligible ? r.rankUp : null;
        d.secRankDown = isEligible ? r.rankDown : null;
      }
    }
  }
  return { groups: groups.size, eligibleSectorTimes: eligibleCount };
}

function lastDailyBefore(bars, iso) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].d < iso) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

// Prior-session sector momentum. We compute a 1-day and a 5-day turnover-weighted member
// return using only daily bars strictly before the decision date. This is an *adaptation* of
// industry momentum (Moskowitz & Grinblatt, 1999), whose tested horizon was months, not 15m.
function precomputeSectorDaily(dec, ds) {
  const dates = [...new Set(dec.map((d) => d.d))].sort();
  const byDate = new Map();
  const daily = new Map();
  for (const st of ds.stocks) {
    const bars = (st.bd || []).filter((b) => b.d && b.cl > 0);
    daily.set(st.sym, bars);
  }
  for (const D of dates) {
    const bySec1 = new Map();
    const bySec5 = new Map();
    for (const st of ds.stocks) {
      const bars = daily.get(st.sym);
      if (!bars || !bars.length) continue;
      const k = lastDailyBefore(bars, D);
      if (k < 1) continue;
      const sec = normalizeIndustry(st.industry);
      const w = bars[k].vol > 0 ? bars[k].vol * bars[k].cl : 1;
      const r1 = (bars[k].cl / bars[k - 1].cl - 1) * 100;
      if (!Number.isFinite(r1)) continue;
      let a = bySec1.get(sec);
      if (!a) bySec1.set(sec, (a = { sw: 0, w: 0, n: 0 }));
      a.sw += r1 * w;
      a.w += w;
      a.n++;
      if (k >= 5 && bars[k - 5].cl > 0) {
        const r5 = (bars[k].cl / bars[k - 5].cl - 1) * 100;
        if (Number.isFinite(r5)) {
          let b = bySec5.get(sec);
          if (!b) bySec5.set(sec, (b = { sw: 0, w: 0, n: 0, vals: [] }));
          b.sw += r5 * w;
          b.w += w;
          b.n++;
          b.vals.push(r5);
        }
      }
    }
    const rows = [];
    for (const [sector, a] of bySec1) {
      if (a.n < 2 || !(a.w > 0)) continue;
      const b = bySec5.get(sector);
      rows.push({
        sector,
        n: a.n,
        ret1: a.sw / a.w,
        ret5: b && b.n >= 2 && b.w > 0 ? b.sw / b.w : null,
      });
    }
    const rank1 = rows.slice().sort((a, b) => b.ret1 - a.ret1 || a.sector.localeCompare(b.sector));
    rank1.forEach((r, k) => {
      r.rank1Up = k + 1;
      r.rank1Down = rank1.length - k;
    });
    const with5 = rows.filter((r) => r.ret5 != null);
    const rank5 = with5.slice().sort((a, b) => b.ret5 - a.ret5 || a.sector.localeCompare(b.sector));
    rank5.forEach((r, k) => {
      r.rank5Up = k + 1;
      r.rank5Down = rank5.length - k;
    });
    const m = new Map(rows.map((r) => [r.sector, r]));
    byDate.set(D, m);
  }
  return byDate;
}

function annotateSectorHistory(dec, byDate) {
  for (const d of dec) {
    const m = byDate.get(d.d);
    const r = m ? m.get(normalizeIndustry(d.ind)) : null;
    d.secRet1 = r ? r.ret1 : null;
    d.secRet5 = r ? r.ret5 : null;
    d.secRank1Up = r ? r.rank1Up : null;
    d.secRank1Down = r ? r.rank1Down : null;
    d.secRank5Up = r && r.rank5Up != null ? r.rank5Up : null;
    d.secRank5Down = r && r.rank5Down != null ? r.rank5Down : null;
    d.secHistoryN = r ? r.n : null;
  }
}

function boardSymOrder(ds) {
  const m = new Map();
  const u = (ds.meta && ds.meta.universe) || [];
  u.forEach((x, i) => m.set(x.sym, i));
  return m;
}

// cfg:
//   sectorK      number of sectors (Infinity = every eligible sector)
//   mode         "abs" (hottest by |%|) or "updown" (top up + bottom down)
//   upK/downK    used by updown; default half of sectorK each
//   rowCap       UI cap; 0 = every row
//   maxPerSector API cap; Infinity = no cap
//   maxSymbols   API cap; Infinity = no cap
//   align        true = CE only in an up sector, PE only in a down sector
function boardEvents(dec, cfg, symOrder) {
  const C = Object.assign({ sectorK: Infinity, mode: "abs", rowCap: 0, maxPerSector: Infinity, maxSymbols: Infinity, align: false, sortMode: "board" }, cfg || {});
  const order = symOrder || new Map();
  const groups = new Map();
  for (let i = 0; i < dec.length; i++) {
    const d = dec[i];
    const key = d.d + "|" + d.tm;
    let a = groups.get(key);
    if (!a) groups.set(key, (a = []));
    a.push(i);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const [da, ta] = a.split("|");
    const [db, tb] = b.split("|");
    return da < db ? -1 : da > db ? 1 : Number(ta) - Number(tb);
  });
  const evD = [];
  const evS = [];
  const lastSide = new Map();
  const meta = { crossSections: keys.length, selectedSectorTimes: 0, candidates: 0, afterRowCap: 0, events: 0 };
  for (const key of keys) {
    const idxs = groups.get(key);
    const rows = sectorRowsForGroup(dec, idxs).filter((r) => r.n >= 2);
    let selected;
    if (C.mode === "updown") {
      const up = rows.filter((r) => r.pct > 0).sort((a, b) => b.pct - a.pct || a.sector.localeCompare(b.sector));
      const down = rows.filter((r) => r.pct < 0).sort((a, b) => a.pct - b.pct || a.sector.localeCompare(b.sector));
      const k = C.sectorK;
      const upK = C.upK != null ? C.upK : Number.isFinite(k) ? Math.ceil(k / 2) : Infinity;
      const downK = C.downK != null ? C.downK : Number.isFinite(k) ? Math.floor(k / 2) : Infinity;
      selected = [...up.slice(0, upK), ...down.slice(0, downK)];
    } else {
      selected = rows.slice().sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct) || a.sector.localeCompare(b.sector)).slice(0, C.sectorK);
    }
    if (!selected.length) continue;
    meta.selectedSectorTimes += selected.length;
    const secOrder = new Map(selected.map((r, k) => [r.sector, k]));
    let scanned;
    if (Number.isFinite(C.maxPerSector) || Number.isFinite(C.maxSymbols)) {
      scanned = new Set();
      let count = 0;
      for (const r of selected) {
        const list = r.idxs.slice().sort((a, b) => (order.get(dec[a].sym) ?? 1e9) - (order.get(dec[b].sym) ?? 1e9) || dec[a].sym.localeCompare(dec[b].sym));
        let added = 0;
        for (const i of list) {
          if (count >= C.maxSymbols || added >= C.maxPerSector) break;
          scanned.add(i);
          count++;
          added++;
        }
      }
    } else {
      scanned = new Set();
      for (const r of selected) for (const i of r.idxs) scanned.add(i);
    }
    const cand = [];
    for (const i of scanned) {
      const d = dec[i];
      if (d.j0 < 0 || d.tier < 2 || !d.side) continue;
      if (C.align && Math.sign(d.secPct) !== d.side) continue;
      cand.push(i);
    }
    meta.candidates += cand.length;
    cand.sort((a, b) => {
      const da = dec[a];
      const db = dec[b];
      const ha = da.helpers == null ? -1 : da.helpers;
      const hb = db.helpers == null ? -1 : db.helpers;
      const ra = da.rvol == null ? -1 : da.rvol;
      const rb = db.rvol == null ? -1 : db.rvol;
      const sa = secOrder.get(normalizeIndustry(da.ind)) ?? 1e9;
      const sb = secOrder.get(normalizeIndustry(db.ind)) ?? 1e9;
      if (C.sortMode === "sector") {
        return sa - sb || db.tier - da.tier || db.agree - da.agree || hb - ha || rb - ra ||
          (order.get(da.sym) ?? 1e9) - (order.get(db.sym) ?? 1e9) || da.sym.localeCompare(db.sym);
      }
      return db.tier - da.tier || db.agree - da.agree || hb - ha || rb - ra ||
        (da.secRankAbs ?? 1e9) - (db.secRankAbs ?? 1e9) ||
        (order.get(da.sym) ?? 1e9) - (order.get(db.sym) ?? 1e9) ||
        da.sym.localeCompare(db.sym);
    });
    const listed = C.rowCap > 0 ? cand.slice(0, C.rowCap) : cand;
    meta.afterRowCap += listed.length;
    for (const i of listed) {
      const d = dec[i];
      const k = d.sym + "|" + d.d;
      const prev = lastSide.get(k) || 0;
      if (d.side === prev) continue;
      lastSide.set(k, d.side);
      evD.push(i);
      evS.push(d.side > 0 ? 0 : 1);
    }
  }
  meta.events = evD.length;
  return { evD, evS, meta };
}

module.exports = {
  sectorRowsForGroup, annotateCurrentSectors, lastDailyBefore, precomputeSectorDaily,
  annotateSectorHistory, boardSymOrder, boardEvents,
};
