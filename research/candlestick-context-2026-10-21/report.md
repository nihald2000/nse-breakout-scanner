# Context-aware candlestick replay — 2026-10-21

Data: 213 current F&O symbols, 39 full sessions (2026-08-24 to 2026-10-19); discovery 19 sessions, validation 20 sessions from 2026-09-21. 131405 overlapping context events across 20 market days.
Signals use completed 5m bars and fill at the next 5m open. Stops are signal/pattern extremes; targets 1R/2R; same-bar stop/target is charged as a stop; EOD exits; max underlying risk 1%; base cost 0.05% per side. Sensitivity also reports 0.1% per side. No option premiums, spread, slippage, brokerage or taxes.
The 60m filter uses only a 60m candle whose close time is no later than the signal close. Session VWAP and opening range use bars available by that close. Relative volume compares the signal bar with the median of up to 20 prior 5m bars in the same session (at least 10 positive-volume bars required). Local-extreme reversal requires the signal bar to touch within 0.1% of the prior 12-bar low/high.
This is exploratory, fixed-family screening after earlier pattern research, not a fresh pre-registered test. Global BH correction covers 672 rows across the pooled validation, cost stress, direction splits and three Nifty-regime slices (96 pattern/filter/target configurations per slice). The same events overlap across patterns and filters; day clustering reduces but does not eliminate dependence. Today's F&O membership causes survivorship bias.

## Validation ranking at base cost (all filters/patterns; descriptive ranking only)

| Pattern | Context filter | Target | n | Target hit | Gross R | Net R | 95% day-cluster CI | p(net≤0) | BH q | same-bar both |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bear marubozu | trend_60m_rvol | 2R | 1396 | 37.3% | 0.245 | -0.209 | -0.471 to 0.053 | 0.944 | 1.000 | 4 |
| bear marubozu | trend_60m_rvol | 1R | 1396 | 55.2% | 0.117 | -0.337 | -0.512 to -0.163 | 1.000 | 1.000 | 17 |
| inside-breakout | vwap_side | 2R | 4256 | 29.9% | -0.020 | -0.342 | -0.420 to -0.265 | 1.000 | 1.000 | 12 |
| inside-breakout | shape_only | 2R | 4259 | 29.8% | -0.026 | -0.346 | -0.414 to -0.278 | 1.000 | 1.000 | 8 |
| inside-breakout | shape_only | 1R | 4259 | 48.1% | -0.028 | -0.348 | -0.393 to -0.302 | 1.000 | 1.000 | 27 |
| inside-breakout | vwap_side | 1R | 4256 | 47.9% | -0.032 | -0.353 | -0.407 to -0.300 | 1.000 | 1.000 | 30 |
| inside-breakout | opening_range | 2R | 3622 | 32.4% | 0.052 | -0.368 | -0.471 to -0.265 | 1.000 | 1.000 | 11 |
| inside-breakout | trend_60m | 2R | 4244 | 31.3% | 0.004 | -0.378 | -0.491 to -0.265 | 1.000 | 1.000 | 13 |
| inside-breakout | trend_60m_rvol | 2R | 3281 | 33.1% | 0.103 | -0.387 | -0.510 to -0.264 | 1.000 | 1.000 | 14 |
| inside-breakout | trend_60m | 1R | 4244 | 48.5% | -0.022 | -0.404 | -0.476 to -0.331 | 1.000 | 1.000 | 33 |
| bearish engulfing | trend_60m_rvol | 2R | 1628 | 37.8% | 0.209 | -0.409 | -0.654 to -0.163 | 0.999 | 1.000 | 11 |
| inside-breakout | opening_range | 1R | 3622 | 49.8% | 0.007 | -0.413 | -0.479 to -0.346 | 1.000 | 1.000 | 29 |
| bear marubozu | opening_range | 2R | 1786 | 35.9% | 0.156 | -0.428 | -0.647 to -0.209 | 1.000 | 1.000 | 9 |
| bear marubozu | vwap_side | 2R | 3273 | 34.3% | 0.087 | -0.443 | -0.623 to -0.262 | 1.000 | 1.000 | 22 |
| bear marubozu | shape_only | 2R | 3855 | 34.8% | 0.095 | -0.460 | -0.627 to -0.293 | 1.000 | 1.000 | 29 |
| inside-breakout | trend_60m_rvol | 1R | 3281 | 50.2% | 0.023 | -0.466 | -0.541 to -0.391 | 1.000 | 1.000 | 36 |
| bear marubozu | trend_60m | 2R | 2677 | 33.9% | 0.066 | -0.472 | -0.659 to -0.284 | 1.000 | 1.000 | 13 |
| bear marubozu | opening_range | 1R | 1786 | 53.8% | 0.084 | -0.500 | -0.648 to -0.353 | 1.000 | 1.000 | 37 |
| bearish engulfing | opening_range | 2R | 1920 | 38.2% | 0.196 | -0.506 | -0.722 to -0.290 | 1.000 | 1.000 | 24 |
| bear marubozu | vwap_side | 1R | 3273 | 50.4% | 0.015 | -0.515 | -0.629 to -0.401 | 1.000 | 1.000 | 66 |
| bearish engulfing | vwap_side | 2R | 3550 | 35.7% | 0.107 | -0.525 | -0.680 to -0.369 | 1.000 | 1.000 | 38 |
| bear marubozu | trend_60m | 1R | 2677 | 50.1% | 0.007 | -0.531 | -0.657 to -0.405 | 1.000 | 1.000 | 60 |
| bear marubozu | shape_only | 1R | 3855 | 51.0% | 0.024 | -0.531 | -0.635 to -0.427 | 1.000 | 1.000 | 90 |
| bearish engulfing | shape_only | 2R | 4192 | 35.7% | 0.098 | -0.538 | -0.669 to -0.407 | 1.000 | 1.000 | 53 |
| outside bar | shape_only | 2R | 4259 | 32.8% | 0.017 | -0.542 | -0.616 to -0.468 | 1.000 | 1.000 | 53 |
| bearish engulfing | trend_60m_rvol | 1R | 1628 | 52.8% | 0.068 | -0.550 | -0.697 to -0.404 | 1.000 | 1.000 | 31 |
| bull marubozu | vwap_side | 1R | 2768 | 45.6% | -0.069 | -0.551 | -0.632 to -0.471 | 1.000 | 1.000 | 54 |
| outside bar | vwap_side | 2R | 4221 | 32.6% | 0.011 | -0.558 | -0.649 to -0.467 | 1.000 | 1.000 | 46 |
| bearish engulfing | trend_60m | 2R | 2884 | 34.8% | 0.079 | -0.559 | -0.710 to -0.407 | 1.000 | 1.000 | 34 |
| bull marubozu | trend_60m_rvol | 2R | 884 | 25.0% | -0.091 | -0.564 | -0.720 to -0.407 | 1.000 | 1.000 | 7 |
| bull marubozu | vwap_side | 2R | 2768 | 28.1% | -0.083 | -0.565 | -0.685 to -0.445 | 1.000 | 1.000 | 18 |
| bull marubozu | trend_60m_rvol | 1R | 884 | 43.1% | -0.094 | -0.566 | -0.673 to -0.460 | 1.000 | 1.000 | 16 |
| bull marubozu | opening_range | 2R | 1368 | 28.9% | -0.052 | -0.568 | -0.695 to -0.440 | 1.000 | 1.000 | 8 |
| bearish engulfing | local_extreme | 2R | 2588 | 37.7% | 0.176 | -0.577 | -0.780 to -0.374 | 1.000 | 1.000 | 35 |
| outside bar | shape_only | 1R | 4259 | 48.2% | -0.034 | -0.593 | -0.648 to -0.537 | 1.000 | 1.000 | 132 |
| outside bar | trend_60m_rvol | 2R | 3093 | 33.4% | 0.065 | -0.596 | -0.732 to -0.460 | 1.000 | 1.000 | 36 |
| outside bar | vwap_side | 1R | 4221 | 48.1% | -0.035 | -0.604 | -0.672 to -0.535 | 1.000 | 1.000 | 115 |
| bull marubozu | opening_range | 1R | 1368 | 44.7% | -0.089 | -0.604 | -0.698 to -0.510 | 1.000 | 1.000 | 30 |
| bullish engulfing | vwap_side | 2R | 3348 | 29.7% | -0.067 | -0.619 | -0.760 to -0.478 | 1.000 | 1.000 | 37 |
| bullish engulfing | trend_60m_rvol | 1R | 1338 | 44.3% | -0.091 | -0.622 | -0.702 to -0.542 | 1.000 | 1.000 | 23 |

## Family conclusions

Positive validation net rows at p<.05: 0/96 eligible. Positive after BH q<.10: 0.

### Cost stress: best 10 rows re-rated at 0.10% per side

| Pattern | Context filter | Target | n | Net R | 95% CI | p | BH q |
|---|---|---:|---:|---:|---:|---:|---:|
| bear marubozu | trend_60m_rvol | 2R | 1396 | -0.663 | -0.966 to -0.361 | 1.000 | 1.000 |
| bear marubozu | trend_60m_rvol | 1R | 1396 | -0.792 | -1.005 to -0.578 | 1.000 | 1.000 |
| inside-breakout | vwap_side | 2R | 4256 | -0.664 | -0.750 to -0.578 | 1.000 | 1.000 |
| inside-breakout | shape_only | 2R | 4259 | -0.666 | -0.741 to -0.592 | 1.000 | 1.000 |
| inside-breakout | shape_only | 1R | 4259 | -0.668 | -0.727 to -0.608 | 1.000 | 1.000 |
| inside-breakout | vwap_side | 1R | 4256 | -0.675 | -0.744 to -0.607 | 1.000 | 1.000 |
| inside-breakout | opening_range | 2R | 3622 | -0.788 | -0.904 to -0.673 | 1.000 | 1.000 |
| inside-breakout | trend_60m | 2R | 4244 | -0.759 | -0.883 to -0.635 | 1.000 | 1.000 |
| inside-breakout | trend_60m_rvol | 2R | 3281 | -0.876 | -1.015 to -0.738 | 1.000 | 1.000 |
| inside-breakout | trend_60m | 1R | 4244 | -0.785 | -0.875 to -0.695 | 1.000 | 1.000 |

## Regime and direction checks

Regime is prior Nifty daily close versus its trailing 20-session SMA; unknown rows are excluded from directional regimes. Tables below list the 15 best validation configurations inside each slice. Results after selecting from this same validation period are descriptive and require a new holdout.

### priorNiftyAboveSma20

| Pattern | Context filter | Target | n | Net R | 95% CI | BH q |
|---|---|---:|---:|---:|---:|---:|
| bear marubozu | trend_60m_rvol | 2R | 234 | -0.232 | -0.526 to 0.063 | 1.000 |
| bear marubozu | trend_60m_rvol | 1R | 234 | -0.321 | -0.493 to -0.149 | 1.000 |
| inside-breakout | shape_only | 1R | 1019 | -0.344 | -0.415 to -0.272 | 1.000 |
| inside-breakout | shape_only | 2R | 1019 | -0.355 | -0.463 to -0.247 | 1.000 |
| inside-breakout | vwap_side | 1R | 1019 | -0.364 | -0.431 to -0.296 | 1.000 |
| inside-breakout | vwap_side | 2R | 1019 | -0.376 | -0.481 to -0.272 | 1.000 |
| inside-breakout | trend_60m | 1R | 1016 | -0.381 | -0.484 to -0.278 | 1.000 |
| inside-breakout | trend_60m | 2R | 1016 | -0.386 | -0.530 to -0.243 | 1.000 |
| inside-breakout | opening_range | 2R | 858 | -0.415 | -0.530 to -0.301 | 1.000 |
| inside-breakout | opening_range | 1R | 858 | -0.418 | -0.512 to -0.325 | 1.000 |
| bear marubozu | opening_range | 2R | 421 | -0.424 | -0.706 to -0.141 | 1.000 |
| bear marubozu | shape_only | 2R | 910 | -0.424 | -0.582 to -0.266 | 1.000 |
| bear marubozu | opening_range | 1R | 421 | -0.438 | -0.629 to -0.247 | 1.000 |
| bear marubozu | vwap_side | 2R | 785 | -0.445 | -0.619 to -0.270 | 1.000 |
| inside-breakout | trend_60m_rvol | 2R | 777 | -0.459 | -0.629 to -0.290 | 1.000 |

### priorNiftyBelowSma20

| Pattern | Context filter | Target | n | Net R | 95% CI | BH q |
|---|---|---:|---:|---:|---:|---:|
| bear marubozu | trend_60m_rvol | 2R | 1162 | -0.205 | -0.475 to 0.066 | 1.000 |
| inside-breakout | vwap_side | 2R | 3236 | -0.331 | -0.416 to -0.246 | 1.000 |
| bear marubozu | trend_60m_rvol | 1R | 1162 | -0.341 | -0.526 to -0.155 | 1.000 |
| inside-breakout | shape_only | 2R | 3239 | -0.343 | -0.419 to -0.268 | 1.000 |
| inside-breakout | shape_only | 1R | 3239 | -0.349 | -0.400 to -0.297 | 1.000 |
| inside-breakout | vwap_side | 1R | 3236 | -0.350 | -0.411 to -0.288 | 1.000 |
| inside-breakout | opening_range | 2R | 2763 | -0.353 | -0.466 to -0.240 | 1.000 |
| inside-breakout | trend_60m_rvol | 2R | 2503 | -0.364 | -0.492 to -0.236 | 1.000 |
| bearish engulfing | trend_60m_rvol | 2R | 1363 | -0.369 | -0.617 to -0.120 | 1.000 |
| inside-breakout | trend_60m | 2R | 3227 | -0.374 | -0.503 to -0.246 | 1.000 |
| inside-breakout | trend_60m | 1R | 3227 | -0.410 | -0.493 to -0.328 | 1.000 |
| inside-breakout | opening_range | 1R | 2763 | -0.411 | -0.479 to -0.342 | 1.000 |
| bear marubozu | opening_range | 2R | 1364 | -0.428 | -0.656 to -0.201 | 1.000 |
| bear marubozu | vwap_side | 2R | 2487 | -0.441 | -0.641 to -0.242 | 1.000 |
| bear marubozu | trend_60m | 2R | 2223 | -0.455 | -0.642 to -0.269 | 1.000 |

### priorNiftyUnknown

| Pattern | Context filter | Target | n | Net R | 95% CI | BH q |
|---|---|---:|---:|---:|---:|---:|
| bullish engulfing | shape_only | 2R | 1 | 1.615 | — to — | — |
| bullish engulfing | local_extreme | 2R | 1 | 1.615 | — to — | — |
| outside bar | local_extreme | 2R | 1 | 1.615 | — to — | — |
| bullish engulfing | vwap_side | 1R | 1 | 0.680 | — to — | — |
| bull marubozu | vwap_side | 1R | 1 | 0.680 | — to — | — |
| bullish engulfing | shape_only | 1R | 1 | 0.615 | — to — | — |
| bullish engulfing | local_extreme | 1R | 1 | 0.615 | — to — | — |
| outside bar | local_extreme | 1R | 1 | 0.615 | — to — | — |
| shooting star | shape_only | 1R | 1 | 0.569 | — to — | — |
| shooting star | trend_60m | 1R | 1 | 0.569 | — to — | — |
| bear marubozu | shape_only | 1R | 1 | 0.513 | — to — | — |
| bear marubozu | trend_60m | 1R | 1 | 0.513 | — to — | — |
| bear marubozu | vwap_side | 1R | 1 | 0.513 | — to — | — |
| outside bar | shape_only | 2R | 1 | 0.169 | — to — | — |
| outside bar | trend_60m | 2R | 1 | 0.169 | — to — | — |

### Side split of best pooled-validation rows

| Pattern | Context filter | Target | Long n / net R | Short n / net R |
|---|---|---:|---:|---:|
| bear marubozu | trend_60m_rvol | 2R | 0 / — | 1396 / -0.209 |
| bear marubozu | trend_60m_rvol | 1R | 0 / — | 1396 / -0.337 |
| inside-breakout | vwap_side | 2R | 2061 / -0.355 | 2195 / -0.330 |
| inside-breakout | shape_only | 2R | 2024 / -0.349 | 2235 / -0.344 |
| inside-breakout | shape_only | 1R | 2024 / -0.337 | 2235 / -0.357 |
| inside-breakout | vwap_side | 1R | 2061 / -0.350 | 2195 / -0.357 |
| inside-breakout | opening_range | 2R | 1671 / -0.493 | 1951 / -0.262 |
| inside-breakout | trend_60m | 2R | 1825 / -0.449 | 2419 / -0.323 |
| inside-breakout | trend_60m_rvol | 2R | 1456 / -0.590 | 1825 / -0.225 |
| inside-breakout | trend_60m | 1R | 1825 / -0.438 | 2419 / -0.377 |
| bearish engulfing | trend_60m_rvol | 2R | 0 / — | 1628 / -0.409 |
| inside-breakout | opening_range | 1R | 1671 / -0.461 | 1951 / -0.371 |
| bear marubozu | opening_range | 2R | 0 / — | 1786 / -0.428 |
| bear marubozu | vwap_side | 2R | 0 / — | 3273 / -0.443 |
| bear marubozu | shape_only | 2R | 0 / — | 3855 / -0.460 |
| inside-breakout | trend_60m_rvol | 1R | 1456 / -0.581 | 1825 / -0.375 |
| bear marubozu | trend_60m | 2R | 0 / — | 2677 / -0.472 |
| bear marubozu | opening_range | 1R | 0 / — | 1786 / -0.500 |
| bearish engulfing | opening_range | 2R | 0 / — | 1920 / -0.506 |
| bear marubozu | vwap_side | 1R | 0 / — | 3273 / -0.515 |

## Decision

A positive row here is a candidate for a genuinely untouched follow-up, not sufficient evidence to add a CE/PE call. Live Calls must remain unchanged unless a specific configuration has positive cost-adjusted validation, survives family correction, behaves across both market regimes and both directions, and passes option-premium plus prospective paper validation. Underlying results are not option returns.
