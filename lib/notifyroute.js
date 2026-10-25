// lib/notifyroute.js (served as /api/notify through a rewrite to /api/sip?mode=notify) - pushes Stocks in Play alerts to your phone (Telegram and/or ntfy).
//
// An outside timer calls this URL every minute or so on trading mornings (about 09:20-10:45 IST) and at 15:10:
//   GET /api/notify            header  x-notify-key: <NOTIFY_KEY>      (or ?key=, which can end up in logs)
//   GET /api/notify?dry=1      shows what would be sent, sends nothing, records nothing
//
// Each run: scan the F&O universe (the same code as /api/sip), turn the calls into events (lib/alerts.js), skip the ones
// already sent, send the rest. Nothing here places an order. Outside 09:15-15:35 IST on weekdays, or when the data is
// older than 10 minutes (a holiday, a feed problem), it does nothing and says why.
//
// Environment (Vercel project settings):  NOTIFY_KEY (required), a channel (see lib/notify.js), optional Upstash REST.

const crypto = require("node:crypto");
const sipscan = require("./sipscan");
const { SIP } = require("./sip");
const { ALERT, eventsFor } = require("./alerts");
const { channelsFrom, sendOne, kvFrom } = require("./notify");

const MAX_PER_RUN = 8;
const WINDOW_MIN = 12; // without a store: only events from the last this-many minutes are sent
const OPEN_MM = 555;
const CLOSE_MM = 935;

function safeEqual(a, b) {
  const h = (x) => crypto.createHash("sha256").update(String(x == null ? "" : x)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

module.exports = async function handler(req, res, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || fetch;
  res.setHeader("Cache-Control", "no-store");
  if (!env.NOTIFY_KEY) return res.status(503).json({ error: "Push alerts are not configured: set NOTIFY_KEY in the project settings." });
  const q = (req && req.query) || {};
  const got = (req && req.headers && req.headers["x-notify-key"]) || q.key;
  if (!safeEqual(got, env.NOTIFY_KEY)) return res.status(401).json({ error: "Not authorised." });

  const dry = q.dry != null && String(q.dry) !== "" && String(q.dry) !== "0";
  const nowSec = Math.floor(Date.now() / 1000);
  const clock = sipscan.istClock(nowSec);
  const weekday = new Date((nowSec + 19800) * 1000).getUTCDay();
  if (weekday === 0 || weekday === 6 || clock.mm < OPEN_MM || clock.mm > CLOSE_MM) {
    return res.status(200).json({ skipped: "outside market hours", istDate: clock.iso, istMinute: clock.mm });
  }

  const channels = channelsFrom(env);
  if (!dry && !channels.length) return res.status(503).json({ error: "No alert channel is configured: set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, or NTFY_TOPIC." });

  const scan = await sipscan.scanAll(nowSec, SIP.minRvol);
  if (scan.error) return res.status(scan.error.code).json({ error: scan.error.error, hint: scan.error.hint });
  const meta = sipscan.feedMeta(scan.sessionDate, scan.newestTs, nowSec);
  const fresh = meta.lagMin != null && meta.lagMin <= ALERT.staleMin;
  if (!meta.marketOpen || !fresh) {
    return res.status(200).json({ skipped: "market not live or data stale", sessionDate: meta.sessionDate, asOf: meta.asOf, lagMin: meta.lagMin, marketOpen: meta.marketOpen, evaluated: scan.evaluated.length, skippedReasons: scan.skipped });
  }

  const events = eventsFor(scan.ranked, { marketOpen: meta.marketOpen, fresh, nowMM: clock.mm, sessionDate: scan.sessionDate });
  const kv = deps.kv !== undefined ? deps.kv : kvFrom(env, fetchImpl);
  const mode = kv ? "store" : "window";
  const report = { sessionDate: meta.sessionDate, asOf: meta.asOf, lagMin: meta.lagMin, evaluated: scan.evaluated.length, candidates: events.length, dedupe: mode, channels, sent: [], skipped: [], errors: [] };
  if (!scan.evaluated.length) {
    report.note = "No stock could be evaluated; see skippedReasons.";
    report.skippedReasons = scan.skipped;
  }

  if (dry) {
    report.dry = true;
    report.events = events.map((e) => ({ id: e.id, kind: e.kind, atMM: e.atMM, title: e.title, text: e.text }));
    return res.status(200).json(report);
  }

  let budget = MAX_PER_RUN;
  for (const ev of events) {
    if (budget <= 0) {
      report.skipped.push({ id: ev.id, why: "per-run limit; next run" });
      continue;
    }
    if (!kv && clock.mm - ev.atMM > WINDOW_MIN) {
      report.skipped.push({ id: ev.id, why: "older than the window" });
      continue;
    }
    let claimed = false;
    if (kv) {
      try {
        if (!(await kv.claim(ev.id))) {
          report.skipped.push({ id: ev.id, why: "already sent" });
          continue;
        }
        claimed = true;
      } catch (e) {
        report.errors.push("store: " + String((e && e.message) || e));
        report.skipped.push({ id: ev.id, why: "store unavailable; not sent to avoid duplicates" });
        continue;
      }
    }
    budget--;
    const results = await Promise.all(channels.map((c) => sendOne(c, ev, env, fetchImpl)));
    const okAny = results.some((r) => r.ok);
    for (const r of results) if (!r.ok) report.errors.push(r.error);
    if (okAny) report.sent.push(ev.id);
    else {
      report.skipped.push({ id: ev.id, why: "send failed" });
      if (claimed) await kv.release(ev.id).catch(() => {});
    }
  }
  return res.status(200).json(report);
};
