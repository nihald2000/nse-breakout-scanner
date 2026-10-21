# NSE Breakout Scanner

Zero-dependency Vercel app (Node 22, CommonJS serverless functions in `api/`, static pages in `public/`).

Pages: Trade Monitor (`/monitor.html`), Breakouts (`/`), Sector Scope (`/sector.html`), Live Calls (`/calls.html`), Skew Map (`/skew.html`), Ichimoku Cloud (`/ichimoku.html`), Index Options (`/indices.html`), Full Chart (`/chart.html`), Journal (`/journal.html`).
Trade Monitor (`/monitor.html`) is the single intraday alert inbox and review screen. It combines fresh index-option rulebook candidates and F&O stock directional watches, caps the visible list at ten, and plots the selected underlying with its levels. Stock watch scores do not have validated entries/stops/targets; the chart shows the last reference close and prior-session high/low. Alerts are opt-in browser notifications; stale or timestamp-missing prices are suppressed. The page must remain open on a running device for monitoring and notifications.
Architecture: `api/indices` supplies rule triggers with underlying entry/stop/target levels; these are the only notification-eligible calls. `api/calls` supplies stock trend context in a separate, non-alerting watch section because its score has no validated trigger or risk levels. Selecting either item opens its underlying chart, where the user makes the final decision. The separate Full Chart page (`/chart.html`) is for review and journaling only; its exploratory ORB setup does not send a second stream of alerts. The list is capped at ten per section; ten is a display limit, not a daily trade target.
To use it, open `/monitor.html`, choose **Enable setup alerts**, and leave that page open in a running browser while you work. Alerts open only if the setup remains in the current fresh list. Clicking a watch opens its chart without sending a notification.
Strategy ratings, research limits and reproducible studies are documented in `research/strategy-audit-2026-10-21.md`, `research/candlestick-2026-10-21/`, `research/candlestick-context-2026-10-21/`, and `research/index-rulebook-2026-10-21/`. Replay commands for the candlestick studies use the cached `research/backtest-2026-10-20/data`; refresh the index rulebook snapshot from free Yahoo data with `node research/index-rulebook-2026-10-21/run-study.js --refresh`.
Full Chart adds a simple closed-bar ORB retest setup with entry, stop, T1/T2 and 1:2 R:R. It is separate from the backtested rulebook, is index-level only, and is journaled locally as an exploratory setup. The live call board suppresses triggers when the market is closed or an index quote is more than five minutes old.
Data: Yahoo Finance chart API. No API keys are needed, so there is nothing secret in this repo.

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
