# NSE Breakout Scanner

Zero-dependency Vercel app (Node 22, CommonJS serverless functions in `api/`, static pages in `public/`).

Pages: Breakouts (`/`), Ichimoku Cloud (`/ichimoku.html`), Index Options (`/indices.html`), Full Chart (`/chart.html`), Journal (`/journal.html`).
Full Chart adds a simple closed-bar ORB retest setup with entry, stop, T1/T2 and 1:2 R:R. It is separate from the backtested rulebook, is index-level only, and its paper alerts are stored in this browser; it is not a server-side alert service.
Data: Yahoo Finance chart API. No API keys are needed, so there is nothing secret in this repo.

## Honesty rules
- Buy CE / buy PE only. Nothing here sells options. Screening aid, not trading advice, not proof of an edge.
- Rules use finished candles only (no look-ahead). Parameters are fixed in advance and are not tuned on the backtest.
- Index feeds carry no volume, so index VWAP is not available. The VWAP strategies show NO TRADE until a broker feed with volume is configured.
- Option P&L in the backtest is a Black-Scholes approximation using India VIX. It is not real premium data.

## Broker adapter (not configured)
`lib/broker.js` is the single plug-in point. All three functions throw `No broker adapter configured`:

- `fetchBars(symbol, interval, range)`: intraday bars with volume. With it, a true VWAP is possible and the backtest can ask for up to 2 years of 5m/15m data.
- `fetchOptionChain(underlying, expiry)`: open interest, needed by the expiry-day max-pain strategy.
- `fetchOptionPremium(...)`: historical option premiums, which would replace the Black-Scholes approximation.

Put broker credentials in Vercel environment variables. Never commit them.

## Deploy
Vercel project `nse-breakout-scanner`. Zero dependencies, nothing to build.
