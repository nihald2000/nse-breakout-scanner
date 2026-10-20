# Elliott Phase 1 - mechanical impulse scan

Descriptive only. This scan finds six-pivot ZigZag windows that fit the four hard impulse rules.
It does **not** measure forward returns, costs, option premiums or an edge, and it is **not a forecast**.

- Snapshot: 2026-10-20
- Universe: 213 F&O symbols from the cached snapshot
- Data: `research\backtest-2026-10-20\data`
- Bars: closed bars only, session-filtered by `engine.cleanBars`
- Pivots: confirmed only after the reverse threshold, so a label cannot use a future extreme
- Rules: W2 not a full retrace; W3 beyond W1; W4 outside W1; W3 not the shortest of 1/3/5
- A truncated fifth (W5 short of W3) is allowed and flagged; it is a guideline, not a hard rule

## Coverage

| timeframe | symbols with data | missing file | shorter than 30 bars | bar dates | bars min/median/max |
| --- | --- | --- | --- | --- | --- |
| 15m | 213 | 0 | 0 | 2026-07-24 to 2026-10-19 | 1471/1487/1499 |
| 1d | 213 | 0 | 0 | 2025-10-20 to 2026-10-19 | 245/246/246 |

## Counts by threshold

| timeframe | ZigZag | symbols with a valid count | valid windows | up | down | 3-of-4 near misses | all windows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 15m | 0.75% | 213 | 3496 | 117 | 96 | 12429 | 56211 |
| 15m | 1% | 213 | 2159 | 99 | 114 | 7278 | 32940 |
| 15m | 1.5% | 205 | 960 | 78 | 127 | 3209 | 14255 |
| 1d | 3% | 213 | 1358 | 67 | 146 | 5496 | 23805 |
| 1d | 5% | 186 | 532 | 86 | 100 | 1962 | 8440 |
| 1d | 8% | 88 | 121 | 38 | 50 | 505 | 2202 |

`valid windows` counts every six-pivot fit; a symbol can contribute more than one. `symbols with a valid count` counts each symbol once per threshold, and `up`/`down` split those symbols by the direction of their latest valid count. `near misses` fit three of the four hard rules.

These are **not independent observations**. A seven-pivot run contains two overlapping six-pivot windows, and every symbol with enough data has at least one valid window at the loose thresholds. The counts describe how often the mechanical definition is satisfied, not how often a trade worked.

## Latest valid counts (examples, not a ranked list)

`since end` is direction-adjusted: positive means price continued in the impulse's direction, negative means it retraced. `retrace` is the percentage of the impulse given back from its end.

### 15m

| symbol | industry | threshold | dir | from | to | last close | since end | retrace | W5 beyond W3 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ADANIPORTS | Services | 1% | up | 2026-10-16 | 2026-10-19 | 1766 | -0.83% | 30.64% | no (truncated) |
| 360ONE | Financial Services | 0.75% | down | 2026-10-16 | 2026-10-19 | 1055 | -1.13% | 35.44% | yes |
| 360ONE | Financial Services | 1% | down | 2026-10-16 | 2026-10-19 | 1055 | -1.05% | 30.81% | no (truncated) |
| ABB | Capital Goods | 1.5% | down | 2026-10-14 | 2026-10-19 | 6974 | -2.98% | 77.06% | no (truncated) |
| BAJAJ-AUTO | Automobile and Auto Components | 0.75% | up | 2026-10-16 | 2026-10-19 | 10287 | -1.94% | 87.88% | yes |
| BAJAJ-AUTO | Automobile and Auto Components | 1.5% | up | 2026-10-09 | 2026-10-19 | 10287 | -2.02% | 29.4% | yes |
| BANKBARODA | Financial Services | 0.75% | up | 2026-10-16 | 2026-10-19 | 238.2 | -0.16% | 3.55% | yes |
| BHARTIARTL | Telecommunication | 1% | up | 2026-10-15 | 2026-10-19 | 1875.2 | -2.82% | 55.45% | yes |
| BHARTIARTL | Telecommunication | 1.5% | up | 2026-10-12 | 2026-10-19 | 1875.2 | -2.82% | 31.81% | yes |
| BANKINDIA | Financial Services | 0.75% | up | 2026-10-15 | 2026-10-19 | 136.78 | 0.68% | 0% | yes |
| COFORGE | Information Technology | 0.75% | up | 2026-10-16 | 2026-10-19 | 1925 | -2.02% | 65.67% | yes |
| DIXON | Consumer Durables | 1% | down | 2026-10-16 | 2026-10-19 | 12100 | 1.46% | 0% | no (truncated) |
| DIXON | Consumer Durables | 1.5% | down | 2026-10-15 | 2026-10-19 | 12100 | 1.46% | 0% | no (truncated) |
| HDFCLIFE | Financial Services | 0.75% | up | 2026-10-16 | 2026-10-19 | 545.5 | -1.76% | 50.13% | yes |
| HDFCLIFE | Financial Services | 1% | up | 2026-10-16 | 2026-10-19 | 545.5 | -0.9% | 27.89% | no (truncated) |

### 1d

| symbol | industry | threshold | dir | from | to | last close | since end | retrace | W5 beyond W3 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FEDERALBNK | Financial Services | 8% | up | 2026-03-23 | 2026-10-19 | 348.85 | -1.87% | 6.51% | no (truncated) |
| TATAELXSI | Information Technology | 3% | up | 2026-10-08 | 2026-10-16 | 3790 | -1.68% | 7.55% | yes |
| HCLTECH | Information Technology | 3% | up | 2026-10-07 | 2026-10-15 | 1379.9 | 0.29% | 0% | yes |
| ICICIBANK | Financial Services | 3% | down | 2026-08-03 | 2026-10-15 | 1381 | -2.9% | 32.99% | no (truncated) |
| MUTHOOTFIN | Financial Services | 3% | down | 2026-09-21 | 2026-10-15 | 2566 | -0.83% | 6.38% | yes |
| NATIONALUM | Metals & Mining | 5% | down | 2026-09-09 | 2026-10-15 | 324.25 | -4.45% | 18.27% | no (truncated) |
| UPL | Chemicals | 3% | up | 2026-10-08 | 2026-10-15 | 530.35 | -3.51% | 26.37% | yes |
| ICICIGI | Financial Services | 3% | up | 2026-09-29 | 2026-10-14 | 1650 | -5.89% | 40.49% | yes |
| PERSISTENT | Information Technology | 3% | up | 2026-10-05 | 2026-10-14 | 5690 | -6.38% | 56.19% | yes |
| LUPIN | Healthcare | 3% | down | 2026-08-26 | 2026-10-14 | 1939.2 | -0.7% | 4.32% | yes |
| SUNPHARMA | Healthcare | 3% | down | 2026-08-31 | 2026-10-14 | 1758.8 | -1.93% | 12.84% | yes |
| BHARTIARTL | Telecommunication | 5% | down | 2026-08-05 | 2026-10-13 | 1875.2 | -6.78% | 43.3% | no (truncated) |
| CROMPTON | Consumer Durables | 5% | down | 2026-08-04 | 2026-10-13 | 208.45 | -3.55% | 10.25% | no (truncated) |
| HINDUNILVR | Fast Moving Consumer Goods | 3% | down | 2026-07-28 | 2026-10-13 | 1853.2 | -2.14% | 9.73% | yes |
| MARUTI | Automobile and Auto Components | 3% | down | 2026-08-03 | 2026-10-13 | 11475 | -3.15% | 10.56% | yes |

## What this does not show

- No forward returns, hit rate, expectancy, costs or option P&L: none of that is computed here.
- No stability test: the count is conditional on the chosen ZigZag threshold, and nearby thresholds can disagree.
- No correction (A-B-C), diagonal or multi-degree labelling. Phase 1 is impulse candidates only.
- No claim that a valid count predicts the next move. The four rules are a definition, not evidence.
- ZigZag runs continuously across sessions: an overnight gap counts as a price move and a pivot can span two sessions.
- Sample span: 15m 2026-07-24 to 2026-10-19; 1d 2025-10-20 to 2026-10-19. That is one market regime, and the universe is today's F&O list, so survivorship bias remains.

