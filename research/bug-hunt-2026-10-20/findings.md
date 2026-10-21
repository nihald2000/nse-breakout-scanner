# Bug hunt — 2026-10-20 (correctness only)

Scope: `lib/sector.js`, `lib/common.js`, `lib/candlebacktest.js`, `lib/replay.js`, `lib/elliott.js`, `api/*.js`, `public/*.html` (render/timer/tier logic), `research/backtest-2026-10-20/{engine,parity,fixes}.js`. Live API smoke on the stable alias `https://nse-breakout-scanner-tau.vercel.app`.

Context that shapes the numbers below: **20-Oct-2026 is a Dussehra NSE holiday** (verified live: Yahoo `LT.NS` `regularMarketTime` = 2026-10-19T15:29:38 IST, no 20-Oct bars in `range=5d/5m` or `1mo/15m`). Every `asOf` on the smoke flicked back to 19-Oct — that is correct behaviour, not staleness.

Baseline: `node --test` → **63/63 pass**. `git status`: only `research/backtest-2026-10-20/` and `.opencode/` untracked; no tracked file modified.

## Verdict: RISK (no blocker; one major display-correctness bug on holidays)

---

## F1 — Holidays are treated as live sessions on `/api/sectors` and `/api/quotes` (major)

- **File:line:** `api/sectors.js:22-23` (`frac = sessionFraction(now)` computed before the data is fetched, never re-checked against `liveISO`); `api/quotes.js:63-68` (`frac = sessionFraction(istParts())`, `marketOpen`/`share` from clock only). Contrast the correct pattern at `api/scan.js:170` and `api/ichimoku.js:278`: `frac = liveISO === now.iso ? sessionFraction(now) : 1`.
- **Severity:** major (every ~15 NSE-holiday weekdays per year, during 09:15–15:30 IST).
- **What is wrong:** on a weekday holiday both routes compute `volShare = expectedVolumeShare(sessionFraction(now)) < 1` while serving the *previous session's* full-day turnover. In `lib/sector.js:60-61` the sector "money ratio" divides `turnoverNow` by `turnoverNorm * share`, so every sector `rvol` is inflated by `1/share`. `/api/quotes` also stamps `marketOpen: true` and a sub-1 `share` into the Breakouts page, where `public/index.html:141` re-derives `rvol = volume / (avgVol * share)` — inflated the same way. Pages built on either API show "Market open (x% of session)" with stale data.
- **Wrong-vs-right demo** (probe `Temp/opencode/holiday_share_probe.js`, using the repo's own `lib/common.js` at 11:00 IST today, a holiday):
  ```
  [sectors/quotes path]  iso: 2026-10-20  frac: 0.280  share: 0.410
  rvol shown: 2.438x  (a rvol of ~2.4x "money" for a stock with a normal previous day;
                       correct: 1.000x because the served turnover IS the full prior session)
  [scan/ichimoku path]   frac: 1  share: 1  rvol: 1.000x            <- the guarded routes
  meta.marketOpen on unguarded path: true
  ```
- **Fix (one sentence):** compute `frac` only when the fetched data's `liveISO` equals today's IST date (same guard `api/scan.js`/`api/ichimoku.js` already use), and for `/api/quotes` derive `marketOpen`/`share` from the served `t` (date of `regularMarketTime`) instead of the wall clock.

## F2 — `/api/backtest` counts a session as finished when only the 15:20 candle exists (minor)

- **File:line:** `api/backtest.js:102` — `const lastDone = lastBars[lastBars.length - 1].mm >= 920;` with the comment "the last session counts only if its final candle (15:25) is there".
- **Severity:** minor.
- **What is wrong:** `mm` is a bar *start*; the true final candle of a session is the one starting 15:25 (`mm=925`). `>= 920` accepts a session whose feed ends at the 15:20 bar, i.e. the session is labelled complete although its last candle is missing — contradicting the comment. Scope verified: outcome math is unaffected because `lib/replay.js:16` `EXIT_MM = 915` means nothing after the 15:15 bar can change a result; the harm is mislabeled "sessions" / `from`/`to` metadata (and the same-day "HALF DONE" truncation of `usable`).
- **Demo** (semantics of the exact expression): a `b5` whose last bar for the newest date is `{mm: 920}` → `lastDone = true`, while Yahoo's true final bar is `{mm: 925}` (confirmed live today: last real 5m bar timestamp 15:25 IST, 19-Oct). Expected per comment: `>= 925`.
- **Fix (one sentence):** compare `>= 925` (or check the last bar's close `t + 300 >= day close`).

## F3 — 502 error bodies echo internal failure text, and pages print it (minor, in-scope "error leaks")

- **File:line:** every 502 path copies `String(e.message)` into `detail`: `api/sectors.js:34,69`, `api/sectorstocks.js:170,177`, `api/calls.js:39`, `api/backtest.js:95`, `api/indexchart.js:23`, `api/scan.js:126`, `api/indices.js:189`, `api/ichimoku.js`. `lib/common.js:66` builds those messages as `"HTTP 429 for https://query1.finance.yahoo.com/…"` — so the client can see the exact upstream URL/status. Pages render it verbatim (`public/index.html:351` appends `data.detail` to the banner).
- **Severity:** minor. Framed as correctness (the message content is an implementation detail, not a fact about the data); a successful-upstream day gives users a raw vendor URL on outage.
- **Live demo:** *not available* — every forced bad-input probe returned a clean 400 without `detail` (`/api/sectorstocks?sector=%20%20` → 400; `/api/candlebacktest?symbols=NBCC&h=9&target=99&stop=0` → 200 with honestly clamped `h=6, target=20, stop=0.05`; empty `?symbols` on quotes/candlebacktest → clean 400). The 502 path exists in code but I could not trigger it (upstream was healthy); the echo itself is code-verified.
- **Fix (one sentence):** send a stable error code + generic text to clients and keep the internal detail in logs.

## F4 — Latent: Yahoo open-less bars degrade silently in two different ways (informational, latent)

- **File:line:** `lib/common.js:155` (`parseChart` pushes `o: 0` when open is missing); `api/indices.js:38` (`parseIdx` pushes `o: cl` when open is missing).
- **Severity:** informational (dormant today) — a bar that loses its open becomes a fake giant bullish body: in `lib/sector.js:194-199` `patternAt` would read it as delusive "bull marubozu"/doji (wrong pattern chips on Sector Scope / Live Calls / the candle backtest), and in `api/scan.js:49,57` the `gapped` note would silently turn off.
- **Measured:** across 10 live unauthenticated fetches today (NBCC, RVNL, TATASTEEL, SBIN, TITAN, CANBK on `1mo/15m` and `5d/5m`, probe `Temp/opencode/open_missing_probe.js`): **0** bars with a missing open and a finite close in 1,975 parsed bars (Yahoo instead emits all-null rows for those bars, which are dropped by both parsers). Probe scripts at `Temp/opencode/open_missing_probe.js`.
- **Fix (one sentence):** if an open is missing, keep the fact visible (e.g. `openMissing: true`) instead of inventing `0` or `close`.

---

## Checked and clean (verified, not bugs)

- **Live smoke (stable alias), holiday context:** `/api/sectors` 200, ~50 kB, `meta.universe` 213-list integrity, `deliveryDate` handling correct; `/api/sectorstocks?sector=Construction&tf=15m` 200 in ~1.1 s, chart bars carry `o/hi/lo/cl`, read populated, tier labels agree with the API's `trend.side/tier`; `/api/candlebacktest?symbols=NBCC,LT&h=3&target=0.5&stop=0.5` 200 → `sessions=20`, 103 signals, newest-first, `result` values all inside `target|stop|both|timeout|open`, `both` and `open` reported separately (honest denominator). `asOf` 19-Oct is *correct* because 20-Oct was a holiday — verified via raw Yahoo probe, **not** a stale-cache bug.
- **Param clamps:** `h=9→6`, `target=99→20`, `stop=0→0.05` — all advertised in `meta`, no silent wraparound. Bad `sector=` and empty `symbols` → 400 without internal detail.
- **`/api/calls` heavy request** (5 sectors, 16 symbols): 4.6 s total, `wanted=16, loaded=16, failed=0` — well inside the 30 s budget (8-sector/100-symbol worst case not exercised today; no failure observed).
- **Closed-candle/no-look-ahead in the replay stack:** `lib/candlebacktest.js` slices `bars[0..i]` only, entry at the decision bar's close, outcomes from `j+1`; `engine.js` cuts `dailyTrendSign`/`hourTrendSign`/ATR strictly at the decision time; `lib/replay.js` can only see bars with `t + 300 <= nowCap`; `rules_core.closedOnly` windows each step per session end; `pivots()` only returns points with `n` closed bars after them. `research/parity.js` asserts the replay read field-by-field equals the real `computeRows` (stubbed Yahoo/clock; `mutate` hooks prove it can fail).
- **Research `engine/parity/fixes`:** differences from production are documented as D1–D3 in `engine.js:10-14`; `computeOutcomes.walk` returns BOTH charged as a stop (never a win), aligning the research math with the "both" honesty label; `fixes.js` variants sit behind explicit `F.or/F.vol/F.range/F.vwap` switches that default to live behaviour, so the research results cannot silently "win" by switching.
- **Timer/pause logic on the pages** (`sector.html`, `calls.html`, `index.html`, `ichimoku.html`, `indices.html`): the interval timer declines to fire while `document.hidden` and the visibility handler restores both next-ticks; open-accordion state (`CUR`) is re-checked after every awaited fetch, so no sector-switch race; tier wording on pages ("strong one-sided"/"building"/"weak") maps to `trendVerdict` tiers without inventing a probability.
- **index.html quote-mixing:** `applyQuotes` only ever raises `dayHigh`/lowers `dayLow` with a newer tick (monotonic — correct for intraday extremes) and uses `state.serverTime - lastTick` for staleness, not local-clock delta.

## Sample/raw artefacts

- Saved responses: `Temp/opencode/smoke_sectors.json`, `smoke_sectorstocks.json`, `smoke_cbt.json`, `calls_heavy.json`, `cbt_edge.json`, `yh_lt_5m.json` (raw Yahoo, proving the holiday).
- Probes: `Temp/opencode/holiday_share_probe.js`, `open_missing_probe.js`, `page_check_generic.js` (6 pages, all PASS).

## Not covered / caveats

- Live-market behaviour of F1 (holiday *morning*) is a deterministic code-path demonstration, not a same-hour production capture — the market is closed all day today; flagging this as the smallest next check: on the next trading holiday, screenshot `/sector.html` at ~10:30 IST for an incident-grade capture.
- No broker adapter configured here, so premium/OI paths (`api/backtest.js` broker branches) ran Yahoo-only.
- `wip/signal-consistency-fixes` not inspected (not requested; must not be touched without approval).
