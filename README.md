# NSE Breakout Scanner

Zero-dependency Vercel app (Node 22, CommonJS serverless functions in `api/`, static pages in `public/`).

Pages: Trade Monitor (`/monitor.html`), Breakouts (`/`), Sector Scope (`/sector.html`), Live Calls (`/calls.html`), Skew Map (`/skew.html`), Ichimoku Cloud (`/ichimoku.html`), Index Options (`/indices.html`), Full Chart (`/chart.html`), Journal (`/journal.html`).
Trade Monitor (`/monitor.html`) is the single intraday alert inbox and review screen. It combines fresh index-option rulebook candidates, Stocks in Play opening-range-breakout plans and fills across every F&O stock, and F&O stock directional watches across every F&O sector, lists every fresh call (no cap), and plots the selected underlying with its levels. Stock watch scores do not have validated entries/stops/targets; the chart shows the last reference close and prior-session high/low. Alerts are opt-in browser notifications; stale or timestamp-missing prices are suppressed. The page must remain open on a running device for monitoring and notifications.
Architecture: `api/indices` supplies paper rule triggers with underlying entry/stop/target levels. `api/calls` supplies stock trend context without validated entry or risk levels. The monitor sends three kinds of notification: a rule-trigger alert with its underlying levels (index triggers, and Stocks in Play plans and fills, which carry a stop-order level and a stop loss), or a watch-only alert asking you to inspect a fresh stock context chart. The watch alert is not an entry signal or a strategy rating. Clicking either alert refreshes the feed and opens the chart only if the item remains fresh. The user makes the final decision. The separate Full Chart page (`/chart.html`) is for review and journaling only; its exploratory ORB setup does not send a second stream of alerts. Nothing is capped or hidden to keep the list short: you see every fresh call and decide which to take.
To use it, open `/monitor.html`, choose **Enable alerts**, and leave that page open in a running browser while you work. Each source (indices, Stocks in Play, stock watches) has its own baseline: notifications are sent only for items that appear after that source's first scan, preventing a startup burst. The *Alert me on* checkboxes (saved in the browser) silence a kind without hiding it; all are on by default. A burst of more than five stock alerts in one poll is sent as one summary notification; index triggers always go one by one.
Strategy ratings, research limits and reproducible studies are documented in `research/strategy-audit-2026-10-21.md`, `research/candlestick-2026-10-21/`, `research/candlestick-context-2026-10-21/`, `research/swing-cash-2026-10-21/`, and `research/index-rulebook-2026-10-21/`. Replay commands for the intraday candlestick studies use the cached `research/backtest-2026-10-20/data`; refresh the free 5-year daily cash-swing data with `node research/swing-cash-2026-10-21/fetch-daily.js`, or refresh the index rulebook sample with `node research/index-rulebook-2026-10-21/run-study.js --refresh`.
Full Chart adds a simple closed-bar ORB retest setup with entry, stop, T1/T2 and 1:2 R:R. It is separate from the backtested rulebook, is index-level only, and is journaled locally as an exploratory setup. The live call board suppresses triggers when the market is closed or an index quote is more than five minutes old.
Data: Yahoo Finance chart API. No API keys are needed, so there is nothing secret in this repo.

## Listing policy: what is shown, what is hidden
The point of the tool is to list every call so you can take the ones you like. Filters from the tested rulebooks therefore no longer hide a call; they annotate it.

- **Index rule triggers** (`/api/indices`, Index Options, Trade Monitor): every trigger that fired on a finished candle is listed as BUY CE / BUY PE. A failed filter of the tested rule (stop wider than the cap, expiry day, RSI band, trigger after the cutoff, ORB range-size band, choppy day, thin room to T1, unconfirmed VWAP structure) shows as a **caution** (`row.cautions`, the ⚠ tag, the monitor card). On a choppy ORB day the edge that broke last is followed.
- **Strict mode** restores the tested ruleset exactly (a failed filter becomes NO TRADE): `/api/indices?strict=1`, or the *Strict* checkbox on Index Options. **The Backtest tab and `lib/replay.js` always run strict**, so their numbers describe the tested rules only and a call with cautions is outside that sample.
- **Stock reads** (`/api/calls`, Live Calls, Trade Monitor): every one-sided read is listed, strong, then moderate, then weak (weak ranked last; use *Strong only* to cut). Option-chain quotes are fetched for the best-ranked 40 rows; the rest are listed without a quote. The Trade Monitor reads **every** F&O sector, not just the hottest eight: it splits the sectors into `/api/calls` requests that each stay inside the route's caps (8 sectors, 100 stocks) and merges the replies; only the first request (hottest sectors) asks NSE for option quotes (`&options=0` on the rest). Browser alerts fire for index triggers, Stocks in Play plans and fills, and every stock watch including weak reads (each switchable on the page).
- **No caps** on the Trade Monitor, Live Calls (Show defaults to All) or the Full Chart call desk.
- **Still not shown, because it is a fact rather than a preference:** a trigger more than 2 bars old (the entry reference would no longer be true), a setup already stopped out or with its structure broken, a stop on the wrong side of price, a VWAP rule on a feed with no volume, prices older than 5 minutes on the monitor, and everything while the market is closed.

Listing a call is not an endorsement of it. The saved research (`research/strategy-audit-2026-10-21.md`) found no net-positive rule; the cautions and tiers exist so you can see how much confirmation a call has.

## Stocks in Play (opening range breakout)
`lib/sip.js` (pure rule), `api/sip.js` (feed), the table on Live Calls and the section on the Trade Monitor. It is the rule of Zarattini, Barbon & Aziz, "A Profitable Day Trading Strategy For The U.S. Equity Market" (Swiss Finance Institute 24-98, 2024), adapted to NSE F&O stocks:

- **Relative volume** = the 09:15 five-minute candle's volume divided by the mean of the same candle over the last 14 full sessions. At 1.0x or more a stock is "in play". Every one is listed, ranked highest first; the paper trades the top 20 (marked *top 20*, not enforced). `?minRvol=0` also lists the names below 1.0x, flagged (the paper found them a slow loser).
- **Side** = the first candle's colour (a doji has no call). **Entry** = a stop order at its high (CE) or low (PE), with no retest. **Stop loss** = 10% of the 14-day ATR from the entry. **No target**; flat at 15:15 IST. Sizing at 1% risk per name is left to you (`riskPerShare` is exposed).
- **Honesty rules in code:** only closed candles are used; a gap through the level fills at the open; a gap through the stop fills at the open; entry and stop inside one candle is scored stop-first and flagged; a touch inside a forming candle is not shown, so PENDING can lag a real fill by up to five minutes. Each call shows its round-trip cost in R (`costR`).
- **Statuses:** PENDING (stop order not touched), OPEN, STOPPED, EXITED (flat at 15:15), NOT TRIGGERED. The Trade Monitor lists and alerts on PENDING plans (alert at 09:20 when the first candle closes) and OPEN fills; the finished ones are counted.
- `/api/sip?sym=RELIANCE` answers for one stock (its call or the reason it has none, plus the session's closed 5m bars). The chart pages use it.

**What is and is not known.** The paper is a US-equity study (2016-2023, 20 names a day, share trades, about 0.007% cost per side); the rule has **not been tested on NSE here** (the research cache and Yahoo are not reachable from the build sandbox), so nothing on it is a proven edge. The paper's edge per trade is small (about +0.08R above 1.0x). Costs are the open problem: at the repo's assumed 0.05% per side, a stop of 10% of ATR is typically 0.1-0.25% of price for an F&O stock (arithmetic from assumed ATRs of 1-2.5%, not a measurement), which puts the round-trip cost alone at roughly 0.4-1R before the trade moves, many times the paper's edge. An option's bid/ask spread can also be wider than that stop. The calls are listed because the person decides; a study script on the saved 5m cache is the next step to test it on NSE before sizing anything.

### Charts
Every stock chart (Live Calls, Sector Scope, Trade Monitor) carries the Stocks in Play overlay by default (`public/sip-overlay.js`): the stop-order level (teal), the stop loss (orange), the fill if it gapped through the level, entry and exit markers snapped onto that chart's own bars, and a chip with the status, relative volume and result in R. A stock with no call shows why ("doji first candle", "needs 15 earlier full sessions"). If the feed is down the chart still draws and the chip says the overlay is unavailable. Index charts do not get it: it is a stock rule, and the indices have their own ORB rulebook.

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
