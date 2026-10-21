# Index rulebook replay: next-open fills and VIX gate audit

Snapshot: 2026-10-21T13:58:51.393Z (Yahoo Finance). Sample: 2026-07-29 to 2026-10-21, 58 complete sessions across five indices.

This is a corrective replay of the existing index rules, not a strategy promotion. Signals now enter at the next 5-minute open. It skips a fill if the opening gap has crossed the stop, reached T1, or expanded risk past the existing cap. Stop/targets stay at the prices that the signal displayed, so gaps change realized R.

Cost stress: 0.05% of underlying notional per side, deducted in R; excludes option spreads/IV/theta and is an assumption. Results are underlying-index R, not option-premium P&L. 95% day-cluster bootstrap, 2,500 resamples; exploratory, not a preregistered holdout. The later half is a descriptive validation period only; rule variants were already explored on overlapping dates.

## VIX gate comparison (T1 plan)

| Rule | Trades without gate | Mean net R | Day-cluster 95% CI | Trades after VIX gate | Mean net R | Day-cluster 95% CI | Removed |
|---|---:|---:|---:|---:|---:|---:|---:|
| ichi | 83 | -1.888 | -2.671 to -1.188 | 58 | -1.884 | -2.917 to -1.007 | 25 |
| orb_break | 233 | -1.211 | -1.465 to -0.960 | 151 | -1.474 | -1.755 to -1.170 | 82 |

## Oct 21, 2026 session

India VIX at the prior close was 14.77 vs p60 12.21 (elevated: true).

| Index | Rule | Side | Signal bar | Next-open fill | Entry | Stop | T1 | T2 | T1 result | T2 result |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| NIFTY | orb_break | BUY CE | 570 | 575 | 23117.35 | 23069.20 | 23208.55 | 23255.00 | SL -1.480R net | SL -1.480R net |
| BANKNIFTY | orb_break | BUY CE | 570 | 575 | 55821.65 | 55746.80 | 55973.15 | 56048.60 | SL -1.746R net | SL -1.746R net |
| FINNIFTY | ichi | BUY PE | 660 | 665 | 24946.90 | 24986.50 | 24880.45 | 24815.75 | TGT 1.048R net | TGT 2.682R net |
| MIDCPNIFTY | orb_break | BUY PE | 585 | 590 | 13506.05 | 13565.05 | 13388.65 | 13329.85 | TGT 1.761R net | TGT 2.758R net |
| NIFTYNXT50 | orb_break | BUY PE | 590 | 595 | 68372.60 | 68496.35 | 68125.24 | 68001.54 | TGT 1.446R net | TGT 2.446R net |

One day is a case review, not evidence of a durable edge. High VIX is an option-cost warning, but this dataset cannot validate a hard block because it has no historical option premiums, spreads, or IV changes.

The fixed snapshot and full trade-level results are in `yahoo-snapshot.json` and `results.json`.
