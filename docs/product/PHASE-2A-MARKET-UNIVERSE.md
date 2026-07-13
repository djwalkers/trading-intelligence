# Phase 2A — Market Universe Foundation

## What this phase is, and isn't

Builds and verifies a genuine, dynamically-maintained "eligible US trading universe" — the
intelligence-core foundation a future market-scanning phase will build on — as a standalone
subsystem. It does **not** wire that universe into the live trading pipeline.

Explicitly **out of scope**: Hermes, candidate ranking, AI reasoning, liquidity scoring, market
scanning, strategy changes, learning, broker integration, new UI pages. Liquidity filtering is
deliberately deferred to Phase 2B (see "Recommended Phase 2B" below).

**The worker's traded instrument list is unchanged.** `src/worker/process-schedule.ts` still passes
the same static 5-symbol list (`src/lib/mock`) into `executeBotScan()`, unconditionally, exactly as
before this phase. This was a deliberate revision after an initial design wired the full eligible
universe into the worker's scan path — the existing Strategy Engine and historical-data pipeline
were never built to safely evaluate thousands of instruments in one scan, and doing so is exactly
the "market scanning" this phase explicitly excludes. Converting a bounded, fully-enriched shortlist
into something the Strategy Engine can safely consume is explicitly deferred to Phase 2B.

## Architecture

```
NASDAQ Trader source files → parse/classify → persist (standalone) → eligibility
                                                    │
                                                    ▼
                              (observability only, default off — see below)
                                                    │
                                                    ▼
                                                 Worker
                                                    │
                                                    ▼
                Strategy Engine → Position Manager → Portfolio Risk   (unchanged, untouched)
```

`getMarketUniverseSummary(client)` (`src/lib/market-universe/get-market-universe-summary.ts`) is the
only function that reads the universe from application code — it returns counts only (eligible
count, and a "complete market data" count that is always 0 in this phase — see below), never an
`Instrument`. It is gated by `MARKET_UNIVERSE_WORKER_ENABLED` (default `false`/absent): when off
(the default), the worker never touches the Market Universe at all; when explicitly on, the worker
additionally logs this summary once per scan cycle, purely for observability. Neither state changes
what the worker actually trades against.

## Data source selection

[NASDAQ Trader's official, free, no-API-key symbol directory files](http://www.nasdaqtrader.com/dynamic/SymDir/):

- `nasdaqlisted.txt` — every NASDAQ-listed security, all market tiers.
- `otherlisted.txt` — NYSE, NYSE American, and other exchanges, filtered to `Exchange ∈ {N, A}`
  (NYSE, NYSE American) — the phase spec names exactly these three exchanges, so Arca (P), BATS
  (Z), and IEXG (V) rows are dropped.

Free, no API key, no manually maintained list — the canonical listing directory most real trading
platforms use for symbol master data. Structurally excludes OTC (these files never list OTC/pink-
sheet tickers at all). Provides genuine, real fields for symbol, company name, exchange, ETF flag,
and test-issue flag. Has no price field and no explicit ADR/REIT flag (see "Filtering rules" and
"Known limitations").

Both files end with a `File Creation Time...` footer line, stripped by content match. On a symbol
collision between the two files (a real, documented edge case — `otherlisted.txt`'s own "NASDAQ
Symbol" column exists precisely because some symbols cross-list), the `nasdaqlisted.txt` row is kept
and the collision is logged, never silently dropped. Live verification found **0 collisions** on the
day tested, across **8,805 unique real symbols** (NASDAQ 5,556, NYSE 2,935, NYSE American 314).

## Refresh strategy

One full refresh (`refreshMarketUniverse`, `src/market-universe/refresh-market-universe.ts`):

1. Download both files (fails loudly on any error — see "safety property" below).
2. Parse, classify, and resolve collisions into one combined snapshot.
3. Diff the snapshot against the currently-persisted universe (`diffUniverseSnapshot`, pure,
   independently unit-tested) into new / delisted / metadata-changed / unchanged buckets — the
   expensive multi-column upsert only ever touches rows that genuinely changed; unchanged rows get
   only a cheap bulk `last_seen_at` touch, never a full rewrite.
4. Select and run one **capped, incremental** price-check batch (see below), recompute eligibility
   for exactly the symbols just checked.
5. Record the run's statistics to `market_universe_refresh_log`.

Writes are chunked at 500 rows per statement. **Safety property**: a failed download never touches
`market_universe_symbols` — the orchestrator throws plainly, the refresh-log row is marked `failed`
with the error, and the existing universe is left exactly as it was. A network blip degrades to
"yesterday's universe, one refresh late," never to "no universe" or a corrupt one.

### Price-check convergence — corrected design

The $1 price-eligibility floor needs a live quote per symbol; there is no free bulk source, and
Finnhub's free tier caps out around 60 calls/minute. An earlier version of this design checked 500
symbols/run with a 7-day staleness window for re-checks — but at 500/run, a first full pass over
~8,805 real symbols takes **~18 days**, longer than the 7-day window that was supposed to trigger
re-checks: an internal contradiction (re-checks were "due" before initial coverage even finished).

**Corrected, then corrected again against a real platform constraint found during live
verification**: 1,750/run was the first fix, but running the real refresh against the live Supabase
project surfaced that PostgREST silently caps any single response — including this
`.range()`-paginated batch-selection query — at **1,000 rows**, regardless of the requested limit.
`PRICE_CHECK_BATCH_SIZE = 1,000` is therefore the real, demonstrated ceiling per run, not a value
chosen freely. Real math, confirmed live: ~8,805 symbols / 1,000 per run ≈ **9 refresh runs** for one
full first pass at a daily cadence (~21 minutes/run including overhead, confirmed by two real runs).
`STALE_PRICE_CHECK_DAYS = 30` remains comfortably after that, so the design stays internally
consistent. The batch-selection query also skips any symbol with a settled listing-level exclusion
(delisted, test issue, unsupported type) — never worth an API call regardless of price.

**A second, more serious instance of the same row-cap surfaced and was fixed**: `getAllUniverseRows()`
(used both to fetch existing rows for diffing and to compute final refresh-log stats) did an
unqualified `.select("*")` with no pagination — silently capped at 1,000 rows out of the real 8,805,
which would have broken the diff's core idempotency guarantee (most of the universe would look "new"
on every re-run) and corrupted every reported statistic. Fixed by paginating both
`getAllUniverseRows()` and `getEligibleUniverseRows()` with `.range()` in a loop until a short page
signals the end — confirmed by a real second refresh run correctly reporting `0` new/changed/delisted
and `8,805` unchanged (see "Verification performed").

**Listing status and price-assessment status are separate fields.** A symbol whose price has never
been successfully checked gets `price_assessment_status = 'awaiting_check'` — it is **not**
"ordinarily excluded" (a settled business decision), it is "not yet knowable" (a temporary,
converging state). `exclusion_reason` now only ever holds the four genuine, settled reasons
(`delisted`, `test_issue`, `unsupported_instrument_type`, `price_below_minimum`); refresh-log stats
report `awaiting_price_check_count` as its own bucket, separate from `excluded_count`.

**Correctness fix, proven live**: `ExternalMarketDataProvider.getQuotes()` (the existing, shared,
unmodified Finnhub quote class used elsewhere in this app) calls `Promise.all()` internally — one
bad symbol in a batch call throws and discards every other quote from that call. Rather than reuse
that class (or widen it, out of scope), `price-eligibility.ts` fetches Finnhub's `/quote` endpoint
directly, **one symbol at a time**, each independently caught and rate-limited (~1 request/second).
Proven live: a batch of `AAPL, MSFT, <invalid symbol>, NVDA, IBM` returned real prices for all four
valid symbols; the invalid one failed alone without discarding the rest.

## Filtering rules

**Instrument-type classification** (`classifyInstrumentType`) returns both a type and its
**classification method** — a data-lineage field, not merely a code comment:

1. The source's real ETF flag → `etf`, method `source_flag` (the only classification ever backed by
   a real, sourced field).
2. Name matches ADR patterns → `adr`, method `name_pattern_inferred`.
3. Name matches REIT patterns → `reit`, method `name_pattern_inferred`.
4. Name matches warrant/right/unit/preferred patterns, or a NASDAQ 5th-character suffix convention
   (secondary, imperfect check) → `unsupported`, method `name_pattern_inferred`.
5. Otherwise → `equity`, method `name_pattern_inferred`.

**`name_pattern_inferred` classifications must never be treated as authoritative.** Live
verification found this matters concretely: of 8,805 real symbols, only 31 classified as REIT —
because most real REIT companies' officially-listed names do **not** contain the word "REIT" at all
(e.g. Realty Income Corporation is listed simply as "Realty Income Corporation Common Stock"). ADR
detection does not have this problem (296 real ADRs found; ADR names usually do say "ADR" or
"American Depositary..."). This is now a documented, verified limitation, not an assumption.

**ETFs, ADRs, and REITs are correctly identified but not excluded** — only a genuine `unsupported`
classification is excluded on instrument-type grounds.

**Eligibility ladder** (`computeListingExclusion` + `computeEligibility`) — Phase 2A **stage 1
only**, first-match-wins:

1. Not active (delisted) → excluded, `delisted`.
2. Test issue → excluded, `test_issue`.
3. Unsupported instrument type → excluded, `unsupported_instrument_type`.
4. Awaiting its first price check → **not eligible, but not excluded** (`exclusion_reason: null`).
5. Checked, price below $1 → excluded, `price_below_minimum`.
6. Checked, price ≥ $1 → eligible.

No liquidity filtering (volume/ADV thresholds) is implemented in this phase.

## Persistence model

Two new, additive tables — no changes to any existing table, migration, or schema.

**`market_universe_symbols`** — one row per real security ever seen, keyed by `symbol`. Rows are
never deleted, only marked `is_active = false` on delisting. Every field required by the spec is
present, plus explicit data-lineage columns: `classification_method` (concern 3/5),
`price_assessment_status` (concern 2), `price_provider` (concern 5, e.g. `'Finnhub'`), and real,
nullable `last_change_absolute` / `last_change_percent` / `last_day_high` / `last_day_low` — read
from the same Finnhub `/quote` response as `last_price`, at no extra API cost, **never fabricated as
0 when absent**. There is deliberately no `last_volume` column: Finnhub's basic quote endpoint has
no volume field at all, so there was nothing genuine to persist (see "Known limitations").

**`market_universe_refresh_log`** — one row per refresh run, now also reporting
`awaiting_price_check_count` as its own field, separate from `excluded_count`.

**RLS**: both tables have row level security **enabled with zero policies defined** (default-deny).
This is global, shared market-reference data (no `user_id`), and nothing but the service-role worker
and the standalone refresh CLI touch it in this phase.

## Worker integration

`src/worker/process-schedule.ts` is **unchanged** in what it trades against:
```diff
  import { instruments } from "@/lib/mock";   // unchanged, unconditional
  ...
+ if (getServerConfig().isMarketUniverseWorkerObservabilityEnabled) {
+   // best-effort log of getMarketUniverseSummary() — never affects `instruments` below
+ }
  const result = await executeBotScan({ instruments, ... });  // instruments is still @/lib/mock's list
```
`MARKET_UNIVERSE_WORKER_ENABLED` (env var, default off) controls only that optional log line. There
is no configuration in Phase 2A under which the worker trades against anything other than the
static 5-symbol list — this was a deliberate architectural constraint, not merely a default: the
existing pipeline has no safe way to evaluate thousands of instruments per scan, and no Market
Universe row is ever converted into a Strategy-Engine-shaped `Instrument` (see next section).

## Why no Market Universe row is converted into an `Instrument` in this phase

An earlier version of this design mapped a Market Universe row directly to an `Instrument`, filling
`changeAbsolute`/`changePercent`/`volume` with `0` when real data was unavailable — indistinguishable
from a genuine "flat, no-volume" reading once it reached `buildStrategyContext()`'s proxy-path
arithmetic. This was corrected two ways:

- Change and day-range data **are** genuinely available for free from the same Finnhub call already
  made for price, and are now captured as real, nullable columns — never fabricated.
- **Volume is never available** from Finnhub's basic quote endpoint, and the shared `Instrument`
  type (used throughout the untouched Strategy Engine and UI) has no way to express "unavailable"
  for a non-nullable `number` field — widening it is out of scope ("no existing trading logic should
  require modification"). So a Market Universe row is only ever converted to an `Instrument` if
  **every** field that conversion needs is genuinely real — since volume never is in Phase 2A, this
  conversion simply isn't built yet. `eligibleWithCompleteMarketDataCount` in the observability
  summary is always `0`, honestly, by design — not a placeholder, not an error.

This is "keep partially enriched universe records out of the Strategy Engine until Phase 2B,"
applied unconditionally. The day a real volume source exists, the same completeness gate starts
passing with no change to its own logic — only a new field to check.

## Verification performed

**Unit tests** — 34 tests across `platform/web/tests/market-universe/` (parsing, classification with
the new method/type shape, the two-stage eligibility split, diff logic including the new
`price_assessment_status`/lineage fields) plus 3 `server-config` tests (Finnhub pairing, the
observability flag's default-off and explicit-on behaviour), alongside the existing 39 (73/73
total). `npx tsc --noEmit` and `npm run lint` both clean.

**Live, real-data verification performed**:

- Downloaded both real NASDAQ Trader files live: 5,556 real NASDAQ rows, 3,249 real NYSE/NYSE
  American rows, **8,805 unique real symbols** combined, **0 collisions**.
- Real classification with the revised `{type, method}` shape: 1,326 ETF (all `source_flag`,
  matching the real ETF count exactly), 5,783 equity, 1,369 unsupported, 296 ADR, 31 REIT (all
  `name_pattern_inferred`) — confirming the classification-method lineage is correctly and
  consistently tagged.
- Spot-checked: `QQQ` → `etf`/`source_flag`; `AAPL` → `equity`/`name_pattern_inferred`; `O` (Realty
  Income, a genuine REIT) → `equity`/`name_pattern_inferred`, directly reproducing the documented
  REIT false-negative finding on live, current data.
- Real Finnhub price-check batch via the revised, self-contained `checkPrices()`: `AAPL`, `MSFT`,
  `NVDA`, `IBM` all returned real price **and** real change/change-percent/day-high/day-low (not
  null, not zero); a deliberately invalid symbol failed alone without discarding the other four
  results.
- **Real end-to-end refresh, after the migrations were applied**: first run downloaded and
  persisted all 8,805 real symbols (`newListingsCount: 8805`, `delistingsCount: 0`,
  `metadataChangesCount: 0`), then ran a real, rate-limited Finnhub price-check batch (1,000
  symbols, 1 failure, ~21 minutes) — this run is what surfaced the PostgREST row-cap bug described
  above, since its own reported stats (capped at the first 1,000 rows read back) were internally
  inconsistent with the real data.
- **After the pagination fix, a second real refresh run proved idempotency for real**: `newListings:
  0, delistings: 0, metadataChanges: 0, unchanged: 8805` — the diff correctly recognized every one of
  the 8,805 previously-seen symbols, not a subset. The run's own stats now reconcile exactly:
  `eligibleCount (1,868) + excludedCount (1,523) + awaitingPriceCheckCount (5,414) = 8,805`, and the
  exclusion breakdown (`unsupported_instrument_type: 1,369`, `test_issue: 25`) exactly matches the
  standalone classification test performed before any database write — direct proof the pagination
  fix now reads the true, full universe, not a truncated slice of it.
- **Real price-check data quality, sampled directly from the table**: every `checked` row carries a
  real, non-zero `last_price`/`last_change_absolute`/`last_change_percent`/`last_day_high`/
  `last_day_low` and `price_provider: "Finnhub"` — e.g. `AEHL: price=0.8845, change=-0.1855,
  changePercent=-17.34%, dayHigh=1.0174, dayLow=0.83` — genuinely fetched data, never a placeholder.
  Rows excluded at the listing level (e.g. `unsupported_instrument_type`) correctly stay
  `price_assessment_status: 'awaiting_check'` forever, since their price is never worth checking —
  confirmed live, not just in the design.
- **`getMarketUniverseSummary()`, both real paths**: called against the live, refreshed project,
  correctly returned `{ eligibleCount: 1868, eligibleWithCompleteMarketDataCount: 0 }` — the second
  field honestly `0`, exactly as designed, not fabricated. The fail-safe guard's exact query shape
  (matching on `status = 'completed'`) was confirmed to correctly return empty against a
  deliberately-non-matching condition, the same check `MarketUniverseNotReadyError` gates on.
- **Confirmed unconditionally**: `process-schedule.ts` still passes exactly the 5 mock symbols to
  `executeBotScan()` — verified by reading the file's own diff against the pre-Phase-2A original,
  not merely by describing the intended behaviour.

## Known limitations

- **This Supabase project's PostgREST caps any single response at 1,000 rows**, regardless of a
  requested `.limit()`/`.range()` size — discovered live during verification, not assumed in
  advance. Every function that needs the true full-table row count (`getAllUniverseRows`,
  `getEligibleUniverseRows`) now paginates with `.range()` in a loop to work around it; anyone adding
  a new "read everything" query against these tables must do the same, or risk silently operating on
  a truncated 1,000-row slice of an ~8,800-row (and growing) universe.
- **The worker's traded instrument list is unconditionally the 5-symbol mock list in this phase** —
  not merely the default; there is no supported configuration that changes this, because no safe
  conversion from a Market Universe row to a Strategy-Engine `Instrument` exists yet (see above).
- **REIT identification has a verified, real false-negative rate** — most REIT companies' listed
  names don't say "REIT" (confirmed: only 31 of 8,805 real symbols classified as REIT, implausibly
  low for the real US market). Reliable REIT identification needs a supplementary data source
  (e.g. SIC-code classification), out of scope for this phase's "no invented metadata" constraint.
  ADR identification does not have this problem.
- **No `last_volume` column exists** — Finnhub's basic quote endpoint never returns volume, so there
  was nothing genuine to persist. `eligibleWithCompleteMarketDataCount` is therefore always `0`.
- **`Instrument.assetClass`/`exchange`/`currency` remain dead code**, unchanged from before this
  phase.
- **The 5th-character NASDAQ suffix classification check is a secondary heuristic**, not a hard
  rule — documented, real exceptions exist.
- **Single-node, in-memory diff** — fine at this scale; a future scalability note for an order of
  magnitude more symbols, not built speculatively now.
- **Multi-run price convergence (~5 days for a first full pass) is by design**, not a limitation to
  fix.

## Recommended Phase 2B

- **A bounded, ranked shortlist** — the actual mechanism that would let the worker safely consume
  part of the Market Universe (candidate ranking, liquidity scoring, and a cap on how many
  instruments one scan evaluates) — explicitly out of scope for Phase 2A.
- **Liquidity filtering** (volume/ADV thresholds) — needs a different data source or endpoint than
  Finnhub's basic quote, which has no volume field.
- **A volume-capable price data source**, which — combined with the bounded shortlist above — is
  what would finally let `eligibleWithCompleteMarketDataCount` become nonzero and let a real
  Market-Universe-to-`Instrument` conversion be built safely.
- **A real diagnostics UI panel**, if operational visibility beyond the refresh CLI's own printed
  summary and the `market_universe_refresh_log` table becomes valuable.
- **A supplementary REIT classification source**, if accurate REIT identification becomes
  load-bearing for a future filtering stage.
- Revisit whether ADR/REIT should be excluded from eligibility (currently: identified but not
  excluded) if a future phase's requirements differ from this phase's reading of the spec.
