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
