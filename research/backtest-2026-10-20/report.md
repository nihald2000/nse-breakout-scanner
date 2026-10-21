# Backtest of the Live Calls signal components

Data snapshot: **2026-10-20** | run: 2026-10-20T09:00:06.466Z | mode: `live` | cost assumption: **0.05% per side on the underlying** (0.10% round trip). Option premium, spread and IV are NOT modeled.

## 1. Answer first

**No edge in this sample.** No strategy beat break-even after costs in the validation half once the number of comparisons is respected.

- Sessions evaluated: **39** (2026-08-24 to 2026-10-19); discovery = first 19, validation = last 20. Signals inside one session share the market's move, so the effective sample is closer to 39 days than to the event counts; day-cluster intervals below account for that, "naive" Wilson intervals do not.
- 1:1 settings with at least 100 decidable validation signals: **1872**. Of those, hit-rate 95% day-cluster interval entirely above 50% (gross): **64** (about 47 expected by chance alone); net expectancy > 0 at p<0.05: **0**.
- Configurations tested: **3240** (30 strategies x 2 signal modes x 54 barrier/horizon/entry settings), each on discovery / validation / all. Of 2808 with enough validation signals, **0** are net-positive at nominal p<0.05 (about 140 would be expected by chance alone even with no edge; Benjamini-Hochberg q<0.10: **0**). Gross-positive at p<0.05: 87.
- Slices add 186 more cells (not included in the count above). Treat any single slice as a hypothesis generator.

### Walk-forward: the 10 best discovery configurations, judged only on the validation half

Selection rule (fixed before looking): signal mode = one entry per side-run, non-baseline strategies, at least 100 decidable signals in discovery, ranked by NET expectancy in the discovery half.

| strategy / setting | discovery: events/dec., net exp. % | validation: events/dec., hit %, break-even, net exp. % (CI), p | lead? |
|---|---|---|---|
| ONLY_1 - fixed 1.0/1.0; 12 bars (180m); entry next 5m open | 8926/2451, -0.083 | 9288/3370, 50.7% (day-cluster 46.4%-55.0%), BE 55.0%, -0.092 (-0.129 to -0.054), p=1.000 | no |
| ONLY_1 - fixed 1.0/0.5; 12 bars (180m); entry next 5m open | 8926/4720, -0.084 | 9288/5647, 27.1% (day-cluster 22.6%-31.5%), BE 40.0%, -0.085 (-0.123 to -0.046), p=1.000 | no |
| ONLY_1 - fixed 1.0/1.0; 12 bars (180m); entry bar close | 8926/2442, -0.085 | 9288/3379, 50.6% (day-cluster 46.3%-55.0%), BE 55.0%, -0.092 (-0.130 to -0.055), p=1.000 | no |
| ONLY_1 - fixed 1.0/0.5; 12 bars (180m); entry bar close | 8926/4712, -0.085 | 9288/5641, 27.2% (day-cluster 22.7%-31.7%), BE 40.0%, -0.084 (-0.123 to -0.045), p=1.000 | no |
| ONLY_0 - fixed 1.0/0.5; 12 bars (180m); entry next 5m open | 18421/10650, -0.088 | 19580/12762, 28.1% (day-cluster 25.0%-31.1%), BE 40.0%, -0.091 (-0.116 to -0.066), p=1.000 | no |
| TIER_WEAK - fixed 1.0/0.5; 12 bars (180m); entry bar close | 4671/2755, -0.089 | 4869/3238, 26.7% (day-cluster 23.1%-30.3%), BE 40.0%, -0.098 (-0.133 to -0.063), p=1.000 | no |
| ONLY_0 - fixed 1.0/0.5; 12 bars (180m); entry bar close | 18421/10665, -0.089 | 19580/12812, 28.0% (day-cluster 25.0%-31.0%), BE 40.0%, -0.093 (-0.118 to -0.067), p=1.000 | no |
| TIER_WEAK - fixed 1.0/0.5; 12 bars (180m); entry next 5m open | 4671/2753, -0.089 | 4869/3227, 26.9% (day-cluster 23.3%-30.5%), BE 40.0%, -0.097 (-0.131 to -0.063), p=1.000 | no |
| ONLY_3 - fixed 1.0/0.5; 12 bars (180m); entry bar close | 7935/4293, -0.089 | 8206/5081, 28.7% (day-cluster 22.7%-34.8%), BE 40.0%, -0.075 (-0.127 to -0.023), p=0.996 | no |
| ONLY_3 - fixed 1.0/0.5; 12 bars (180m); entry next 5m open | 7935/4297, -0.089 | 8206/5076, 28.8% (day-cluster 22.8%-34.8%), BE 40.0%, -0.075 (-0.126 to -0.023), p=0.996 | no |

A strategy chosen because it was best in discovery will look worse in validation by construction (regression to the mean). A "lead" needs: validation decidable >= 100, net expectancy > 0, and one-sided p < 0.05/10 (Bonferroni over the 10 picks).

## 2. Data and hygiene

- Universe: 213 symbols requested, **213 usable**, **0 missing/skipped** (list in `missing_symbols.json`). Missing data is skipped, never zero-filled.
- Sessions in the cache: 60; full sessions used for decisions: 51. Short or partial sessions excluded: none.
- NSE bhavcopy calendar validation: done. In Yahoo but not NSE: 2026-07-24, 2026-07-27, 2026-07-28, 2026-07-29, 2026-07-30, 2026-07-31, 2026-08-03, 2026-08-04, 2026-08-05. In NSE but missing from Yahoo: 2026-09-14, 2026-10-02.
- Corporate-action flags (decisions inside the 1-month window after one are dropped): none.
- Decisions built: **197928**. Skipped, by reason: day:not a full market session (holiday/half-day/partial) = 1917; day:history shorter than the live 1mo window = 2554; day:stock-day has too few bars (missing = skip, never zero) = 62.
- Sessions are IST 09:15-15:30 only; bars outside that window and duplicate timestamps are removed. Decisions are taken at every closed 15m bar from the one closing 09:30 up to the one closing 15:15, with the 5m series aligned to the same instant and no look-ahead (verified by a truncation test in `harness_check.js`).
- Yahoo limits intraday history to ~60 calendar days, and the live read needs a one-month window for Ichimoku/ADX/range baselines, so in `live` mode only the second month can be evaluated. That is why the sample is short.

## 3. Fidelity to production

The replay imports the same pure helpers from `lib/sector.js` and parses bars with the same `parseIdx`; the assembly in `computeRows()` is mirrored and checked by `parity.js` against the real `computeRows()` with Yahoo and the clock stubbed (see `parity.json` when produced from real data, and the self-test output for the synthetic proof).

**Parity on this run's data:** 200 stock-bars sampled, 7800 field comparisons, **0 mismatches** against the real computeRows().

Known differences, documented and not hidden:
1. Live uses `ltp` (regularMarketPrice) for the VWAP-position check; the replay uses the last closed 5m close. In the parity mutation test a 0.3% change in this one price flipped the lean counts on about a quarter of stock-bars, so this difference matters at the margin and is quantified with 1-minute data in `timing_1m.md` when that script has been run.
2. Live `today` (RVOL) and `rangeVsNormal` include the still-forming bar; the replay sees only closed bars.
3. Live asks Yahoo for `range=5d` / `range=1mo` at call time; the replay rebuilds those windows (last 5 sessions; bars from the same calendar day one month earlier) from the cache. The exact window Yahoo returns for `1mo` is an assumption.
4. `lib/candlebacktest.js` (the in-app journal replay) computes everything on 15m bars and uses all prior sessions for volume baselines, so it is a different, easier-to-pass read. This report does not use it.

## 4. Tiers and baselines (primary settings, one entry per side-run)

Primary settings were fixed before running: **P1** = fixed 0.5%/0.5%, 90m, next 5m open; **P2** = fixed 1.0%/1.0%, 90m, next 5m open. The baselines show what a signal-free or inverted rule does on the same bars; a signal only means something relative to them.

### P1: fixed 0.5%/0.5%, 90m, next 5m open

|  | events / decidable | hit % of decidable | break-even hit % (net) | gross exp. %/trade | NET exp. %/trade (95% day-cluster CI) | p (net exp. <= 0) |
|---|---|---|---|---|---|---|
| STRONG_MODERATE - discovery | 9852/5633 | 47.3% (naive 46.0%-48.6%; day-cluster 43.4%-51.1%) | 60.0% | -0.017 | -0.117 (-0.140 to -0.095) | 1.000 |
| STRONG_MODERATE - **validation** | 10096/6660 | 49.6% (naive 48.4%-50.8%; day-cluster 47.3%-51.8%) | 60.0% | -0.003 | -0.103 (-0.118 to -0.088) | 1.000 |
| TIER_STRONG - discovery | 5700/3237 | 47.0% (naive 45.3%-48.7%; day-cluster 41.5%-52.5%) | 60.0% | -0.021 | -0.121 (-0.155 to -0.087) | 1.000 |
| TIER_STRONG - **validation** | 5770/3749 | 50.2% (naive 48.6%-51.8%; day-cluster 44.6%-55.9%) | 60.0% | 0.004 | -0.096 (-0.136 to -0.057) | 1.000 |
| TIER_MODERATE - discovery | 11741/6540 | 48.3% (naive 47.0%-49.5%; day-cluster 44.9%-51.6%) | 60.0% | -0.011 | -0.111 (-0.130 to -0.091) | 1.000 |
| TIER_MODERATE - **validation** | 11921/7665 | 49.5% (naive 48.4%-50.6%; day-cluster 47.4%-51.6%) | 60.0% | -0.002 | -0.102 (-0.117 to -0.088) | 1.000 |
| TIER_WEAK - discovery | 4671/2862 | 50.6% (naive 48.8%-52.4%; day-cluster 46.7%-54.5%) | 60.0% | 0.004 | -0.096 (-0.120 to -0.072) | 1.000 |
| TIER_WEAK - **validation** | 4869/3367 | 48.1% (naive 46.4%-49.8%; day-cluster 45.2%-51.0%) | 60.0% | -0.012 | -0.112 (-0.132 to -0.092) | 1.000 |
| LEAN_ANY - discovery | 11540/6737 | 48.4% (naive 47.2%-49.6%; day-cluster 45.4%-51.4%) | 60.0% | -0.011 | -0.111 (-0.130 to -0.092) | 1.000 |
| LEAN_ANY - **validation** | 11794/7942 | 48.9% (naive 47.8%-50.0%; day-cluster 46.7%-51.1%) | 60.0% | -0.007 | -0.107 (-0.121 to -0.092) | 1.000 |
| BASE_LONG - discovery | 4047/3138 | 49.8% (naive 48.0%-51.5%; day-cluster 40.7%-58.9%) | 60.0% | -0.015 | -0.115 (-0.186 to -0.043) | 0.998 |
| BASE_LONG - **validation** | 4200/3625 | 52.9% (naive 51.3%-54.5%; day-cluster 43.4%-62.5%) | 60.0% | 0.022 | -0.078 (-0.163 to 0.006) | 0.966 |
| BASE_SHORT - discovery | 4047/3138 | 50.2% (naive 48.5%-52.0%; day-cluster 41.1%-59.3%) | 60.0% | 0.014 | -0.086 (-0.158 to -0.015) | 0.990 |
| BASE_SHORT - **validation** | 4200/3625 | 47.1% (naive 45.5%-48.7%; day-cluster 37.5%-56.6%) | 60.0% | -0.023 | -0.123 (-0.208 to -0.039) | 0.997 |
| BASE_RANDOM - discovery | 50186/27720 | 50.1% (naive 49.5%-50.7%; day-cluster 49.8%-50.5%) | 60.0% | 0.001 | -0.099 (-0.102 to -0.097) | 1.000 |
| BASE_RANDOM - **validation** | 52321/33222 | 49.7% (naive 49.2%-50.3%; day-cluster 49.3%-50.2%) | 60.0% | -0.001 | -0.101 (-0.104 to -0.098) | 1.000 |
| INVERSE_SM - discovery | 9852/5633 | 52.7% (naive 51.4%-54.0%; day-cluster 48.9%-56.6%) | 60.0% | 0.016 | -0.084 (-0.107 to -0.061) | 1.000 |
| INVERSE_SM - **validation** | 10096/6660 | 50.4% (naive 49.2%-51.6%; day-cluster 48.2%-52.7%) | 60.0% | 0.002 | -0.098 (-0.114 to -0.083) | 1.000 |

### P2: fixed 1.0%/1.0%, 90m, next 5m open

|  | events / decidable | hit % of decidable | break-even hit % (net) | gross exp. %/trade | NET exp. %/trade (95% day-cluster CI) | p (net exp. <= 0) |
|---|---|---|---|---|---|---|
| STRONG_MODERATE - discovery | 9852/1657 | 49.4% (naive 47.0%-51.8%; day-cluster 42.8%-55.9%) | 55.0% | -0.020 | -0.120 (-0.153 to -0.087) | 1.000 |
| STRONG_MODERATE - **validation** | 10096/2185 | 52.4% (naive 50.4%-54.5%; day-cluster 48.5%-56.4%) | 55.0% | 0.002 | -0.098 (-0.127 to -0.069) | 1.000 |
| TIER_STRONG - discovery | 5700/892 | 48.4% (naive 45.2%-51.7%; day-cluster 38.7%-58.2%) | 55.0% | -0.027 | -0.127 (-0.174 to -0.081) | 1.000 |
| TIER_STRONG - **validation** | 5770/1230 | 51.4% (naive 48.6%-54.2%; day-cluster 41.5%-61.2%) | 55.0% | 0.003 | -0.097 (-0.160 to -0.034) | 0.998 |
| TIER_MODERATE - discovery | 11741/1866 | 50.2% (naive 47.9%-52.5%; day-cluster 43.9%-56.6%) | 55.0% | -0.012 | -0.112 (-0.142 to -0.082) | 1.000 |
| TIER_MODERATE - **validation** | 11921/2459 | 51.8% (naive 49.8%-53.7%; day-cluster 48.0%-55.5%) | 55.0% | 0.004 | -0.096 (-0.121 to -0.071) | 1.000 |
| TIER_WEAK - discovery | 4671/823 | 52.7% (naive 49.3%-56.1%; day-cluster 47.1%-58.4%) | 55.0% | 0.003 | -0.097 (-0.131 to -0.063) | 1.000 |
| TIER_WEAK - **validation** | 4869/1091 | 52.2% (naive 49.2%-55.1%; day-cluster 47.2%-57.1%) | 55.0% | -0.007 | -0.107 (-0.138 to -0.076) | 1.000 |
| LEAN_ANY - discovery | 11540/1969 | 51.3% (naive 49.1%-53.5%; day-cluster 47.5%-55.1%) | 55.0% | -0.013 | -0.113 (-0.140 to -0.086) | 1.000 |
| LEAN_ANY - **validation** | 11794/2613 | 52.8% (naive 50.9%-54.7%; day-cluster 49.2%-56.5%) | 55.0% | -0.000 | -0.100 (-0.125 to -0.075) | 1.000 |
| BASE_LONG - discovery | 4047/1209 | 55.3% (naive 52.4%-58.0%; day-cluster 42.3%-68.2%) | 55.0% | -0.005 | -0.105 (-0.210 to -0.001) | 0.976 |
| BASE_LONG - **validation** | 4200/1594 | 61.3% (naive 58.9%-63.7%; day-cluster 49.3%-73.3%) | 55.0% | 0.071 | -0.029 (-0.161 to 0.102) | 0.678 |
| BASE_SHORT - discovery | 4047/1209 | 44.7% (naive 42.0%-47.6%; day-cluster 31.8%-57.7%) | 55.0% | 0.005 | -0.095 (-0.199 to 0.010) | 0.963 |
| BASE_SHORT - **validation** | 4200/1594 | 38.7% (naive 36.3%-41.1%; day-cluster 26.7%-50.7%) | 55.0% | -0.071 | -0.171 (-0.302 to -0.039) | 0.993 |
| BASE_RANDOM - discovery | 50186/7506 | 49.7% (naive 48.5%-50.8%; day-cluster 48.8%-50.5%) | 55.0% | -0.000 | -0.100 (-0.103 to -0.098) | 1.000 |
| BASE_RANDOM - **validation** | 52321/10524 | 49.9% (naive 48.9%-50.8%; day-cluster 49.2%-50.5%) | 55.0% | -0.001 | -0.101 (-0.104 to -0.097) | 1.000 |
| INVERSE_SM - discovery | 9852/1657 | 50.6% (naive 48.2%-53.0%; day-cluster 44.1%-57.2%) | 55.0% | 0.019 | -0.081 (-0.114 to -0.048) | 1.000 |
| INVERSE_SM - **validation** | 10096/2185 | 47.6% (naive 45.5%-49.6%; day-cluster 43.6%-51.5%) | 55.0% | -0.003 | -0.103 (-0.132 to -0.074) | 1.000 |


### How often does the board fire, and does that drift through the day?

| decision time (IST) | stock-bars | any side | strong | moderate | weak | volume-spike helper on | range >= 1.15x helper on | avg checks counted (of 6) |
|---|---|---|---|---|---|---|---|---|
| 09:30-10:15 | 32988 | 54.4% | 7.9% | 28.4% | 18.1% | 44.0% | 4.6% | 3.21 |
| 10:15-12:00 | 57729 | 86.4% | 38.2% | 39.3% | 8.9% | 80.0% | 10.8% | 4.97 |
| 12:00-14:00 | 65976 | 86.0% | 44.5% | 36.7% | 4.9% | 93.8% | 18.6% | 4.87 |
| 14:00-15:15 | 41235 | 87.0% | 48.3% | 34.0% | 4.7% | 97.0% | 26.0% | 4.88 |

The volume-spike helper is a running maximum over the day and the range helper compares a part-day range with full-day averages, so both can only become more likely as the session ages (see `CODE_REVIEW.md`, findings 4-6). If the strong/moderate share climbs through the day here, part of the tier is a clock effect, not a market one.

The same table for "every bar" (a signal counted at each bar it is on) is in `grid.csv`; those events overlap in time, so they are far less independent than the table above.

## 5. Ablation: which component adds anything?

Single checks use the check's side alone; leave-one-out applies the lean rule (agree >= 3 and >= 60%) to the other five checks. A component only 'adds' if removing it clearly lowers the result; where intervals overlap, the honest answer is that the data cannot separate them.

### P1: fixed 0.5%/0.5%, 90m, next 5m open - validation half

|  | events / decidable | hit % of decidable | break-even hit % (net) | gross exp. %/trade | NET exp. %/trade (95% day-cluster CI) | p (net exp. <= 0) |
|---|---|---|---|---|---|---|
| LEAN_ANY (all six checks) | 11794/7942 | 48.9% (naive 47.8%-50.0%; day-cluster 46.7%-51.1%) | 60.0% | -0.007 | -0.107 (-0.121 to -0.092) | 1.000 |
| without VWAP position (delta net 0.010, CIs overlap) | 8975/5845 | 50.0% (naive 48.7%-51.3%; day-cluster 47.6%-52.4%) | 60.0% | 0.003 | -0.097 (-0.114 to -0.080) | 1.000 |
| without VWAP slope (12 x 5m) (delta net 0.001, CIs overlap) | 11586/7787 | 49.1% (naive 48.0%-50.2%; day-cluster 46.9%-51.2%) | 60.0% | -0.006 | -0.106 (-0.120 to -0.091) | 1.000 |
| without Ichimoku above/below both lines (delta net 0.007, CIs overlap) | 9444/6171 | 49.7% (naive 48.4%-50.9%; day-cluster 46.9%-52.4%) | 60.0% | -0.000 | -0.100 (-0.119 to -0.081) | 1.000 |
| without 30m structure (delta net 0.001, CIs overlap) | 11924/7970 | 49.0% (naive 47.9%-50.1%; day-cluster 46.7%-51.2%) | 60.0% | -0.006 | -0.106 (-0.121 to -0.091) | 1.000 |
| without Opening-range break (delta net 0.002, CIs overlap) | 11979/7982 | 49.2% (naive 48.1%-50.3%; day-cluster 46.6%-51.7%) | 60.0% | -0.005 | -0.105 (-0.123 to -0.088) | 1.000 |
| without ADX(14) >= 18 DI side (delta net 0.009, CIs overlap) | 10564/6896 | 50.0% (naive 48.8%-51.2%; day-cluster 47.3%-52.8%) | 60.0% | 0.002 | -0.098 (-0.116 to -0.079) | 1.000 |
| only VWAP position | 19580/13473 | 49.7% (naive 48.9%-50.5%; day-cluster 46.8%-52.6%) | 60.0% | -0.003 | -0.103 (-0.123 to -0.084) | 1.000 |
| only VWAP slope (12 x 5m) | 9288/6001 | 49.9% (naive 48.6%-51.1%; day-cluster 46.4%-53.3%) | 60.0% | 0.000 | -0.100 (-0.123 to -0.076) | 1.000 |
| only Ichimoku above/below both lines | 14145/9408 | 50.3% (naive 49.3%-51.3%; day-cluster 47.4%-53.2%) | 60.0% | 0.002 | -0.098 (-0.119 to -0.077) | 1.000 |
| only 30m structure | 8206/5258 | 51.1% (naive 49.7%-52.4%; day-cluster 46.8%-55.4%) | 60.0% | 0.008 | -0.092 (-0.121 to -0.063) | 1.000 |
| only Opening-range break | 4011/3017 | 47.7% (naive 45.9%-49.4%; day-cluster 43.9%-51.4%) | 60.0% | -0.013 | -0.113 (-0.142 to -0.085) | 1.000 |
| only ADX(14) >= 18 DI side | 7874/5748 | 48.7% (naive 47.4%-50.0%; day-cluster 45.8%-51.5%) | 60.0% | -0.011 | -0.111 (-0.133 to -0.089) | 1.000 |
| Strong+moderate AND a candle pattern on-side | 15876/9902 | 51.3% (naive 50.3%-52.3%; day-cluster 47.7%-54.8%) | 60.0% | 0.009 | -0.091 (-0.115 to -0.067) | 1.000 |
| Strong+moderate AND running RVOL >= 1.5 | 2774/2067 | 47.9% (naive 45.7%-50.1%; day-cluster 45.4%-50.4%) | 60.0% | -0.016 | -0.116 (-0.136 to -0.097) | 1.000 |
| Strong+moderate AND prior-day delivery % above that day's median | 5022/3129 | 50.0% (naive 48.3%-51.8%; day-cluster 47.4%-52.7%) | 60.0% | 0.001 | -0.099 (-0.117 to -0.082) | 1.000 |
| Strong+moderate AND day change on the same side | 8460/5683 | 50.1% (naive 48.8%-51.4%; day-cluster 47.4%-52.8%) | 60.0% | 0.003 | -0.097 (-0.117 to -0.078) | 1.000 |
| Strong+moderate WITH the daily trend (close vs SMA20, prior day) | 5347/3455 | 51.6% (naive 49.9%-53.2%; day-cluster 47.0%-56.2%) | 60.0% | 0.009 | -0.091 (-0.123 to -0.060) | 1.000 |
| Strong+moderate WITH the 60m trend (close vs EMA20) | 8345/5494 | 49.8% (naive 48.5%-51.2%; day-cluster 47.1%-52.6%) | 60.0% | -0.001 | -0.101 (-0.121 to -0.081) | 1.000 |
| Strong+moderate WITH the Nifty daily trend | 5277/3416 | 53.5% (naive 51.9%-55.2%; day-cluster 47.8%-59.3%) | 60.0% | 0.025 | -0.075 (-0.116 to -0.034) | 0.999 |
| Candle pattern alone (latest directional pattern) | 39714/24921 | 50.6% (naive 49.9%-51.2%; day-cluster 49.4%-51.7%) | 60.0% | 0.002 | -0.098 (-0.105 to -0.090) | 1.000 |
| Day change alone (|chg| >= 0.5%) | 7730/5622 | 49.1% (naive 47.8%-50.4%; day-cluster 45.3%-52.9%) | 60.0% | -0.005 | -0.105 (-0.133 to -0.077) | 1.000 |

### P2: fixed 1.0%/1.0%, 90m, next 5m open - validation half

|  | events / decidable | hit % of decidable | break-even hit % (net) | gross exp. %/trade | NET exp. %/trade (95% day-cluster CI) | p (net exp. <= 0) |
|---|---|---|---|---|---|---|
| LEAN_ANY (all six checks) | 11794/2613 | 52.8% (naive 50.9%-54.7%; day-cluster 49.2%-56.5%) | 55.0% | -0.000 | -0.100 (-0.125 to -0.075) | 1.000 |
| without VWAP position (delta net 0.007, CIs overlap) | 8975/1839 | 52.0% (naive 49.7%-54.3%; day-cluster 47.8%-56.1%) | 55.0% | 0.006 | -0.094 (-0.125 to -0.062) | 1.000 |
| without VWAP slope (12 x 5m) (delta net -0.001, CIs overlap) | 11586/2581 | 52.2% (naive 50.2%-54.1%; day-cluster 48.7%-55.6%) | 55.0% | -0.001 | -0.101 (-0.126 to -0.076) | 1.000 |
| without Ichimoku above/below both lines (delta net 0.003, CIs overlap) | 9444/1926 | 51.9% (naive 49.7%-54.1%; day-cluster 48.1%-55.8%) | 55.0% | 0.003 | -0.097 (-0.129 to -0.065) | 1.000 |
| without 30m structure (delta net 0.002, CIs overlap) | 11924/2628 | 52.4% (naive 50.5%-54.3%; day-cluster 49.0%-55.8%) | 55.0% | 0.002 | -0.098 (-0.122 to -0.074) | 1.000 |
| without Opening-range break (delta net 0.001, CIs overlap) | 11979/2635 | 52.7% (naive 50.8%-54.6%; day-cluster 49.2%-56.3%) | 55.0% | 0.000 | -0.100 (-0.128 to -0.071) | 1.000 |
| without ADX(14) >= 18 DI side (delta net 0.010, CIs overlap) | 10564/2129 | 53.2% (naive 51.0%-55.3%; day-cluster 49.0%-57.3%) | 55.0% | 0.010 | -0.090 (-0.121 to -0.058) | 1.000 |
| only VWAP position | 19580/4677 | 51.8% (naive 50.4%-53.3%; day-cluster 48.2%-55.5%) | 55.0% | 0.002 | -0.098 (-0.122 to -0.073) | 1.000 |
| only VWAP slope (12 x 5m) | 9288/1831 | 52.4% (naive 50.1%-54.7%; day-cluster 46.0%-58.8%) | 55.0% | 0.004 | -0.096 (-0.137 to -0.055) | 1.000 |
| only Ichimoku above/below both lines | 14145/3145 | 53.3% (naive 51.5%-55.0%; day-cluster 49.7%-56.8%) | 55.0% | 0.009 | -0.091 (-0.120 to -0.063) | 1.000 |
| only 30m structure | 8206/1672 | 52.7% (naive 50.3%-55.1%; day-cluster 44.3%-61.1%) | 55.0% | 0.006 | -0.094 (-0.141 to -0.047) | 1.000 |
| only Opening-range break | 4011/1090 | 48.8% (naive 45.8%-51.8%; day-cluster 43.2%-54.4%) | 55.0% | -0.015 | -0.115 (-0.166 to -0.065) | 1.000 |
| only ADX(14) >= 18 DI side | 7874/2102 | 51.6% (naive 49.4%-53.7%; day-cluster 47.7%-55.4%) | 55.0% | -0.006 | -0.106 (-0.138 to -0.075) | 1.000 |
| Strong+moderate AND a candle pattern on-side | 15876/3034 | 54.4% (naive 52.6%-56.1%; day-cluster 49.8%-58.9%) | 55.0% | 0.020 | -0.080 (-0.117 to -0.043) | 1.000 |
| Strong+moderate AND running RVOL >= 1.5 | 2774/858 | 52.8% (naive 49.5%-56.1%; day-cluster 47.8%-57.8%) | 55.0% | -0.006 | -0.106 (-0.147 to -0.065) | 1.000 |
| Strong+moderate AND prior-day delivery % above that day's median | 5022/921 | 52.0% (naive 48.8%-55.2%; day-cluster 47.6%-56.5%) | 55.0% | 0.004 | -0.096 (-0.123 to -0.069) | 1.000 |
| Strong+moderate AND day change on the same side | 8460/1913 | 53.3% (naive 51.0%-55.5%; day-cluster 48.8%-57.7%) | 55.0% | 0.011 | -0.089 (-0.124 to -0.054) | 1.000 |
| Strong+moderate WITH the daily trend (close vs SMA20, prior day) | 5347/1137 | 53.6% (naive 50.7%-56.4%; day-cluster 46.2%-60.9%) | 55.0% | 0.023 | -0.077 (-0.130 to -0.025) | 0.997 |
| Strong+moderate WITH the 60m trend (close vs EMA20) | 8345/1874 | 53.3% (naive 51.0%-55.5%; day-cluster 48.8%-57.7%) | 55.0% | 0.008 | -0.092 (-0.128 to -0.056) | 1.000 |
| Strong+moderate WITH the Nifty daily trend | 5277/1101 | 55.0% (naive 52.0%-57.9%; day-cluster 44.8%-65.1%) | 55.0% | 0.042 | -0.058 (-0.128 to 0.013) | 0.948 |
| Candle pattern alone (latest directional pattern) | 39714/7708 | 51.1% (naive 49.9%-52.2%; day-cluster 49.9%-52.3%) | 55.0% | 0.003 | -0.097 (-0.104 to -0.090) | 1.000 |
| Day change alone (|chg| >= 0.5%) | 7730/2162 | 52.2% (naive 50.1%-54.3%; day-cluster 46.9%-57.4%) | 55.0% | 0.004 | -0.096 (-0.139 to -0.053) | 1.000 |

Display-only items (candle patterns, RVOL, delivery %, day change) are tested only as standalone rules and as filters on strong+moderate, never as tier attribution. Daily/60m/Nifty regime rows use only information known before the decision.

## 6. 1:1 settings after costs, validation half

Listing: run mode, 90m horizon, next-5m-open entry, strategies with enough validation signals, sorted by validation net expectancy (a descriptive listing, not a selection). All settings are in `grid.csv`.

|  | events / decidable | hit % of decidable | break-even hit % (net) | gross exp. %/trade | NET exp. %/trade (95% day-cluster CI) | p (net exp. <= 0) |
|---|---|---|---|---|---|---|
| SM_MKT - fixed 1.0/1.0 | 5277/1101 | 55.0% (naive 52.0%-57.9%; day-cluster 44.8%-65.1%) | 55.0% | 0.042 | -0.058 (-0.128 to 0.013) | 0.948 |
| SM_MKT - Kijun stop 1:1 | 4435/2474 | 55.3% (naive 53.3%-57.2%; day-cluster 49.9%-60.6%) | 57.5% | 0.040 | -0.060 (-0.123 to 0.002) | 0.971 |
| SM_PATTERN - Kijun stop 1:1 | 14220/6534 | 51.5% (naive 50.3%-52.7%; day-cluster 48.6%-54.4%) | 56.3% | 0.025 | -0.075 (-0.115 to -0.035) | 1.000 |
| SM_MKT - fixed 0.5/0.5 | 5277/3416 | 53.5% (naive 51.9%-55.2%; day-cluster 47.8%-59.3%) | 60.0% | 0.025 | -0.075 (-0.116 to -0.034) | 0.999 |
| SM_MKT - ATR 1.0x/1.0x | 5277/4016 | 53.8% (naive 52.2%-55.3%; day-cluster 49.0%-58.5%) | 61.3% | 0.024 | -0.076 (-0.113 to -0.040) | 1.000 |
| SM_DAILY - fixed 1.0/1.0 | 5347/1137 | 53.6% (naive 50.7%-56.4%; day-cluster 46.2%-60.9%) | 55.0% | 0.023 | -0.077 (-0.130 to -0.025) | 0.997 |
| SM_MKT - Kijun stop capped 0.5% 1:1 | 4435/3385 | 53.5% (naive 51.8%-55.2%; day-cluster 49.0%-58.0%) | 63.1% | 0.021 | -0.079 (-0.112 to -0.046) | 1.000 |
| SM_PATTERN - fixed 1.0/1.0 | 15876/3034 | 54.4% (naive 52.6%-56.1%; day-cluster 49.8%-58.9%) | 55.0% | 0.020 | -0.080 (-0.117 to -0.043) | 1.000 |
| PAT_ONLY - Kijun stop 1:1 | 20267/9697 | 50.9% (naive 49.9%-51.9%; day-cluster 48.3%-53.4%) | 56.6% | 0.019 | -0.081 (-0.118 to -0.043) | 1.000 |
| SM_DAILY - Kijun stop 1:1 | 4549/2492 | 53.1% (naive 51.1%-55.0%; day-cluster 49.0%-57.1%) | 57.3% | 0.015 | -0.085 (-0.134 to -0.036) | 0.999 |
| ONLY_3 - Kijun stop 1:1 | 6078/3108 | 52.3% (naive 50.5%-54.0%; day-cluster 47.5%-57.1%) | 56.9% | 0.014 | -0.086 (-0.150 to -0.023) | 0.995 |
| ONLY_1 - Kijun stop 1:1 | 7044/3355 | 51.6% (naive 49.9%-53.3%; day-cluster 47.1%-56.1%) | 56.7% | 0.013 | -0.087 (-0.144 to -0.029) | 0.997 |
| PAT_ONLY - Kijun stop capped 0.5% 1:1 | 20267/14539 | 51.3% (naive 50.5%-52.1%; day-cluster 47.9%-54.7%) | 62.6% | 0.011 | -0.089 (-0.114 to -0.064) | 1.000 |
| TIER_MODERATE - Kijun stop 1:1 | 10114/5713 | 51.4% (naive 50.1%-52.7%; day-cluster 48.8%-54.0%) | 57.8% | 0.011 | -0.089 (-0.118 to -0.060) | 1.000 |
| SM_DAYCHG - fixed 1.0/1.0 | 8460/1913 | 53.3% (naive 51.0%-55.5%; day-cluster 48.8%-57.7%) | 55.0% | 0.011 | -0.089 (-0.124 to -0.054) | 1.000 |
| SM_PATTERN - Kijun stop capped 0.5% 1:1 | 14220/10136 | 51.3% (naive 50.4%-52.3%; day-cluster 47.9%-54.8%) | 62.1% | 0.011 | -0.089 (-0.115 to -0.063) | 1.000 |
| LOO_5 - fixed 1.0/1.0 | 10564/2129 | 53.2% (naive 51.0%-55.3%; day-cluster 49.0%-57.3%) | 55.0% | 0.010 | -0.090 (-0.121 to -0.058) | 1.000 |
| ONLY_3 - Kijun stop capped 0.5% 1:1 | 6078/4533 | 51.2% (naive 49.7%-52.7%; day-cluster 46.0%-56.4%) | 62.5% | 0.010 | -0.090 (-0.128 to -0.052) | 1.000 |
| SM_DELIV - Kijun stop 1:1 | 4259/2410 | 51.2% (naive 49.2%-53.2%; day-cluster 48.0%-54.4%) | 58.1% | 0.010 | -0.090 (-0.120 to -0.060) | 1.000 |
| SM_PATTERN - fixed 0.5/0.5 | 15876/9902 | 51.3% (naive 50.3%-52.3%; day-cluster 47.7%-54.8%) | 60.0% | 0.009 | -0.091 (-0.115 to -0.067) | 1.000 |
| ONLY_2 - fixed 1.0/1.0 | 14145/3145 | 53.3% (naive 51.5%-55.0%; day-cluster 49.7%-56.8%) | 55.0% | 0.009 | -0.091 (-0.120 to -0.063) | 1.000 |
| SM_DAILY - fixed 0.5/0.5 | 5347/3455 | 51.6% (naive 49.9%-53.2%; day-cluster 47.0%-56.2%) | 60.0% | 0.009 | -0.091 (-0.123 to -0.060) | 1.000 |
| SM_60M - fixed 1.0/1.0 | 8345/1874 | 53.3% (naive 51.0%-55.5%; day-cluster 48.8%-57.7%) | 55.0% | 0.008 | -0.092 (-0.128 to -0.056) | 1.000 |
| ONLY_3 - fixed 0.5/0.5 | 8206/5258 | 51.1% (naive 49.7%-52.4%; day-cluster 46.8%-55.4%) | 60.0% | 0.008 | -0.092 (-0.121 to -0.063) | 1.000 |
| SM_DAYCHG - Kijun stop 1:1 | 7902/4059 | 52.2% (naive 50.7%-53.7%; day-cluster 49.5%-54.9%) | 56.8% | 0.008 | -0.092 (-0.127 to -0.057) | 1.000 |
| SM_DAILY - ATR 1.0x/1.0x | 5347/4081 | 52.1% (naive 50.6%-53.6%; day-cluster 48.2%-56.0%) | 61.4% | 0.008 | -0.092 (-0.121 to -0.064) | 1.000 |
| ONLY_1 - Kijun stop capped 0.5% 1:1 | 7044/5061 | 51.0% (naive 49.6%-52.4%; day-cluster 46.6%-55.4%) | 62.2% | 0.007 | -0.093 (-0.124 to -0.061) | 1.000 |
| ONLY_3 - fixed 1.0/1.0 | 8206/1672 | 52.7% (naive 50.3%-55.1%; day-cluster 44.3%-61.1%) | 55.0% | 0.006 | -0.094 (-0.141 to -0.047) | 1.000 |
| LOO_0 - fixed 1.0/1.0 | 8975/1839 | 52.0% (naive 49.7%-54.3%; day-cluster 47.8%-56.1%) | 55.0% | 0.006 | -0.094 (-0.125 to -0.062) | 1.000 |
| TIER_STRONG - Kijun stop 1:1 | 5508/2275 | 49.8% (naive 47.7%-51.9%; day-cluster 44.1%-55.5%) | 55.8% | 0.005 | -0.095 (-0.165 to -0.024) | 0.995 |
| ONLY_3 - ATR 1.0x/1.0x | 8206/6155 | 51.2% (naive 50.0%-52.5%; day-cluster 47.4%-55.0%) | 61.2% | 0.005 | -0.095 (-0.123 to -0.067) | 1.000 |
| SM_PATTERN - ATR 1.0x/1.0x | 15876/11931 | 51.1% (naive 50.2%-52.0%; day-cluster 48.1%-54.0%) | 61.5% | 0.005 | -0.095 (-0.115 to -0.075) | 1.000 |
| SM_60M - Kijun stop 1:1 | 7778/3841 | 51.5% (naive 49.9%-53.0%; day-cluster 48.5%-54.5%) | 56.6% | 0.005 | -0.095 (-0.132 to -0.058) | 1.000 |
| STRONG_MODERATE - Kijun stop 1:1 | 8521/4791 | 51.3% (naive 49.9%-52.7%; day-cluster 48.6%-54.0%) | 57.5% | 0.005 | -0.095 (-0.128 to -0.063) | 1.000 |
| TIER_STRONG - Kijun stop capped 0.5% 1:1 | 5508/3914 | 49.9% (naive 48.4%-51.5%; day-cluster 44.3%-55.5%) | 61.3% | 0.004 | -0.096 (-0.136 to -0.055) | 1.000 |
| TIER_MODERATE - fixed 1.0/1.0 | 11921/2459 | 51.8% (naive 49.8%-53.7%; day-cluster 48.0%-55.5%) | 55.0% | 0.004 | -0.096 (-0.121 to -0.071) | 1.000 |
| LOO_5 - Kijun stop 1:1 | 9208/5281 | 51.2% (naive 49.9%-52.5%; day-cluster 48.4%-54.0%) | 58.0% | 0.004 | -0.096 (-0.130 to -0.062) | 1.000 |
| SM_DELIV - fixed 1.0/1.0 | 5022/921 | 52.0% (naive 48.8%-55.2%; day-cluster 47.6%-56.5%) | 55.0% | 0.004 | -0.096 (-0.123 to -0.069) | 1.000 |
| DAYCHG_ONLY - fixed 1.0/1.0 | 7730/2162 | 52.2% (naive 50.1%-54.3%; day-cluster 46.9%-57.4%) | 55.0% | 0.004 | -0.096 (-0.139 to -0.053) | 1.000 |
| ONLY_1 - fixed 1.0/1.0 | 9288/1831 | 52.4% (naive 50.1%-54.7%; day-cluster 46.0%-58.8%) | 55.0% | 0.004 | -0.096 (-0.137 to -0.055) | 1.000 |

## 7. Slices (primary settings; validation and discovery side by side)

Cells with fewer than 100 decidable signals say "insufficient n". "All bars" = both sides at every decision in the slice, a signal-free reference. 186 slice cells were examined: expect several to look good or bad by chance.

### STRONG_MODERATE at P1 (fixed 0.5%/0.5%, 90m, next 5m open)

**tier (lean rule, any tier)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| moderate | 8900/5112 | 47.8% / -0.114 | 9167/6046 | 49.5% (47.3%-51.8%) / -0.103 | 50.0% / -0.100 |
| strong | 952/521 | 42.4% / -0.145 | 929/614 | 50.2% (44.5%-55.9%) / -0.102 | 50.0% / -0.100 |

**side**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| long / CE read | 4558/2699 | 47.8% / -0.123 | 4649/3164 | 45.1% (40.6%-49.6%) / -0.137 | 44.6% / -0.139 |
| short / PE read | 5294/2934 | 46.8% / -0.113 | 5447/3496 | 53.7% (47.9%-59.4%) / -0.074 | 55.4% / -0.062 |

**time of day (decision close)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| 09:30-10:15 | 3111/2251 | 45.5% / -0.134 | 3211/2551 | 46.3% (42.3%-50.3%) / -0.128 | 50.0% / -0.100 |
| 10:15-12:00 | 2882/1614 | 47.2% / -0.113 | 2921/1877 | 52.2% (48.4%-55.9%) / -0.081 | 50.0% / -0.100 |
| 12:00-14:00 | 2427/1179 | 50.6% / -0.102 | 2463/1556 | 52.1% (46.2%-57.9%) / -0.091 | 50.0% / -0.100 |
| 14:00-15:15 | 1432/589 | 47.4% / -0.115 | 1501/676 | 49.1% (38.7%-59.5%) / -0.113 | 50.0% / -0.101 |

**sector (NIFTY-500 industry)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| Automobile and Auto Components | 755/435 | 48.7% / -0.114 | 775/527 | 49.5% (43.3%-55.7%) / -0.108 | 50.0% / -0.100 |
| Capital Goods | 1089/713 | 49.6% / -0.102 | 1123/809 | 46.0% (40.9%-51.1%) / -0.132 | 50.0% / -0.100 |
| Chemicals | 260/134 | 42.5% / -0.147 | 266/170 | 46.5% (38.6%-54.4%) / -0.126 | 50.0% / -0.100 |
| Construction | 135/69 | insufficient n | 137/87 | insufficient n | 50.0% / -0.100 |
| Construction Materials | 192/79 | insufficient n | 184/122 | 51.6% (39.3%-63.9%) / -0.078 | 50.0% / -0.101 |
| Consumer Durables | 455/268 | 44.4% / -0.124 | 475/315 | 54.0% (46.7%-61.2%) / -0.080 | 50.0% / -0.100 |
| Consumer Services | 440/266 | 44.0% / -0.142 | 396/282 | 50.4% (42.8%-57.9%) / -0.104 | 50.0% / -0.100 |
| Fast Moving Consumer Goods | 624/275 | 54.5% / -0.083 | 640/358 | 52.0% (44.2%-59.8%) / -0.080 | 50.0% / -0.100 |
| Financial Services | 2631/1510 | 45.4% / -0.129 | 2672/1793 | 48.0% (44.1%-51.9%) / -0.114 | 50.0% / -0.101 |
| Healthcare | 749/405 | 47.2% / -0.118 | 771/485 | 52.8% (47.8%-57.8%) / -0.082 | 50.0% / -0.100 |
| Information Technology | 574/340 | 47.6% / -0.120 | 611/431 | 53.1% (47.2%-59.1%) / -0.074 | 50.0% / -0.100 |
| Metals & Mining | 441/289 | 49.8% / -0.092 | 460/287 | 48.8% (43.3%-54.2%) / -0.108 | 50.0% / -0.100 |
| Oil Gas & Consumable Fuels | 397/177 | 48.0% / -0.112 | 412/196 | 55.6% (47.4%-63.8%) / -0.070 | 50.0% / -0.100 |
| Other / no industry tag | 49/43 | insufficient n | 61/59 | insufficient n | 50.0% / -0.100 |
| Power | 364/206 | 46.6% / -0.118 | 390/257 | 48.2% (40.3%-56.2%) / -0.113 | 50.0% / -0.100 |
| Realty | 279/194 | 46.9% / -0.126 | 299/204 | 49.0% (41.9%-56.2%) / -0.109 | 50.0% / -0.100 |
| Services | 239/135 | 49.6% / -0.116 | 222/158 | 55.1% (46.6%-63.5%) / -0.051 | 50.0% / -0.100 |
| Telecommunication | 136/76 | insufficient n | 138/85 | insufficient n | 50.0% / -0.100 |
| Textiles | 43/19 | insufficient n | 64/35 | insufficient n | 50.0% / -0.100 |

**ADX bucket**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| <18 | 1732/796 | 49.0% / -0.105 | 1954/1128 | 52.8% (48.3%-57.4%) / -0.085 | 50.0% / -0.100 |
| >=35 | 1787/1179 | 47.1% / -0.116 | 1706/1243 | 49.9% (45.3%-54.5%) / -0.102 | 50.0% / -0.100 |
| 18-25 | 3475/1995 | 48.5% / -0.114 | 3645/2386 | 49.2% (46.4%-52.1%) / -0.104 | 50.0% / -0.100 |
| 25-35 | 2858/1663 | 45.2% / -0.130 | 2791/1903 | 47.9% (46.1%-49.6%) / -0.116 | 50.0% / -0.100 |

**day-range vs 20-session mean**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| <0.5x | 2524/1383 | 46.9% / -0.121 | 2600/1707 | 49.9% (46.9%-52.8%) / -0.096 | 50.0% / -0.100 |
| >=1.15x | 676/417 | 49.2% / -0.111 | 753/554 | 49.1% (43.9%-54.3%) / -0.119 | 50.0% / -0.101 |
| 0.5-0.85x | 5025/2849 | 47.4% / -0.115 | 5196/3371 | 50.5% (47.9%-53.0%) / -0.099 | 50.0% / -0.100 |
| 0.85-1.15x | 1627/984 | 46.6% / -0.123 | 1547/1028 | 46.5% (41.8%-51.2%) / -0.123 | 50.0% / -0.101 |

**running RVOL**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| <0.8 | 4219/2270 | 47.1% / -0.116 | 4280/2641 | 51.1% (47.1%-55.1%) / -0.091 | 50.0% / -0.100 |
| >=2 | 972/703 | 48.1% / -0.118 | 1124/868 | 47.6% (45.0%-50.2%) / -0.124 | 50.0% / -0.101 |
| 0.8-1.2 | 2672/1496 | 46.4% / -0.122 | 2605/1658 | 48.9% (45.9%-51.8%) / -0.112 | 50.0% / -0.100 |
| 1.2-2 | 1989/1164 | 48.2% / -0.114 | 2087/1493 | 48.8% (46.6%-51.1%) / -0.107 | 50.0% / -0.100 |

**daily trend (prior close vs SMA20)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| against the trend | 4780/2776 | 49.6% / -0.109 | 4746/3204 | 47.4% (44.3%-50.6%) / -0.117 | 47.8% / -0.115 |
| n/a | 0/0 | insufficient n | 3/1 | insufficient n | insufficient n |
| with the trend | 5072/2857 | 45.0% / -0.125 | 5347/3455 | 51.6% (47.0%-56.2%) / -0.091 | 52.2% / -0.085 |

**60m trend (close vs EMA20)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| against the trend | 3217/1747 | 53.1% / -0.082 | 3125/1959 | 49.2% (45.8%-52.6%) / -0.104 | 49.0% / -0.107 |
| with the trend | 6635/3886 | 44.7% / -0.135 | 6971/4701 | 49.7% (46.6%-52.8%) / -0.103 | 51.0% / -0.093 |

**Nifty daily trend**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| against the trend | 4558/2699 | 47.8% / -0.123 | 4819/3244 | 45.4% (40.8%-50.1%) / -0.134 | 46.2% / -0.126 |
| with the trend | 5294/2934 | 46.8% / -0.113 | 5277/3416 | 53.5% (47.8%-59.3%) / -0.075 | 53.8% / -0.074 |

### STRONG_MODERATE at P2 (fixed 1.0%/1.0%, 90m, next 5m open)

**tier (lean rule, any tier)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| moderate | 8900/1533 | 50.4% / -0.115 | 9167/1990 | 52.7% (48.7%-56.7%) / -0.096 | 50.0% / -0.100 |
| strong | 952/124 | 36.3% / -0.167 | 929/195 | 49.7% (40.1%-59.4%) / -0.111 | 50.0% / -0.100 |

**side**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| long / CE read | 4558/814 | 60.7% / -0.111 | 4649/1056 | 50.7% (43.9%-57.5%) / -0.149 | 47.4% / -0.150 |
| short / PE read | 5294/843 | 38.4% / -0.127 | 5447/1129 | 54.1% (43.8%-64.4%) / -0.054 | 52.6% / -0.050 |

**time of day (decision close)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| 09:30-10:15 | 3111/864 | 44.4% / -0.156 | 3211/1042 | 48.6% (43.0%-54.1%) / -0.132 | 50.0% / -0.100 |
| 10:15-12:00 | 2882/365 | 50.1% / -0.113 | 2921/543 | 55.1% (49.0%-61.1%) / -0.074 | 50.0% / -0.100 |
| 12:00-14:00 | 2427/267 | 58.1% / -0.090 | 2463/434 | 56.7% (45.8%-67.6%) / -0.083 | 50.0% / -0.100 |
| 14:00-15:15 | 1432/161 | 59.6% / -0.105 | 1501/166 | 57.2% (44.6%-69.8%) / -0.096 | 50.0% / -0.100 |

**sector (NIFTY-500 industry)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| Automobile and Auto Components | 755/115 | 58.3% / -0.103 | 775/168 | 57.7% (47.2%-68.2%) / -0.102 | 50.0% / -0.100 |
| Capital Goods | 1089/241 | 51.5% / -0.107 | 1123/284 | 52.5% (44.7%-60.2%) / -0.116 | 50.0% / -0.100 |
| Chemicals | 260/38 | insufficient n | 266/58 | insufficient n | 50.0% / -0.100 |
| Construction | 135/10 | insufficient n | 137/22 | insufficient n | 50.0% / -0.100 |
| Construction Materials | 192/20 | insufficient n | 184/30 | insufficient n | 50.0% / -0.100 |
| Consumer Durables | 455/95 | insufficient n | 475/110 | 60.9% (50.6%-71.2%) / -0.039 | 50.0% / -0.100 |
| Consumer Services | 440/78 | insufficient n | 396/100 | 44.0% (35.1%-52.9%) / -0.120 | 50.0% / -0.100 |
| Fast Moving Consumer Goods | 624/55 | insufficient n | 640/110 | 61.8% (53.6%-70.0%) / -0.068 | 50.0% / -0.100 |
| Financial Services | 2631/450 | 46.7% / -0.136 | 2672/618 | 47.9% (43.3%-52.5%) / -0.115 | 50.0% / -0.100 |
| Healthcare | 749/103 | 57.3% / -0.100 | 771/129 | 60.5% (48.7%-72.2%) / -0.074 | 50.0% / -0.100 |
| Information Technology | 574/103 | 47.6% / -0.123 | 611/140 | 48.6% (39.0%-58.2%) / -0.087 | 50.0% / -0.100 |
| Metals & Mining | 441/97 | insufficient n | 460/85 | insufficient n | 50.0% / -0.100 |
| Oil Gas & Consumable Fuels | 397/42 | insufficient n | 412/54 | insufficient n | 50.0% / -0.100 |
| Other / no industry tag | 49/21 | insufficient n | 61/29 | insufficient n | 50.0% / -0.100 |
| Power | 364/51 | insufficient n | 390/83 | insufficient n | 50.0% / -0.100 |
| Realty | 279/72 | insufficient n | 299/72 | insufficient n | 50.0% / -0.100 |
| Services | 239/36 | insufficient n | 222/51 | insufficient n | 50.0% / -0.100 |
| Telecommunication | 136/25 | insufficient n | 138/33 | insufficient n | 50.0% / -0.100 |
| Textiles | 43/5 | insufficient n | 64/9 | insufficient n | insufficient n |

**ADX bucket**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| <18 | 1732/176 | 58.0% / -0.100 | 1954/302 | 56.6% (46.3%-67.0%) / -0.080 | 50.0% / -0.100 |
| >=35 | 1787/414 | 46.1% / -0.129 | 1706/458 | 49.8% (43.4%-56.2%) / -0.118 | 50.0% / -0.100 |
| 18-25 | 3475/565 | 50.1% / -0.117 | 3645/759 | 54.3% (49.4%-59.1%) / -0.089 | 50.0% / -0.100 |
| 25-35 | 2858/502 | 48.2% / -0.129 | 2791/666 | 50.3% (46.6%-54.0%) / -0.110 | 50.0% / -0.100 |

**day-range vs 20-session mean**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| <0.5x | 2524/338 | 43.2% / -0.138 | 2600/561 | 52.4% (48.1%-56.7%) / -0.087 | 50.0% / -0.100 |
| >=1.15x | 676/157 | 52.9% / -0.093 | 753/243 | 54.3% (46.4%-62.3%) / -0.089 | 50.0% / -0.100 |
| 0.5-0.85x | 5025/842 | 50.4% / -0.116 | 5196/1042 | 53.6% (49.0%-58.3%) / -0.098 | 50.0% / -0.100 |
| 0.85-1.15x | 1627/320 | 51.6% / -0.113 | 1547/339 | 47.5% (39.2%-55.8%) / -0.121 | 50.0% / -0.100 |

**running RVOL**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| <0.8 | 4219/557 | 47.6% / -0.122 | 4280/770 | 53.2% (47.2%-59.3%) / -0.082 | 50.0% / -0.100 |
| >=2 | 972/301 | 52.8% / -0.105 | 1124/404 | 51.7% (45.2%-58.2%) / -0.103 | 50.0% / -0.100 |
| 0.8-1.2 | 2672/420 | 47.6% / -0.122 | 2605/474 | 50.4% (44.2%-56.6%) / -0.113 | 50.0% / -0.100 |
| 1.2-2 | 1989/379 | 51.2% / -0.118 | 2087/537 | 53.6% (49.9%-57.4%) / -0.109 | 50.0% / -0.100 |

**daily trend (prior close vs SMA20)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| against the trend | 4780/807 | 56.8% / -0.098 | 4746/1048 | 51.2% (45.8%-56.6%) / -0.121 | 49.7% / -0.118 |
| n/a | 0/0 | insufficient n | 3/0 | insufficient n | insufficient n |
| with the trend | 5072/850 | 42.4% / -0.140 | 5347/1137 | 53.6% (46.2%-60.9%) / -0.077 | 50.3% / -0.082 |

**60m trend (close vs EMA20)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| against the trend | 3217/426 | 60.3% / -0.061 | 3125/537 | 48.2% (43.3%-53.2%) / -0.111 | 47.2% / -0.116 |
| with the trend | 6635/1231 | 45.6% / -0.148 | 6971/1648 | 53.8% (48.6%-59.0%) / -0.092 | 52.8% / -0.084 |

**Nifty daily trend**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| against the trend | 4558/814 | 60.7% / -0.111 | 4819/1084 | 49.9% (43.1%-56.7%) / -0.142 | 47.5% / -0.135 |
| with the trend | 5294/843 | 38.4% / -0.127 | 5277/1101 | 55.0% (44.8%-65.1%) / -0.058 | 52.5% / -0.065 |

### LEAN_ANY at P1 (fixed 0.5%/0.5%, 90m, next 5m open)

**tier (lean rule, any tier)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| moderate | 6615/3743 | 46.9% / -0.120 | 6847/4491 | 49.5% (47.1%-52.0%) / -0.103 | 50.0% / -0.100 |
| strong | 677/351 | 45.9% / -0.127 | 603/394 | 49.7% (43.9%-55.5%) / -0.105 | 50.0% / -0.100 |
| weak | 4248/2643 | 50.8% / -0.094 | 4344/3057 | 47.9% (44.7%-51.1%) / -0.113 | 50.0% / -0.100 |

**side**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| long / CE read | 5292/3192 | 48.0% / -0.123 | 5511/3810 | 44.6% (39.6%-49.7%) / -0.143 | 44.6% / -0.139 |
| short / PE read | 6248/3545 | 48.7% / -0.101 | 6283/4132 | 52.9% (47.8%-57.9%) / -0.075 | 55.4% / -0.062 |

**time of day (decision close)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| 09:30-10:15 | 4122/3004 | 48.8% / -0.107 | 4333/3455 | 45.3% (40.8%-49.8%) / -0.137 | 50.0% / -0.100 |
| 10:15-12:00 | 3288/1837 | 46.6% / -0.118 | 3232/2095 | 52.6% (48.9%-56.2%) / -0.078 | 50.0% / -0.100 |
| 12:00-14:00 | 2560/1260 | 50.3% / -0.108 | 2597/1664 | 52.1% (46.8%-57.4%) / -0.089 | 50.0% / -0.100 |
| 14:00-15:15 | 1570/636 | 47.6% / -0.114 | 1632/728 | 48.5% (38.9%-58.1%) / -0.112 | 50.0% / -0.101 |

**sector (NIFTY-500 industry)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| Automobile and Auto Components | 893/521 | 49.3% / -0.110 | 897/619 | 47.5% (43.5%-51.5%) / -0.120 | 50.0% / -0.100 |
| Capital Goods | 1262/841 | 51.1% / -0.093 | 1327/962 | 46.0% (41.5%-50.6%) / -0.130 | 50.0% / -0.100 |
| Chemicals | 292/160 | 46.3% / -0.135 | 314/205 | 44.4% (37.0%-51.8%) / -0.134 | 50.0% / -0.100 |
| Construction | 156/79 | insufficient n | 158/104 | 41.3% (33.3%-49.4%) / -0.141 | 50.0% / -0.100 |
| Construction Materials | 223/98 | insufficient n | 217/147 | 49.0% (38.0%-59.9%) / -0.100 | 50.0% / -0.101 |
| Consumer Durables | 549/306 | 48.4% / -0.109 | 566/380 | 50.5% (43.6%-57.5%) / -0.103 | 50.0% / -0.100 |
| Consumer Services | 518/320 | 48.8% / -0.113 | 467/342 | 49.4% (42.9%-56.0%) / -0.108 | 50.0% / -0.100 |
| Fast Moving Consumer Goods | 712/332 | 53.0% / -0.087 | 767/443 | 50.8% (44.1%-57.5%) / -0.093 | 50.0% / -0.100 |
| Financial Services | 3067/1803 | 47.3% / -0.118 | 3119/2137 | 49.1% (45.8%-52.4%) / -0.108 | 50.0% / -0.101 |
| Healthcare | 883/490 | 46.3% / -0.119 | 906/580 | 50.3% (45.3%-55.4%) / -0.096 | 50.0% / -0.100 |
| Information Technology | 706/437 | 44.9% / -0.134 | 698/506 | 50.8% (44.7%-56.9%) / -0.089 | 50.0% / -0.100 |
| Metals & Mining | 511/337 | 51.0% / -0.090 | 526/348 | 50.6% (44.2%-57.0%) / -0.091 | 50.0% / -0.100 |
| Oil Gas & Consumable Fuels | 477/217 | 47.9% / -0.112 | 469/225 | 54.2% (47.6%-60.9%) / -0.075 | 50.0% / -0.100 |
| Other / no industry tag | 59/53 | insufficient n | 63/59 | insufficient n | 50.0% / -0.100 |
| Power | 429/250 | 46.4% / -0.114 | 460/304 | 51.3% (42.7%-59.9%) / -0.090 | 50.0% / -0.100 |
| Realty | 324/224 | 50.4% / -0.105 | 351/258 | 47.7% (40.3%-55.1%) / -0.119 | 50.0% / -0.100 |
| Services | 265/152 | 52.0% / -0.103 | 261/184 | 50.5% (44.0%-57.1%) / -0.082 | 50.0% / -0.100 |
| Telecommunication | 162/93 | insufficient n | 153/96 | insufficient n | 50.0% / -0.100 |
| Textiles | 52/24 | insufficient n | 75/43 | insufficient n | 50.0% / -0.100 |

**ADX bucket**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| <18 | 2422/1202 | 47.3% / -0.115 | 2701/1636 | 51.2% (48.0%-54.4%) / -0.095 | 50.0% / -0.100 |
| >=35 | 2055/1360 | 49.7% / -0.101 | 1977/1450 | 49.7% (45.7%-53.7%) / -0.100 | 50.0% / -0.100 |
| 18-25 | 3833/2246 | 49.3% / -0.107 | 3910/2643 | 48.4% (45.2%-51.5%) / -0.110 | 50.0% / -0.100 |
| 25-35 | 3230/1929 | 47.0% / -0.120 | 3206/2213 | 47.3% (44.8%-49.8%) / -0.117 | 50.0% / -0.100 |

**day-range vs 20-session mean**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| <0.5x | 3759/2215 | 48.8% / -0.107 | 3900/2668 | 48.1% (45.1%-51.0%) / -0.110 | 50.0% / -0.100 |
| >=1.15x | 662/408 | 49.0% / -0.114 | 727/537 | 49.9% (44.6%-55.2%) / -0.111 | 50.0% / -0.101 |
| 0.5-0.85x | 5498/3159 | 48.7% / -0.109 | 5653/3735 | 49.8% (47.1%-52.5%) / -0.101 | 50.0% / -0.100 |
| 0.85-1.15x | 1621/955 | 46.1% / -0.129 | 1514/1002 | 47.3% (43.0%-51.6%) / -0.118 | 50.0% / -0.101 |

**running RVOL**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| <0.8 | 5453/3093 | 48.4% / -0.109 | 5480/3542 | 49.3% (45.8%-52.8%) / -0.101 | 50.0% / -0.100 |
| >=2 | 1007/713 | 48.1% / -0.118 | 1139/876 | 48.1% (45.0%-51.1%) / -0.121 | 50.0% / -0.101 |
| 0.8-1.2 | 2983/1703 | 48.0% / -0.115 | 2962/1955 | 48.2% (45.5%-51.0%) / -0.113 | 50.0% / -0.100 |
| 1.2-2 | 2097/1228 | 49.2% / -0.108 | 2213/1569 | 49.5% (46.5%-52.4%) / -0.105 | 50.0% / -0.100 |

**daily trend (prior close vs SMA20)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| against the trend | 5575/3276 | 49.7% / -0.110 | 5659/3892 | 46.8% (42.8%-50.8%) / -0.123 | 47.8% / -0.115 |
| n/a | 0/0 | insufficient n | 4/1 | insufficient n | insufficient n |
| with the trend | 5965/3461 | 47.2% / -0.112 | 6131/4049 | 51.0% (46.7%-55.3%) / -0.092 | 52.2% / -0.085 |

**60m trend (close vs EMA20)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| against the trend | 3856/2114 | 53.2% / -0.084 | 3806/2435 | 49.7% (46.5%-52.8%) / -0.097 | 49.0% / -0.107 |
| with the trend | 7684/4623 | 46.2% / -0.125 | 7988/5507 | 48.6% (45.3%-51.9%) / -0.111 | 51.0% / -0.093 |

**Nifty daily trend**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| against the trend | 5292/3192 | 48.0% / -0.123 | 5752/3944 | 44.8% (40.1%-49.5%) / -0.139 | 46.2% / -0.126 |
| with the trend | 6248/3545 | 48.7% / -0.101 | 6042/3998 | 53.0% (47.8%-58.2%) / -0.076 | 53.8% / -0.074 |

### LEAN_ANY at P2 (fixed 1.0%/1.0%, 90m, next 5m open)

**tier (lean rule, any tier)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| moderate | 6615/1103 | 51.7% / -0.119 | 6847/1482 | 53.9% (50.3%-57.6%) / -0.093 | 50.0% / -0.100 |
| strong | 677/88 | insufficient n | 603/124 | 45.2% (34.7%-55.6%) / -0.117 | 50.0% / -0.100 |
| weak | 4248/778 | 52.4% / -0.098 | 4344/1007 | 52.1% (46.7%-57.5%) / -0.109 | 50.0% / -0.100 |

**side**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| long / CE read | 5292/954 | 61.1% / -0.114 | 5511/1292 | 52.6% (45.2%-59.9%) / -0.148 | 47.4% / -0.150 |
| short / PE read | 6248/1015 | 42.1% / -0.112 | 6283/1321 | 53.1% (44.4%-61.7%) / -0.059 | 52.6% / -0.050 |

**time of day (decision close)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| 09:30-10:15 | 4122/1115 | 49.6% / -0.121 | 4333/1398 | 48.9% (43.5%-54.3%) / -0.143 | 50.0% / -0.100 |
| 10:15-12:00 | 3288/409 | 50.4% / -0.117 | 3232/586 | 57.0% (51.7%-62.3%) / -0.067 | 50.0% / -0.100 |
| 12:00-14:00 | 2560/274 | 55.8% / -0.099 | 2597/453 | 58.1% (47.8%-68.3%) / -0.075 | 50.0% / -0.100 |
| 14:00-15:15 | 1570/171 | 57.3% / -0.106 | 1632/176 | 56.3% (43.4%-69.1%) / -0.095 | 50.0% / -0.100 |

**sector (NIFTY-500 industry)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| Automobile and Auto Components | 893/142 | 59.9% / -0.090 | 897/206 | 57.8% (50.2%-65.3%) / -0.102 | 50.0% / -0.100 |
| Capital Goods | 1262/293 | 54.3% / -0.091 | 1327/332 | 52.4% (45.2%-59.6%) / -0.113 | 50.0% / -0.100 |
| Chemicals | 292/42 | insufficient n | 314/68 | insufficient n | 50.0% / -0.100 |
| Construction | 156/16 | insufficient n | 158/26 | insufficient n | 50.0% / -0.100 |
| Construction Materials | 223/19 | insufficient n | 217/30 | insufficient n | 50.0% / -0.100 |
| Consumer Durables | 549/102 | 55.9% / -0.101 | 566/133 | 57.1% (45.2%-69.1%) / -0.077 | 50.0% / -0.100 |
| Consumer Services | 518/93 | insufficient n | 467/113 | 48.7% (39.7%-57.6%) / -0.120 | 50.0% / -0.100 |
| Fast Moving Consumer Goods | 712/73 | insufficient n | 767/118 | 63.6% (56.4%-70.7%) / -0.076 | 50.0% / -0.100 |
| Financial Services | 3067/511 | 51.1% / -0.126 | 3119/764 | 50.5% (45.3%-55.8%) / -0.106 | 50.0% / -0.100 |
| Healthcare | 883/130 | 50.8% / -0.108 | 906/150 | 57.3% (45.0%-69.7%) / -0.084 | 50.0% / -0.100 |
| Information Technology | 706/125 | 44.8% / -0.145 | 698/181 | 53.6% (47.6%-59.6%) / -0.081 | 50.0% / -0.100 |
| Metals & Mining | 511/121 | 50.4% / -0.085 | 526/91 | insufficient n | 50.0% / -0.100 |
| Oil Gas & Consumable Fuels | 477/52 | insufficient n | 469/60 | insufficient n | 50.0% / -0.100 |
| Other / no industry tag | 59/27 | insufficient n | 63/36 | insufficient n | 50.0% / -0.100 |
| Power | 429/65 | insufficient n | 460/104 | 51.0% (37.4%-64.5%) / -0.102 | 50.0% / -0.100 |
| Realty | 324/88 | insufficient n | 351/93 | insufficient n | 50.0% / -0.100 |
| Services | 265/37 | insufficient n | 261/59 | insufficient n | 50.0% / -0.100 |
| Telecommunication | 162/26 | insufficient n | 153/37 | insufficient n | 50.0% / -0.100 |
| Textiles | 52/7 | insufficient n | 75/12 | insufficient n | insufficient n |

**ADX bucket**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| <18 | 2422/291 | 52.2% / -0.110 | 2701/454 | 56.6% (49.8%-63.4%) / -0.081 | 50.0% / -0.100 |
| >=35 | 2055/473 | 52.0% / -0.108 | 1977/533 | 51.6% (45.4%-57.8%) / -0.112 | 50.0% / -0.100 |
| 18-25 | 3833/630 | 50.5% / -0.113 | 3910/851 | 51.7% (45.9%-57.6%) / -0.104 | 50.0% / -0.100 |
| 25-35 | 3230/575 | 51.1% / -0.118 | 3206/775 | 52.6% (49.9%-55.3%) / -0.105 | 50.0% / -0.100 |

**day-range vs 20-session mean**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| <0.5x | 3759/601 | 48.6% / -0.120 | 3900/883 | 51.5% (47.1%-56.0%) / -0.106 | 50.0% / -0.100 |
| >=1.15x | 662/149 | 49.7% / -0.094 | 727/230 | 55.7% (46.0%-65.3%) / -0.080 | 50.0% / -0.100 |
| 0.5-0.85x | 5498/948 | 52.4% / -0.110 | 5653/1153 | 53.9% (50.0%-57.9%) / -0.098 | 50.0% / -0.100 |
| 0.85-1.15x | 1621/271 | 54.2% / -0.117 | 1514/347 | 50.4% (42.2%-58.6%) / -0.104 | 50.0% / -0.100 |

**running RVOL**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| <0.8 | 5453/805 | 50.4% / -0.114 | 5480/1062 | 53.4% (47.6%-59.1%) / -0.089 | 50.0% / -0.100 |
| >=2 | 1007/301 | 52.8% / -0.105 | 1139/411 | 52.8% (46.3%-59.3%) / -0.101 | 50.0% / -0.100 |
| 0.8-1.2 | 2983/479 | 50.3% / -0.115 | 2962/575 | 51.5% (45.9%-57.1%) / -0.116 | 50.0% / -0.100 |
| 1.2-2 | 2097/384 | 53.1% / -0.112 | 2213/565 | 53.1% (48.3%-57.9%) / -0.106 | 50.0% / -0.100 |

**daily trend (prior close vs SMA20)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| against the trend | 5575/940 | 57.6% / -0.100 | 5659/1304 | 53.0% (47.0%-58.9%) / -0.120 | 49.7% / -0.118 |
| n/a | 0/0 | insufficient n | 4/0 | insufficient n | insufficient n |
| with the trend | 5965/1029 | 45.6% / -0.125 | 6131/1309 | 52.6% (46.4%-58.9%) / -0.082 | 50.3% / -0.082 |

**60m trend (close vs EMA20)**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| against the trend | 3856/517 | 59.6% / -0.068 | 3806/704 | 51.0% (46.3%-55.7%) / -0.103 | 47.2% / -0.116 |
| with the trend | 7684/1452 | 48.3% / -0.136 | 7988/1909 | 53.5% (48.6%-58.4%) / -0.099 | 52.8% / -0.084 |

**Nifty daily trend**

| slice | disc. events/dec. | disc. hit / net exp. % | valid. events/dec. | valid. hit (day-cluster CI) / net exp. % | valid. all bars: hit / net exp. % |
|---|---|---|---|---|---|
| against the trend | 5292/954 | 61.1% / -0.114 | 5752/1344 | 51.5% (44.2%-58.7%) / -0.141 | 47.5% / -0.135 |
| with the trend | 6248/1015 | 42.1% / -0.112 | 6042/1269 | 54.2% (45.7%-62.7%) / -0.061 | 52.5% / -0.065 |

## 8. Multiple comparisons and limits

- 3240 configurations x 3 windows were computed and 186 slice cells; nothing here was tuned. All thresholds (tiers, RVOL >= 1.5, day change >= 0.5%, 0.1% tolerance etc.) are the live ones or were fixed before the run.
- With 2808 testable validation cells, roughly 140 nominal "p < 0.05" results are expected from noise; cells share events and days, so they are strongly correlated and the count of independent tests is smaller but unknowable.
- Day-cluster intervals use few clusters (about 20 validation sessions) with a t-distribution; with so few clusters they are still approximate and likely somewhat too narrow.
- 'Both in one candle' is never counted as a win; for expectancy it is charged as a stop. Trades that hit neither barrier are marked at the horizon close ('timeout'), or at the session close if the horizon would run past it ('open').
- Underlying only: no option premium, theta, IV change, spread, brokerage, STT or liquidity. Costs are a flat 0.05% per side of the underlying, an assumption, not a measurement.
- One regime: roughly two months of one market. A result here says nothing about other regimes.

## 9. Files

`report.md` (this), `results.json`, `grid.csv` (every configuration x window), `signals.csv.gz` (every lean signal in run mode with all 54 outcomes; `configs.json` lists what each `res_c*`/`ret_c*` column is), `missing_symbols.json`, `parity.json` (when produced), `run_command.txt`.