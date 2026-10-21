# Daily cash swing candlestick study — 2026-10-21

Data snapshot: 2026-10-21T14:22:21.828Z; 206 current F&O stocks, 1234 Nifty sessions, 2021-10-21 to 2026-10-19. Discovery 2022-01-03 to 2024-03-19; a 20-session purge separates validation (2024-04-23 to 2026-09-18).

This is long-only cash swing research. Bearish cash shorts are excluded because the user specified those as intraday only. It tests the repository's bullish engulfing, hammer, bull marubozu and bullish outside-bar definitions, plus a trend-pullback candidate: in a stock uptrend (SMA20>SMA50, close>SMA50), each of the prior three lows touches its then-current SMA20 and a bullish candle closes back above today's SMA20. Entry is the next NSE session open; candle stops use the signal low (four-bar lowest low for the pullback); target is 2R; stop width must be between 0.5% and 8% of entry; exit is at stop, target or after 5, 10 or 20 sessions. One trade per symbol/rule at a time. If stop and target fall inside the same daily bar, the result is charged as a stop. Signals without a complete forward horizon or next-session bar are omitted.

Candle patterns use four contexts: shape alone; stock uptrend; Nifty above SMA50; both trends. The SMA20 pullback is tested only with stock uptrend, and with/without the Nifty trend gate. The complete 54-test family is adjusted using Benjamini–Hochberg. Confidence intervals and one-sided p-values cluster by signal day. Base cost is 0.05% per side; stress is 0.10% per side. These are assumed underlying-share costs, not broker-specific estimates. The matched buy-and-hold column is the forward 5/10/20-session close return on the same entries, without the stop/target exit.

Limitations: the universe is current F&O membership (survivorship bias); Yahoo OHLC is adjusted using its adjusted-close ratio; there are no delisted names, historical F&O membership, dividend cash flows, event filters, exact taxes/brokerage/impact costs or live fills. A positive row would still be a candidate for prospective paper testing, never immediate proof. The validation period is still one market path.

## Validation results

| Pattern | Context | Max hold | Trades | Win rate | Gross mean R | Net mean R | Net % | Matched hold % | Day-cluster 95% CI | P(net ≤ 0) | BH q | Net R at 0.10%/side |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sma20 pullback reclaim | stock_uptrend | 10 | 1987 | 42.0% | -0.014 | -0.041 | -0.172% | 0.003% | -0.108 to 0.026 | 0.887 | 1.000 | -0.068 |
| sma20 pullback reclaim | stock_uptrend | 20 | 1774 | 38.1% | -0.015 | -0.042 | -0.134% | 0.698% | -0.119 to 0.036 | 0.855 | 1.000 | -0.068 |
| sma20 pullback reclaim | stock_uptrend | 5 | 2218 | 44.0% | -0.027 | -0.055 | -0.177% | -0.033% | -0.114 to 0.004 | 0.966 | 1.000 | -0.083 |
| sma20 pullback reclaim | both_uptrends | 10 | 1448 | 40.4% | -0.034 | -0.062 | -0.346% | -0.019% | -0.142 to 0.018 | 0.937 | 1.000 | -0.090 |
| sma20 pullback reclaim | both_uptrends | 20 | 1302 | 36.8% | -0.039 | -0.067 | -0.327% | 0.969% | -0.160 to 0.027 | 0.920 | 1.000 | -0.094 |
| sma20 pullback reclaim | both_uptrends | 5 | 1592 | 42.7% | -0.041 | -0.070 | -0.293% | -0.094% | -0.140 to 0.001 | 0.973 | 1.000 | -0.098 |
| hammer | stock_uptrend | 5 | 1533 | 37.0% | -0.022 | -0.083 | -0.030% | -0.123% | -0.174 to 0.008 | 0.963 | 1.000 | -0.144 |
| hammer | stock_uptrend | 20 | 1502 | 33.4% | -0.030 | -0.090 | -0.033% | 0.045% | -0.185 to 0.004 | 0.969 | 1.000 | -0.151 |
| bull marubozu | shape_only | 5 | 916 | 42.4% | -0.056 | -0.091 | -0.163% | 0.031% | -0.183 to 0.002 | 0.973 | 1.000 | -0.125 |
| bullish engulfing | both_uptrends | 20 | 1200 | 33.8% | -0.046 | -0.096 | -0.132% | 1.216% | -0.199 to 0.006 | 0.968 | 1.000 | -0.147 |
| bull marubozu | shape_only | 10 | 902 | 38.6% | -0.068 | -0.102 | -0.163% | 0.252% | -0.206 to 0.002 | 0.973 | 1.000 | -0.137 |
| bullish engulfing | stock_uptrend | 5 | 1865 | 39.3% | -0.055 | -0.102 | -0.193% | 0.003% | -0.185 to -0.020 | 0.993 | 1.000 | -0.150 |
| hammer | both_uptrends | 5 | 1062 | 36.0% | -0.040 | -0.103 | -0.120% | -0.190% | -0.208 to 0.002 | 0.972 | 1.000 | -0.166 |
| hammer | stock_uptrend | 10 | 1515 | 34.0% | -0.042 | -0.103 | -0.095% | -0.009% | -0.194 to -0.011 | 0.986 | 1.000 | -0.164 |
| bullish engulfing | stock_uptrend | 20 | 1726 | 33.5% | -0.055 | -0.103 | -0.169% | 0.617% | -0.192 to -0.015 | 0.989 | 1.000 | -0.151 |
| bullish engulfing | both_uptrends | 5 | 1286 | 39.2% | -0.059 | -0.109 | -0.234% | 0.054% | -0.205 to -0.014 | 0.988 | 1.000 | -0.160 |
| hammer | both_uptrends | 20 | 1045 | 32.8% | -0.046 | -0.109 | -0.096% | 0.416% | -0.220 to 0.001 | 0.974 | 1.000 | -0.173 |
| bullish engulfing | both_uptrends | 10 | 1235 | 36.7% | -0.059 | -0.110 | -0.209% | 0.452% | -0.211 to -0.008 | 0.983 | 1.000 | -0.160 |
| bullish engulfing | stock_uptrend | 10 | 1782 | 36.3% | -0.062 | -0.110 | -0.203% | 0.214% | -0.196 to -0.023 | 0.994 | 1.000 | -0.158 |
| outside bar | stock_uptrend | 5 | 2388 | 38.7% | -0.069 | -0.115 | -0.291% | -0.119% | -0.188 to -0.042 | 0.999 | 1.000 | -0.160 |
| hammer | shape_only | 5 | 3379 | 36.0% | -0.058 | -0.118 | -0.091% | -0.096% | -0.203 to -0.032 | 0.996 | 1.000 | -0.178 |
| bull marubozu | stock_uptrend | 5 | 470 | 42.1% | -0.085 | -0.118 | -0.198% | 0.135% | -0.242 to 0.007 | 0.968 | 1.000 | -0.151 |
| bullish engulfing | shape_only | 5 | 3622 | 38.0% | -0.070 | -0.118 | -0.254% | -0.172% | -0.190 to -0.046 | 0.999 | 1.000 | -0.166 |
| outside bar | shape_only | 5 | 4632 | 38.1% | -0.074 | -0.121 | -0.260% | -0.183% | -0.191 to -0.051 | 1.000 | 1.000 | -0.167 |
| outside bar | stock_uptrend | 20 | 2157 | 33.1% | -0.078 | -0.123 | -0.358% | 0.404% | -0.206 to -0.041 | 0.998 | 1.000 | -0.168 |
| outside bar | both_uptrends | 20 | 1525 | 32.9% | -0.079 | -0.125 | -0.383% | 1.015% | -0.219 to -0.031 | 0.995 | 1.000 | -0.171 |
| hammer | shape_only | 20 | 3292 | 32.4% | -0.065 | -0.125 | -0.111% | 0.308% | -0.213 to -0.037 | 0.997 | 1.000 | -0.185 |
| outside bar | both_uptrends | 5 | 1652 | 38.3% | -0.079 | -0.125 | -0.356% | -0.107% | -0.209 to -0.042 | 0.998 | 1.000 | -0.172 |
| bull marubozu | stock_uptrend | 10 | 461 | 37.5% | -0.095 | -0.128 | -0.202% | 0.212% | -0.269 to 0.013 | 0.963 | 1.000 | -0.161 |
| bullish engulfing | shape_only | 10 | 3464 | 35.3% | -0.080 | -0.129 | -0.297% | 0.033% | -0.206 to -0.052 | 0.999 | 1.000 | -0.177 |
| hammer | shape_only | 10 | 3326 | 33.3% | -0.070 | -0.130 | -0.131% | 0.018% | -0.217 to -0.042 | 0.998 | 1.000 | -0.190 |
| outside bar | stock_uptrend | 10 | 2243 | 34.8% | -0.085 | -0.130 | -0.370% | 0.001% | -0.208 to -0.053 | 0.999 | 1.000 | -0.176 |
| outside bar | shape_only | 10 | 4388 | 34.7% | -0.087 | -0.134 | -0.312% | -0.115% | -0.211 to -0.056 | 1.000 | 1.000 | -0.180 |
| bull marubozu | market_uptrend | 10 | 529 | 36.9% | -0.098 | -0.134 | -0.250% | 0.259% | -0.268 to 0.001 | 0.974 | 1.000 | -0.169 |
| outside bar | shape_only | 20 | 4224 | 32.7% | -0.088 | -0.134 | -0.311% | 0.272% | -0.213 to -0.054 | 1.000 | 1.000 | -0.180 |
| hammer | both_uptrends | 10 | 1054 | 32.9% | -0.072 | -0.136 | -0.214% | 0.146% | -0.240 to -0.031 | 0.995 | 1.000 | -0.199 |
| bull marubozu | stock_uptrend | 20 | 453 | 34.4% | -0.105 | -0.137 | -0.222% | 0.702% | -0.288 to 0.013 | 0.963 | 1.000 | -0.170 |
| bullish engulfing | shape_only | 20 | 3351 | 32.5% | -0.091 | -0.139 | -0.312% | 0.370% | -0.216 to -0.061 | 1.000 | 1.000 | -0.187 |
| bull marubozu | shape_only | 20 | 885 | 34.0% | -0.109 | -0.143 | -0.363% | 0.270% | -0.253 to -0.034 | 0.995 | 1.000 | -0.178 |
| bull marubozu | market_uptrend | 5 | 541 | 40.1% | -0.110 | -0.146 | -0.313% | -0.033% | -0.265 to -0.026 | 0.991 | 1.000 | -0.181 |
| outside bar | both_uptrends | 10 | 1570 | 34.3% | -0.100 | -0.146 | -0.455% | 0.217% | -0.234 to -0.057 | 0.999 | 1.000 | -0.192 |
| bull marubozu | market_uptrend | 20 | 520 | 34.0% | -0.111 | -0.146 | -0.296% | 0.843% | -0.288 to -0.004 | 0.978 | 1.000 | -0.181 |
| bullish engulfing | market_uptrend | 5 | 2100 | 36.8% | -0.101 | -0.152 | -0.336% | -0.196% | -0.240 to -0.065 | 1.000 | 1.000 | -0.204 |
| bull marubozu | both_uptrends | 10 | 325 | 36.0% | -0.123 | -0.157 | -0.313% | 0.363% | -0.330 to 0.016 | 0.962 | 1.000 | -0.190 |
| bull marubozu | both_uptrends | 20 | 320 | 33.4% | -0.124 | -0.157 | -0.256% | 1.337% | -0.346 to 0.031 | 0.949 | 1.000 | -0.191 |
| outside bar | market_uptrend | 5 | 2671 | 36.4% | -0.118 | -0.166 | -0.418% | -0.270% | -0.247 to -0.085 | 1.000 | 1.000 | -0.215 |
| bullish engulfing | market_uptrend | 10 | 2026 | 34.2% | -0.121 | -0.173 | -0.405% | 0.027% | -0.271 to -0.075 | 1.000 | 1.000 | -0.225 |
| bull marubozu | both_uptrends | 5 | 334 | 39.8% | -0.140 | -0.173 | -0.423% | 0.088% | -0.325 to -0.022 | 0.987 | 1.000 | -0.207 |
| hammer | market_uptrend | 5 | 1896 | 33.7% | -0.109 | -0.174 | -0.229% | -0.333% | -0.267 to -0.081 | 1.000 | 1.000 | -0.239 |
| bullish engulfing | market_uptrend | 20 | 1967 | 31.2% | -0.129 | -0.181 | -0.390% | 0.654% | -0.280 to -0.082 | 1.000 | 1.000 | -0.232 |
| hammer | market_uptrend | 20 | 1860 | 30.6% | -0.119 | -0.184 | -0.247% | 0.074% | -0.280 to -0.088 | 1.000 | 1.000 | -0.249 |
| outside bar | market_uptrend | 20 | 2485 | 31.0% | -0.144 | -0.192 | -0.501% | 0.596% | -0.286 to -0.098 | 1.000 | 1.000 | -0.240 |
| hammer | market_uptrend | 10 | 1876 | 30.9% | -0.139 | -0.204 | -0.322% | -0.124% | -0.294 to -0.114 | 1.000 | 1.000 | -0.269 |
| outside bar | market_uptrend | 10 | 2564 | 32.3% | -0.156 | -0.204 | -0.558% | -0.115% | -0.293 to -0.115 | 1.000 | 1.000 | -0.252 |

Promotion gate: n ≥ 100, positive net expectancy, day-cluster 95% CI entirely above zero and BH q < 0.10. Passing rows: 0/54. The least-negative validation row is sma20 pullback reclaim + stock_uptrend, 10-session hold (n=1987, net -0.041R, 95% CI -0.108 to 0.026, q=1.000).

## Decision

No tested daily candle/context/holding rule passed the promotion gate. Do not add a daily candlestick BUY to Live Calls. Keep the current directional stock watch non-alerting; continue collecting data or obtain a longer, survivorship-aware history before deciding whether a swing rule is worth adding.

Reproduce from the frozen snapshot with `node research/swing-cash-2026-10-21/run-study.js`. Rebuild the frozen snapshot from the existing one-year cache with `node research/swing-cash-2026-10-21/run-study.js --freeze-cache`.
