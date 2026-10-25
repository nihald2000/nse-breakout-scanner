# Phone push alerts for Stocks in Play

`/api/notify` scans the F&O universe with the same rule as `/api/sip`, turns the result into alerts and pushes them to
Telegram and/or ntfy. It never places an order and picks no option contract (that is a later step).

| Alert | When |
|---|---|
| Shortlist | once, after the 09:15 candle closes: top 10 names by volume vs normal, with levels |
| Building | price is within a quarter of the stop distance of the entry level |
| Triggered | the entry level was touched; shows the stop and a chase limit (skip if already past it) |
| +1R | the trade is one stop distance in profit: move the stop to cost, trail the rest |
| Stopped | the stop loss was hit |
| Exit by 15:15 | reminder at 15:10 for anything still open |

Levels are the underlying share's, from closed 5-minute candles, so an alert can lag the live price by up to five
minutes. Check the option's spread and open interest and the F&O ban list on your broker first.

## Setup (once)

1. **Telegram:** talk to @BotFather, `/newbot`, copy the token. Send your bot any message, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`. (Or use **ntfy**: install the ntfy app and
   subscribe to a long random topic name.)
2. **Vercel project settings, Environment Variables** (for the environment you deploy to):
   - `NOTIFY_KEY`: a long random string; the timer sends it as a header
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and/or `NTFY_TOPIC` (optional `NTFY_SERVER`)
   - Recommended: a free Upstash Redis database; set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
     It stops the same alert being sent twice. Without it only events from the last 12 minutes are sent, so a late or
     missed timer tick can lose the 09:20 shortlist.
3. **Timer** (the free Vercel plan only runs a job once a day, so use an outside one such as cron-job.org):
   - URL `https://<your-domain>/api/notify`, header `x-notify-key: <NOTIFY_KEY>`
   - time zone Asia/Kolkata, Monday to Friday, every minute from 09:20 to 10:45, and once at 15:10
   - A preview deployment sits behind Vercel Authentication and will answer 401 to the timer; use the production
     domain, or add the project's protection-bypass header. Prefer the header to `?key=`, which can end up in logs.
4. **Test:** open `/api/notify?dry=1` with the header (any time): it shows what would be sent and sends nothing.

## Known limits

- Holidays: the route does nothing when the market is closed or the newest candle is over 10 minutes old, so it does not
  depend on the repo's holiday list.
- The scan uses Yahoo 5-minute data (about one month). If Yahoo's 09:15 volume is zero or missing, nothing is listed;
  `/api/sip?sym=RELIANCE&debug=1` shows how each session's first candle was read.
- Not tested on NSE. An alert is a rule firing, not an edge. Screening aid, not trading advice.
