# 1-minute entry-timing study

Names with 1m data: 20; sessions covered: 7; strong+moderate events: 2392. Tiny sample (about 5 sessions x 20 names): use it to size execution effects, never to judge the signal.

## A. Cost of a late entry (strong+moderate, hold ends 90 min after the 15m close)

| barrier | delay (min) | events | decidable | hit % | both | timeout | gross exp. %/trade | net exp. %/trade |
|---|---|---|---|---|---|---|---|---|
| fixed 0.5/0.5 | 0 | 2392 | 1391 | 50.6% | 0 | 1001 | 0.008 | -0.092 |
| fixed 0.5/0.5 | 1 | 2300 | 1360 | 51.6% | 0 | 940 | 0.011 | -0.089 |
| fixed 0.5/0.5 | 2 | 2300 | 1326 | 50.9% | 1 | 973 | 0.008 | -0.092 |
| fixed 0.5/0.5 | 3 | 2300 | 1316 | 52.2% | 0 | 984 | 0.016 | -0.084 |
| fixed 0.5/0.5 | 5 | 2300 | 1305 | 51.6% | 0 | 995 | 0.011 | -0.089 |
| fixed 1.0/1.0 | 0 | 2392 | 348 | 52.6% | 0 | 2044 | 0.019 | -0.081 |
| fixed 1.0/1.0 | 1 | 2300 | 349 | 52.4% | 0 | 1951 | 0.021 | -0.079 |
| fixed 1.0/1.0 | 2 | 2300 | 341 | 52.5% | 0 | 1959 | 0.021 | -0.079 |
| fixed 1.0/1.0 | 3 | 2300 | 336 | 53.3% | 0 | 1964 | 0.026 | -0.074 |
| fixed 1.0/1.0 | 5 | 2300 | 330 | 54.2% | 0 | 1970 | 0.026 | -0.074 |

Net uses 0.05% per side. With only a few hundred events no difference between delays can be called real.

## B. VWAP-position check: closed 5m close vs the live price inside the forming bar (difference D1)

Checks: 12647; the side of the check flipped in 849 (6.7%).

| minutes into the forming bar | checks | flipped | % |
|---|---|---|---|
| 1 | 3245 | 136 | 4.2% |
| 2 | 3134 | 185 | 5.9% |
| 3 | 3134 | 245 | 7.8% |
| 4 | 3134 | 283 | 9.0% |

## C. Candles that touched both barriers (fixed 0.5/0.5, 90m, next 5m open)

5m outcomes marked 'both': 2. With 1m bars: target first 1, stop first 1, still both inside one minute 0.

Consistency: for every event where the 5m outcome was not 'both', the 1m outcome was identical in 2390 of 2390 cases (mismatches: 0).