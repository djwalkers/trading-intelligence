# Decision Intelligence Architecture — Phase 2B

## Purpose

The Hermes trading runtime analyses the market roughly once a minute, but every analysis was
previously transient — visible only in the current process's own audit trail and diagnostics
output, gone once the runtime restarted. Phase 2B persists **every** analysis cycle into Supabase,
turning the platform's decision-making into a permanent, queryable, auditable history. Future
phases (performance analysis, learning, optimisation) build on this data; this phase only records
it — nothing here reads its own history back into a trading decision.

Read-only from a strategy perspective, by construction: nothing in this phase can influence
`MarketDecisionEngine`, strategy rules, indicator formulas, broker behaviour, execution logic,
scheduler timing, the risk engine, or Telegram. It observes a cycle's already-finished outcome and
writes it down, after the fact, on a best-effort basis that can never affect the cycle itself.

## Data flow

```
TradingRuntime.runCycleBody()                         (unmodified control flow)
  │
  ├─ buildMarketDecisionContext()  ──► real candles/indicators (Phase 2A, unmodified)
  ├─ runMarketDecisionCycleWithLifecycle()
  │     ├─ MarketDecisionEngine.evaluate()             (unmodified)
  │     ├─ PortfolioRiskEngine.evaluate()               (unmodified)
  │     └─ broker.placeMarketOrder() / closePosition()  (unmodified)
  │
  ▼ (cycle's real work has now fully finished — success or failure)
  │
  persistAnalysis()                                    ◄── Phase 2B, strictly additive
  │  ├─ buildAnalysisRecord()        pure: cycle outcome ──► AnalysisRunInput + AnalysisEventInput[]
  │  └─ AnalysisRepository
  │        ├─ saveAnalysis(run)      ──► INSERT market_analysis_runs   (one row per cycle)
  │        └─ saveEvents(id, events) ──► INSERT market_analysis_events (a handful of rows per cycle)
  │
  └─ any persistence failure: logged, swallowed — never rethrown, never changes the cycle's
     returned outcome (see "Runtime flow" below)
```

`AnalysisRepository` (`src/lib/hermes-execution/analysis/analysis-repository.ts`) is the **only**
place SQL is issued for this feature — `trading-runtime.ts` never sees a table or column name, only
plain domain objects (`AnalysisRunInput`, `AnalysisEventInput`).

Reads flow the other way, through the same repository, via two independent paths:

```
Browser (Decision Intelligence page)          External (Hermes Agent / curl)
        │                                              │
  anon-key client + the                        GET /api/hermes/analysis
  signed-in user's own                         (bearer-token auth, withHermesGuard)
  session (RLS-scoped)                                 │
        │                                     service-role client +
        │                                     HERMES_SUPABASE_USER_ID
        └──────────────┬───────────────────────────────┘
                        ▼
         SupabaseAnalysisRepository.getRecentAnalyses() /
                     .getStrategyPerformance()
```

Only the injected Supabase client and `userId` differ between these three consumers (the trading
runtime, the API route, the browser page) — `SupabaseAnalysisRepository` itself is identical code
in every case, mirroring `server-decision-history-store.ts`'s own established "same row mapping,
different auth" precedent for this codebase.

## Runtime flow — exactly what happens per cycle

1. `TradingRuntime.runCycleBody()` runs the cycle exactly as it always has (unchanged).
2. **On success**: after `TRADING_CYCLE_COMPLETED` is already recorded to the existing audit trail,
   `persistAnalysis({ kind: "success", snapshot, context, result, runtimeDurationMs })` is called —
   this **attempts** exactly one `saveAnalysis()` + one `saveEvents()` batch write.
3. **On failure**: after `TRADING_CYCLE_FAILED` is already recorded, `persistAnalysis({ kind:
   "failure", error, runtimeDurationMs })` is called instead — the runtime still **attempts** one
   analysis record, with `decision: "ERROR"` and the caught error's message/code. See "Persistence
   guarantees & limitations" immediately below for what "attempts" does and doesn't promise.
4. `persistAnalysis()` is wrapped in its own `try/catch` that never rethrows — a Supabase outage,
   RLS misconfiguration, or any other persistence failure is logged (structured — see below) and
   swallowed, exactly like `JsonFileAuditTrail.persist()`'s own established "catch internally, log,
   never propagate" discipline. `runCycleBody()`'s own returned `TradingCycleOutcome` (`kind:
   "completed"` / `"failed"`) is identical with or without analysis persistence enabled or working.
5. Exactly **one** `saveAnalysis()` attempt per cycle, always — because the cycle's full outcome
   (including whether a trade executed) is already known synchronously by the time
   `persistAnalysis()` runs, there is never a need to create a second record and update it later.
   `AnalysisRepository.markTradeExecuted()` exists as a genuine, tested repository capability (this
   phase's own required method) for a hypothetical future async-reconciliation step, but the
   current runtime integration never calls it.
6. When `HERMES_SUPABASE_USER_ID` / the Supabase service role aren't configured, `deps.analysis` is
   `undefined` and `persistAnalysis()` is a no-op — the runtime behaves byte-for-byte as it did
   before this phase existed.

## Persistence guarantees & limitations — read this before relying on completeness

Stated plainly, without overstating what this phase actually delivers:

- **The runtime attempts exactly one analysis-persistence operation per cycle. It does not
  guarantee that operation succeeds.** "Attempt" is the accurate word — a Supabase outage, network
  partition, or RLS misconfiguration during that window means the write simply fails.
- **A persistence failure never changes the trading decision or execution outcome.** This is a hard
  guarantee, not a best-effort one: `persistAnalysis()`'s `try/catch` cannot propagate, so
  `MarketDecisionEngine`'s decision and whatever the broker already did are completely unaffected
  either way (see the scheduler-integration tests in
  `trading-runtime-analysis-persistence.test.ts` for the assertions that pin this).
- **Failed writes are logged with the execution/cycle id.** Every failure logs `executionRunId`
  (the same id `TRADING_CYCLE_STARTED`/`_COMPLETED`/`_FAILED` audit events already use),
  `instrument`, `strategyId`, a short `errorCategory` (the Postgrest/Postgres error code when
  available, e.g. `"42501"` for an RLS denial — see `AnalysisPersistenceError`/
  `categorizeAnalysisPersistenceError` in `analysis-repository.ts`), and `persistenceEnabled`.
  Never a Supabase key, token, raw header, or full database response — only `.message` and the
  short category code.
- **Database outages create gaps in the analysis history, not corrupted or delayed records.** If
  `saveAnalysis()`/`saveEvents()` fails, that cycle's row(s) are simply absent from
  `market_analysis_runs`/`market_analysis_events` — there is no placeholder, no partial row, and
  nothing else in the pipeline is aware a gap exists beyond the error log itself.
- **There is no durable retry queue in this phase.** A failed write is not retried, queued to disk,
  or replayed later — this is a deliberate scope boundary for Phase 2B, not an oversight. A future
  phase could add one; this one does not.

## Database schema

Two tables (`supabase/migrations/0022_market_analysis_runs.sql`,
`0023_market_analysis_events.sql`):

### `market_analysis_runs` — one row per scheduler cycle

| Column | Notes |
|---|---|
| `id`, `user_id`, `created_at` | `user_id` scopes RLS — not part of the original suggested schema, added because "users only see their own data" is unenforceable without it |
| `runtime_mode`, `broker_provider`, `market_provider` | The pipeline config this cycle ran under |
| `instrument`, `timeframe`, `strategy_id`, `strategy_version` | |
| `current_bid`, `current_ask`, `current_mid`, `last_close` | |
| `ema20`, `ema50`, `rsi14`, `atr14`, `trend` | Exactly what `MarketIntelligenceBuilder` computed this cycle |
| `confidence`, `decision`, `decision_reason` | `MarketDecisionEngine`'s own output; `decision` includes `'ERROR'` for a failed cycle |
| `executed_trade`, `trade_id` | The broker's own position/trade id (a string, not a uuid) |
| `validation_ok`, `fallback_used`, `candle_count`, `data_age_seconds` | Mirrors the Phase 2A.1 diagnostics validation fields exactly |
| `runtime_duration_ms` | Wall-clock cycle duration — operational signal only |
| `error_code`, `error_message` | Set only when `decision = 'ERROR'` |
| `metadata` | `jsonb` catch-all: the full reasoning array, `blockedReasons`, trigger type |

Indexes: `created_at`, `instrument`, `strategy_id`, `decision`, `executed_trade` (as specified),
plus a composite `(user_id, created_at desc)` for the common "my own history, newest first" query.

### `market_analysis_events` — timeline events within one run

`analysis_run_id` (FK, cascade delete), `timestamp`, `event_type`, `severity`, `message`,
`payload jsonb`. `event_type` is a deliberately open vocabulary (no check constraint) — see
`ANALYSIS_EVENT_TYPES` in `src/lib/hermes-execution/analysis/types.ts` for the current set
(`CYCLE_STARTED`, `MARKET_DATA_FETCHED`, `INDICATORS_CALCULATED`, `DECISION_COMPLETED`,
`EXECUTION_STARTED`/`_SKIPPED`/`_COMPLETED`, `ERROR`) — a new event type never needs a migration.

### ER diagram

```
auth.users
    │ 1
    │
    │ *
market_analysis_runs ──────────────┐
    │ id (PK)                      │
    │ user_id (FK → auth.users)    │
    │ instrument, strategy_id,     │
    │ decision, executed_trade,    │
    │ ema20/ema50/rsi14/atr14, ... │
    │ 1                            │
    │                              │
    │ *                            │
market_analysis_events             │
    │ id (PK)                      │
    │ analysis_run_id (FK) ────────┘  on delete cascade
    │ timestamp, event_type,
    │ severity, message, payload
```

### Row Level Security

Both tables have RLS enabled. `market_analysis_runs` policies check `auth.uid() = user_id`
directly; `market_analysis_events` has no `user_id` column of its own and is scoped via a join back
to `market_analysis_runs.user_id`, exactly matching `trade_events`'s own established convention
(`0007_user_scoped_row_level_security.sql`). Writes only ever happen through the service-role
client (which bypasses RLS by design), but real `insert`/`update` policies exist anyway — the same
defense-in-depth discipline `decision_history`'s own migration already established — so a future
browser-side write path would already be correctly scoped without a further migration. Every secret
(tokens, broker credentials, Supabase keys, eToro instrument ids) stays out of this schema entirely
— see `analysis-repository.ts`'s own row mapping for exactly what is and isn't stored.

## Analytics

`computeStrategyPerformance()` and `computeStrategyUsage()`
(`src/lib/hermes-execution/analysis/analysis-analytics.ts`) are pure functions over an already-
fetched array of `AnalysisRun` — no SQL-level aggregation, independently unit-tested without a
database, and called identically by `SupabaseAnalysisRepository.getStrategyPerformance()` (server)
and the Decision Intelligence page's own summary panels (client), so the two can never disagree
about a number. Every figure — BUY/SELL/HOLD %, execution %, average RSI14/ATR14/runtime/
confidence, top traded instruments, most common trend, error rate, fallback rate — is computed from
already-recorded history, well after the cycles it describes have finished; none of it feeds back
into runtime behaviour.

## Deployment

```bash
# Apply migrations via the Supabase SQL editor or CLI, in order: 0022, then 0023
git pull && npm ci && npm run build

# New env vars (both required to enable persistence; safe to omit — the feature stays off
# otherwise, per "Runtime flow" step 6 above):
#   HERMES_SUPABASE_USER_ID=<the Supabase auth uuid this deployment's rows are written under>
#   SUPABASE_SERVICE_ROLE_KEY=<already required for other server-role features>

pm2 restart trading-runtime trading-web --update-env
```

`trading-runtime` and `trading-web` are this deployment's actual PM2 process names on the VPS —
`--update-env` ensures the newly-set `HERMES_SUPABASE_USER_ID`/`SUPABASE_SERVICE_ROLE_KEY` are
picked up rather than PM2 reusing the environment snapshot from the last start.

## Future learning roadmap

This phase deliberately stops at persistence and read-only display. It creates the substrate three
explicitly out-of-scope future phases would build on:

- **Performance analysis** — join `market_analysis_runs`/`market_analysis_events` against the
  existing `trade_events`/`decision_history` tables to answer "which analyses actually led to a
  profitable trade" — not built here; `trade_id` is recorded specifically so that join is possible
  later without a schema change.
- **Learning** — using this history as a training/evaluation set for a future model or rule-tuning
  process. Nothing in this phase computes or suggests a rule change; `decision_reason`/`metadata`
  are recorded with enough fidelity (the full `MarketDecision.reasoning` array, `blockedReasons`)
  for a future phase to reconstruct exactly why each decision was made.
- **Optimisation** — using `StrategyPerformanceSummary`-shaped aggregates across many strategies/
  instruments to inform future strategy design. `computeStrategyPerformance()`'s pure, filter-driven
  design (any `AnalysisFilter` in, one summary out) is intended to be directly reusable for that,
  without rewriting the aggregation logic.

None of these exist yet. This phase's own explicit boundary: record everything, change nothing.
