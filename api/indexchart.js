// api/indexchart.js - 5-minute candles for one index and one session, with the rule levels drawn on the chart:
// opening range, session average price (VWAP when the feed has volume), previous close, and the signals the
// rules would have given during that session (replayed on finished candles only), with how each one played out.
// Strategy ids: orb_break, orb_retest, ichi, vwap_reclaim, vwap_pullback (ichi_swing and expiry_maxpain are not replayed).

const { istParts, sessionFraction, formatIST, indiaVix, vixState } = require("../lib/common");
const { _internals: I } = require("./indices");
const { fetchData, replayDay, sessionDates } = require("../lib/replay");
const { computeChartSetup } = require("../lib/chart_setup");

const { INDICES, P } = I;

module.exports = async function handler(req, res) {
  const key = String((req.query && req.query.index) || "NIFTY").toUpperCase();
  const ix = INDICES.find((x) => x.key === key);
  if (!ix) return res.status(400).json({ error: "Unknown index.", hint: INDICES.map((x) => x.key).join(", ") });

  const now = istParts();
  const nowSec = Math.floor(Date.now() / 1000);
  const marketOpen = sessionFraction(now) < 1;
  const [data, vixRaw] = await Promise.all([fetchData(ix, INDICES.indexOf(ix), false), indiaVix()]);
  if (data.error || !data.p5.bars.length) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Could not load prices for " + ix.name + ".", detail: String(data.error || "no bars").slice(0, 80) });
  }

  const b5 = data.p5.bars;
  const dates = sessionDates(b5);
  const want = String((req.query && req.query.date) || "");
  const date = dates.includes(want) ? want : dates[dates.length - 1];
  const day = b5.filter((b) => b.d === date);
  const isToday = date === dates[dates.length - 1] && date === now.iso && marketOpen;

  const hasVol = day.some((b) => b.vol > 0);
  let sv = 0;
  let sp = 0;
  const vwap = day.map((b, k) => {
    const tp = (b.hi + b.lo + b.cl) / 3;
    if (hasVol) {
      sp += tp * b.vol;
      sv += b.vol;
      return sv > 0 ? sp / sv : tp;
    }
    sp += tp;
    return sp / (k + 1);
  });

  const closedDay = isToday ? day.filter((b) => b.t + 300 <= nowSec) : day;
  const orBars = closedDay.filter((b) => b.mm >= P.orStart && b.mm < P.orEnd);
  const orb = orBars.length === 3 ? { hi: Math.max(...orBars.map((b) => b.hi)), lo: Math.min(...orBars.map((b) => b.lo)) } : null;
  const prev = [...b5].reverse().find((b) => b.d < date);

  // India VIX as known at the start of that session (previous close vs the 60 sessions before it).
  const vs = vixState(vixRaw, date, false);
  const rep = replayDay(ix, data, date, isToday ? nowSec : null, { vix: vs.ok ? vs : null });
  const setup = computeChartSetup(closedDay, { orb, vix: vs.ok ? vs : null, live: isToday });

  res.setHeader("Cache-Control", isToday ? "public, s-maxage=20, stale-while-revalidate=40" : "public, s-maxage=300");
  return res.status(200).json({
    index: ix.key,
    name: ix.name,
    date,
    dates: dates.slice(-5).reverse(),
    live: isToday,
    nowSec,
    asOf: formatIST(day[day.length - 1].t),
    sourceAsOfTs: Number.isFinite(data.p5.meta && data.p5.meta.regularMarketTime) ? data.p5.meta.regularMarketTime : null,
    vwapLabel: hasVol ? "VWAP" : "Session average price",
    vwapIsProxy: !hasVol,
    prevClose: prev ? prev.cl : null,
    expiry: !!rep.expiry,
    orb,
    bars: day.map((b) => ({ t: b.t, mm: b.mm, o: b.o, hi: b.hi, lo: b.lo, cl: b.cl })),
    vwap,
    signals: rep.signals,
    setup,
    blocked: rep.blocked || [],
    vix: vs.ok ? { value: vs.value, p60: vs.p60, blocked: vs.blocked } : { unavailable: vs.note },
    hasVolume: hasVol,
  });
};
