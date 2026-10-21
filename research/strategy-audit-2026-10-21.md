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
| Candlestick labels (`patternAt`) | Heuristic engulfing, inside/outside, doji, hammer/star and marubozu shapes. No trend/location filter, confirmation, invalidation or position sizing. | Visualization only; a pattern name is not a strategy. Actionable strategy evidence: **0/10**; chart-context value: **1/10**. |
| Index rulebook (ORB, Ichimoku/Fib, VWAP) | Fixed, explicit rules with closed bars, stops, targets, expiry/size guards and chart levels. Yahoo has limited history; index volume is absent; option results use a Black–Scholes proxy. | Most structured paper candidates in the repo, but recent corrected results are net-negative. Rule clarity: **6/10**; evidence for a positive edge: **1/10**. |
| Swing Ichimoku / expiry max pain | Require Daily/4h or option-chain data; the current index backtest explicitly excludes them. | Not validated; do not display as proven live calls. |
| Full Chart ORB retest | Separate 5m index chart setup with entry, structural stop and 1R/2R targets. | Clear paper trigger; no net-positive holdout evidence in the saved ORB tests. |

Scores are evidence/readiness ratings for this repository, not a rating of the user's skill or financial suitability.

## Evidence in this repository

`research/backtest-2026-10-20/research2_livehelpers/research2_report.md` is a fixed discovery/validation replay across 39 sessions (2026-08-24 to 2026-10-19), 213 current F&O stocks, and 197,928 decision points. It tested the stock composite board, board caps/alignment, ORB variants, VWAP/trend and sector overlays. Of 1,076 eligible validation cells, zero had positive net expectancy at nominal p<0.05 and zero survived Benjamini–Hochberg correction at q<0.10. The sample was one falling-market regime and used an assumed 0.05% underlying cost per side. It did not model options, spreads, slippage, taxes or brokerage. Many decisions share the same session movement, so 197,928 is not an independent-trade sample.

The old stock replay assumed entry at the same candle close that created the signal. This was not executable after the candle-close decision. It now uses the next 15-minute bar open, records the entry time, and omits last-bar signals with no later fill. The old hard-coded `63.6%`/`52.3%` UI claims were removed; those were small/gross-of-costs and overstated what the test showed.

### Direct named-pattern replay

`research/candlestick-2026-10-21/report.md` adds a fixed named-pattern replay using the same 213-symbol/39-session cache. It tests engulfing, hammer, shooting star, marubozu, outside-bar, and a separately defined inside-bar breakout; one eligible signal per pattern/symbol/session; 5m closed-bar trigger; next 5m open fill; stop at the pattern extreme; 1R or 2R target; end-of-day time exit; stop-first for same-bar ambiguity; and a 1% underlying stop-width ceiling. Costs are the existing research assumption of 0.05% per side. It compares the first 19 discovery sessions with the last 20 validation sessions and adjusts 16 pattern/target p-values.

**None of the 16 validation rows is profitable net of the assumed underlying cost** (all one-sided p-values and BH q-values are 1.000). The better looking rows before costs still fail after costs: bearish engulfing at 2R has gross mean +0.098R but net mean -0.527R; bear marubozu at 2R has gross +0.095R but net -0.456R. The best net row is inside-bar breakout at 1R, -0.387R (95% day-cluster CI -0.437 to -0.336). These are underlying results, not option P&L. This small, falling-market sample is not enough to rule out every context-specific candle setup, but it gives no basis to promote one into actionable Live Calls.

### Context-aware replay

`research/candlestick-context-2026-10-21/report.md` extends the same cache with six fixed contexts: prior 60-minute EMA trend alignment, session VWAP side, opening-range breakout side, 60-minute trend plus 1.5× prior-bar relative volume, and local 12-bar extreme reversal, alongside shape-only controls. The rule still uses closed 5m signals, next 5m open, pattern-extreme stops, 1R/2R exits and a 1% underlying risk cap. It compares 8 shapes/strategies × 6 filters × 2 targets (96 validation configurations); the global BH family includes 672 pooled, direction, cost-stress, and market-regime comparisons.

**Zero of the 96 pooled validation configurations was net-positive** at the assumed 0.05% per-side underlying cost; zero had nominal p<0.05. The least-negative row was bearish marubozu + 60m trend + relative volume at 2R: gross +0.245R, net -0.209R, 95% day-cluster CI [-0.471, +0.053], p=0.944, global q=1.000. At 0.10% per-side cost it fell to -0.663R. No long/short direction or prior-Nifty regime slice produced a positive row. This is exploratory and uses the same held-out dates after prior pattern work, so it is not a fresh untouched validation. It supplies no strategy to promote into Live Calls.

The earlier broad component study independently tested the aggregate latest directional pattern on 15m decisions: 50.6% hit at ±0.5% (60% cost-adjusted break-even) and 51.1% at ±1.0% (55% break-even), with negative validation net expectancy in both cases. Adding an on-side pattern to the existing strong/moderate read also remained net negative.

### Corrected index-rule replay and Oct 21 session

`research/index-rulebook-2026-10-21/` stores a Yahoo snapshot and a replay of the five index rulebooks across 58 complete sessions (2026-07-29 to 2026-10-21). This replay fixes a material execution error: earlier stats entered at the trigger candle close, which is only known after that candle ends. The corrected replay enters at the next 5-minute bar open, skips gaps through the stop or T1 and skips fills that widen risk past the fixed rule cap. Published stop/target levels remain fixed, so a gap changes realized R. Same-bar stop/target remains pessimistic (stop first).

At an assumed 0.05% underlying cost per side (not an option cost estimate), the later-half validation sample was negative for every replayed rule/target: ORB breakout 1R net mean -0.749R (95% day-cluster CI [-1.091, -0.386]) and 2R -0.644R (CI [-1.086, -0.161]); Ichimoku 1R -1.491R (CI [-2.373, -0.669]) and 2R -1.346R (CI [-2.368, -0.357]). These results remain underlying-index outcomes, not options P&L.

The previous VIX rule blocked every BUY when the prior close was above the 60-session 60th percentile. Across this sample it removed 82 of 233 ORB breakout T1 outcomes and 25 of 83 Ichimoku outcomes. The VIX-gated ORB mean was worse (-1.474R) than without the gate (-1.211R); Ichimoku was effectively unchanged (-1.884R vs -1.888R). This does not validate a universal VIX veto. On Oct 21, with prior-close VIX 14.77 vs p60 12.21, the gate suppressed five next-open candidates: two early CE breakouts later hit stops and three PE-side index setups later reached their underlying targets. A single day cannot establish skill or profitable option trades, but it shows the hard block would have silenced all five sides indiscriminately.

The live rulebook now keeps VIX as an informational premium-cost caution, not a directional trigger blocker. The replay and Index Options page disclose next-open entry and skipped gap fills. No rule was promoted as profitable: both tested systems remain net-negative under the stated underlying-cost assumption, and no historical option premium/spread/IV evidence exists.

## Candlestick research synthesis

The empirical literature is mixed and market-specific:

- Marshall, Young & Rose’s DJIA study found candlestick rules did not create value under their tested methodology; later work reports results can depend on holding/exit definitions. [Marshall et al. (2006)](https://www.sciencedirect.com/science/article/pii/S0378426605002116), [Lui & Chong (2015)](https://www.sciencedirect.com/science/article/abs/pii/S0378426615002678).
- Studies have found selected patterns profitable in other datasets such as Taiwanese daily equities, while a Thai-market study found no single rule beat buy-and-hold after transaction costs and data-snooping correction. These results do not establish an NSE intraday or options edge. [Taiwan study](https://ideas.repec.org/a/eee/pacfin/v26y2014icp65-78.html), [Thailand study](https://journals.sagepub.com/doi/10.1177/2158244017736799).
- Lo, Mamaysky & Wang show that a systematic pattern-recognition method can test whether chart patterns add conditional information; their paper is not a license to treat named candle shapes as executable profitable rules. [Journal of Finance paper](https://www.mit.edu/~wangj/pap/LoMamayskyWang00.pdf).

Therefore, candle labels remain chart context. Any candidate pattern strategy needs a fixed definition, market regime/location, confirmation bar, next-bar fill, structural stop, time exit, realistic costs, a discovery/validation split, and a new untouched period. Pattern variants must be corrected for multiple testing.

## Live-call plan

1. Keep ten as a display cap, not a quota; return fewer or zero when no fresh candidate passes.
2. Only a current closed-candle rule trigger with explicit underlying entry, invalidation and targets may send a browser alert. Stock directional scores stay in a separate non-alerting **WATCH CE SIDE / WATCH PE SIDE** section, with their last close and prior-session high/low on the chart. Do not invent an entry, stop, target, probability, or option return.
3. Promote a stock to a paper **setup** only after a separately specified trigger fires. Suggested research candidate: opening-range break/retest with relative volume and broad-market direction as context, followed by a confirmation close; keep candle shape descriptive. The saved sample did not validate ORB, so this remains an experiment.
4. Every paper call should record signal time, next-bar entry, invalidation, T1/T2, reason, spread/quote freshness, and an explicit stale/expired state. If stop/target are both touched in one candle, report ambiguous rather than a win.
5. Use underlying rules only to decide the directional thesis. Option contract selection, quote age, spread, liquidity, IV and theta are separate checks; with free public data and no historical option trades, do not claim backtested CE/PE P&L.
6. Keep alerts opt-in and paper-only. An alert click refreshes the feed and opens the chart only while the rule trigger remains current; expired or invalidated setups are called out as no longer current. Browser notifications need an open browser page; true delivery while the device/browser is closed needs a push service, an intraday scheduler, and subscription storage, which this free-data prototype does not provide.

## Changes in this audit

- Stock calls are explicitly directional watches, not “BUY CE/PE” orders.
- Removed synthetic ±0.5% stock stop/target levels from call charts, cards, copy text and notifications. Prior-session high/low and last reference close are labeled as references.
- Added recent candle-shape context to stock watch cards and chart details without treating those shapes as triggers.
- Made the Trade Monitor chart-first workday screen: explicit index rule triggers are listed first and alone can notify; stock trend scores remain separate non-alerting context watches. Notifications re-check the current feed before opening an item.
- Removed browser notifications from the separate Live Calls stock-watch page; it now links users to the Trade Monitor for setup alerts.
- Repaired the candle replay fill assumption to next-bar open and removed the unsupported “evidence-backed / ranked #1” candlestick comment.
- Added OHLC validity checks so missing/impossible candle inputs do not create pattern labels.
- Added a reproducible, fixed-rule, next-bar-open study for named patterns; it does not silently feed a failed candidate into live calls.
- Added a second research-only replay of the same patterns with five context filters; none of the 96 held-out rows passed the cost-adjusted edge gate, so no new candle strategy was added to Live Calls.
- Corrected index rulebook replays from trigger-close entry to next-5-minute-open fills; gaps past the stop/T1 or risk cap no longer become trades.
- Replaced the unsupported blanket VIX BUY veto with a visible option-cost caution after a paired replay found no general improvement from that gate; exact evidence is in `research/index-rulebook-2026-10-21/`.

## Next validation gate

Do not label a candidate strategy “live” until it has: a pre-registered rule and parameters; no-look-ahead replay; next-executable-bar fills; realistic costs/slippage; option-chain bid/ask and historical premium evidence for option P&L; day-clustered confidence intervals; correction for all tried variants; performance in multiple market regimes; and a prospective paper period with every alert logged, including missed/ignored alerts. A backtest that has only underlying moves remains an underlying filter test.
