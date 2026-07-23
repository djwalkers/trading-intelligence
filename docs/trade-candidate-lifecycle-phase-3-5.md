# Trade Review & Approval — Phase 3.5

## Purpose

Before this phase, `TradingRuntime.runCycleBody()` called the broker automatically the moment
`MarketDecisionEngine` returned a BUY/SELL decision (subject only to `PortfolioRiskEngine`'s
automatic checks). Phase 3.5 inserts a mandatory human review step between decision and execution:
**automatic execution is off unconditionally** — every BUY/SELL decision becomes a `TradeCandidate`
awaiting explicit approval on the new Trade Approval page, and the broker is only ever called for a
candidate a human has approved.

`MarketDecisionEngine`, every `Strategy`, `PortfolioRiskEngine`, the broker adapters, and
`technical-indicators.ts` are all **unmodified** by this phase. The `TradingScheduler` (tick timing)
is also unmodified. What changed is *when* the existing risk-check-and-broker-call pipeline runs —
gated behind approval instead of running automatically inside every cycle.

## New flow

```
Analyse            buildMarketDecisionContext()                    (unmodified, Phase 2A)
  │
  ▼
Decision            MarketDecisionEngine.evaluate()                (unmodified, Phase 3)
  │
  ├─ HOLD  ──────────────────────────────────────────────────────► nothing further happens
  │
  ▼ BUY / SELL
Trade Candidate      buildTradeCandidateInput()                    entryPrice/stopLoss/takeProfit/
  │                                                                 riskReward computed for review;
  │                                                                 frozen { marketContext,
  │                                                                 marketDataSnapshot, amount }
  │                                                                 snapshot saved for later replay
  ▼
Persist              TradeCandidateRepository.create()             INSERT trade_candidates (status
  │                                                                 PENDING)
  ▼
Review UI            /trade-approval (this app, browser-direct      human reads strategy, reasoning,
  │                   Supabase, RLS-scoped)                         EMA/RSI/ATR/trend, confidence,
  │                                                                 entry/SL/TP/risk:reward
  ▼
Approved?    ── No (Reject) ──────────────────────────────────────► REJECTED, never executes
  │
  │ Yes (Approve)
  ▼
  … candidate is now APPROVED; execution happens on a LATER trading-runtime cycle, not
    synchronously in the approval request (see "Why execution is deferred" below) …
  ▼
Broker               executeApprovedTradeCandidate()                replays the frozen snapshot
                      → runMarketDecisionCycleWithLifecycle()        through the exact same,
                        ├─ MarketDecisionEngine.evaluate()           unmodified pipeline this
                        ├─ PortfolioRiskEngine.evaluate()            runtime always had — just
                        └─ broker.placeMarketOrder()/closePosition() invoked later, once, on
                                                                      approval instead of always,
                                                                      automatically
```

Every cycle of `TradingRuntime.runCycleBody()` now does two things, in order:

1. **Execute approved work.** Expire any stale candidates (`sweepExpiredCandidates`), then execute
   every `APPROVED` candidate for this strategy+instrument via `executeApprovedTradeCandidate` —
   the *only* place this runtime ever calls the broker.
2. **Decide and propose.** Build a fresh `MarketDecisionContext`, evaluate it, and — for BUY/SELL
   only — persist a new `PENDING` candidate. Never touches the risk engine or the broker.

## TradeCandidate lifecycle

```
                 ┌────────────┐
    created ───► │  PENDING   │
                 └─────┬──────┘
        approve()      │      reject()          expiresAt passes
        ┌───────────────┼───────────────┐              │
        ▼               │               ▼              ▼
  ┌────────────┐         │        ┌────────────┐  ┌────────────┐
  │  APPROVED  │         │        │  REJECTED  │  │  EXPIRED   │
  └─────┬──────┘         │        └────────────┘  └────────────┘
        │  (terminal — no further transition; a human already decided)
        │
   next cycle's executeApprovedTradeCandidate()
        │
   ┌────┼──────────────┐
   ▼    ▼               ▼
┌────────────┐   ┌────────────┐   ┌────────────┐
│  EXECUTED  │   │   FAILED   │   │  EXPIRED   │
└────────────┘   └────────────┘   └────────────┘
   (terminal)   (risk re-check      (expiresAt passed
                 blocked it, or      before a runtime
                 the broker call     cycle got to it)
                 threw)
```

Enforced by `VALID_CANDIDATE_TRANSITIONS` / `assertValidCandidateTransition`
(`src/lib/hermes-execution/trade-approval/types.ts`) and, at the persistence layer, by
`TradeCandidateRepository.transition(id, from, patch)` — an **atomic, conditional** update
(`UPDATE ... WHERE id = ? AND user_id = ? AND status = ?`) that only applies when the row's current
status still equals `from`. This is what makes duplicate approval, a rejection racing an expiry
sweep, or two runtime cycles both trying to execute the same candidate all safe: the second attempt
simply matches zero rows and the caller receives `"already-handled"`, never a double transition and
never a thrown error.

| From | To | Trigger |
|---|---|---|
| PENDING | APPROVED | Human clicks Approve (candidate not yet expired) |
| PENDING | REJECTED | Human clicks Reject |
| PENDING | EXPIRED | `expiresAt` passed before a decision was made — including an approval *attempt* on an already-expired candidate, which expires it rather than approving it |
| APPROVED | EXECUTED | A later runtime cycle's risk re-check passed and the broker call succeeded |
| APPROVED | FAILED | The risk re-check now blocks it (account/position state changed since approval), or the broker call threw |
| APPROVED | EXPIRED | `expiresAt` passed before any runtime cycle got to executing it |

`REJECTED`, `EXPIRED`, `EXECUTED`, and `FAILED` are all terminal — there is no retry-from-failure
path in this phase (matches `TradeLifecycleStatus`'s own precedent of no retry-from-`EXECUTION_FAILED`).

## Why execution is deferred to a later cycle, not the approval request itself

The Trade Approval page runs inside this Next.js app; the broker, `PortfolioRiskEngine`, and
`TradeLifecycleService` instances the trading pipeline actually uses live inside the **standalone**
Hermes trading-runtime process (`src/hermes-execution/market-runtime.ts`) — a different, long-running
process, typically on a different machine (see the VPS deployment runbook). For the default
`LocalPaperBroker`, positions/account state are file-backed on that process's own disk, not visible
to the web app at all. The `trade_candidates` table is the coordination channel between the two:
the web app only ever flips a row's `status` (`PENDING → APPROVED/REJECTED`); the runtime process,
which already ticks on its own schedule, is the only thing that ever calls the broker. This means
there is up to one scheduler interval of latency between approval and execution — a deliberate,
documented trade-off, not an oversight (see "Remaining limitations").

## Trade candidate data model

`src/lib/hermes-execution/trade-approval/types.ts` (`TradeCandidate`) / `supabase/migrations/0024_trade_candidates.sql`:

| Field | Notes |
|---|---|
| `analysisRunId` | Best-effort cross-reference to `market_analysis_runs.id` (Phase 2B) — nullable; that layer is itself best-effort and can be silently missing. The candidate row's own fields below are the durable record regardless. |
| `strategyId` / `strategyVersion` / `instrument` / `direction` | Identity of the decision. |
| `confidence` | `MarketDecision.confidence`, unmodified. |
| `entryPrice` / `stopLoss` / `takeProfit` / `riskReward` | Computed for review only by `computeTradeLevels` (ATR-based, `build-trade-candidate.ts`) — informational, never enforced as a bracket order, never fed back into the strategy or engine. |
| `reasoning` / `validationNotes` | `MarketDecision.reasoning` / `.validationNotes` verbatim. |
| `execution` | Frozen `{ marketContext, marketDataSnapshot, amount }`, replayed verbatim at execution time — never re-fetched, so execution always matches exactly what was reviewed. |
| `expiresAt` | `createdAt + HERMES_TRADE_CANDIDATE_EXPIRY_MINUTES` (default 20 minutes). |
| `status` / `approvedAt` / `approvedByUserId` / `rejectedAt` / `rejectedByUserId` / `rejectionReason` / `executedAt` / `lifecycleRecordId` / `brokerOrderId` / `failureReason` | The full, durable history of what happened to this candidate — satisfies "every approval/rejection/execution/failure remains linked to the originating analysis" via the row itself, independent of the best-effort audit trail below. |

A parallel, best-effort audit trail (`AuditTrail.record`) also fires `TRADE_CANDIDATE_CREATED` /
`_APPROVED` / `_REJECTED` / `_EXPIRED` / `_EXECUTED` / `_EXECUTION_FAILED` events — named distinctly
from the pre-existing `TRADE_APPROVED` event (Milestone 6, meaning "PortfolioRiskEngine's automatic
check passed," nothing to do with a human) to avoid colliding with that already-shipped meaning.

## Permission model

The Trade Approval page reads and writes `trade_candidates` directly from the browser — the anon
Supabase key plus the signed-in user's own session — exactly like `SupabaseDecisionHistoryStore` and
`SupabaseAnalysisRepository` already do elsewhere in this app. There is no separate server action or
bearer-token layer for approve/reject. The actual, database-enforced permission boundary is Postgres
Row Level Security (`auth.uid() = user_id`, `0024_trade_candidates.sql`) — a signed-in user's
Supabase requests are authenticated by their own session JWT regardless of what the client-side code
claims, so one user's session can never read, approve, reject, or execute another user's candidates.
`SupabaseTradeCandidateRepository` additionally scopes every query by the constructed `userId` at
the application level (`.eq("user_id", ...)`) as defense in depth. Both layers are covered by
`tests/hermes-execution/trade-approval/trade-candidate-repository.test.ts`.

`approveTradeCandidate` / `rejectTradeCandidate` (`trade-candidate-service.ts`) are the **same**
functions the standalone runtime process itself would use — one shared implementation of "what
counts as a valid approval/rejection," not a second, parallel copy of that logic in the UI.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `HERMES_TRADE_CANDIDATE_EXPIRY_MINUTES` | 20 | How long a candidate stays valid before the next cycle's sweep marks it `EXPIRED` instead of acting on it. |

Trade candidate persistence reuses the same `HERMES_SUPABASE_USER_ID` + Supabase service-role
configuration Phase 2B's analysis persistence already established (`analysis-persistence-config.ts`)
— the same Supabase Auth user owns both a deployment's analysis rows and its trade candidates.
Unlike analysis persistence, this is **not optional**: `market-runtime.ts` refuses to start the
runtime at all if it cannot construct a `TradeCandidateRepository`, since a candidate with nowhere
durable to go could never be reviewed from the (separate-process) Trade Approval page.

## Testing

- `tests/hermes-execution/trade-approval/build-trade-candidate.test.ts` — entry/SL/TP computation.
- `tests/hermes-execution/trade-approval/trade-candidate-service.test.ts` — creation (BUY/SELL vs.
  HOLD), **approval**, **rejection**, **expiry** (both "expires instead of approving" and "expires
  instead of executing"), **duplicate approval**, **execution** (success and risk-blocked-at-
  execution-time failure).
- `tests/hermes-execution/trade-approval/trade-candidate-repository.test.ts` — row mapping and
  **permission** (user_id scoping on every method, including a cross-user transition attempt).
- `tests/hermes-execution/runtime/trading-runtime.test.ts` — a BUY decision creates a candidate and
  never touches the broker automatically; a candidate approved in one cycle is executed on the next.
- `tests/hermes-execution/runtime/trading-runtime-analysis-persistence.test.ts` — a candidate's
  `analysisRunId` cross-references the Phase 2B row saved the same cycle.

## Remaining limitations

- **Execution latency.** Up to one scheduler interval passes between approval and execution (see
  "Why execution is deferred" above) — not immediate.
- **No retry from FAILED.** A candidate whose execution failed (e.g. risk blocked it at execution
  time) is terminal; there is no re-approval or retry path in this phase.
- **`lifecycleRecordId` is not durably joinable today.** `TradeLifecycleStore` has only an
  in-memory implementation (`InMemoryTradeLifecycleStore` — see trade-lifecycle/trade-lifecycle-store.ts's
  own doc comment); the id recorded on an `EXECUTED` candidate is a label, not a guaranteed-queryable
  foreign key, until a durable lifecycle store ships.
- **`analysisRunId` is best-effort.** Phase 2B's analysis persistence can silently fail to write
  (see its own "Persistence guarantees & limitations"); when it does, a candidate's
  `analysisRunId` is simply absent — the candidate's own reasoning/indicator fields remain the
  durable record regardless.
- **CLI (`market-decide.ts`) is unaffected.** This phase only gates the standalone scheduler
  (`TradingRuntime` / `market-runtime.ts`); the manual, single-shot CLI entry point still calls
  `runMarketDecisionCycleWithLifecycle` directly, unchanged. It was already a manual, human-invoked
  action before this phase, so it was not brought into scope.
