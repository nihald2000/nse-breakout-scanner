// api/sectorstocks.js - Sector Scope stock list for ONE chosen sector (?sector=Bank).
// For each F&O stock in that sector (Yahoo, 2 fetches each):
//   5m  : today's closed candles -> true VWAP, and "running volume so far vs the same clock time
//         on the earlier sessions in the same fetch" (intraday RVOL, needs 3 prior sessions).
//   tf  : 15m or 5m series -> Tenkan(9) / Kijun(26) line state, computed on closed bars only.
// Tags: F&O ban is not checked (no free source); live option bid/ask is not available. Facts only.
//   ltp, pchg, rvol (running), rvolNote, vwap, vwapDistPct, prev level hi/lo,
//   lines: { tf, tenkan, kijun, pos, linePos, held, stop, dTenkan, dKijun }
//
// computeRows() carries the per-stock maths and is shared with api/calls.js (the multi-sector
// live calls board) so both routes describe a stock in exactly the same way.

const { FO_INDEX, mapPool, istParts, formatIST } = require("../lib/common");
const { getUniverse, yahooChart } = require("../lib/common");
const { parseIdx } = require("./indices")._internals;
const { OTHER, vwapSeries, lineState, intradayRvol, tenkanKijun, loadDeliveryMap, vwapTrend, swingStructure, orStats, candlePatterns, volSpike, adxRead, rangeVsNormal, trendVerdict } = require("../lib/sector");

const TFS = { "15m": { range: "1mo", interval: "15m", step: 900 }, "5m": { range: "5d", interval: "5m", step: 300 } };

// Compute the rows for the given Yahoo symbols (without .NS) on one timeframe.
// labelOf(sym) -> the industry tag shown on the row (or null).
// Returns { rows, failed, newestTs } - rows sorted by running volume, like the sector panel.
async function computeRows(symbols, tfKey, labelOf) {
  const tf = TFS[tfKey] || TFS["15m"];
  const [gotThis, delivery] = await Promise.all([
    mapPool(symbols, 16, async (sym, i) => {
      try {
        const [r5, rtf] = await Promise.allSettled([
          yahooChart(sym + ".NS", i, "5d", "5m"),
          yahooChart(sym + ".NS", i + 1, tf.range, tf.interval),
        ]);
        if (r5.status !== "fulfilled") throw r5.reason;
        return { sym, p5: parseIdx(r5.value), ptf: rtf.status === "fulfilled" ? parseIdx(rtf.value) : null };
      } catch (e) {
        return { sym, error: String(e && e.message).slice(0, 60) };
      }
    }),
    loadDeliveryMap(istParts().iso).catch(() => ({ map: {}, date: null })),
  ]);
  const got = gotThis;

  const rows = [];
  let newestTs = 0;
  let failed = 0;

  for (const g of got) {
    if (g.error || !g.p5 || !g.p5.bars.length) {
      failed++;
      continue;
    }
    const all5 = g.p5.bars;
    const liveISO = all5[all5.length - 1].d;
    const today = all5.filter((b) => b.d === liveISO);
    if (today.length < 3) {
      failed++;
      continue;
    }
    const m = g.p5.meta;
    const ltp = Number.isFinite(m.regularMarketPrice) ? m.regularMarketPrice : today[today.length - 1].cl;
    const prev = [...all5].reverse().find((b) => b.d < liveISO);
    if (!prev || !(ltp > 0)) {
      failed++;
      continue;
    }
    newestTs = Math.max(newestTs, m.regularMarketTime || 0);
    const pchg = ((ltp - prev.cl) / prev.cl) * 100;
    const closed5 = all5.filter((b) => b.d === liveISO && b.t + 300 <= Math.floor(Date.now() / 1000));

    // Intraday RVOL: cumulative volume so far vs the same clock minute on the earlier sessions.
    const prevMap = new Map();
    for (const b of all5) {
      if (b.d >= liveISO) break;
      if (!prevMap.has(b.d)) prevMap.set(b.d, []);
      prevMap.get(b.d).push(b);
    }
    const rvol = intradayRvol(today, prevMap);

    // True VWAP (stocks have volume).
    const vw = closed5.length && closed5.some((b) => b.vol > 0) ? vwapSeries(closed5) : null;
    const vwapNow = vw ? vw[vw.length - 1] : null;
    const vwapDistPct = vwapNow ? ((ltp - vwapNow) / vwapNow) * 100 : null;
    const vwapSide = vwapNow == null ? "n/a (no volume in feed)" : ltp > vwapNow ? "above VWAP" : ltp < vwapNow ? "below VWAP" : "at VWAP";

    // Tenkan / Kijun on the chosen timeframe's closed bars.
    let lines = { ok: false, why: "no data for this timeframe" };
    let chartBars = [];
    const closedTf = g.ptf && g.ptf.bars.length
      ? g.ptf.bars.filter((b) => b.mm != null && b.t + tf.step <= Math.floor(Date.now() / 1000))
      : [];
    if (closedTf.length) {
      lines = lineState(closedTf);
      const day = closedTf.filter((b) => b.d === closedTf[closedTf.length - 1].d);
      chartBars = day.map((b) => ({ mm: b.mm, o: b.o, cl: b.cl, vol: b.vol, t9: null, k26: null }));
      const lk = tenkanKijun(closedTf);
      const off = closedTf.length - day.length;
      chartBars.forEach((b, k) => {
        b.t9 = lk.tenkan[off + k];
        b.k26 = lk.kijun[off + k];
        b.hi = day[k].hi;
        b.lo = day[k].lo;
      });
    }

    // Intraday read: candles, volume behaviour, structure and levels - facts only.
    const read = {};
    read.vwapTrend = vwapTrend(vw);
    read.structure = swingStructure(closed5);
    read.or = orStats(closed5);
    read.patterns = candlePatterns(closed5);
    read.volSpike = volSpike(closed5, prevMap);
    read.adx = adxRead(closedTf);
    read.range = g.ptf ? rangeVsNormal(g.ptf.bars) : null;
    const checks = [];
    if (vwapNow != null) checks.push(ltp > vwapNow ? "up" : ltp < vwapNow ? "down" : null);
    if (read.vwapTrend && read.vwapTrend.dir !== "flat") checks.push(read.vwapTrend.dir);
    if (lines.ok) {
      if (/above both/.test(lines.pos)) checks.push("up");
      else if (/below both/.test(lines.pos)) checks.push("down");
    }
    if (read.structure && read.structure.dir) checks.push(read.structure.dir);
    if (read.or) checks.push(read.or.brokeUp && (!read.or.brokeDown || read.or.brokeUp < read.or.brokeDown) ? "up" : read.or.brokeDown ? "down" : null);
    if (read.adx && read.adx.v >= 18 && read.adx.dir) checks.push(read.adx.dir);
    read.lean = {
      up: checks.filter((c) => c === "up").length,
      down: checks.filter((c) => c === "down").length,
      total: checks.filter((c) => c === "up" || c === "down").length,
    };
    read.trend = trendVerdict(read);

    rows.push({
      sym: g.sym,
      industry: labelOf ? labelOf(g.sym) : null,
      ltp,
      pchg,
      rvol: rvol == null ? null : Math.round(rvol * 100) / 100,
      rvolNote: rvol == null ? "needs 3 earlier sessions in the fetch" : null,
      vwap: vwapNow,
      vwapDistPct: vwapDistPct == null ? null : vwapDistPct,
      vwapSide,
      prevHi: prev.hi,
      prevLo: prev.lo,
      prevClose: prev.cl,
      lines: lines.ok
        ? { ok: true, tf: tfKey, tenkan: lines.tenkan, kijun: lines.kijun, pos: lines.pos, linePos: lines.linePos, held: lines.held, stop: lines.stop, dTenkan: lines.dTenkan, dKijun: lines.dKijun }
        : { ok: false, why: lines.why },
      read,
      chart: { tf: tfKey, bars: chartBars },
      deliveryPct: delivery.map[g.sym] == null ? null : delivery.map[g.sym],
      liquidityNote: "option bid/ask not available here; check your broker before buying",
    });
  }

  rows.sort((a, b) => (b.rvol == null ? -1 : b.rvol) - (a.rvol == null ? -1 : a.rvol) || Math.abs(b.pchg) - Math.abs(a.pchg));
  return { rows, failed, newestTs };
}

module.exports = async function handler(req, res) {
  const q = (req && req.query) || {};
  const want = String(q.sector || "").trim();
  const tfKey = TFS[q.tf] ? q.tf : "15m";
  const t0 = Date.now();

  if (!want) return res.status(400).json({ error: "Pass ?sector= with a sector name from /api/sectors." });

  let universe;
  try {
    universe = await getUniverse(FO_INDEX);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Could not load the F&O stock list.", detail: String((e && e.message) || e) });
  }
  let industryOf;
  try {
    const n500 = await getUniverse("NIFTY 500");
    industryOf = new Map(n500.map((u) => [u.sym, u.industry]));
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Could not load the industry list.", detail: String((e && e.message) || e) });
  }

  const symbols = universe.map((u) => u.sym).filter((s) => (industryOf.get(s) || OTHER) === want).slice(0, 40);
  if (!symbols.length) return res.status(400).json({ error: `No F&O stocks found for sector "${want}".`, hint: "Use exactly the sector name from /api/sectors." });

  const { rows, failed, newestTs } = await computeRows(symbols, tfKey, () => want);

  res.setHeader("Cache-Control", "public, s-maxage=45, stale-while-revalidate=90");
  return res.status(200).json({
    meta: {
      sector: want,
      tf: tfKey,
      wanted: symbols.length,
      universe: rows.length,
      failed,
      asOf: newestTs ? formatIST(newestTs) : null,
      notes: [
        "Tenkan(9)/Kijun(26) are computed on closed candles only and describe where price sits - they are not a buy or sell order.",
        "F&O ban and live option liquidity are not checked anywhere here (no free source); they are never shown as checked.",
        "Screening aid, not trading advice.",
      ],
      source: "Yahoo Finance",
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - t0,
    },
    stockRows: rows,
  });
};

module.exports._internals = { TFS, computeRows };
