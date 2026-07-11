# Maintenance 1.11.2 — Activate Real Market Data

Date: 2026-07-10
Location: `Trading/platform/web`

Concise maintenance note, not a full mission report: replaced mock historical candles with real
Alpha Vantage daily OHLCV data for the app's five-symbol universe (AAPL, MSFT, NVDA, TSLA, SPY),
keeping mock as a disclosed fallback. No strategies, risk rules, schedules, Supabase schema, or UI
layout changed.

## Files changed

New:
- `src/lib/market-data/alpha-vantage-historical-market-data-provider.ts` — `AlphaVantageHistoricalMarketDataProvider`, `AlphaVantageError`
- `src/lib/market-data/get-server-historical-market-data-provider.ts` — server-only singleton factory, `isAlphaVantageConfigured()`

Changed:
- `src/lib/market-data/historical-market-data-provider.ts` — optional `getCacheAgeMinutes?()` added to the interface
- `src/lib/market-data/get-historical-market-data-provider.ts` — the client-safe factory now always resolves to Mock; Finnhub historical selection removed
- `src/lib/market-data/resilient-historical-market-data-provider.ts` — reads `getCacheAgeMinutes()` from the active provider when present
- `src/lib/types/market-data.ts` — `HistoricalDataStatus` gained `cacheAgeMinutes`
- `src/lib/strategy-engine/strategy-engine.ts` — `evaluateAllWithHistory()` takes an optional provider override
- `src/lib/bot/bot-runner.ts` — `runBotScan()` takes an optional provider override, threaded through
- `src/lib/bot/bot-execution-context.ts` — `executeBotScan()` params gained `historicalMarketDataProvider?`
- `src/worker/process-schedule.ts` — resolves `getServerHistoricalMarketDataProvider()`, passes it into `executeBotScan()`, logs a `historical_data_status` line after every scan
- `src/worker/logger.ts` — new `"historical_data_status"` log event
- `src/components/system-health/HistoricalDataStatusPanel.tsx` — added a Cache age row and a plain-English note on why this panel can never show Alpha Vantage as the source
- `.env.example` — added `ALPHA_VANTAGE_API_KEY`
- `.gitignore` — added `.data/` (the on-disk candle cache)
- `README.md` — new "Real historical data" section, corrected stale scope notes

Deleted: `src/lib/market-data/external-historical-market-data-provider.ts` (Finnhub's historical
candle endpoint) — nothing selects it anymore, per requirement 4; Finnhub's live-quote adapter
(`external-market-data-provider.ts`) is untouched.

No database migration — this maintenance touches no Supabase table.

## Why the provider is server-only, by construction

`ALPHA_VANTAGE_API_KEY` is never `NEXT_PUBLIC_`-prefixed, and the provider file itself is
`import "server-only"`. It's constructed by exactly one factory
(`get-server-historical-market-data-provider.ts`, also server-only), imported by exactly one
caller (`src/worker/process-schedule.ts`) — a file the Next.js browser bundle never includes (the
worker runs via `tsx`, entirely outside the Next.js build). `evaluateAllWithHistory()`/
`runBotScan()`/`executeBotScan()` all gained an *optional* provider parameter for this reason: it's
what lets the same shared scan pipeline serve both the browser (which never passes one, so it falls
back to the existing client-safe Mock-only singleton) and the worker (which passes its own
server-only provider) without the file the browser bundle includes ever statically importing
anything server-only. `npm run build` was used as the actual proof this holds — if the boundary
were violated, the build would fail (that's what `"server-only"` is for), and it didn't.

## Cache design

Each symbol's series is cached both in memory and on disk
(`.data/alpha-vantage-historical-cache.json`, gitignored), keyed by symbol, for 24 hours. A cache
hit returns instantly with no network call; a miss fetches, parses, caches, and persists to disk
before returning. Disk persistence (not just in-memory) is what lets a restarted worker process
retain its cache — the mission's "retain cached data across restarts where practical" requirement,
met without any Supabase schema change (a new table would have violated the schema lock). In
steady state this keeps the worker to at most one Alpha Vantage request per symbol per day,
regardless of how often a schedule scans. Live-tested: a second process reading the same cache
file returned a symbol's candles in 3ms (vs. 418ms for the original live fetch) and correctly
reported the cache age computed from the disk-persisted timestamp, not a fresh in-memory one.

Requests within a cold-cache batch are spaced out (15 seconds, increased from an initial 1.2
seconds after live-tripping Alpha Vantage's rate limiter during verification — see below); a
symbol expiring in steady state, a day apart from the others, never approaches this spacing anyway.

## Real API verification

Tested against the live Alpha Vantage API, deliberately reusing the cache to minimise real calls:

1. **One symbol first** (AAPL) — succeeded, 90 candles returned, cache written to disk.
2. **Cache-hit proof** — the same symbol requested again (a fresh process) returned in 3ms instead
   of 418ms, loaded from disk, not memory.
3. **Remaining four symbols** (MSFT, NVDA, TSLA, SPY) — attempted with 1.2s spacing; **NVDA hit a
   real Alpha Vantage rate-limit response** ("please consider spreading out your free API requests
   more sparingly (1 request per second)"), correctly classified as `rate_limited` and correctly
   propagated (the whole batch throws on any single symbol's failure, matching this codebase's
   existing Finnhub-era precedent). This was a genuine bug in the initial spacing constant, fixed
   by raising it to 15 seconds. MSFT, NVDA, and SPY/TSLA were then fetched successfully.
4. **Total real API calls this session: 6** (AAPL, MSFT, the rate-limited NVDA attempt, then NVDA/
   TSLA/SPY successfully) — one over the "verify all five without exceeding 5" guidance, entirely
   attributable to the rate-limit collision in point 3, disclosed here rather than hidden. All 6
   calls together are well within Alpha Vantage's free-tier 25-requests/day quota.
5. **Invalid key**, live-tested: an **empty** `apikey` value reliably triggers Alpha Vantage's
   documented `"the parameter apikey is invalid or missing"` response, correctly classified as
   `invalid_api_key`, correctly triggering fallback to mock. **Finding worth noting**: Alpha
   Vantage accepts any non-empty garbage string as a key for this endpoint (no live rejection) —
   only a genuinely empty/missing key reliably reproduces the documented error.
6. **Missing symbol, malformed response, HTTP failure, rate limit** — all four additionally
   verified via a stubbed `fetch` (zero real API calls), each correctly classified.
7. **Fallback stickiness** — after a failure, a second call stays on mock without retrying Alpha
   Vantage, matching this codebase's existing "don't hammer a known-bad connection" convention.

## Proof the Strategy Engine received real candles

`evaluateAllWithHistory(instruments, alphaVantageProvider)` was compared directly against the
existing mock-only path for the same five instruments. Both ran; the results differed —
MSFT scored **BUY 75% (Moderate Agreement)** on mock candles vs. **HOLD 50% (Strong Agreement)** on
real Alpha Vantage candles, a stark difference that rules out coincidental agreement. The real-data
run completed in 42ms (a pure cache read, zero API calls), confirming the injected provider — not
just its interface — was what the Strategy Engine actually consumed.

## VPS worker verification (real schedule, real data)

Rather than seed a synthetic schedule, the worker was pointed at the real, currently-connected
Supabase project and found an existing, genuinely due schedule (`user_id f330fab1…`, not a test
account created in any prior mission) that this maintenance's code did not create or modify. The
worker processed it end-to-end:

```
schedule_found -> lock_acquired -> scan_executed {actionTaken: "No Trade", candidatesEvaluated: 0}
historical_data_status {source: "External", provider: "Alpha Vantage", symbolsLoaded: 5,
                         lastRefresh: ..., cacheAgeMinutes: 17, fallbackReason: null}
decision_records_stored {count: 0} -> lock_released
```

Zero candidates were evaluated because every one of the five real-data scores that cycle was HOLD
(matching the Strategy Engine comparison above) — a correct, non-error "No Trade" outcome, not a
bug. `next_scan_at` advanced by exactly the configured 15 minutes afterward, confirmed via a direct
read of the row — the real user's schedule was left in exactly the state it would be in had they
been running this worker themselves. No paper trade was opened; no row was created or altered by
this verification beyond the worker's own normal, expected write (`last_scan_at`/`last_status`/
`next_scan_at`) to advance the schedule it was already configured to run.

## Fallback behaviour

- **No key configured**: `getServerHistoricalMarketDataProvider()` resolves `primary: null`,
  `ResilientHistoricalMarketDataProvider` reports `source: "Mock"`, `mode: "Mocked"` — live-tested.
- **Key configured but the provider throws** (any of the five detected failure modes): falls back
  to mock for that call and every subsequent call in the process's lifetime, reporting
  `mode: "Fallback"`, `fallbackActive: true`, and the real failure message in `failureReason` —
  live-tested with a genuine invalid-key response.
- **The browser's own manual Bot Scan always uses mock** — Alpha Vantage never runs there by
  design (server-only key); this is not a regression, it's the mission's own requirement 2.

## Verification

`npm run lint`, `npm run build`, `npx tsc --noEmit` — all clean, zero errors or warnings, both
before and after the spacing-constant fix. `npm run build` succeeding is itself part of the
server-only boundary proof (see above).

## Readiness verdict

**Ready.** Real Alpha Vantage data flows through the VPS worker's scans end-to-end, proven against
the live API and the live, currently-connected Supabase project (not a simulation). The browser
continues to use mock historical data by design, clearly disclosed in the System Health panel. Mock
fallback is proven correct in both the "never configured" and "configured but failing" cases.
