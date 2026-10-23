# NSE Breakout Scanner

Zero-dependency Vercel app (Node 22, CommonJS serverless functions in `api/`, static pages in `public/`).

Pages: Trade Monitor (`/monitor.html`), Breakouts (`/`), Sector Scope (`/sector.html`), Live Calls (`/calls.html`), Skew Map (`/skew.html`), Ichimoku Cloud (`/ichimoku.html`), Index Options (`/indices.html`), Full Chart (`/chart.html`), Journal (`/journal.html`).
Trade Monitor (`/monitor.html`) is the single intraday alert inbox and review screen. It combines fresh index-option rulebook candidates and F&O stock directional watches, lists every fresh call (no cap), and plots the selected underlying with its levels. Stock watch scores do not have validated entries/stops/targets; the chart shows the last reference close and prior-session high/low. Alerts are opt-in browser notifications; stale or timestamp-missing prices are suppressed. The page must remain open on a running device for monitoring and notifications.
Architecture: `api/indices` supplies paper rule triggers with underlying entry/stop/target levels. `api/calls` supplies stock trend context without validated entry or risk levels. The monitor can send two distinct kinds of notification: a rule-trigger alert with its underlying levels, or a watch-only alert asking you to inspect a fresh stock context chart. The watch alert is not an entry signal or a strategy rating. Clicking either alert refreshes the feed and opens the chart only if the item remains fresh. The user makes the final decision. The separate Full Chart page (`/chart.html`) is for review and journaling only; its exploratory ORB setup does not send a second stream of alerts. Nothing is capped or hidden to keep the list short: you see every fresh call and decide which to take.
To use it, open `/monitor.html`, choose **Enable setup and watch alerts**, and leave that page open in a running browser while you work. Notifications are sent only for items that appear after the initial baseline scan, preventing a startup burst of alerts.
Strategy ratings, research limits and reproducible studies are documented in `research/strategy-audit-2026-10-21.md`, `research/candlestick-2026-10-21/`, `research/candlestick-context-2026-10-21/`, `research/swing-cash-2026-10-21/`, and `research/index-rulebook-2026-10-21/`. Replay commands for the intraday candlestick studies use the cached `research/backtest-2026-10-20/data`; refresh the free 5-year daily cash-swing data with `node research/swing-cash-2026-10-21/fetch-daily.js`, or refresh the index rulebook sample with `node research/index-rulebook-2026-10-21/run-study.js --refresh`.
Full Chart adds a simple closed-bar ORB retest setup with entry, stop, T1/T2 and 1:2 R:R. It is separate from the backtested rulebook, is index-level only, and is journaled locally as an exploratory setup. The live call board suppresses triggers when the market is closed or an index quote is more than five minutes old.
Data: Yahoo Finance chart API. No API keys are needed, so there is nothing secret in this repo.

## Listing policy: what is shown, what is hidden
The point of the tool is to list every call so you can take the ones you like. Filters from the tested rulebooks therefore no longer hide a call; they annotate it.

- **Index rule triggers** (`/api/indices`, Index Options, Trade Monitor): every trigger that fired on a finished candle is listed as BUY CE / BUY PE. A failed filter of the tested rule (stop wider than the cap, expiry day, RSI band, trigger after the cutoff, ORB range-size band, choppy day, thin room to T1, unconfirmed VWAP structure) shows as a **caution** (`row.cautions`, the ⚠ tag, the monitor card). On a choppy ORB day the edge that broke last is followed.
- **Strict mode** restores the tested ruleset exactly (a failed filter becomes NO TRADE): `/api/indices?strict=1`, or the *Strict* checkbox on Index Options. **The Backtest tab and `lib/replay.js` always run strict**, so their numbers describe the tested rules only and a call with cautions is outside that sample.
- **Stock reads** (`/api/calls`, Live Calls, Trade Monitor): every one-sided read is listed, strong, then moderate, then weak (weak ranked last; use *Strong only* to cut). Option-chain quotes are fetched for the best-ranked 40 rows; the rest are listed without a quote. Browser alerts fire for index triggers and for strong/moderate stock watches, not for weak ones.
- **No caps** on the Trade Monitor, Live Calls (Show defaults to All) or the Full Chart call desk.
- **Still not shown, because it is a fact rather than a preference:** a trigger more than 2 bars old (the entry reference would no longer be true), a setup already stopped out or with its structure broken, a stop on the wrong side of price, a VWAP rule on a feed with no volume, prices older than 5 minutes on the monitor, and everything while the market is closed.

Listing a call is not an endorsement of it. The saved research (`research/strategy-audit-2026-10-21.md`) found no net-positive rule; the cautions and tiers exist so you can see how much confirmation a call has.

## Honesty rules
- Buy CE / buy PE only. Nothing here sells options. Screening aid, not trading advice, not proof of an edge.
- Rules use finished candles only (no look-ahead). Parameters are fixed in advance and are not tuned on the backtest.
- Index feeds carry no volume, so index VWAP is not available. The VWAP strategies show NO TRADE until a broker feed with volume is configured.
- Option P&L in the backtest is a Black-Scholes approximation using India VIX. It is not real premium data.
- India VIX is shown as an option-cost caution; it does not suppress a directional rule trigger because there is no historical premium evidence validating that veto.
- Trade Monitor polls while the page is open. Browser notifications can arrive with the tab in the background, but the browser/device must remain running. Vercel Hobby cron runs at most once per day, so it cannot deliver intraday alerts when the browser is closed. True unattended push requires a separate intraday scheduler and subscription storage; this free-data prototype does not provide those services.

## Broker adapter (not configured)
`lib/broker.js` is the single plug-in point. All three functions throw `No broker adapter configured`:

- `fetchBars(symbol, interval, range)`: intraday bars with volume. With it, a true VWAP is possible and the backtest can ask for up to 2 years of 5m/15m data.
- `fetchOptionChain(underlying, expiry)`: open interest, needed by the expiry-day max-pain strategy.
- `fetchOptionPremium(...)`: historical option premiums, which would replace the Black-Scholes approximation.

Put broker credentials in Vercel environment variables. Never commit them.

## Deploy
Vercel project `nse-breakout-scanner`. Zero dependencies, nothing to build.
