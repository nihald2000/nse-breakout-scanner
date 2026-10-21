# Walk-forward backtest of the Live Calls signal components

Offline research. Nothing here changes `lib/` or `api/`, touches production thresholds, deploys, or runs git.

> **20-Oct-2026 update.** The live read now implements findings 1-3 and 6 from `CODE_REVIEW.md` (current opening-range side, latest-bar volume spike, same-clock-window range, VWAP carried through zero-volume bars). That change is on branch `fix/live-helper-clock-bias` (`aff7add`), not in this research folder. As a result, `--fix none` no longer reproduces the pre-fix baseline; the reports here are the historical pre-fix comparison. `fixes.js` remains for the single-fix runs.

## Run it (Windows PowerShell or any shell; Node 22; zero dependencies)

```
cd C:\NSE\nse-breakout-scanner
node research/backtest-2026-10-20/run_all.js
```

That runs, in order: `fetch_data.js` (download once, resumable, ~850 Yahoo requests plus ~45 NSE bhavcopy files, a few minutes), `parity.js`, `run_backtest.js`, `timing_1m.js`. Run it **after the 15:30 close** (the partial current session is dropped automatically, but a clean snapshot is easier to reason about). Re-run with `--skip-fetch` to reuse the cache. The exact commands used are written to `run_command.txt`.

Then read `report.md`. Its first section answers: *does any strategy beat 50% at 1:1 after costs, with n and CI, or is there no edge in this sample?*

Options: `--data <dir>` (default `./data`), `--out <dir>` (default this folder), `--mode live|extended` (live = only days with a full one-month window behind them, the faithful default; extended = at least 10 prior sessions, more days, weaker parity), `--cost 0.05` (% per side on the underlying), `--fix or,vol,range,vwap` (research-only fixed helpers; see below).

## Fixed-helper re-run (research only)

The live-code review found four helpers whose behaviour is clock-biased: the opening-range break never expires, the volume-spike helper keeps the day's maximum, the range helper compares part of today with prior full days, and a zero-volume bar pulls VWAP to its typical price. `fixes.js` contains corrected versions, and `run_fixed.js` runs baseline vs each single fix vs all four:

```
node --expose-gc research/backtest-2026-10-20/run_fixed.js
```

It writes `fixed/fixed_report.md`, `fixed/fixed_summary.json`, and one `fixed/<variant>/` directory per variant. The four rules are now part of live production (see the update note above), so a fresh `--fix none` run is the fixed read, not the old baseline.

First run on the 20-Oct snapshot: the fixes remove most of the clock trend (the volume-spike helper becomes flat at 18.3% -> 18.0% and the range helper at 29.1% -> 30.0%), but no variant produces a net-positive, multiple-comparison-robust configuration. The best combined setting is still negative after costs. See `fixed/fixed_report.md`.

## Before you trust it: the self-test

```
node --test research/backtest-2026-10-20/harness_check.js
```

It runs the whole pipeline on synthetic markets with known truth (about 30 s): outcome mechanics, no look-ahead, data hygiene, parity with the real `computeRows()` (and proof that the parity test can fail), a driftless market that must not yield an edge, a planted-edge market that must, honest coverage of the day-cluster intervals, the downloader against a mock Yahoo/NSE server, and the 1-minute study.

## Files

| file | role |
|---|---|
| `fetch_data.js` | downloads Yahoo 5m/15m (60d), 60m (3mo), daily (1y), 1m (7d, 20 most liquid names), Nifty daily, NSE bhavcopy (calendar, delivery %, corporate-action detection); the F&O list and industries come from the same NSE files the app uses |
| `engine.js` | the replay: reuses the pure helpers from `lib/sector.js`, mirrors the `computeRows` assembly, builds decisions at every closed 15m bar, computes barrier outcomes |
| `parity.js` | proves the replay equals the real `computeRows()` on 200 sampled stock-bars with Yahoo and the clock stubbed |
| `analysis.js` | strategies, event selection (every bar / one per side-run), aggregation, cell statistics |
| `stats.js` | Wilson, day-cluster interval, bootstrap, Benjamini-Hochberg, t distribution (checked against scipy) |
| `run_backtest.js` | grid, walk-forward split, ablation, slices, report |
| `timing_1m.js` | cost of a late entry, VWAP-flip frequency, 'both in one candle' resolution on 1m data |
| `code_review_probes.js` + `CODE_REVIEW.md` | executable evidence for each bug/weakness found in the live code |
| `synth.js`, `harness_check.js`, `loader.js` | synthetic markets, tests, data loading |

## Method in one screen

- **Universe/data**: every F&O symbol; IST 09:15-15:30 only; missing bars skipped, never zero-filled; short/half sessions excluded; session dates validated against NSE bhavcopy; corporate-action breaks (NSE PREV_CLOSE mismatch, or a >12% overnight gap) exclude the symbol for one month; missing symbols listed in the report.
- **Decision**: every closed 15m bar from 09:30 to 15:15 close, rebuilt from only the bars closed by then (5m window = last 5 sessions, 15m window = one calendar month, as the live Yahoo ranges). Tiers, helpers and thresholds are the live ones.
- **Entries**: at the 15m bar close, and at the next 5m open. **Paths**: 5m bars. **Horizons**: 3/6/12 15m bars, same session only (a horizon cut by the close is `open`, marked at the close).
- **Barriers**: fixed 0.5/0.5, 1.0/0.5, 0.5/1.0, 1.0/1.0 %; ATR(14) x 0.5/1.0, 0.5/0.5, 1.0/1.0 (target/stop; both readings of "0.5x/1.0x" are covered); Kijun as the stop with a 1:1 target, and Kijun capped at 0.5%.
- **Outcomes**: target, stop, both-in-one-candle (never a win; charged as a stop), timeout, open, n/a. **Costs**: 0.05% per side, gross and net shown; options premium is not modeled.
- **Signals**: lean rule (any tier), strong, moderate, weak, strong+moderate (what the board lists); each of the six checks alone; leave-one-out; patterns / RVOL / delivery % / day change as standalone rules and as filters on strong+moderate; daily, 60m and Nifty trend as ex-ante regime filters; baselines (always long, always short, seeded random side, inverse of strong+moderate).
- **Walk-forward**: first half of the evaluable sessions = discovery, second half = validation. The best 10 discovery configurations (non-baseline, one entry per side-run, >= 100 decidable signals) are judged on validation only; a "lead" needs validation net expectancy > 0 and one-sided p < 0.05/10.
- **Honest intervals**: signals on the same day share the market's move, so the report shows the naive Wilson interval *and* a day-clustered interval, and says which to believe (the clustered one: it covers 94.8% of the time in the coverage test, naive Wilson 50%).
- **Multiple comparisons**: 30 strategies x 2 signal modes x 54 settings = 3,240 configurations, plus slice cells; the report prints how many "significant" results chance alone would produce and the Benjamini-Hochberg count.
- Cells with fewer than 100 decidable signals print "insufficient n".

## Known limits (also printed in the report)

Yahoo gives only ~60 calendar days of 5m/15m, and the live read needs a one-month window, so in `live` mode about 20 sessions can be evaluated (10 discovery, 10 validation). That is a short sample of one market regime; a "no edge" or a "lead" from it is weak evidence either way. Longer history would need a different data source (for example broker historical data), which this harness can read if it is written in the same `raw/<interval>/SYMBOL.json` Yahoo `result` shape.
