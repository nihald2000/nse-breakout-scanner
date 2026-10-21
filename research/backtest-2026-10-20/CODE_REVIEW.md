# Code review of the Live Calls signal code

> **Update 20-Oct-2026:** findings 1-3 and 6 are fixed in `lib/sector.js` on branch `fix/live-helper-clock-bias` (`aff7add`). The review below describes commit `7bbc369` and is kept as the pre-fix record.

Scope: `api/sectorstocks.js` (`computeRows`), `api/calls.js`, `lib/sector.js`, `lib/indicators.js`, `lib/candlebacktest.js`, at commit `7bbc369`.
Nothing in `lib/` or `api/` was changed. Every finding below has a runnable probe: `node research/backtest-2026-10-20/code_review_probes.js` (output saved in `code_review_probes.out.txt`).

**Evidence grades.** *Demonstrated* = the real function was run on a hand-built input and the output is shown. *Structural* = follows from how the code is written and is shown by the same demonstration. *Needs your data* = the size of the effect can only be measured on real NSE bars; `code_review_probes.js --data <dir>` prints it.

## Things checked and found correct

| Item | How it was checked | Result |
|---|---|---|
| ADX(14), +DI, -DI (`lib/indicators.js`) | Re-implemented separately from Wilder's definition in numpy and compared on 400 random bars | identical (max difference 0.0, same warm-up positions) |
| Tenkan(9), Kijun(26) (`tenkanKijun`) | Same, rolling (high+low)/2 | identical |
| Lean rule equals `trendVerdict` side | 20,000 random six-check combinations | 0 disagreements (harness check 2) |
| Replay equals `computeRows()` | 200 sampled stock-bars, 7,800 field comparisons, Yahoo and clock stubbed | 0 mismatches; the test fails when the data windows or the price are deliberately altered (harness check 6) |
| No look-ahead in the replay | Scrambled every bar at/after 12:00 IST; every earlier decision unchanged | pass (harness check 4) |
| `lib/common.js` F&O list | `SYMBOL` and `NIFTYFPI` rows were being treated as stocks; origin/main already excludes them | fixed upstream, test present |

## Findings

Severity is about how much the finding can change what the board shows, not about crashes.

### 1. The opening-range check never expires — **High**, demonstrated
`orStats` keeps the first close beyond the 09:15-09:30 range for the rest of the day and `computeRows` lets "the earlier break win". Probe P5: price breaks up at 09:30, then falls to 1.4% *below* the range; the check still says **up**. After noon this check contradicts the VWAP-position check in a large share of bars (measured on the synthetic market: 39%; real value from `--data`). Effect: it adds a permanently-on vote that has no information late in the day, and it can be the vote that turns a split read into "agree >= 3".

### 2. The volume-spike helper is a running maximum — **High**, demonstrated
`volSpike` returns the largest 5m volume ratio *anywhere so far today*. Probe P6: one 5x bar at 09:20 and the helper is still on at 11:35 after 25 quiet bars. Within a session it can only switch on, never off, so a helper that is 51% on at 09:30-10:15 is 99.8% on by 14:00 in the synthetic market. This feeds the tier: helpers >= 2 or >= 3 is what separates weak/moderate/strong.

### 3. The "range >= 1.15x" helper compares part of a day with whole days — **High**, demonstrated
`rangeVsNormal` divides today's range *so far* by the mean *full-day* range of the previous sessions. Probe P7: on a day that is exactly average, the ratio is 0.43 at 09:30, 0.72 at 10:30, 1.00 from 12:30. A 1.15x threshold is therefore nearly unreachable in the morning and easy on any active afternoon: it measures the clock as much as the market.

Findings 1-3 together mean the tier is partly a function of time of day. In the synthetic driftless market the strong share goes 9.8% -> 41.7% -> 47.2% -> 53.2% across the day and 77% of all stock-bars are strong or moderate with *no* signal in the data. The report prints the same table for real data (section 4); if the share climbs with the clock there, that is these three findings, not market behaviour.

### 4. Forming bar is counted in RVOL — **Medium**, demonstrated
`computeRows` passes `today` (including the still-forming 5m bar) to `intradayRvol`, while the baseline sums *full* earlier bars up to the same bar count. Probe P4: a true 1.00 reads 0.886 forty seconds into a bar. Fix would be to use `closed5` (or scale the partial bar). Display-only, but RVOL is shown as a ranking key and used by the board's sort.

### 5. RVOL aligns earlier sessions by bar count, not clock time — **Medium**, demonstrated
The comment says "same clock position"; the code uses the cumulative bar *count*. Yahoo drops null bars, so a missing 09:25 bar in the three earlier sessions shifts each baseline by one bar. Probe P3: RVOL reads 0.949 where the truth is 1.000. Display-only.

### 6. A bar with missing volume pulls VWAP away for a bar — **Medium**, demonstrated
`parseIdx` turns a missing volume into 0, and `vwapSeries` returns that bar's *typical price* instead of carrying the running VWAP forward. Probe P1: running VWAP 100.0, **103.0**, 100.0. It can flip the VWAP-position check for one bar and distorts the 12-bar slope for an hour. Frequency on real data: printed by `--data` (zero-volume bars as a share of all 5m bars); `fetch_data` + `engine.cleanBars` already count them per symbol (`hygiene.zeroVol`).

### 7. Live uses `ltp` for the VWAP-position check, the closed-bar series for everything else — **Low-Medium**, demonstrated on synthetic 1m data
Documented difference D1. The size depends on how far price moves inside a 5m bar: on the synthetic 1m sample the side flipped in 1.4% / 3.3% / 5.3% / 6.1% of checks 1-4 minutes into the bar. `timing_1m.js` measures this on your real 1m data. A 0.3% price change in the parity mutation test flipped the lean counts on about a quarter of stock-bars, so the check is sensitive.

### 8. "Held/rejected at the line" compares past bars with today's lines — **Low**, demonstrated (exaggerated)
`lineState` tests each of the last `look` bars against the *current* Tenkan/Kijun, not that bar's own. With the live `look = 2` the effect is at most one bar of line drift; Probe P2 uses `look = 20` only to make it visible. Context-only (not in the lean).

### 9. The journal replay (`lib/candlebacktest.js`) is a different, easier read than the live board — **Medium (wording)**
It computes VWAP, opening range, structure and volume baselines on 15m bars, uses *all* prior sessions for the volume baseline (live: at most 4), and fires on side *changes* only. `calls.js` states "The replay behind this page measured +/-0.5% on the stock"; that statement is about the 15m replay, not about the 5m read the board shows. Also (Probe P8) a signal on bar 22 of 25 with `h = 6` is labelled `timeout` after 2 bars rather than `open`, so its timeout counts mix horizons. No costs are modeled there, and it is in-sample.

### 10. Counted "agreeing checks" are not independent — **Design observation**
VWAP position, VWAP slope, 30m structure, the opening-range break and (partly) Ichimoku are all functions of the same price path, so they tend to move together; "agree >= 3 of 6" is easy to reach in any session that has simply moved one way so far. In the synthetic driftless market `agree >= 3` with a clear side held in 63-88% of bars (62.8% at 09:30-10:15, ~87% after 10:15). Whether that holds on NSE data is exactly what sections 4-5 of the backtest report show (tier share by time of day, and each check alone vs the full rule).

### 11. Smaller notes
- `pchg` uses the previous session's last 5m close, not NSE's official close; wrong on corporate-action days (Yahoo intraday is unadjusted) and slightly different from the exchange's figure otherwise. Display-only.
- `candlePatterns` looks back 12 bars (one hour of 5m); an engulfing bar is still listed an hour later. Display-only.
- `swingStructure` ignores the last incomplete 30-minute bucket, so structure updates only every 30 minutes; with a missing 5m bar the buckets drift off the clock.
- `calls.js` truncates at 100 symbols / 40 per sector and reports it in `meta.truncated`; no bug, but the board can silently omit names on a hot day unless that flag is shown.
- Yahoo history limits (verified from yfinance issue reports): 5m and 15m only the last 60 days, 60m 730 days. Vendors commonly have holes in 1m history (Zerodha forum threads), so missing bars are expected and the harness skips rather than fills them.

## What was deliberately not done
No live code was changed, nothing was committed or pushed, nothing was deployed. The research-copy re-run with fixed variants of findings 1-3 and 6 is in `fixed/fixed_report.md`: each fix was tested alone and together. The short result is that the clock bias largely goes away (especially for the volume and range helpers), but no variant produced a net-positive, multiple-comparison-robust configuration; the no-edge conclusion still stands for this sample.

## Sources for the data-limit statements
- yfinance issue #2451: Yahoo errors "The requested range must be within the last 60 days" for 2m/5m/15m/90m and "within the last 730 days" for 60m — https://github.com/ranaroussi/yfinance/issues/2451
- Zerodha Kite forum, "Data holes in 1min historical data for CM" (vendor 1m history has gaps) — https://kite.trade/forum/discussion/4524/data-holes-in-1min-historical-data-for-cm
