// lib/sipscan.js - the whole-universe Stocks in Play scan and the feed facts around it. Shared by /api/sip (the list reply)
// and the push-alert route (lib/notifyroute.js). Kept in lib/ so it is not a separate Vercel function.
const { FO_INDEX, getUniverse, yahooChart, mapPool, formatIST } = require("./common");
const { parseIdx } = require("../api/indices")._internals;
const { SIP, evaluate, rankCalls } = require("./sip");

// IST date and minutes from a unix time, so "today" and "market open" follow the request time and the data's own
// session date (a holiday weekday serves the previous session and is correctly reported as not live).
function istClock(nowSec) {
  const d = new Date((nowSec + 19800) * 1000);
  return { iso: d.toISOString().slice(0, 10), mm: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

const reasonKey = (s) => String(s).replace(/\(have \d+\)/, "").trim();

// Session and feed-age facts shared by both replies. "Today" follows the request time and the data's own session date.
function feedMeta(sessionDate, newestTs, nowSec) {
  const clock = istClock(nowSec);
  return {
    sessionDate: sessionDate || null,
    showingLastSession: !!sessionDate && sessionDate !== clock.iso,
    marketOpen: !!sessionDate && sessionDate === clock.iso && clock.mm >= SIP.firstBarMM && clock.mm < SIP.sessionEndMM,
    asOf: newestTs ? formatIST(newestTs) : null,
    lagMin: newestTs ? Math.max(0, Math.round(((nowSec - newestTs) / 60) * 10) / 10) : null,
  };
}

// The whole-universe scan, shared by the list reply and the push-alert route (api/notify.js).
// Returns { error: { code, error, hint } } when the universe cannot be loaded, otherwise the ranked calls and counts.
async function scanAll(nowSec, minRvol, rankBy = "auto") {
  let universe;
  try {
    universe = await getUniverse(FO_INDEX);
  } catch (e) {
    return { error: { code: 502, error: "Could not load the F&O universe.", hint: "Try again in a minute." } };
  }
  let industryOf = new Map();
  try {
    const n500 = await getUniverse("NIFTY 500");
    industryOf = new Map(n500.map((u) => [u.sym, u.industry]));
  } catch (e) {
    // The industry label is a convenience; the scan does not need it.
  }

  const fetched = await mapPool(universe, 16, async (u, i) => {
    try {
      const parsed = parseIdx(await yahooChart(u.sym + ".NS", i, "1mo", "5m"));
      return { bars: parsed.bars, ts: parsed.meta && parsed.meta.regularMarketTime };
    } catch (e) {
      return { failed: true };
    }
  });

  // One evaluation pass over the fetched bars with the chosen ranking metric.
  const pass = (mode) => {
    const skipped = {};
    const evaluated = [];
    let failed = 0;
    let newestTs = 0;
    for (let i = 0; i < universe.length; i++) {
      const f = fetched[i];
      if (!f || f.failed) {
        failed++;
        continue;
      }
      if (Number.isFinite(f.ts)) newestTs = Math.max(newestTs, f.ts);
      const out = evaluate(universe[i].sym, f.bars, nowSec, { rankBy: mode });
      if (!out.ok) {
        const k = reasonKey(out.skip);
        skipped[k] = (skipped[k] || 0) + 1;
        continue;
      }
      evaluated.push({ ...out.call, industry: industryOf.get(universe[i].sym) || null });
    }
    return { skipped, evaluated, failed, newestTs };
  };

  // "auto": the paper's volume rule, unless most of the universe cannot be evaluated because the 09:15 volume history is
  // missing; then every stock is ranked by first-candle range instead (never a mix of the two metrics in one list).
  let used = rankBy === "range" ? "range" : "volume";
  let r = pass(used);
  const volumeMissing = r.skipped["first-candle volume history missing"] || 0;
  if (rankBy === "auto" && volumeMissing > universe.length * 0.5) {
    used = "range";
    r = pass("range");
  }
  const { skipped, evaluated, failed, newestTs } = r;
  const ranked = rankCalls(evaluated, { minRvol });
  // With no evaluated stock (a feed problem) the session date still follows the newest bar so "live" is reported honestly.
  const newestDay = newestTs ? new Date((newestTs + 19800) * 1000).toISOString().slice(0, 10) : "";
  const sessionDate = evaluated.reduce((m, c) => (c.session > m ? c.session : m), "") || newestDay;
  const byStatus = {};
  for (const c of ranked) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  return { universe, evaluated, ranked, skipped, failed, newestTs, sessionDate, byStatus, rankBy: used };
}

module.exports = { istClock, reasonKey, feedMeta, scanAll };
