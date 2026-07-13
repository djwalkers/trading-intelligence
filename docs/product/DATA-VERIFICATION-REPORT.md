# Technical Acceptance Phase A — Data and Calculation Verification Report

Date: 2026-07-12
Scope: `Trading/platform/web` (feature-frozen)
Author: automated technical acceptance audit
Environment: live project credentials present in `.env.local` (Supabase, Finnhub, Alpha Vantage) — every claim below marked "VERIFIED (live)" was produced by an actual network call or an actual database query against the real, running project, not by reading code and assuming it works.

> **A note on how this report was produced.** Every indicator, every strategy evaluation, every
> database row, and every API response quoted below was captured by executing the platform's own
> shipped code against real external services and the real Supabase project — not by re-deriving
> expected values from the specification. Where a value could not be produced this way, it is
> marked **NOT VERIFIED** rather than assumed. One incident occurred during this audit: a shell
> command briefly printed the project's real API keys to this session's transcript. The user was
> notified immediately and chose to continue; this is disclosed here for completeness, not because
> it affects the technical findings below.

---

## Final Recommendation

# **FAIL — Technical Acceptance Phase A**

The market-data pipeline, indicator mathematics, worker execution, authentication/RLS security
boundary, and portfolio/P&L calculations are all **verified genuine and correct** against live
external data and a live database. However, one **high-severity, reproducible data-integrity
defect** breaks the platform's core traceability guarantee — the very thing this Phase A audit was
commissioned to prove: *"the full data lineage from external providers through to persisted
trading decisions."* That chain is confirmed broken at its final link (see Finding A below). A
second, lower-severity finding (Finding B) means several prominent UI surfaces display
non-indicator values that could be mistaken for real technical-indicator output. Neither finding
was fixed as part of this audit, per the instruction to fix only defects that prevent verification —
both were fully reproducible and did not block verification of any other component.

**Recommendation:** do not accept Phase A until Finding A is fixed and re-verified. Finding B should
be resolved or, at minimum, explicitly labelled in the UI before Phase A is re-run.

---

## Summary of Findings

| # | Severity | Component | Finding | Status |
|---|---|---|---|---|
| A | **High** | `decision_history` persistence | The `DecisionRecord` for the *winning* candidate in a scan that opens a trade is never persisted to Supabase — confirmed on 100% (0 of 4) of real trade-opening scans in the live database, while the *losing* candidates from those same scans persist correctly. Root-caused to application code (not a database constraint — proven by a clean synthetic insert), specific line not isolated within this audit's scope. | **FAILED — reproducible defect** |
| B | Medium | Dashboard / Watchlist / Market Intelligence / Operations Centre strategy display | These four surfaces call `StrategyEngine.evaluateAll()`, which uses a **snapshot-proxy** context (`buildStrategyContext()`) that fabricates SMA/EMA/RSI-shaped numbers from a single day's price/volume/change via fixed multipliers — it is not calculateSMA/EMA/RSI at all. Only the Bot Runner (`evaluateAllWithHistory()`) uses genuine indicator math. This is disclosed in source comments but not disclosed to an end user reading these pages. | **Disclosed limitation, not a defect — but affects "legitimacy" framing** |
| C | Medium | Moving Average Crossover strategy, real-history path | Even when `buildStrategyContextFromHistory()` supplies a genuine, Alpha-Vantage-derived `shortMovingAverage`/`longMovingAverage`, the strategy's `instrument.price > shortMovingAverage` comparison still reads the **static mock price** from `src/lib/mock/instruments.ts` — never a live quote. Live-reproduced: for NVDA, mock price $134.87 vs. real recent close ~$211 produced a SELL signal that was materially influenced by the stale price, not purely by the real moving averages. | **Verified data-integrity defect** |
| D | Low | Outcome analysis (Mission 11) | 0 of 377 live `decision_history` rows have ever been classified `Win`/`Loss`/`Neutral` — every row is `Pending`, including rows old enough that their linked trades have long since closed. Consistent with, and partially explained by, Finding A (no linked row exists to reconcile in the first place for the 4 known trade-opening scans). | **Verified non-functioning feature in production** |
| — | — | Everything else audited (see body) | Finnhub, Alpha Vantage, disk caching + TTL, all four indicator functions, worker startup/poll/shutdown, Supabase schema/RLS, portfolio & P/L math | **VERIFIED (live)** |

---

## 1. Methodology

Every component below was checked with **live execution**, not static reading alone, in this order:
1. Read the actual shipping source file.
2. Where the component talks to an external service or a database, invoke it for real — an HTTP
   call to Finnhub/Alpha Vantage, or a query against the live Supabase project via the app's own
   `getServiceRoleClient()`/`getSupabaseClient()` factories — and capture the raw response.
3. Where the component is a pure calculation, import the *actual shipped function* (not a
   reimplementation) into a throwaway script, run it against test data, and independently
   re-derive the same value from a from-scratch reference implementation and/or by hand, to prove
   the shipped code matches the standard formula rather than merely being internally consistent.
4. Anything that could not be exercised this way is marked **NOT VERIFIED**, explicitly, rather
   than assumed correct.

All temporary verification scripts were deleted after use; no production code was left changed
except where explicitly noted (none were — this audit made no source changes).

---

## 2. Data Lineage Classification

Every category of displayed/used value, classified per the brief's four categories.

| Value | Where shown | Classification | Evidence |
|---|---|---|---|
| Live instrument quote (price, change, day range) | Watchlist "Price"/"Change" columns, Paper Trade entry price *when `NEXT_PUBLIC_MARKET_DATA_PROVIDER`/`_API_KEY` configured* | **Live external data** (Finnhub) | §3 |
| Instrument quote when market data unconfigured/failed | Same surfaces, fallback path | **Sample/mock data** | §3, `MockMarketDataProvider` |
| Historical OHLCV candles, worker-triggered scans | Feeds Strategy Engine indicators for `Scheduled` trigger type | **Live external data** (Alpha Vantage) | §4 |
| Historical OHLCV candles, browser-triggered scans (manual or browser-scheduled) | Feeds Strategy Engine indicators for Bot Runner in the browser | **Sample/mock data** (deterministic PRNG) — never Alpha Vantage; the browser bundle has no access to `ALPHA_VANTAGE_API_KEY` by design | §4, `get-historical-market-data-provider.ts` |
| SMA/EMA/RSI/Momentum/Volume-ratio/Volatility, when real history is available | Bot Runner decisions, Operations Centre "AI Engine" panel confidence figures for those decisions | **Internal calculation**, verified to standard formula | §5 |
| "shortMovingAverage"/"longMovingAverage"/"rsi"/"volumeRatio", Dashboard/Watchlist/Market Intelligence/Operations Centre Strategy panels | Every `evaluateAll()` call site | **Internal calculation — NOT a technical indicator.** A single-day snapshot fed through fixed multipliers (§6, Finding B) | §6 |
| Strategy signals (BUY/SELL/HOLD), confidence, agreement | All Strategy Engine consumers | **Internal calculation**, deterministic given its inputs — verified correct arithmetic; input quality depends on which context path fed it (real or proxy, see above) | §6 |
| Paper trade entry/exit price | Trade Journal, Paper Portfolio | **Live external data** when a market data provider is configured and reachable at the moment of entry/close; **sample/mock data** otherwise. Provenance is recorded per-trade (`entry_price_source` column) | §8, live row example |
| Realised/unrealised P/L | Paper Portfolio, Trade Journal | **Internal calculation**, verified exact against live persisted data | §8 |
| Portfolio exposure snapshot (capital deployed, cash available, sector exposure) | Bot Runner risk checks, Operations Centre | **Internal calculation**, verified exact against live persisted data | §8 |
| Paper trades, decision records, schedules | Supabase `paper_trades`/`decision_history`/`bot_schedules` | **User-generated data** (a real person's or the worker's trading activity), persisted for real | §7 |
| Starting portfolio holdings, sector mapping | Paper Portfolio "Open positions" table | **Sample/mock data**, static, authored once (disclosed since Build 1.12.1) | code inspection only, unchanged this audit |
| Signals/Strategies pages (separate from AI Engine) | `/signals`, `/strategies` | **Sample/mock data**, deterministic mock generator, explicitly disclosed in-app since Build 1.12.1 | code inspection only |

---

## 3. Finnhub Live Connectivity — VERIFIED (live)

**Code**: `src/lib/market-data/external-market-data-provider.ts` — a genuine `fetch()` call to
`https://finnhub.io/api/v1/quote`, field-mapped 1:1 into `MarketQuote { symbol, price,
changeAbsolute, changePercent, lastUpdated }`.

**Live call made during this audit** (`GET https://finnhub.io/api/v1/quote?symbol=AAPL&token=<redacted>`):

```
HTTP/2 200
date: Sat, 11 Jul 2026 12:24:16 GMT
x-ratelimit-limit: 60
x-ratelimit-remaining: 59

{"c":315.32,"d":-0.9,"dp":-0.2846,"h":316.91,"l":312.17,"o":314.72,"pc":316.22,"t":1783713600}
```

`t: 1783713600` converts to `2026-07-10T21:00:00 BST` — the previous session's close, consistent
with the app's own "NYSE closes at 21:00 BST" market-status copy. This is a real, live, rate-limited
API response, not a stub.

**Fallback behaviour** (`resilient-market-data-provider.ts`, code-verified): on any thrown error the
provider switches to `MockMarketDataProvider` for the remainder of the session ("do not keep
retrying a known-broken connection") and reports `mode: "Fallback"` with the failure reason — this
status is what the Operations Centre's "Market Data" panel surfaces.

---

## 4. Alpha Vantage Connectivity and Caching — VERIFIED (live)

**Code**: `src/lib/market-data/alpha-vantage-historical-market-data-provider.ts`.

**Live call made during this audit** (`GET https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=AAPL&outputsize=compact&apikey=<redacted>`):

```json
{
  "Meta Data": {
    "1. Information": "Daily Prices (open, high, low, close) and Volumes",
    "2. Symbol": "AAPL",
    "3. Last Refreshed": "2026-07-10",
    "4. Output Size": "Compact",
    "5. Time Zone": "US/Eastern"
  },
  "Time Series (Daily)": { "...100 real trading days..." }
}
```

Most recent day (2026-07-10): open 314.72, high 316.91, low 312.17, close 315.32 — **identical, to
the cent, to Finnhub's same-day OHLC figures captured independently above.** This cross-provider
agreement is strong evidence both feeds are genuine, not fabricated.

### Caching — VERIFIED (live, by execution of the actual provider class)

The actual `AlphaVantageHistoricalMarketDataProvider` class (not a mock of it) was instantiated and
exercised directly:

| Call | What it should do | Result |
|---|---|---|
| 1. `getHistoricalCandles(["MSFT"], 30)`, cold cache | Real network fetch | **290ms**, 30 candles returned |
| 2. Same call, same instance | In-memory cache hit | **0ms**, identical data (`JSON.stringify` equal) |
| 3. Same call, **fresh instance** (new process-equivalent object) | Disk cache hit (`.data/alpha-vantage-historical-cache.json` read back) | **0ms**, identical to call 1 |
| 4. Cache entry manually backdated 25 hours (past the 24h TTL), then called again | TTL expiry forces a real refetch | **372ms** (network-speed, not cache-speed) — confirms expiry genuinely triggers a new fetch, not merely a code path that looks correct |

Disk file confirmed present after call 1 with correct structure:
`{"MSFT": {"candles": [...100 entries...], "fetchedAt": "2026-07-11T12:26:35.616Z"}}`.

**Error classification** (`AlphaVantageError`, code-verified, not independently live-triggered since
doing so would require deliberately exhausting quota or using an invalid key): five reasons —
`invalid_api_key`, `rate_limited`, `missing_symbol`, `malformed_response`, `http_failure` — each
with a distinct, correctly-ordered detection branch in `fetchFromAlphaVantage()`. **NOT VERIFIED
live** (would require intentionally breaking a working credential); verified by code inspection
only.

---

## 5. Indicator Calculations — VERIFIED (live execution + independent cross-check)

**Code**: `src/lib/indicators/indicators.ts` — `calculateSMA`, `calculateEMA`, `calculateRSI`,
`calculateMomentumPercent`, `calculateVolumeRatio`, `calculateVolatility`.

Method: the actual shipped functions were imported and run against test series, then checked
against (a) an independent from-scratch reference implementation written separately for this audit,
and (b) hand arithmetic.

### Walkthrough 1 — hand-verifiable linear series

`closes = [1,2,3,4,5,6,7,8,9,10]`, `period = 5`.

- **SMA**: hand calc `(6+7+8+9+10)/5 = 8`. Shipped function returned **8**. Independent
  reimplementation: **8**. Match.
- **EMA**: seed = SMA(first 5) = 3, smoothing k = 2/6 = 0.33333. Walking forward:
  `i=5: 6·k+3·(1-k)=4.0`, `i=6: 7·k+4·(1-k)=5.0`, `i=7: →6.0`, `i=8: →7.0`, `i=9: →8.0`.
  Shipped function returned **8**. Match.

### Walkthrough 2 — realistic 20-point price series, RSI(14)

```
prices = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
          45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64]
```

| Indicator | Shipped function output | Independent reference output | Diff |
|---|---|---|---|
| RSI(14) | 57.91502067008556 | 57.91502067008556 | 0 |
| SMA(14) | 45.91642857142857 | 45.91642857142857 | 0 |
| EMA(14) | 45.66401689058201 | 45.66401689058201 | 0 |
| Momentum(10) | -0.9548611111111062 | -0.9548611111111062 | 0 |

### Walkthrough 3 — boundary correctness

- Strictly rising 20-point series → RSI(14) = **100** exactly (zero average loss; not a rounding
  artefact — the code has an explicit `if (avgLoss === 0) return 100` branch, and it fired).
- Strictly falling 20-point series → RSI(14) = **0** exactly (zero average gain).
- A 3-value series against `period=5`/`14` for every indicator → **`null` in every case**, never a
  fabricated or padded number.
- `calculateVolumeRatio` with a 5× volume spike on the latest day against a flat 10-day baseline →
  returned exactly **5**.
- `calculateVolatility` on a perfectly flat closes series → returned exactly **0**.

**Conclusion: all four named indicators (EMA, SMA, RSI, Momentum) — plus the two supporting ones
(volume ratio, volatility) — compute the textbook-standard formula exactly, with correct edge-case
behaviour.**

---

## 6. Strategy Engine — VERIFIED with two material findings (B and C)

**Code**: `src/lib/strategy-engine/`.

### 6.1 Two genuinely different context-construction paths exist

| Call site | Function used | Data source |
|---|---|---|
| `evaluateInstrument()` / `evaluateAll()` / `evaluateAllWithTiming()` | `buildStrategyContext()` | **Snapshot proxy** — today's price/change/volume run through fixed multipliers (0.5×/2.5× drift for short/long "moving average", ±12×changePercent mapped onto a 0–100 "RSI" scale, volume/60M clamped to a "volume ratio"). **This is not SMA/EMA/RSI math.** |
| `evaluateInstrumentWithHistory()` / `evaluateAllWithHistory()` | `buildStrategyContextFromHistory()`, falling back to the proxy only if `< 31` candles are available | **Real indicator math** (§5) over real or mock OHLCV candles, depending on which historical provider fed it |

**Exact call sites, confirmed by `grep`:**

```
app/page.tsx (Dashboard):              evaluateAll()               → proxy
app/watchlist/page.tsx:                evaluateAll()               → proxy
app/market-intelligence/page.tsx:      evaluateAll()               → proxy
app/system-health/page.tsx:            evaluateAllWithTiming()     → proxy (calls evaluateAll internally)
src/lib/bot/bot-runner.ts (Bot Runner, browser & worker): evaluateAllWithHistory() → real indicators
```

**Finding B**: every page a first-time user is likely to read for "what does the Strategy Engine
think" — Dashboard, Watchlist, Market Intelligence, and even the Operations Centre's own "AI Engine"
health panel's evaluation-speed/strategy-count figures — is driven by the proxy, not real indicator
math. Only the Bot Runner's actual trading decisions use real indicators. This is disclosed in code
comments (`build-context.ts`, lines 10-13) but **not disclosed anywhere in the UI** a user would see
it. This is not a bug in the sense of incorrect arithmetic — the proxy computes its own documented
formula correctly — but it means four prominent surfaces display numbers shaped like technical
indicators that are not, in fact, technical indicators.

### 6.2 Full live pipeline, worker-realistic — VERIFIED (live)

The actual `StrategyEngine.evaluateAllWithHistory()` was run against **real Alpha Vantage candles**
for all 5 of the app's instruments (AAPL, MSFT, TSLA, NVDA, SPY), exactly mirroring what
`src/worker/process-schedule.ts` does in production. Full results:

| Symbol | Real close (2026-07-10) | EMA(12) | SMA(30) | RSI(14) | Momentum(5) | Overall signal | Agreement |
|---|---|---|---|---|---|---|---|
| AAPL | 315.32 | 305.20 | 300.69 | 63.00 | +2.17% | HOLD (55) | Strong Agreement |
| MSFT | 385.10 | 383.28 | 395.80 | 48.49 | -1.38% | HOLD (52) | Strong Agreement |
| TSLA | 407.76 | 403.87 | 405.18 | 50.40 | +3.64% | HOLD (58) | Moderate Agreement |
| NVDA | 210.96 | 201.86 | 205.58 | 55.84 | +8.28% | HOLD (59) | Moderate Agreement |
| SPY | 754.95 | 746.73 | 745.20 | 58.66 | +1.37% | HOLD (53) | Strong Agreement |

Every one of the five context objects above was cross-checked field-by-field against the same
indicator functions called independently on the same closes/volumes array — **every field matched**
(differences under 0.01, attributable only to rounding at the `round2()` display layer, e.g.
`shortMovingAverage: 305.20` vs. raw `305.1956`).

### 6.3 Finding C — a real data-integrity defect in the real-data path

`movingAverageCrossoverStrategy.evaluate()` compares `instrument.price` (not
`context.shortMovingAverage` vs. a live price — the *static mock snapshot price* from
`src/lib/mock/instruments.ts`, imported unconditionally by `src/worker/process-schedule.ts`)
against the genuinely-real `shortMovingAverage`. For **NVDA**: mock `instrument.price = $134.87`,
real `shortMovingAverage = $201.86`. Since `134.87 < 201.86`, the strategy's SELL branch condition
(`shortMA < longMA && price < shortMA`) is trivially satisfied by the stale mock price regardless of
what the real moving averages actually show relative to a genuine current quote. The live pipeline
run above shows exactly this: NVDA's Moving Average Crossover strategy returned **SELL**, partly on
the strength of a price that is $76 stale.

**This affects the worker's real, production scan path** — not just a display quirk. It means the
Moving Average Crossover strategy's signal quality is compromised by a stale price input even when
genuine Alpha Vantage history is feeding its moving averages.

---

## 7. Worker Execution — VERIFIED (live), plus an unplanned discovery

**Code**: `src/worker/run-worker.ts`, `process-schedule.ts`, `fetch-due-schedules.ts`,
`reconcile-all-users.ts`, `logger.ts`.

**Live run performed during this audit** (`npm run worker`, ~18 seconds, then SIGTERM):

```
[worker] 2026-07-12T21:22:03.080Z worker_started {"workerId":"worker-2502","pollIntervalMs":10000}
[worker] 2026-07-12T21:22:03.100Z poll_started
[worker] 2026-07-12T21:22:03.312Z no_schedules_due
[worker] 2026-07-12T21:22:13.627Z poll_started
[worker] 2026-07-12T21:22:13.740Z no_schedules_due
[worker] 2026-07-12T21:22:20.395Z worker_finished {"reason":"SIGTERM"}
```

This confirms: real service-role Supabase authentication succeeded (a bad key would have logged
`scan_failed` and exited before the first `poll_started`); a real `bot_schedules` query executed
(212ms and 113ms round trips, consistent with a real network query, not an in-memory stub); the
poll loop correctly waits `WORKER_POLL_INTERVAL_MS` (10,000ms in this environment) between cycles;
and graceful shutdown on `SIGTERM` works.

**Unplanned discovery**: while querying the live database (§8) it became clear that a **separate,
already-running worker process** (scan-id prefix `WORKER-18717-`) has been operating continuously
against this same Supabase project — 135 sequential scheduled scans at a 15-minute cadence,
spanning roughly 33 hours, the most recent just before this audit began. This process was not
started by this audit and its origin (a persistent local process, a remote deployment, or similar)
was not investigated further — flagged here as a fact discovered during verification, not something
this audit caused or controls. Its continuous, successful operation is itself strong additional
evidence that the worker's core loop is stable under real, sustained conditions — but see Findings
A and D, both discovered via this same process's accumulated data.

**Scan outcome, live-observed**: every one of that worker's 135 scans, and every one of the second
schedule's 6 browser-triggered scans, resulted in `No Trade` / `Rejected` for every candidate —
consistent with genuine risk-check behaviour (see §6.3's stale-price finding as one plausible
contributing cause among others not investigated further, since root-causing strategy tuning is
outside this audit's scope).

---

## 8. Database Persistence — VERIFIED (live), with Finding A

**Schema**: all 17 migrations (`supabase/migrations/0001`–`0017`) read in full. `paper_trades` is
the base table (Build 0.7.0); user-scoping (`user_id`) and RLS were added in Build 1.1.0
(migrations 0006/0007); Strategy Engine, Bot Runner, Portfolio Risk, and Position Manager metadata
columns were added incrementally (0009–0013), all nullable, none altering existing rows. `bot_schedules`
and `bot_decisions` (Mission 6) are worker-only infrastructure. `decision_history` (Mission 7,
extended by Mission 11's migration 0017) is the analytical record this Phase A audit's own mandate
turns on.

### 8.1 Live query results (via the real service-role client, read-only except for one
reversible test insert, described and cleaned up below)

| Table | Live row count | Notes |
|---|---|---|
| `paper_trades` | 8 | 3 distinct real users; sources Signal, Market Intelligence, and Bot all represented |
| `bot_schedules` | 2 | One enabled (15-minute interval, actively running per §7), one disabled |
| `bot_decisions` | 305 | Worker-authored server-side decision log (Mission 6/7 infrastructure) |
| `decision_history` | 377 (378 momentarily, during the test insert below) | **100% `outcome: "Pending"`. 100% `action_taken: "Rejected"` — zero rows with `action_taken: "Trade Opened"` exist, ever, across the whole table.** |

### 8.2 RLS security boundary — VERIFIED (live)

An unauthenticated request using the real public **anon key** (no session) against `paper_trades`
returned **HTTP 200 with zero rows**, despite 8 real rows existing (visible only via the
service-role key). This is a live-proven, working security boundary, not merely a migration that
exists on paper.

### 8.3 Finding A — full reproduction

Cross-referencing the 5 real trades with `source = 'Bot'` (i.e., opened by a scan, not a manual
click) against `decision_history` by `created_trade_id`:

```
Closed trade 4d3d9d8b... (TSLA, scan_id SCAN-000001, user f330fab1...) → 0 linked decision_history rows
Closed trade a9c72df5... (TSLA, scan_id SCAN-000002, user f330fab1...) → 0 linked decision_history rows
Open trade   11611b49... (NVDA, scan_id SCAN-000001, user b9632206...) → 0 linked decision_history rows
Open trade   4eb78d6f... (TSLA, scan_id SCAN-000002, user b9632206...) → 0 linked decision_history rows
```

Yet `decision_history` **does** contain a row for `scan_id = SCAN-000001` (user `f330fab1`) — for
**MSFT**, `action_taken: "Rejected"`. That scan opened a TSLA trade (confirmed above) *and*
evaluated at least one other candidate that was correctly recorded as rejected. **The winning
candidate's record for the same scan is the one missing.**

`buildDecisionRecords()` (`src/lib/decision-intelligence/build-decision-records.ts`) is called on
the fully-formed `BotDecision` object, which by that point already has `createdTradeId` populated
(confirmed by reading `bot-runner.ts`'s return statement, line 545: `createdTradeId: openedTrade.id`)
— so, in memory, a `DecisionRecord` with `actionTaken: "Trade Opened"` and a populated
`createdTradeId` should exist in the array passed to `persistDecisionRecords()`.

**Ruled out as the cause**: a database constraint. A synthetic row with the exact shape
`toDbDecisionRecord()` would produce for a winning candidate — `action_taken: "Trade Opened"`,
`created_trade_id: "TEST-TRADE-ID-VERIFICATION-DELETE-ME"` — was inserted successfully via the
live service-role client and cleaned up immediately after (confirmed deleted, table back to 377
rows). The unique partial index on `created_trade_id` and every check constraint accepted the row
without complaint.

**Conclusion**: the defect is in application code, somewhere between the scan's candidate array
being finalised and `context.persistDecisionRecords()` being called or completing successfully for
that specific record — this audit did not isolate the exact line, since doing so crosses from
verification into a repair task outside this audit's mandate ("only fix defects that prevent
verification" — this one didn't prevent verification, it was fully verified as broken).

### 8.4 Finding D — outcome analysis has never fired

All 377 live `decision_history` rows show `outcome: "Pending"`, including rows from scans run over
a day ago. Mission 11's reconciliation (`reconcileAllUsers()`, run every worker poll per §7's log
evidence — `outcomes_reconciled` never once appeared in any observed log) has had nothing to
reconcile, consistent with Finding A: reconciliation matches a closed trade back to its
`decision_history` row via `created_trade_id`, and no such linked row has ever existed for any of
the trades that have actually closed.

### 8.5 Portfolio and P/L calculations — VERIFIED (live, exact match)

Real row (`paper_trades.id = a9c72df5...`, TSLA, closed): `entry_price = 242.23`,
`exit_price = 407.76`, `quantity = 1`, stored `realised_pnl = 165.53`.

- Hand calculation: `(407.76 − 242.23) × 1 = 165.53`. Match.
- Recalculated via the actual shipped `calculateTradePnl()` function: **165.53**. Exact match, zero
  diff.
- `realised_pnl_percent`: stored `68.33587912314742`; recalculated via `calculateTradePnlPercent()`:
  **68.33587912314742**. Exact match.
- **Notable corroboration**: this trade's `exit_price` of $407.76 is identical, to the cent, to the
  real Alpha Vantage close for TSLA on 2026-07-10 independently fetched in §4 — strong (though not
  conclusively provider-labelled, since the schema doesn't record an exit-price source) evidence the
  close price came from genuine live market data, not a mock number.

`buildExposureSnapshot()`'s notional math was independently checked against the same row's embedded
`portfolio_exposure_snapshot` JSONB: `capitalByInstrument.NVDA = 277.30`, which is exactly
`quantity(2) × entry_price(138.65) = 277.30` for the real, live NVDA position open at that moment.
Exact match.

---

## 9. NOT VERIFIED

Listed explicitly, per the instruction to classify anything not conclusively provable this way
rather than assume it:

- **Alpha Vantage's five error-classification branches** (`invalid_api_key`, `rate_limited`,
  `missing_symbol`, `malformed_response`, `http_failure`) — code-verified only; live-triggering
  each would require deliberately breaking a working credential or exhausting real quota, judged
  not worth the cost to this account for an audit.
- **Live Finnhub/quote-provider failure fallback path** — the fallback-to-mock *logic* was
  code-verified (§3), but not live-triggered (would require making the credential fail, which risks
  leaving the account rate-limited or blocked).
- **`decision_history` outcome reconciliation once a linked record exists** — `outcome-analysis.ts`'s
  Win/Loss/Neutral classification logic was read but never observed running against a real linked
  pair, since no such pair has ever existed in this live database (Finding A/D).
- **RLS enforcement on `bot_schedules`/`bot_decisions`/`decision_history` specifically via the
  anon key** — only `paper_trades`' anon-key RLS behaviour was live-tested (§8.2); the other three
  tables' RLS policies were read and appear structurally identical, but were not independently
  live-tested with an anon key in this audit.
- **Root cause of Finding A** — confirmed real and reproducible, but the exact line/mechanism
  causing the winning candidate's record to be dropped was not isolated (see §8.3).
- **Position Manager and Portfolio Risk Manager threshold math on live data** — read and structurally
  sound (§6.2's live pipeline run shows their checks executing and passing/failing sensibly in the
  `portfolio_risk_summary`/`risk_checks_summary` text fields), but not independently hand-recalculated
  against a live example the way P/L math was in §8.5.

---

## 10. Pipeline Diagrams

### 10.1 Live quote pipeline (browser, any page showing "current price")

```
Finnhub REST API (finnhub.io/api/v1/quote)
        │  real HTTP GET, browser-side (NEXT_PUBLIC_ key)
        ▼
ExternalMarketDataProvider.getQuote()
        │  1:1 field mapping → MarketQuote
        ▼
ResilientMarketDataProvider  ──on failure──▶  MockMarketDataProvider (sample data, disclosed)
        │
        ▼
useMarketQuotes() hook  →  Watchlist / Paper Trade entry price / Portfolio valuation
```

### 10.2 Historical data pipeline — WORKER path (the only path that can be genuinely live)

```
Alpha Vantage REST API (TIME_SERIES_DAILY)
        │  real HTTP GET, server-only (ALPHA_VANTAGE_API_KEY, never in browser bundle)
        ▼
AlphaVantageHistoricalMarketDataProvider
        │  disk cache (.data/*.json), 24h TTL — VERIFIED §4
        ▼
StrategyEngine.evaluateAllWithHistory(instruments, provider)
        │  instruments = static mock snapshot (src/lib/mock/instruments.ts) ◀── Finding C: price
        │                                                                        input is stale here
        ▼
buildStrategyContextFromHistory()  →  calculateSMA/EMA/RSI/Momentum/VolumeRatio  (VERIFIED §5)
        ▼
3 strategies (Moving Average Crossover, RSI Reversal, Momentum)  →  aggregateResults()
        ▼
BotDecision  →  runBotScan()  →  executeBotScan()
        │                              │
        │                              ├──▶ persistTrade()            (paper_trades — VERIFIED §8)
        │                              ├──▶ persistDecision()         (bot_decisions — VERIFIED §8)
        │                              └──▶ persistDecisionRecords()  (decision_history)
        │                                        │
        │                                        └──▶ ✗ FINDING A: winning candidate's record
        │                                                 never actually lands in the table
        ▼
process-schedule.ts logs the outcome  →  bot_schedules.last_status/last_scan_at updated (VERIFIED §7/§8)
```

### 10.3 Historical data pipeline — BROWSER path (manual / browser-scheduled Bot Runner)

```
get-historical-market-data-provider.ts (client-safe factory)
        │  hardcoded: primary = null, fallback = MockHistoricalMarketDataProvider
        ▼
MockHistoricalMarketDataProvider  →  deterministic seeded PRNG (mulberry32), NOT live data
        ▼
StrategyEngine.evaluateAllWithHistory()  →  same real indicator math as §10.2,
                                             but over synthetic input data
        ▼
Same executeBotScan() persistence path as above, same Finding A applies
```

### 10.4 Dashboard/Watchlist/Market Intelligence/Operations Centre "Strategy" display

```
instruments (static mock snapshot)
        ▼
buildStrategyContext()  ◀── Finding B: NOT calculateSMA/EMA/RSI —
        │                   a proxy: price − 0.5×Δ, price − 2.5×Δ, 50+12×%Δ, volume/60M
        ▼
3 strategies  →  aggregateResults()  →  rendered directly, no persistence
```

---

## 11. Failed Acceptance Criteria (explicit list)

1. **"Prove the full data lineage from external providers through to persisted trading
   decisions."** — **FAILED.** The chain is genuinely, live-provably intact from Finnhub/Alpha
   Vantage through indicator calculation, strategy evaluation, and trade persistence — but breaks
   at the final step for the analytical `decision_history` record of the specific candidate that
   actually became a trade (Finding A). 0 of 4 live examples succeeded.
2. **Strategy Engine calculation legitimacy on primary user-facing surfaces** — **PARTIALLY
   FAILED.** Dashboard, Watchlist, Market Intelligence, and Operations Centre all display
   proxy-derived values that are not the audited SMA/EMA/RSI/Momentum functions (Finding B). Not a
   calculation error — the proxy is internally correct — but it does not meet a plain reading of
   "prove the legitimacy of every calculation used by the platform" if "legitimacy" implies these
   are the named indicators.
3. **Moving Average Crossover signal integrity on the real-data path** — **FAILED.** Confirmed
   live: a genuinely-calculated moving average pair is evaluated against a stale mock price, not a
   live or even same-day-consistent value (Finding C).
4. **Outcome analysis (Mission 11) functioning in production** — **FAILED.** 0 of 377 live records
   have ever been classified (Finding D), though this is substantially explained by Finding A.

All other named verification targets (Finnhub connectivity, Alpha Vantage connectivity, caching,
EMA/SMA/RSI/Momentum calculation, worker execution, database persistence of trades and schedules,
RLS security, and portfolio/P&L calculations) **PASSED** with live evidence.

---

## 12. Files touched during this audit

**None.** This was a read/verify-only audit. All temporary scripts used to execute live code paths
were created outside the repository (in the session scratchpad) or as gitignored temp files inside
`platform/web/` and deleted immediately after use; no source file, migration, or configuration was
modified. The one live database write (§8.3's synthetic test row) was deleted within the same
script run and confirmed removed.

---

## 13. Recommended Next Steps (not performed as part of this audit)

1. Root-cause and fix Finding A (`decision_history` missing "Trade Opened" records) — highest
   priority, since it's the specific gap blocking this Phase A's own core requirement.
2. Decide, as a product/stakeholder call rather than an engineering one, whether Finding B (proxy
   vs. real indicators on primary UI surfaces) needs a UI disclosure, a switch to real indicators
   everywhere, or is an accepted architectural tradeoff worth documenting explicitly in-app.
3. Fix Finding C by sourcing a live/consistent price for the Moving Average Crossover strategy's
   comparison, or by disclosing that the strategy's signal quality is bounded by mock-price staleness
   in its current form.
4. Once Finding A is fixed, re-verify Finding D (outcome analysis) against real linked data before
   considering it resolved — it may still have its own independent bug.
5. Re-run this Phase A audit after the above, focusing re-verification on §8.3/§8.4/§6.3.
