# Research pass 2: uncapped sector board + literature-inspired tests

Data snapshot: **2026-10-20** | run: 2026-10-20T09:10:54.318Z | mode: `live` | cost: **0.05% per side on the underlying** (0.10% round trip). Option premium, spread, IV, theta and liquidity are **not** modeled.
Fixes used: **none**. The live `lib/` and `api/` code was not changed.

## 1. Answer first

**No tested board or literature-inspired rule produced a net-positive validation cell at nominal p<0.05.** Removing the 20-row cap or the sector cap did not create an edge in this sample, and the separate hold-to-close ORB test did not either. The honest conclusion is still no edge, not a hidden profitable configuration.

- Sessions: **39** (2026-08-24 to 2026-10-19); discovery = first 19, validation = last 20. Signals in one session share the market move, so the effective sample is ~39 days, not 197928 independent trades.
- Decisions: **197928**. Cells tested: **1080** (9 per-decision rules + 11 board variants, each on 54 barrier/horizon/entry settings). Validation cells with enough decidable signals: **1076**.
- Nominal net-positive validation cells: **0** (about 54 expected by chance). BH q<0.10: **0**. Gross-positive before costs at p<0.05: **0**.
- Hold-to-close ORB: **11** rules; **11** with n>=100; nominal net-positive **0**; BH q<0.10 **0**.
- Board cross-sections: **936**; eligible sector-times (2+ stocks): **15888**.

## 2. What the literature actually supports

I only used sources with a real sample, explicit rules and a cost discussion. "Heavily backtested" does **not** mean transferable: most of the strong evidence is US equities/ETFs, and the one NSE ORB paper is a single stock for one year with statistically insignificant results.

| Source | What was tested | Reported result | Why it does / does not fit this scanner |
|---|---|---|---|
| Zarattini, Barbon & Aziz (2024), *A Profitable Day Trading Strategy for the U.S. Equity Market*, SSRN 4729284 | 7,000 US stocks, 2016–2023; 5-minute opening range; top 20 stocks by first-5m relative volume; 1 ATR stop; hold to close | 1,600%+ net, Sharpe 2.81, alpha 36% (authors) | Closest strategy to test. But: US equities, 5m OR, top-20 selection, hold-to-close, 7,000-stock universe, no options. Our 213 F&O stocks, next-open entries and altered universe are an adaptation; we also run a closer 5m ORB test. |
| QuantConnect (2024), *Opening Range Breakout for Stocks in Play* (replication) | 1,000 liquid US stocks, 2016 only; 5m OR; top 20 relative volume; 1 ATR stop; hold to close | 2.4 Sharpe in 2016 | Independent replication of 2016, not 2016–2023. Community comments report poor other years, cost concerns and possible overfit. It is evidence that the rule is fragile, not a guarantee. |
| Gao, Han, Li & Zhou (2018), *Market Intraday Momentum*, JFE 129(2) | US market index, 1993–2013; first half-hour return predicts last half-hour | Significant intraday momentum | Market-index, last-30-minute horizon. Our scanner is stock-level with 45–180m barriers; we do not have Nifty intraday bars in this cache. Not tested here. |
| Moskowitz & Grinblatt (1999), *Do Industries Explain Momentum?*, Journal of Finance | US industries, 1963–1995; 6–12 month industry momentum | Industry momentum explains much of stock momentum | Supports **slow** sector momentum, not 15m sector rotation. Our 39 sessions cannot test the tested horizon; the 1-day/5-day sector overlay below is an adaptation, not a replication. |
| Zarattini & Aziz (2023), *Volume Weighted Average Price (VWAP): The Holy Grail for Day Trading Systems*, SSRN 4631351 | QQQ/TQQQ, 2018–2023; price above/below VWAP, trend rule | 671% net on QQQ, Sharpe 2.1, max DD 9.4% | Single ETF, long sample, no broad cross-section. Our VWAP test is a component check, not a replication. |
| Wang & Gangwar (2025), *Optimizing Intraday Breakout Strategies on the NSE*, SSRN 5198458 | One NSE stock (Tata Motors), one year; 5/15/30m ORB with volume filters and block holding periods | ORB beat buy-and-hold in raw returns, but p-values ~0.45–0.50; no statistical evidence | Directly NSE, but one stock, one year, and the authors themselves call for stricter data coverage, transaction-cost modeling and significance testing. It is a warning: apparent ORB profits can be luck. |

**What this means for our scanner:** the evidence does not support the current six-check composite as a validated intraday edge, and it does not support 15-minute sector rotation. The strongest testable idea is ORB + relative volume. Sector momentum is a slower overlay; it should be tested as a filter, not sold as an intraday edge.

## 3. Exact rules tested

### Board selection variants

| Variant | Sectors | Row cap | API scan caps | Side alignment | Row order |
|---|---|---|---|---|---|
| BOARD_LIVE_DEFAULT | 6 | 20 | 100 symbols / 40 per sector | any strong/moderate side | tier → agree → helpers → RVOL |
| BOARD_LIVE_8 | 8 | 20 | 100 symbols / 40 per sector | any strong/moderate side | tier → agree → helpers → RVOL |
| BOARD_NO_ROW_CAP | 8 | none | 100 symbols / 40 per sector | any strong/moderate side | tier → agree → helpers → RVOL |
| BOARD_NO_SECTOR_CAP | all eligible | 20 | none | any strong/moderate side | tier → agree → helpers → RVOL |
| BOARD_UNCAPPED | all eligible | none | none | any strong/moderate side | tier → agree → helpers → RVOL |
| BOARD_UNCAPPED_ALIGNED | all eligible | none | none | CE only in up sectors, PE only in down sectors | tier → agree → helpers → RVOL |
| BOARD_TOP8_ALIGNED | 8 | none | 100 symbols / 40 per sector | CE only in up sectors, PE only in down sectors | tier → agree → helpers → RVOL |
| BOARD_TOPBOTTOM3 | 6 | none | 100 symbols / 40 per sector | CE only in up sectors, PE only in down sectors | tier → agree → helpers → RVOL |
| BOARD_SECTOR_FIRST | all eligible | none | none | any strong/moderate side | sector hotness first |
| BOARD_SECTOR_FIRST_ALIGNED | all eligible | none | none | CE only in up sectors, PE only in down sectors | sector hotness first |
| BOARD_SECTOR_FIRST_20 | all eligible | 20 | none | any strong/moderate side | sector hotness first |

All board variants list only strong/moderate rows and require 2+ stocks in a sector. The live default and the cap tests use the production row order (tier → agreeing checks → helpers → RVOL); the two `SECTOR_FIRST` variants put the hottest sector first, then use that order inside the sector. The live default also has a 100-symbol API scan cap; the uncapped variant removes it. This is a research replay, not the production page: the live page re-ranks sectors every 5 minutes, while the replay uses each closed 15m cross-section.

### Per-decision rules

| Rule | Fixed definition |
|---|---|
| ORB5 | First 5m bar direction must agree; at a closed 15m decision, last closed 5m price must be beyond that first bar's high (up) or low (down). |
| ORB5_RVOL | ORB5 plus first *traded* 5m volume / the same clock slot on the prior 14 sessions ≥ 1.5. Yahoo's 09:15 bar is almost always a zero-volume opening print, so the first bar with volume (normally 09:20) is the correct comparison. |
| ORB15 | Same, using the first 15m bar's high/low and direction. |
| ORB15_RVOL | ORB15 plus the same first traded-5m RVOL ≥ 1.5 filter. |
| VWAP_TREND | Price side of VWAP and 12-bar VWAP slope must agree (both up or both down). |
| SM_SECTOR_1D | Strong+moderate side must agree with the stock's sector being top 3 or bottom 3 by prior-session turnover-weighted member return. |
| SM_SECTOR_5D | Same using the prior 5-session sector return. |
| MEANREV_45M | Fade a 45-minute move of at least 1.0% (short after an up move, long after a down move). Control, not a proposed edge. |

All entries are at the next 5m open; ORB rules take at most one trade per stock per day (the first breakout), matching the paper. Primary settings are 0.5/0.5 and 1.0/1.0 barriers, 90-minute horizon. The ORB paper holds to the close; our 90m/3h horizons are shorter, so this is an adaptation. The sector rules use prior-session daily bars only; the current sector % used by the board uses today's closed bars only.

## 4. Board cap results (validation half)

### 0.5/0.5 barriers, 90m, next-5m entry

| Board variant | Signals/decidable | Hit % | Break-even % | Net exp. % (day-cluster 95% CI) | p (one-sided) |
|---|---|---|---|---|---|
| BOARD_LIVE_DEFAULT | 1589/1179 | 49.7 | 60.0 | -0.10 (-0.13 to -0.07) | 1.000 |
| BOARD_LIVE_8 | 1718/1267 | 48.7 | 60.0 | -0.11 (-0.14 to -0.08) | 1.000 |
| BOARD_NO_ROW_CAP | 3978/2787 | 48.9 | 60.0 | -0.11 (-0.13 to -0.08) | 1.000 |
| BOARD_NO_SECTOR_CAP | 1663/1272 | 48.9 | 60.0 | -0.11 (-0.14 to -0.07) | 1.000 |
| BOARD_UNCAPPED | 7563/5163 | 48.7 | 60.0 | -0.11 (-0.12 to -0.09) | 1.000 |
| BOARD_UNCAPPED_ALIGNED | 4648/3301 | 48.1 | 60.0 | -0.11 (-0.14 to -0.08) | 1.000 |
| BOARD_TOP8_ALIGNED | 2456/1804 | 48.6 | 60.0 | -0.11 (-0.15 to -0.07) | 1.000 |
| BOARD_TOPBOTTOM3 | 1749/1248 | 47.0 | 60.0 | -0.12 (-0.15 to -0.09) | 1.000 |
| BOARD_SECTOR_FIRST | 7563/5163 | 48.7 | 60.0 | -0.11 (-0.12 to -0.09) | 1.000 |
| BOARD_SECTOR_FIRST_ALIGNED | 4648/3301 | 48.1 | 60.0 | -0.11 (-0.14 to -0.08) | 1.000 |
| BOARD_SECTOR_FIRST_20 | 1700/1243 | 50.4 | 60.0 | -0.10 (-0.13 to -0.06) | 1.000 |

### 1.0/1.0 barriers, 90m, next-5m entry

| Board variant | Signals/decidable | Hit % | Break-even % | Net exp. % (day-cluster 95% CI) | p (one-sided) |
|---|---|---|---|---|---|
| BOARD_LIVE_DEFAULT | 1589/478 | 51.5 | 55.0 | -0.09 (-0.14 to -0.03) | 0.998 |
| BOARD_LIVE_8 | 1718/502 | 49.4 | 55.0 | -0.10 (-0.16 to -0.05) | 0.999 |
| BOARD_NO_ROW_CAP | 3978/1010 | 53.0 | 55.0 | -0.09 (-0.14 to -0.04) | 1.000 |
| BOARD_NO_SECTOR_CAP | 1663/541 | 52.9 | 55.0 | -0.09 (-0.15 to -0.03) | 0.998 |
| BOARD_UNCAPPED | 7563/1737 | 51.6 | 55.0 | -0.10 (-0.13 to -0.07) | 1.000 |
| BOARD_UNCAPPED_ALIGNED | 4648/1172 | 50.8 | 55.0 | -0.11 (-0.17 to -0.05) | 0.999 |
| BOARD_TOP8_ALIGNED | 2456/698 | 51.4 | 55.0 | -0.10 (-0.19 to -0.02) | 0.992 |
| BOARD_TOPBOTTOM3 | 1749/487 | 47.0 | 55.0 | -0.13 (-0.18 to -0.07) | 1.000 |
| BOARD_SECTOR_FIRST | 7563/1737 | 51.6 | 55.0 | -0.10 (-0.13 to -0.07) | 1.000 |
| BOARD_SECTOR_FIRST_ALIGNED | 4648/1172 | 50.8 | 55.0 | -0.11 (-0.17 to -0.05) | 0.999 |
| BOARD_SECTOR_FIRST_20 | 1700/530 | 53.8 | 55.0 | -0.09 (-0.15 to -0.04) | 0.999 |

### All 39 sessions (descriptive, not a held-out result)

| Board variant | P1 net exp. % | P2 net exp. % | P1 decidable | P2 decidable |
|---|---|---|---|---|
| BOARD_LIVE_DEFAULT | -0.11 | -0.10 | 2195 | 854 |
| BOARD_LIVE_8 | -0.11 | -0.11 | 2375 | 893 |
| BOARD_NO_ROW_CAP | -0.11 | -0.11 | 5120 | 1761 |
| BOARD_NO_SECTOR_CAP | -0.10 | -0.10 | 2401 | 979 |
| BOARD_UNCAPPED | -0.11 | -0.11 | 9586 | 3077 |
| BOARD_UNCAPPED_ALIGNED | -0.12 | -0.12 | 6081 | 2076 |
| BOARD_TOP8_ALIGNED | -0.12 | -0.12 | 3234 | 1193 |
| BOARD_TOPBOTTOM3 | -0.12 | -0.13 | 2434 | 879 |
| BOARD_SECTOR_FIRST | -0.11 | -0.11 | 9586 | 3077 |
| BOARD_SECTOR_FIRST_ALIGNED | -0.12 | -0.12 | 6081 | 2076 |
| BOARD_SECTOR_FIRST_20 | -0.10 | -0.11 | 2350 | 954 |

Read the cap table this way: if `BOARD_NO_ROW_CAP` and `BOARD_UNCAPPED` are not better than `BOARD_LIVE_DEFAULT`, the caps were not hiding an edge. If they are better only in the all-session column but not validation, the difference is not held-out evidence.

`BOARD_SECTOR_FIRST` and `BOARD_UNCAPPED` have identical events because no row cap is applied: with every row listed, row order is presentation only. `BOARD_SECTOR_FIRST_20` is the informative sector-first selection test, because the 20-row cap forces the order to choose which rows a user sees.

A repeat with the live helpers (`--fix none`, saved under `research2_livehelpers/`) also found **0** nominal net-positive and **0** BH cells. Its `BOARD_LIVE_DEFAULT` P1 was -0.09% and `BOARD_UNCAPPED` -0.10%; the cap conclusion does not depend on the fixes.

## 5. Literature-inspired results (validation half)

### 0.5/0.5 barriers, 90m, next-5m entry

| Rule | Signals/decidable | Hit % | Break-even % | Net exp. % (day-cluster 95% CI) | p (one-sided) |
|---|---|---|---|---|---|
| SM_REF | 10096/6660 | 49.6 | 60.0 | -0.10 (-0.12 to -0.09) | 1.000 |
| ORB5 | 2994/2372 | 47.1 | 60.0 | -0.12 (-0.16 to -0.08) | 1.000 |
| ORB5_RVOL | 553/476 | 49.2 | 60.0 | -0.11 (-0.17 to -0.06) | 1.000 |
| ORB15 | 2834/2100 | 48.2 | 60.0 | -0.11 (-0.14 to -0.08) | 1.000 |
| ORB15_RVOL | 473/392 | 47.2 | 60.0 | -0.12 (-0.18 to -0.06) | 1.000 |
| VWAP_TREND | 8921/5724 | 50.1 | 60.0 | -0.10 (-0.12 to -0.07) | 1.000 |
| SM_SECTOR_1D | 1791/1175 | 47.7 | 60.0 | -0.12 (-0.14 to -0.09) | 1.000 |
| SM_SECTOR_5D | 1984/1354 | 49.9 | 60.0 | -0.10 (-0.14 to -0.07) | 1.000 |
| MEANREV_45M | 4335/3635 | 50.2 | 60.0 | -0.10 (-0.14 to -0.07) | 1.000 |

### 1.0/1.0 barriers, 90m, next-5m entry

| Rule | Signals/decidable | Hit % | Break-even % | Net exp. % (day-cluster 95% CI) | p (one-sided) |
|---|---|---|---|---|---|
| SM_REF | 10096/2185 | 52.4 | 55.0 | -0.10 (-0.13 to -0.07) | 1.000 |
| ORB5 | 2994/952 | 49.6 | 55.0 | -0.12 (-0.17 to -0.06) | 1.000 |
| ORB5_RVOL | 553/247 | 46.2 | 55.0 | -0.13 (-0.22 to -0.05) | 0.998 |
| ORB15 | 2834/769 | 48.2 | 55.0 | -0.11 (-0.18 to -0.05) | 0.999 |
| ORB15_RVOL | 473/177 | 45.2 | 55.0 | -0.15 (-0.24 to -0.06) | 0.998 |
| VWAP_TREND | 8921/1722 | 54.2 | 55.0 | -0.09 (-0.13 to -0.05) | 1.000 |
| SM_SECTOR_1D | 1791/394 | 50.0 | 55.0 | -0.12 (-0.16 to -0.08) | 1.000 |
| SM_SECTOR_5D | 1984/476 | 52.5 | 55.0 | -0.10 (-0.16 to -0.05) | 0.999 |
| MEANREV_45M | 4335/1680 | 45.9 | 55.0 | -0.12 (-0.17 to -0.07) | 1.000 |

The ORB rows are the closest data-compatible test of the strongest literature result. The sector rows are slow overlays, not 15m sector rotation. `MEANREV_45M` is a control: if it is the best row, the sample is mean-reverting, not trending.

### Hold-to-close ORB (closest to the paper)

The paper's exit is a 1 ATR stop with **no target**, held to the close. The 45/90/180m grid cannot express that, so these are separate tests: one trade per stock per day (first signal), entry at the next 5m open, 1 ATR stop, exit at the last closed 5m bar of the day. The first seven rows use the 15m decision grid. The four `ORB5M*` rows scan every 5m bar, enter on the first close beyond the opening range at the next 5m open, and use a 5m ATR(14) stop. `ORB5M` uses the 09:15 bar; because Yahoo's 09:15 bar is almost always a zero-volume opening print, `ORB5MT` uses the first traded 5m bar (normally 09:20) and is the closer test of live trading. They are still adaptations: the paper enters at the breakout level, not the next open, and uses its own universe/filters.

| Rule | Events | Decidable | Days | Stop hit % | Net exp. % (day-cluster 95% CI) | p | q |
|---|---|---|---|---|---|---|---|
| ORB5_CLOSE | 5957 | 2127 | 20 | 67.0 | -0.08 (-0.20 to 0.05) | 0.898 | 0.940 |
| ORB15_CLOSE | 5568 | 2691 | 20 | 62.9 | -0.03 (-0.15 to 0.09) | 0.699 | 0.940 |
| ORB5_RVOL_CLOSE | 1042 | 385 | 20 | 66.0 | -0.04 (-0.25 to 0.16) | 0.660 | 0.940 |
| ORB15_RVOL_CLOSE | 884 | 453 | 20 | 65.8 | -0.06 (-0.23 to 0.12) | 0.742 | 0.940 |
| ORB5_TOP20_CLOSE | 586 | 218 | 20 | 63.8 | 0.03 (-0.23 to 0.30) | 0.394 | 0.940 |
| ORB15_TOP20_CLOSE | 498 | 244 | 20 | 66.0 | -0.07 (-0.23 to 0.10) | 0.797 | 0.940 |
| SM_REF_CLOSE | 8232 | 4192 | 20 | 65.2 | -0.04 (-0.13 to 0.06) | 0.781 | 0.940 |
| ORB5M_CLOSE | 6351 | 3214 | 20 | 79.1 | -0.07 (-0.16 to 0.02) | 0.940 | 0.940 |
| ORB5M_TOP20_CLOSE | 623 | 317 | 20 | 76.7 | -0.04 (-0.23 to 0.16) | 0.651 | 0.940 |
| ORB5MT_CLOSE | 6584 | 3326 | 20 | 76.9 | -0.04 (-0.14 to 0.05) | 0.834 | 0.940 |
| ORB5MT_TOP20_CLOSE | 601 | 303 | 20 | 73.6 | -0.03 (-0.17 to 0.10) | 0.689 | 0.940 |

`*_TOP20_CLOSE` selects the top 20 stocks by first traded-5m RVOL each day, the paper's "stocks in play" idea. `SM_REF_CLOSE` is the current composite with the same exit, for comparison. The close-exit family is corrected separately (BH over these rules), not mixed into the main barrier grid.
All-session descriptive: ORB5_TOP20_CLOSE 0.03%, ORB15_TOP20_CLOSE -0.04%, ORB5M_CLOSE -0.06%, ORB5M_TOP20_CLOSE -0.03%, ORB5MT_CLOSE -0.06%, ORB5MT_TOP20_CLOSE -0.03%. The full-sample results are not held-out evidence; the validation column is what matters.

## 6. Multiple comparisons and the best validation cells

- 1076 validation cells had at least 100 decidable signals; roughly 54 nominal p<0.05 hits are expected from noise.
- Nominal net-positive: **0**. BH q<0.10: **0**. Gross-positive before costs at p<0.05: **0**.
- Separate hold-to-close family: **11** rules with n>=100; nominal net-positive **0**; BH q<0.10 **0**.

The 15 best validation cells by net expectancy are listed below **only to show how easy it is to cherry-pick**; this is not a selection rule and none of them is a lead unless it also survives BH and a fresh sample.

| Cell | Config | Decidable | Hit % | Net exp. % | p |
|---|---|---|---|---|---|
| BOARD_LIVE_DEFAULT | Kijun stop 1:1; 12 bars (180m); entry bar close | 784 | 54.6 | -0.04 | 0.793 |
| BOARD_LIVE_DEFAULT | Kijun stop 1:1; 12 bars (180m); entry next 5m open | 774 | 54.4 | -0.04 | 0.822 |
| BOARD_LIVE_DEFAULT | fixed 1.0/1.0; 12 bars (180m); entry bar close | 754 | 52.1 | -0.06 | 0.946 |
| BOARD_LIVE_DEFAULT | fixed 1.0/1.0; 12 bars (180m); entry next 5m open | 759 | 52.4 | -0.06 | 0.942 |
| VWAP_TREND | Kijun stop 1:1; 12 bars (180m); entry next 5m open | 4118 | 52.5 | -0.06 | 0.979 |
| BOARD_SECTOR_FIRST_20 | Kijun stop 1:1; 12 bars (180m); entry bar close | 883 | 54.2 | -0.06 | 0.901 |
| VWAP_TREND | Kijun stop 1:1; 12 bars (180m); entry bar close | 4125 | 52.0 | -0.06 | 0.979 |
| BOARD_SECTOR_FIRST_20 | Kijun stop 1:1; 12 bars (180m); entry next 5m open | 872 | 54.2 | -0.06 | 0.912 |
| BOARD_LIVE_8 | Kijun stop 1:1; 12 bars (180m); entry bar close | 834 | 53.5 | -0.06 | 0.946 |
| BOARD_LIVE_DEFAULT | fixed 1.0/0.5; 12 bars (180m); entry next 5m open | 1124 | 30.2 | -0.07 | 0.996 |
| BOARD_TOP8_ALIGNED | Kijun stop 1:1; 12 bars (180m); entry bar close | 1363 | 53.0 | -0.07 | 0.887 |
| BOARD_NO_SECTOR_CAP | fixed 1.0/1.0; 12 bars (180m); entry next 5m open | 825 | 53.3 | -0.07 | 0.975 |
| BOARD_SECTOR_FIRST_20 | fixed 1.0/0.5; 12 bars (180m); entry next 5m open | 1201 | 30.8 | -0.07 | 0.993 |
| BOARD_SECTOR_FIRST_20 | fixed 1.0/1.0; 12 bars (180m); entry next 5m open | 821 | 53.0 | -0.07 | 0.977 |
| BOARD_LIVE_DEFAULT | fixed 1.0/0.5; 12 bars (180m); entry bar close | 1119 | 29.9 | -0.07 | 0.998 |

## 7. Verdict

**The caps are not the problem.** Removing the row cap, the sector cap or both did not produce a net-positive held-out result. The ORB and sector adaptations did not produce one, and the closer hold-to-close ORB test did not either. The current board remains a descriptive watchlist, not a validated trade signal.

What I would change in the product, subject to approval:

1. Keep the board as context; do not advertise a win rate. The current banner's 63.6% strong-read number is a small, component-level, gross-of-costs result and should not be presented as an edge.
2. If you want an uncapped sector board, make it a **display** change first: remove the 20-row cap and show all strong/moderate rows, but keep the API scan caps until the serverless runtime is measured. The research says the caps do not create edge; they are a presentation/runtime choice.
3. Port bugs 1–3 and 6 to live only as **correctness fixes**, with regression tests. They remove clock bias; they do not create alpha.
4. Do not replace the composite with ORB yet. Test the exact ORB rule on a fresh sample first; the NSE-specific evidence is statistically weak, and the US evidence is not transferable by assumption.

## 8. Limits

- One regime: 39 sessions of a falling market (Nifty 50 roughly -5.5% over the sample). No statement about other regimes.
- 213 F&O symbols from today's list: survivorship bias remains. Yahoo intraday history is ~60 days; the live read needs a one-month window, so only the second month is usable.
- Underlying only: no option premium, IV, theta, spread, brokerage, STT or liquidity. A 0.05% per-side cost is an assumption, not a measurement.
- The board replay uses closed 15m cross-sections; the live page re-ranks sectors every 5 minutes and calls every 60 seconds. Sector % is the turnover-weighted member average, not the NSE sector index.
- The main ORB grid uses 15m decision times and 90m/3h barriers, not the paper's 5m entries and hold-to-close. The decision-based close-exit tests fix the exit (1 ATR, hold to the last closed 5m bar) but still use 15m decisions and next-5m entries. The four `ORB5M*` tests scan every 5m bar and use a 5m ATR stop, but enter at the next 5m open rather than at the breakout level. The sector overlay uses 1-day/5-day returns, not the 6–12 month horizon in the industry-momentum paper. These are adaptations, not replications.
- The board's API scan cap is a runtime constraint; removing it in research does not prove the live route can scan 213 stocks within the serverless budget.

## 9. Files

`research2_report.md` (this), `research2_results.json`, `research2_grid.csv`, `research2_close.csv`, `research2_command.txt`, `board.js`, `research_strategies.js`, `run_research2.js`.

Sources: [SSRN 4729284](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4729284), [QuantConnect ORB replication](https://www.quantconnect.com/research/18444/opening-range-breakout-for-stocks-in-play/), [Gao et al. JFE 2018](https://www.sciencedirect.com/science/article/abs/pii/S0304405X18301351), [Moskowitz & Grinblatt 1999](https://www.aqr.com/Insights/Research/Journal-Article/Do-Industries-Explain-Momentum), [SSRN 4631351](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4631351), [SSRN 5198458](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5198458).
