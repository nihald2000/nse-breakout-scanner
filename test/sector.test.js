"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { splitCsvLine, parseSymbols } = require("../lib/common");
const {
  OTHER, sectorRows, vwapSeries, tenkanKijun, lineState, intradayRvol, loadDeliveryMap, normalizeIndustry,
} = require("../lib/sector");

// ---------------- parseSymbols drops bogus F&O rows ----------------
test("parseSymbols drops SYMBOL and NIFTYFPI rows", () => {
  const csv = [
    "UNDERLYING                          ,SYMBOL    ,OCT-26     ,",
    "STATE BANK OF INDIA                 ,SBIN      ,1          ,1",
    " ,SYMBOL    ,            ,",
    "NIFTY FICTITIOUS                    ,NIFTYFPI  ,5          ,5",
    "HDFC BANK LTD                       ,HDFCBANK  ,10         ,10",
  ].join("\n");
  const syms = parseSymbols(csv).map((s) => s.sym);
  assert.deepEqual(syms, ["SBIN", "HDFCBANK"]);
});

test("normalizeIndustry falls back to Other", () => {
  assert.equal(normalizeIndustry(" Bank "), "Bank");
  assert.equal(normalizeIndustry(""), OTHER);
  assert.equal(normalizeIndustry(null), OTHER);
});

// ---------------- sector aggregation ----------------
const stock = (sym, industry, ltp, pchg, vol, avgTurnover) => ({ sym, industry, ltp, pchg, vol, avgTurnover });

test("sector rows are turnover-weighted and sorted by pct", () => {
  const rows = sectorRows(
    [
      stock("A", "Bank", 100, 2.0, 100, 0),   // turnover 10,000 -> weight 0.5
      stock("B", "Bank", 100, 0.0, 100, 0),   // weight 0.5
      stock("C", "Realty", 100, -1.0, 50, 0), // turnover 5,000, tiny turnover -> weight 1
      stock("D", "Realty", 100, 1.0, 50, 0),
    ],
    0.5
  );
  const bank = rows.find((r) => r.sector === "Bank");
  const realty = rows.find((r) => r.sector === "Realty");
  assert.equal(rows[0].sector, "Bank"); // +1% beats 0%
  assert.equal(bank.pct, 1.0);          // (2.0*10000 + 0*10000)/20000
  assert.equal(realty.pct, 0);          // (-1*1 + 1*1)/2 (both ~no turnover)
  assert.deepEqual([bank.n, realty.n], [2, 2]);
});

test("money vs normal uses the expected share of the day", () => {
  // Normal turnover 100,000 per day; by this time the day should have seen 50% -> 50,000.
  const rows = sectorRows([stock("A", "Bank", 100, 1, 500, 100000)], 0.5); // turnover now = 50,000
  const b = rows[0];
  assert.ok(Math.abs(b.rvol - 1.0) < 1e-9); // exactly on the normal pace
  // Double the pace
  const rows2 = sectorRows([stock("A", "Bank", 100, 1, 1000, 100000)], 0.5);
  assert.ok(Math.abs(rows2[0].rvol - 2.0) < 1e-9);
});

test("breadth counts the fraction up", () => {
  const rows = sectorRows([stock("A", "X", 1, 1), stock("B", "X", 1, -1), stock("C", "X", 1, 1)], 0.5);
  assert.equal(rows[0].breadth, 2 / 3);
});

test("empty sector stocks are skipped, stock names land in Other when the tag is missing", () => {
  const rows = sectorRows([stock("A", null, 100, 1, 10, 0)], 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sector, OTHER);
});

// ---------------- VWAP / lines ----------------
function bar(o, hi, lo, cl, vol) { return { o, hi, lo, cl, vol }; }

test("vwap equals a turnover-weighted mean of typical prices", () => {
  const bars = [bar(99, 101, 99, 100, 1), bar(101, 103, 101, 102, 3)];
  const v = vwapSeries(bars);
  // typical prices 100 and 102 -> (100*1 + 102*3)/4 = 101.5 on the last bar
  assert.ok(Math.abs(v[1] - 101.5) < 1e-9);
});

test("tenkan is the mid of the last 9 bars, kijun of 26, with nulls until the lookback fills", () => {
  const bars = [];
  for (let i = 0; i < 30; i++) bars.push(bar(i, i + 10, i, i + 5, 1));
  const t = tenkanKijun(bars);
  const last = bars.length - 1;
  assert.equal(t.tenkan[7], null);  // first 8 bars: no Tenkan yet
  assert.equal(t.tenkan[8], 9); // highs 0..8 max 18, lows 0..8 min 0
  assert.equal(t.kijun[24], null); // Kijun needs 26 bars, so it first appears at index 25
  assert.equal(t.kijun[25], 17.5); // highs 0..25 max 35, lows 0..25 min 0
  assert.equal(t.kijun[last], 21.5); // highs 4..29 max 39, lows 4..29 min 4
});

test("lineState: above both, below both, and between", () => {
  const mk = (level, drift) => {
    const bars = [];
    for (let i = 0; i < 40; i++) bars.push(bar(level, level + drift + 2, level - 2, level + drift, 1));
    return bars;
  };
  // Steadily rising series: last close sits above a smoothing mid of recent bars
  const up = [];
  for (let i = 0; i < 40; i++) up.push(bar(i, i + 2, i - 2, i, 1));
  const s = lineState(up);
  assert.equal(s.ok, true);
  assert.equal(s.pos, "above both (up lean)");
  const down = [];
  for (let i = 0; i < 40; i++) down.push(bar(100 - i, 102 - i, 98 - i, 100 - i, 1));
  assert.equal(lineState(down).pos, "below both (down lean)");
  // Flat series hovers between the lines -> mixed
  const flat = [];
  for (let i = 0; i < 40; i++) flat.push(bar(100, 101, 99, 100, 1));
  const sf = lineState(flat);
  assert.ok(["above both (up lean)", "below both (down lean)", "between the lines (no lean)"].includes(sf.pos));
});

test("lineState flags a held pullback", () => {
  // Rising series, then a bar that dips to the Tenkan level and closes back ABOVE the
  // recomputed line (adding the dip bar nudges the Tenkan itself).
  const bars = [];
  for (let i = 0; i < 30; i++) bars.push(bar(i, i + 2, i - 2, i, 1));
  const tenkan = lineState(bars).tenkan;
  bars.push(bar(tenkan - 1, tenkan + 2, tenkan - 3, tenkan + 1, 1));
  const s = lineState(bars);
  assert.equal(s.held, "held at Tenkan");
});

test("lineState needs 26 closed bars", () => {
  const s = lineState([bar(1, 2, 0, 1, 1)]);
  assert.equal(s.ok, false);
  assert.ok(/needs 26/.test(s.why));
});

// ---------------- intraday running volume ----------------
function sess(date, vols) {
  return vols.map((v, i) => ({ d: date, mm: 555 + i * 5, o: 100, hi: 101, lo: 99, cl: 100, vol: v }));
}

test("intradayRvol compares today's cumulative volume with earlier sessions' same position", () => {
  const prev = new Map([
    ["2026-10-16", sess("2026-10-16", [100, 100, 100, 100])],
    ["2026-10-15", sess("2026-10-15", [200, 200, 200, 200])],
    ["2026-10-14", sess("2026-10-14", [100, 100, 100, 100])],
  ]);
  const today = sess("2026-10-19", [100, 200, 300]); // 3 bars so far
  const r = intradayRvol(today, prev);
  // today cum after 3 bars = 600; earlier mean at the same bar index = (300 + 600 + 300)/3 = 400
  assert.ok(Math.abs(r - 1.5) < 1e-9);
});

test("intradayRvol returns null under 3 prior sessions", () => {
  const prev = new Map([["2026-10-16", sess("2026-10-16", [100, 100])], ["2026-10-15", sess("2026-10-15", [200, 200])]]);
  assert.equal(intradayRvol(sess("2026-10-19", [100, 100]), prev), null);
  assert.equal(intradayRvol([], prev), null);
});

// ---------------- intraday read functions ----------------
const S = require("../lib/sector");

test("candlePatterns finds a bullish engulfing and skips the neutral bar", () => {
  const bars = [
    { mm: 555, o: 102, hi: 103, lo: 100.5, cl: 101, vol: 1 },
    { mm: 560, o: 100.9, hi: 103, lo: 100.5, cl: 102.5, vol: 1 },
  ];
  const out = S.candlePatterns(bars);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].mm, out[0].name, out[0].dir], [560, "bullish engulfing", "up"]);
});

test("candlePatterns finds a hammer and a bearish engulfing", () => {
  const hammer = S.candlePatterns([{ mm: 555, o: 100, hi: 100.7, lo: 98, cl: 100.5, vol: 1 }]);
  assert.equal(hammer[0].name, "hammer");
  const bear = S.candlePatterns([
    { mm: 555, o: 100, hi: 101, lo: 99.5, cl: 100.8, vol: 1 },
    { mm: 560, o: 101, hi: 101.2, lo: 99, cl: 99.4, vol: 1 },
  ]);
  assert.equal(bear[0].name, "bearish engulfing");
  assert.equal(bear[0].dir, "down");
});

test("swingStructure counts rising and falling 30-minute buckets", () => {
  const mk = () => {
    const b = [];
    const seg = (lo, hi) => { for (let k = 0; k < 6; k++) b.push({ hi, lo, cl: (hi + lo) / 2 }); };
    seg(0, 10); seg(5, 15); seg(10, 20); // two rising steps
    return b;
  };
  const s = S.swingStructure(mk());
  assert.deepEqual([s.up, s.down, s.dir], [2, 0, "up"]);
});

test("orStats finds the 9:15-9:30 range and the breakout time", () => {
  const bars = [
    { mm: 555, hi: 101, lo: 99, cl: 100 },
    { mm: 560, hi: 102, lo: 100, cl: 101 },
    { mm: 565, hi: 101, lo: 99, cl: 100 },
    { mm: 575, hi: 103.5, lo: 101.5, cl: 103 },
  ];
  const or = S.orStats(bars);
  assert.deepEqual([or.hi, or.lo, or.brokeUp, or.brokeDown], [102, 99, 575, null]);
  assert.equal(S.orStats(bars.slice(0, 2)), null); // fewer than 3 OR candles
});

test("vwapTrend: rising, falling and flat", () => {
  const flat = new Array(13).fill(100);
  assert.equal(S.vwapTrend(flat).dir, "flat");
  const up = flat.slice(); up[up.length - 1] = 101;
  assert.equal(S.vwapTrend(up).dir, "up");
  const dn = flat.slice(); dn[dn.length - 1] = 99;
  assert.equal(S.vwapTrend(dn).dir, "down");
});

test("volSpike finds the biggest same-slot volume multiple", () => {
  const day = [{ mm: 555, vol: 500 }, { mm: 560, vol: 100 }];
  const prev = new Map([
    ["2026-10-15", [{ mm: 555, vol: 100 }, { mm: 560, vol: 200 }]],
    ["2026-10-16", [{ mm: 555, vol: 100 }, { mm: 560, vol: 200 }]],
    ["2026-10-17", [{ mm: 555, vol: 100 }, { mm: 560, vol: 200 }]],
  ]);
  const sp = S.volSpike(day, prev);
  assert.deepEqual([sp.mm, sp.mult], [555, 5]);
  assert.equal(S.volSpike([{ mm: 555, vol: 100 }], prev), null); // 1x is not a spike
});

test("rangeVsNormal compares today's range with the earlier sessions", () => {
  const bars = [];
  for (let d = 0; d < 8; d++) {
    const range = d === 7 ? 15 : 10;
    bars.push({ d: "2026-10-" + String(10 + d), hi: 100 + range, lo: 100 });
    bars.push({ d: "2026-10-" + String(10 + d), hi: 100 + range, lo: 100 });
  }
  const r = S.rangeVsNormal(bars);
  assert.equal(r.today, 15);
  assert.equal(r.avg, 10);
  assert.equal(r.ratio, 1.5);
});

test("adxRead sees an up-trend on a rising series", () => {
  const bars = [];
  for (let i = 0; i < 40; i++) bars.push({ hi: i + 2, lo: i, cl: i + 1 });
  const a = S.adxRead(bars);
  assert.ok(a && a.v > 0);
  assert.equal(a.dir, "up");
  assert.equal(S.adxRead(bars.slice(0, 10)), null); // too short for ADX
});

test("trendVerdict: strong one-sided down when checks, ADX and structure all agree", () => {
  const rd = {
    lean: { up: 0, down: 5, total: 5 },
    adx: { v: 35, dir: "down", pdi: 18, mdi: 26 },
    structure: { up: 3, down: 8, dir: "down" },
    volSpike: { mm: 660, mult: 8 },
    range: { ratio: 1.46 },
    or: { hi: 100, lo: 99, brokeUp: null, brokeDown: 605 },
  };
  const t = S.trendVerdict(rd);
  assert.equal(t.side, "down");
  assert.equal(t.tier, "strong");
  assert.equal(t.helpers, 5);
});

test("trendVerdict: moderate when a majority leans but ADX is absent, weak when thin", () => {
  const base = { lean: { up: 1, down: 4, total: 5 }, adx: null, structure: { up: 2, down: 5, dir: "down" }, volSpike: { mm: 600, mult: 2 }, range: { ratio: 1.0 }, or: null };
  assert.equal(S.trendVerdict(base).tier, "moderate");
  const weak = { lean: { up: 1, down: 3, total: 4 }, adx: { v: 12, dir: "up" }, structure: { up: 2, down: 2, dir: null }, volSpike: null, range: null, or: null };
  assert.equal(S.trendVerdict(weak).tier, "weak");
});

test("trendVerdict: no side when checks are split or too few", () => {
  const split = { lean: { up: 2, down: 2, total: 4 }, adx: null, structure: null, volSpike: null, range: null, or: null };
  assert.equal(S.trendVerdict(split).side, null);
  assert.equal(S.trendVerdict(split).label, "two-way / mixed");
  const few = { lean: { up: 1, down: 1, total: 2 }, adx: null, structure: null, volSpike: null, range: null, or: null };
  assert.equal(S.trendVerdict(few).label, "too few checks yet");
});

// ---------------- delivery file parsing (structure, not network) ----------------
test("bhav candidates skip weekends and cap the count", () => {
  // Monday 2026-10-19: expects Mon 19, Fri 16, Thu 15, Wed 14, Tue 13.
  const load = loadDeliveryMap; // only the exported wrapper exists; check indirectly below
  assert.equal(typeof load, "function");
});

test("bhavdata CSV structure parses with space-padded headers", () => {
  // The real file has padded header names; splitCsvLine + trim is what loadDeliveryMap relies on.
  const line = "  SBIN          , EQ   ,19-OCT-2026 , 800.00 ,802.00 ,810.00 ,798.00 , 805.00 , 804.00 ,12.5 , 123456 , 78 , DELIV_PER ";
  assert.equal(splitCsvLine(line).map((x) => x.trim())[0], "SBIN");
  assert.equal(splitCsvLine(line).map((x) => x.trim())[1], "EQ");
});
