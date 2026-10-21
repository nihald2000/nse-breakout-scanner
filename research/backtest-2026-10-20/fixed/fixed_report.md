# Fixed-helper re-run - Live Calls signal components

Same data, same 39 sessions (39 total; discovery 19, validation 20), same 213 symbols, same 0.05%/side cost. Only the four helpers change. Research-only: `lib/` and `api/` are untouched.

Baseline sanity check: the `baseline` variant reproduces the main `results.json` headline exactly (197928 decisions; P1 49.6% / net -0.103, P2 52.4% / net -0.098).

## What changed

- **OR:** the check is the latest closed bar's side of the 09:15-09:30 range. Back inside = no break; beyond the other side = that side. The live code keeps the first break all day.
- **Volume spike:** the latest closed 5m bar vs its same clock slot on earlier sessions. The live code uses the day's maximum spike.
- **Range vs normal:** today's range-so-far vs prior sessions' range over the same clock window. The live code compares part of today with prior full days.
- **VWAP:** carry the last valid VWAP through a zero-volume bar. The live code jumps to that bar's typical price.

## Strong + moderate at the two primary settings

One entry per side-run; 90m horizon; next 5m open. CI is the day-cluster 95% interval. Net is after 0.10% round trip.

| variant | P1 n/dec | P1 hit (CI) | P1 net % | P2 n/dec | P2 hit (CI) | P2 net % |
|---|---|---|---|---|---|---|
| baseline - Current live logic | 10096/6660 | 49.6% (47.3%-51.8%) | -0.103 | 10096/2185 | 52.4% (48.5%-56.4%) | -0.098 |
| fix_or - OR break is current state | 10356/6829 | 50.1% (47.6%-52.6%) | -0.100 | 10356/2255 | 52.8% (48.8%-56.8%) | -0.095 |
| fix_vol - Volume spike = current bar | 9232/6152 | 49.5% (47.1%-52.0%) | -0.104 | 9232/2031 | 52.1% (47.6%-56.7%) | -0.098 |
| fix_range - Range = same clock window | 10256/6799 | 49.5% (47.2%-51.7%) | -0.104 | 10256/2268 | 52.2% (48.2%-56.2%) | -0.099 |
| fix_vwap - VWAP carries through zero volume | 10095/6659 | 49.6% (47.3%-51.8%) | -0.103 | 10095/2185 | 52.4% (48.5%-56.4%) | -0.098 |
| fix_all - All four fixes together | 9783/6538 | 49.5% (46.8%-52.3%) | -0.103 | 9783/2218 | 52.2% (47.6%-56.8%) | -0.098 |

### Delta vs baseline

`delta` is the fixed variant minus the current live logic. Positive is better.

| variant | P1 hit change | P1 net change | P2 hit change | P2 net change |
|---|---|---|---|---|
| fix_or | +0.5% | +0.003 | +0.4% | +0.002 |
| fix_vol | -0.1% | -0.000 | -0.3% | -0.000 |
| fix_range | -0.1% | -0.001 | -0.2% | -0.001 |
| fix_vwap | +0.0% | +0.000 | 0.0% | +0.000 |
| fix_all | -0.1% | -0.000 | -0.2% | +0.000 |

The OR fix is the only single change that improves both primary settings, and it still leaves both net expectancies negative. The volume fix makes the late-session helper honest but slightly lowers the hit rate; the range fix removes the clock trend but does not change the result; the VWAP fix has no measurable effect in this sample. The combined variant is the best of the four, and still has no net-positive, multiple-comparison-robust cell.

Not changed here: forming-bar RVOL (finding 4), RVOL clock alignment (5), live VWAP using `ltp` (7), held/rejected lines (8), and the exact Live Calls board selection. This is a component test, not a board replay.

## Tier ordering at P1 (0.5/0.5, 90m, next open)

| variant | strong | moderate | weak | strong - moderate |
|---|---|---|---|---|
| baseline | 50.2% (n=3749) | 49.5% (n=7665) | 48.1% (n=3367) | 0.7% |
| fix_or | 50.1% (n=3748) | 49.8% (n=7634) | 47.6% (n=3329) | 0.3% |
| fix_vol | 50.4% (n=3500) | 50.0% (n=7203) | 47.4% (n=5331) | 0.4% |
| fix_range | 50.2% (n=3760) | 49.5% (n=7811) | 48.5% (n=3118) | 0.7% |
| fix_vwap | 50.2% (n=3749) | 49.5% (n=7664) | 48.1% (n=3367) | 0.7% |
| fix_all | 50.3% (n=3596) | 49.9% (n=7435) | 47.7% (n=5240) | 0.3% |

At P2 (1.0/1.0) the weak tier printed baseline 52.2% (n=1091), fix_or 51.1% (n=1086), fix_vol 51.0% (n=1658), fix_range 53.1% (n=964), fix_vwap 52.2% (n=1091), fix_all 50.2% (n=1585). These samples are small (n=153-278), the ordering is not monotonic, and weak is not a signal the board lists; treat those cells as noise, not a reason to trade weak reads.

## Clock effect

| variant | strong 09:30-10:15 | strong 14:00-15:15 | vol-spike on early -> late | range>=1.15 early -> late | avg checks early -> late |
|---|---|---|---|---|---|
| baseline | 7.9% | 48.3% | 44.0% -> 97.0% | 4.6% -> 26.0% | 3.21 -> 4.88 |
| fix_or | 6.7% | 47.8% | 44.0% -> 97.0% | 4.6% -> 26.0% | 3.08 -> 4.60 |
| fix_vol | 7.6% | 40.8% | 18.4% -> 17.5% | 4.6% -> 26.0% | 3.21 -> 4.88 |
| fix_range | 7.9% | 48.3% | 44.0% -> 97.0% | 30.9% -> 31.6% | 3.21 -> 4.88 |
| fix_vwap | 7.9% | 48.3% | 44.0% -> 97.0% | 4.6% -> 26.0% | 3.21 -> 4.88 |
| fix_all | 6.4% | 43.2% | 18.4% -> 17.5% | 30.9% -> 31.6% | 3.08 -> 4.60 |

## Multiple comparisons / lead count

| variant | testable validation cells | net-positive nominal p<0.05 | net-positive BH q<0.10 | 1:1 eligible | 1:1 net-positive nominal | leads from discovery top 10 |
|---|---|---|---|---|---|---|
| baseline | 2808 | 0 | 0 | 1872 | 0 | 0 |
| fix_or | 2808 | 0 | 0 | 1872 | 0 | 0 |
| fix_vol | 2808 | 0 | 0 | 1872 | 0 | 0 |
| fix_range | 2808 | 0 | 0 | 1872 | 0 | 0 |
| fix_vwap | 2808 | 0 | 0 | 1872 | 0 | 0 |
| fix_all | 2808 | 0 | 0 | 1872 | 0 | 0 |

## Best 1:1 row (90m, next-open, validation, at least 100 decidable)

| variant | strategy / config | n/dec | hit (CI) | break-even | gross % | net % |
|---|---|---|---|---|---|---|
| baseline | SM_MKT - fixed 1.0/1.0; 6 bars (90m); entry next 5m open | 5277/1101 | 55.0% (44.8%-65.1%) | 55.0% | 0.042 | -0.058 |
| fix_or | SM_MKT - fixed 1.0/1.0; 6 bars (90m); entry next 5m open | 5456/1139 | 55.7% (45.1%-66.2%) | 55.0% | 0.046 | -0.054 |
| fix_vol | SM_MKT - fixed 1.0/1.0; 6 bars (90m); entry next 5m open | 4816/1027 | 54.9% (44.5%-65.3%) | 55.0% | 0.043 | -0.057 |
| fix_range | SM_MKT - fixed 1.0/1.0; 6 bars (90m); entry next 5m open | 5347/1134 | 55.0% (45.0%-65.1%) | 55.0% | 0.042 | -0.058 |
| fix_vwap | SM_MKT - fixed 1.0/1.0; 6 bars (90m); entry next 5m open | 5277/1101 | 55.0% (44.8%-65.1%) | 55.0% | 0.042 | -0.058 |
| fix_all | SM_MKT - fixed 1.0/1.0; 6 bars (90m); entry next 5m open | 5170/1129 | 55.6% (45.1%-66.2%) | 55.0% | 0.047 | -0.053 |

## Verdict

**No fixed variant produced a net-positive, multiple-comparison-robust configuration in this sample.** The fixes change the clock profile and the tier counts, but they do not turn the per-stock reads into a demonstrated edge. The no-edge conclusion from the baseline report stands for this sample.

The fixes are not a rescue of the per-stock idea. They remove a known clock bias; if the fixed read still has no edge, the next test should be the exact board selection (hot sectors + 20-row cap) on a longer, independent sample, not more tuning of these 39 sessions.

## Files

Each variant has its own `grid.csv`, `results.json`, `configs.json`, `missing_symbols.json` and `run_command.txt` under `fixed/<variant>/`. The combined summary is `fixed/fixed_summary.json`.
