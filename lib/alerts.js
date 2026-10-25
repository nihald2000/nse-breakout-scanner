// lib/alerts.js - turns the Stocks in Play (opening range breakout) calls into phone-alert events.
// Pure functions: no network, no storage, no clock of its own. api/notify.js supplies the data and the time.
//
// Events, in the order a trade moves:
//   shortlist : once after the first candle closes, the top names by 09:15 relative volume with their levels
//   building  : price is within a quarter of the stop distance of the entry level (time to open your broker)
//   triggered : the entry level was touched (a closed 5m candle shows it), with the chase limit
//   oneR      : the trade is at +1R (move the stop to cost, book some, trail the rest)
//   stopped   : the stop loss was hit
//   flat      : 15:10 reminder, the rule is flat at 15:15
//
// Nothing here places an order or picks an option. Every level is the underlying share's, from closed 5-minute
// candles that can lag the live price by up to five minutes. An alert says "this appeared", not "buy".

const ALERT = {
  watchN: 10, // how many of the ranked names are watched and listed
  buildFrac: 0.25, // "building" = within this fraction of the stop distance of the entry level
  chaseFrac: 0.5, // enter only while price is within this fraction of the stop distance past the level
  shortlistFromMM: 560, // 09:20 IST, the first candle has closed
  shortlistUntilMM: 690, // 11:30 IST, a shortlist later than this is not sent
  entryUntilMM: 870, // 14:30 IST, no building/triggered alerts after this (the rule itself warns about late triggers)
  flatMM: 910, // 15:10 IST
  staleMin: 10, // data older than this is not alerted on
};

const n2 = (v) => (Number.isFinite(v) ? Number(v).toFixed(2) : "n/a");
const hm = (mm) => String(Math.floor(mm / 60)).padStart(2, "0") + ":" + String(mm % 60).padStart(2, "0");
const sgn = (c) => (c.side === "long" ? 1 : -1);
const word = (c) => (c.side === "long" ? "above" : "below");
const rTxt = (r) => (Number.isFinite(r) ? (r >= 0 ? "+" : "") + r.toFixed(2) + "R" : "n/a");

const FOOT = "Underlying share levels from closed 5-minute candles (can lag up to 5 min). Check the option's spread and open interest and the F&O ban list on your broker, and place your own order.";

function watchList(calls, ctx, opts) {
  return (calls || []).filter((c) => c && c.inPlay && Number.isFinite(c.rank) && c.rank <= opts.watchN && c.session === ctx.sessionDate);
}

// Distance from the last close to the entry level, in the direction that still has to be travelled (negative = past it).
function toLevel(c) {
  return sgn(c) * (c.level - c.ltp);
}

function shortlistEvent(watch, ctx) {
  const lines = watch.map((c) => {
    const state = c.status === "PENDING" ? `${c.action} ${word(c)} ${n2(c.level)} · stop ${n2(c.plannedStop)}` : c.status === "OPEN" ? `${c.action} already triggered at ${n2(c.entry)} · stop ${n2(c.stop)}` : `${c.status.toLowerCase()}`;
    return `${c.rank}. ${c.sym} · ${state} · ${c.rvol.toFixed(1)}x volume`;
  });
  return {
    id: `${ctx.sessionDate}:shortlist`,
    kind: "shortlist",
    sym: null,
    atMM: ALERT.shortlistFromMM,
    priority: "default",
    title: `Stocks in Play - top ${watch.length} for ${ctx.sessionDate}`,
    text: `Top ${watch.length} by 09:15 volume vs normal (opening range breakout):\n${lines.join("\n")}\n\n${FOOT}`,
  };
}

function eventsFor(calls, ctx, opts = {}) {
  const o = { ...ALERT, ...opts };
  if (!ctx || !ctx.marketOpen || !ctx.fresh || !ctx.sessionDate || !Number.isFinite(ctx.nowMM)) return [];
  const watch = watchList(calls, ctx, o);
  const out = [];
  if (watch.length && ctx.nowMM >= o.shortlistFromMM && ctx.nowMM <= o.shortlistUntilMM) out.push(shortlistEvent(watch, ctx));

  for (const c of watch) {
    const base = { sym: c.sym, priority: "default" };
    const id = (k) => `${ctx.sessionDate}:${c.sym}:${k}`;
    const risk = c.riskPerShare;
    if (c.status === "PENDING" && ctx.nowMM <= o.entryUntilMM && Number.isFinite(c.ltp) && risk > 0 && toLevel(c) <= o.buildFrac * risk) {
      out.push({
        ...base,
        id: id("building"),
        kind: "building",
        atMM: c.ltpMM,
        title: `Building - ${c.sym}`,
        text: `BUILDING · ${c.sym} · ${c.action}\nOrder level ${n2(c.level)} (${word(c)}); last close ${n2(c.ltp)}, ${n2(Math.max(0, toLevel(c)))} away. Stop loss would be ${n2(c.plannedStop)} (risk ${n2(risk)} per share). ${c.rvol.toFixed(1)}x volume.\nOpen your broker and look at the option chain now.\n\n${FOOT}`,
      });
    }
    if (c.status === "OPEN" && c.entry != null) {
      if (c.entryMM != null && c.entryMM <= o.entryUntilMM + 5) {
        const past = sgn(c) * (c.ltp - c.entry); // how far price has run beyond the fill, in rupees
        const limit = c.entry + sgn(c) * o.chaseFrac * risk;
        const ok = past <= o.chaseFrac * risk;
        out.push({
          ...base,
          id: id("triggered"),
          kind: "triggered",
          atMM: c.entryMM,
          priority: "high",
          title: `Triggered - ${c.sym} ${c.action}`,
          text: `TRIGGERED · ${c.sym} · ${c.action}\nLevel ${n2(c.level)} touched at ${hm(c.entryMM)} (fill ${n2(c.entry)}). Stop loss ${n2(c.stop)} (risk ${n2(risk)} per share). Last close ${n2(c.ltp)} (${rTxt(c.r)}).\n${ok ? `Chase limit ${n2(limit)}: enter only while the share is ${c.side === "long" ? "at or below" : "at or above"} it.` : `TOO LATE: price is already past the chase limit ${n2(limit)} (${n2(past / risk)} stop distances beyond the fill). Skip this one.`}\n\n${FOOT}`,
        });
      }
      if (Number.isFinite(c.r) && c.r >= 1) {
        out.push({
          ...base,
          id: id("oneR"),
          kind: "oneR",
          atMM: c.ltpMM,
          priority: "high",
          title: `+1R - ${c.sym}`,
          text: `+1R · ${c.sym} · ${c.action}\nLast close ${n2(c.ltp)} is ${rTxt(c.r)} from the fill ${n2(c.entry)}. If you are in this trade: move your stop to cost, consider booking part, and trail the rest. No fixed target; the rule is flat at 15:15.`,
        });
      }
      if (ctx.nowMM >= o.flatMM) {
        out.push({
          ...base,
          id: id("flat"),
          kind: "flat",
          atMM: o.flatMM,
          priority: "high",
          title: `Exit by 15:15 - ${c.sym}`,
          text: `EXIT BY 15:15 · ${c.sym} · ${c.action}\nStill open at ${n2(c.ltp)} (${rTxt(c.r)}). The rule is flat at 15:15 and brokers square off intraday positions soon after.`,
        });
      }
    }
    if (c.status === "STOPPED" && c.entry != null) {
      out.push({
        ...base,
        id: id("stopped"),
        kind: "stopped",
        atMM: c.exitMM,
        priority: "high",
        title: `Stopped - ${c.sym}`,
        text: `STOPPED · ${c.sym} · ${c.action}\nStop loss ${n2(c.stop)} was reached${c.exit != null ? ` (exit ${n2(c.exit)}, ${rTxt(c.r)})` : ""}. If you are in this trade, the plan says exit.${c.ambiguous ? " Entry and stop were inside one candle; treat as stopped." : ""}`,
      });
    }
  }
  const order = { triggered: 0, stopped: 1, oneR: 2, flat: 3, shortlist: 4, building: 5 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || (a.sym || "").localeCompare(b.sym || ""));
}

module.exports = { ALERT, eventsFor, toLevel };
