# Strategy audit and live-call design (2026-10-21)

## Decision

Keep the existing signal engines as research/watch tools. Do not promote any current stock score or candlestick shape into an “ultimate” or proven trade strategy. The saved held-out research does not support that claim. The product should distinguish:

1. **Directional watch:** context score says CE-side or PE-side; no entry/stop/target implied.
2. **Rule trigger:** a closed-candle rule has fired and the chart can show its actual trigger, invalidation level, and targets.
3. **Paper outcome:** next executable bar open, underlying first-touch result, with ambiguous same-bar stop/target counted separately.

Only the first two may be shown in the monitor; neither is a promise of option P&L. Browser notifications require the monitor page to stay open and can be throttled while backgrounded.

## Existing project strategy review

| Module | What it does today | Assessment |
|---|---|---|
| Sector Scope / Live Calls (`lib/sector.js`, `api/calls.js`) | Votes across VWAP, VWAP slope, Ichimoku position, swing structure, opening range, ADX, range expansion and volume. “Strong/moderate” indicate vote agreement. Candle labels do not enter the vote. | Reasonable descriptive ranking; **no validated entry, stop, target or option expectancy**. Do not call it BUY CE/PE. Strategy evidence: **1/10**. |
| Candlestick labels (`patternAt`) | Heuristic engulfing, inside/outside, doji, hammer/star and marubozu shapes. No trend/location filter, confirmation, invalidation or position sizing. | Visualization only; a pattern name is not a strategy. Standalone strategy evidence: **1/10**. |
| Index rulebook (ORB, Ichimoku/Fib, VWAP) | Fixed, explicit rules with closed bars, stops, targets, expiry/volatility/size guards and chart levels. Yahoo has limited history; index volume is absent; option results use a Black–Scholes proxy. | Best structured paper candidates in the repo, but **not proven profitable**. Rule clarity: **6/10**; evidence for trading: **2/10**. |
| Swing Ichimoku / expiry max pain | Require Daily/4h or option-chain data; the current index backtest explicitly excludes them. | Not validated; do not display as proven live calls. |
| Full Chart ORB retest | Separate 5m index chart setup with entry, structural stop and 1R/2R targets. | Clear paper trigger; no net-positive holdout evidence in the saved ORB tests. |

Scores are evidence/readiness ratings for this repository, not a rating of the user's skill or financial suitability.

## Evidence in this repository

`research/backtest-2026-10-20/research2_livehelpers/research2_report.md` is a fixed discovery/validation replay across 39 sessions (2026-08-24 to 2026-10-19), 213 current F&O stocks, and 197,928 decision points. It tested the stock composite board, board caps/alignment, ORB variants, VWAP/trend and sector overlays. Of 1,076 eligible validation cells, zero had positive net expectancy at nominal p<0.05 and zero survived Benjamini–Hochberg correction at q<0.10. The sample was one falling-market regime and used an assumed 0.05% underlying cost per side. It did not model options, spreads, slippage, taxes or brokerage. Many decisions share the same session movement, so 197,928 is not an independent-trade sample.

The old stock replay assumed entry at the same candle close that created the signal. This was not executable after the candle-close decision. It now uses the next 15-minute bar open, records the entry time, and omits last-bar signals with no later fill. The old hard-coded `63.6%`/`52.3%` UI claims were removed; those were small/gross-of-costs and overstated what the test showed.

## Candlestick research synthesis

The empirical literature is mixed and market-specific:

- Marshall, Young & Rose’s DJIA study found candlestick rules did not create value under their tested methodology; later work reports results can depend on holding/exit definitions. [Marshall et al. (2006)](https://www.sciencedirect.com/science/article/pii/S0378426605002116), [Lui & Chong (2015)](https://www.sciencedirect.com/science/article/abs/pii/S0378426615002678).
- Studies have found selected patterns profitable in other datasets such as Taiwanese daily equities, while a Thai-market study found no single rule beat buy-and-hold after transaction costs and data-snooping correction. These results do not establish an NSE intraday or options edge. [Taiwan study](https://ideas.repec.org/a/eee/pacfin/v26y2014icp65-78.html), [Thailand study](https://journals.sagepub.com/doi/10.1177/2158244017736799).
- Lo, Mamaysky & Wang show that a systematic pattern-recognition method can test whether chart patterns add conditional information; their paper is not a license to treat named candle shapes as executable profitable rules. [Journal of Finance paper](https://www.mit.edu/~wangj/pap/LoMamayskyWang00.pdf).

Therefore, candle labels remain chart context. Any candidate pattern strategy needs a fixed definition, market regime/location, confirmation bar, next-bar fill, structural stop, time exit, realistic costs, a discovery/validation split, and a new untouched period. Pattern variants must be corrected for multiple testing.

## Live-call plan

1. Keep ten as a display cap, not a quota; return fewer or zero when no fresh candidate passes.
2. A stock directional score can raise a **WATCH CE SIDE / WATCH PE SIDE** notification. Show its last closed reference and actual prior-session high/low on the underlying chart. It must not invent an entry, stop, target, probability, or option return.
3. Promote a stock to a paper **setup** only after a separately specified trigger fires. Suggested research candidate: opening-range break/retest with relative volume and broad-market direction as context, followed by a confirmation close; keep candle shape descriptive. The saved sample did not validate ORB, so this remains an experiment.
4. Every paper call should record signal time, next-bar entry, invalidation, T1/T2, reason, spread/quote freshness, and an explicit stale/expired state. If stop/target are both touched in one candle, report ambiguous rather than a win.
5. Use underlying rules only to decide the directional thesis. Option contract selection, quote age, spread, liquidity, IV and theta are separate checks; with free public data and no historical option trades, do not claim backtested CE/PE P&L.
6. Keep alerts opt-in and paper-only. Current browser notifications need an open browser page; true delivery while the device/browser is closed needs a push/email service and credentials, which this free-data prototype does not provide.

## Changes in this audit

- Stock calls are explicitly directional watches, not “BUY CE/PE” orders.
- Removed synthetic ±0.5% stock stop/target levels from call charts, cards, copy text and notifications. Prior-session high/low and last reference close are labeled as references.
- Repaired the candle replay fill assumption to next-bar open and removed the unsupported “evidence-backed / ranked #1” candlestick comment.
- Added OHLC validity checks so missing/impossible candle inputs do not create pattern labels.

## Next validation gate

Do not label a candidate strategy “live” until it has: a pre-registered rule and parameters; no-look-ahead replay; next-executable-bar fills; realistic costs/slippage; option-chain bid/ask and historical premium evidence for option P&L; day-clustered confidence intervals; correction for all tried variants; performance in multiple market regimes; and a prospective paper period with every alert logged, including missed/ignored alerts. A backtest that has only underlying moves remains an underlying filter test.
