# Candlestick strategy study — 2026-10-21

Data: cached NSE F&O universe, 213 usable symbols; 39 validated full sessions (2026-08-24 to 2026-10-19). Discovery: first 19 sessions. Validation: last 20 sessions from 2026-09-21.
Each named candle is tested as the only signal. Fixed rules: first eligible signal per symbol/pattern/session; closed 5m trigger; fill at next 5m open; stop at pattern extreme; skip if the underlying stop is wider than 1% of entry; target 1R or 2R; exit at stop, target, or last bar close; both touched in one bar is charged as the stop. Underlying cost assumption: 0.05% per side. Cluster confidence intervals group by trading day. Benjamini–Hochberg correction covers 16 pattern/target comparisons.

This is a fixed-rule screening study, not an options backtest. It does not model option premiums, spread, IV, theta, broker charges, taxes or slippage. The sample is short and recent; symbol membership is today's F&O list, so survivorship bias remains.

| Pattern | Target | Discovery n | Validation n | Target hit | Gross mean (R) | Net mean (R) | 95% day-cluster net CI | p(net ≤ 0) | BH q | Both bars (charged stop) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bullish engulfing | 1R | 3981 | 4195 | 45.6% | -0.086 | -0.675 | -0.780 to -0.570 | 1.000 | 1.000 | 132 |
| bullish engulfing | 2R | 3981 | 4195 | 30.2% | -0.066 | -0.655 | -0.804 to -0.506 | 1.000 | 1.000 | 49 |
| bearish engulfing | 1R | 4000 | 4191 | 50.0% | 0.000 | -0.625 | -0.711 to -0.539 | 1.000 | 1.000 | 135 |
| bearish engulfing | 2R | 4000 | 4191 | 35.7% | 0.098 | -0.527 | -0.659 to -0.395 | 1.000 | 1.000 | 50 |
| hammer | 1R | 3677 | 3858 | 45.3% | -0.094 | -1.021 | -1.140 to -0.902 | 1.000 | 1.000 | 256 |
| hammer | 2R | 3677 | 3858 | 32.0% | -0.041 | -0.968 | -1.115 to -0.820 | 1.000 | 1.000 | 96 |
| shooting star | 1R | 3669 | 3855 | 47.4% | -0.053 | -0.907 | -1.007 to -0.806 | 1.000 | 1.000 | 235 |
| shooting star | 2R | 3669 | 3855 | 34.2% | 0.032 | -0.822 | -0.940 to -0.703 | 1.000 | 1.000 | 100 |
| bull marubozu | 1R | 3408 | 3578 | 44.9% | -0.091 | -0.644 | -0.746 to -0.541 | 1.000 | 1.000 | 82 |
| bull marubozu | 2R | 3408 | 3578 | 28.3% | -0.093 | -0.646 | -0.786 to -0.506 | 1.000 | 1.000 | 31 |
| bear marubozu | 1R | 3667 | 3855 | 51.0% | 0.025 | -0.526 | -0.626 to -0.425 | 1.000 | 1.000 | 89 |
| bear marubozu | 2R | 3667 | 3855 | 34.8% | 0.095 | -0.456 | -0.619 to -0.292 | 1.000 | 1.000 | 28 |
| outside bar | 1R | 4047 | 4259 | 48.2% | -0.034 | -0.583 | -0.637 to -0.529 | 1.000 | 1.000 | 129 |
| outside bar | 2R | 4047 | 4259 | 32.8% | 0.017 | -0.532 | -0.605 to -0.460 | 1.000 | 1.000 | 50 |
| inside-breakout | 1R | 4047 | 4259 | 48.4% | -0.026 | -0.387 | -0.437 to -0.336 | 1.000 | 1.000 | 30 |
| inside-breakout | 2R | 4047 | 4259 | 31.0% | -0.019 | -0.380 | -0.450 to -0.310 | 1.000 | 1.000 | 7 |

## Interpretation guardrails

- A pattern is only a candle-shape definition. The study does not establish a profitable strategy or transferable edge.
- Named patterns overlap in time and stock; the per-day cluster interval addresses shared market days, while BH adjusts this fixed family of 16 comparisons.
- The validation period was held out from choosing the rule definitions, but this is still one market regime and not a fresh prospective test.
- Do not add a pattern to actionable Live Calls unless its validation net expectancy is positive, survives correction, has a sufficiently narrow day-cluster interval, and is separately validated on option data / prospective paper calls.
