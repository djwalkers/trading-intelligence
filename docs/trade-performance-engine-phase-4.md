# Trade Performance Engine — Phase 4

## Purpose

The platform can analyse markets, create trade candidates, get them approved, and execute them —
but until now it had no objective record of how those executed trades actually turned out. Phase 4
adds a Trade Performance Engine: every closed trade is measured (P/L, return %, holding time, risk
multiple, MFE/MAE, drawdown, win/loss) and persisted, with per-strategy analytics and a dashboard on
top. This phase is purely observational — it measures trading quality, it does not attempt to
improve it. `MarketDecisionEngine`, every `Strategy`, `PortfolioRiskEngine`, the broker adapters,
`TradingScheduler`, `technical-indicators.ts`, and the trade approval workflow (`trade-candidate-
service.ts`, `trade-candidate-repository.ts`, the Trade Approval page) are all **unmodified**.

## Trade lifecycle, end to end

```
Analyse                 buildMarketDecisionContext()                (Phase 2A, unmodified)
  │
Decision                 MarketDecisionEngine.evaluate()             (Phase 3, unmodified)
  │
Trade Candidate           buildTradeCandidateInput()                  (Phase 3.5, unmodified)
  │
Persist                   TradeCandidateRepository.create()           (Phase 3.5, unmodified)
  │
Review UI / Approval       Trade Approval page, approveTradeCandidate() (Phase 3.5, unmodified)
  │
Execution                  executeApprovedTradeCandidate()
  │                          -> runMarketDecisionCycleWithLifecycle()  (unmodified, Milestones 2-6)
  │                          -> TradeLifecycleService.recordOpened()   (position OPEN)
  │                             … later, a SELL candidate closes it …
  │                          -> TradeLifecycleService.recordClosed()   (realisedPnl/MFE/MAE/holding
  │                                                                     time computed HERE, unmodified)
  ▼
Performance               TradingRuntime.persistTradePerformance()    ◄── Phase 4, strictly additive
  │  (one new, small, best-effort call in runCycleBody — see "Where the hook lives" below)
  │
  ├─ recordTradePerformanceForExecutedCandidate()
  │     ├─ candidateRepository.getById() / .list()   (existing, unmodified READS)
  │     ├─ lifecycleStore.getById()                  (existing, unmodified READ)
  │     ├─ buildTradePerformanceInput()               pure: PnL/return%/R/MFE/MAE/drawdown/win-loss
  │     └─ TradePerformanceRepository.upsert()        INSERT/UPDATE trade_performance (idempotent)
  │
  └─ any failure: logged, swallowed — never rethrown, never changes the cycle's own decision, risk,
     execution, or approval outcome
```

## Where the hook lives, and why

`TradeLifecycleStore` (Milestone 6) has never had a database implementation — it is still in-memory,
per-process (see its own top-of-file comment, unchanged). MFE/MAE, realised P/L, and holding time
only exist inside the **standalone trading-runtime process**, at the moment a `TradeLifecycleRecord`
transitions to `CLOSED`. Nothing outside that process can observe those figures at all — not the
web app, not a decoupled reconciliation job. Given that hard constraint, this phase adds one small,
additive, read-only, best-effort call to `TradingRuntime.runCycleBody()` — positioned exactly like
Phase 2B's own `persistAnalysis()` bolt-on, immediately after the existing (unmodified) candidate-
execution loop:

```ts
for (const candidateId of executedCandidateIds) {
  await this.persistTradePerformance(candidateId); // never throws — see its own doc comment
}
```

`persistTradePerformance` only ever calls existing, unmodified **read** methods
(`TradeCandidateRepository.getById`/`.list`, `TradeLifecycleStore.getById`) — it never writes to
either, never re-evaluates a decision, never re-runs risk, never calls the broker, and a failure
here can never affect the cycle's own outcome (see its own try/catch, mirroring `persistAnalysis`'s
"catch internally, log, never propagate" discipline exactly). `deps.tradePerformance` is optional,
same as `deps.analysis` — when it's undefined (the default), `TradingRuntime` behaves byte-for-byte
as it did before this phase existed.

## Schema — `trade_performance`

One row per closed trade (`supabase/migrations/0025_trade_performance.sql`), keyed uniquely on
`(user_id, trade_id)` so the hook above is idempotent (safe to call more than once for the same
close):

| Field | Source |
|---|---|
| `trade_id` | `TradeLifecycleRecord.id` — the natural, already-assigned identifier for one open-to-close lifecycle |
| `analysis_run_id` | The closing candidate's own `analysisRunId` (Phase 2B cross-reference) |
| `candidate_id` | The **closing** (SELL) `TradeCandidate.id` |
| `strategy_id` / `strategy_version` / `instrument` / `side` | From the lifecycle record |
| `entry_time` / `entry_price` / `exit_time` / `exit_price` / `holding_time_ms` | From the lifecycle record, unchanged |
| `gross_pnl` | `TradeLifecycleRecord.realisedPnl` |
| `fees` | Always 0 today — no fee modelling exists anywhere in this paper-trading pipeline; an explicit, documented parameter so a future live-fee integration has one seam to fill in |
| `net_pnl` | `gross_pnl - fees` |
| `return_percent` | `net_pnl / (entry_price × quantity) × 100` |
| `risk_multiple` (R) | `net_pnl / (|entryPrice - stopLoss| × quantity)`, using the **opening** BUY candidate's own stop-loss (found by `findOpeningCandidate` — the most recent EXECUTED BUY candidate for the same strategy+instrument, at or before the close). Null when unresolvable — never fabricated. |
| `max_favourable_excursion` / `max_adverse_excursion` (MFE/MAE) | From the lifecycle record, unchanged |
| `peak_profit` | `= max_favourable_excursion`, under a dashboard-friendlier name |
| `maximum_drawdown` | `max(0, peak_profit - net_pnl)` — how much of this trade's own peak was given back before it closed. A **per-trade approximation** from entry/exit/MFE/MAE snapshots only (this pipeline retains no full intra-trade price path) — distinct from the strategy-level, equity-curve drawdown the analytics layer separately computes. |
| `win_loss` | `WIN` / `LOSS` / `BREAKEVEN`, using the same £0.01 break-even threshold `DecisionIntelligenceView` already established |
| `exit_reason` | From the lifecycle record |

RLS (`auth.uid() = user_id`) is the actual permission boundary — read directly from the browser
(anon key + the signed-in user's session), same pattern `trade_candidates` already established.

## Performance Engine

`src/lib/hermes-execution/trade-performance/calculate-trade-performance.ts` — pure functions, no
I/O, independently unit-tested: `classifyWinLoss`, `calculateRiskMultiple`,
`calculatePeakProfitAndDrawdown`, `buildTradePerformanceInput`. `trade-performance-service.ts`
orchestrates: resolve the closing candidate → resolve the CLOSED lifecycle record → resolve the
opening candidate → build the input → upsert it.

## Analytics

`src/lib/hermes-execution/trade-performance/trade-performance-analytics.ts` — pure functions over an
already-fetched `TradePerformanceRecord[]`:

- **Per strategy** (`computeStrategyPerformance`/`computeAllStrategyPerformance`): win rate, loss
  rate, average winner, average loser, profit factor (undefined, never `Infinity`, with no losing
  trades), expectancy (mean net P/L), average holding time, maximum drawdown (equity-curve
  peak-to-trough over that strategy's own trades, ordered by exit time — a distinct, portfolio-level
  concept from any single trade's own `maximum_drawdown`), average R multiple (excluding trades with
  no resolvable R, never treating them as 0), best/worst trade, largest consecutive win/loss streaks
  (a `BREAKEVEN` breaks both streaks).
- **Equity curve** (`buildEquityCurve`): running cumulative net P/L, ordered by exit time.
- **Monthly summary** (`buildMonthlySummary`): trade count, win/loss count, net P/L, win rate,
  grouped by exit month.

## Dashboard — `/performance-analytics`

Reads `trade_performance` and `trade_candidates` directly from the browser (anon key + the
signed-in user's session — RLS-scoped, same pattern the Trade Approval page already established; no
server action exists here either). Never writes to either table.

- **Equity curve** — cumulative net P/L line.
- **P/L over time** — one bar per closed trade, coloured by outcome.
- **Win/loss** — a donut of WIN/LOSS/BREAKEVEN proportions.
- **Strategy comparison** — net P/L by strategy.
- **Trade duration** — a histogram of holding-time buckets.
- **Monthly summary** — a table.
- **Strategy analytics** — one card per strategy with every metric listed above.
- **Recent performance** — the 10 most recently closed trades.
- **Open positions** — *approximated*: an EXECUTED BUY candidate for a strategy+instrument with no
  later `trade_performance` row for that same strategy+instrument. Not a live broker read (see
  Limitations).
- **Closed positions** — every measured trade; clicking a row expands the **full chain** inline:
  Analysis → Indicators (EMA/RSI/ATR/trend, from the closing candidate's own frozen market context)
  → Decision (reasoning) → Trade Candidate (id, SL/TP) → Approval (who/when) → Execution (broker
  order id) → Performance (this row's own metrics). This is a read-only, in-page expansion — no
  cross-page navigation into the Trade Approval page was added, since modifying that page's UI is
  out of this phase's explicit scope.

## Performance impact

Zero impact on decision/risk/execution/approval latency or correctness: the new hook runs strictly
*after* a cycle's execution work has already fully completed, is wrapped in try/catch, and never
throws. Its own cost per cycle is bounded — 0 to (a handful of) reads against
`TradeCandidateRepository`/`TradeLifecycleStore` only when a candidate actually executed that cycle,
plus one `upsert` when it represents a close. A cycle with nothing executed pays nothing extra at
all.

## Tests

- `calculate-trade-performance.test.ts` — PnL, risk multiple, peak-profit/drawdown, win/loss
  classification, full input-building including its own data-integrity guards.
- `trade-performance-analytics.test.ts` — every per-strategy metric, equity curve, monthly summary.
- `trade-performance-repository.test.ts` — row mapping, upsert idempotency
  (`onConflict: user_id,trade_id`), user_id scoping (permission).
- `trade-performance-service.test.ts` — the chain-linking logic end to end against in-memory test
  doubles: resolves the opening candidate correctly, links `candidate_id`/`analysis_run_id`, is
  idempotent, degrades gracefully (no opening candidate, unknown candidate, BUY-direction execution).
- `trading-runtime-trade-performance.test.ts` — end to end through the **real** `TradingRuntime`: a
  full BUY-open → SELL-close cycle produces exactly one row; a broken performance repository never
  fails the cycle; the hook is a no-op when `deps.tradePerformance` is undefined.
- `tests/components/performance-analytics/dashboard.test.tsx` — every chart/table renders correctly
  for empty and populated data, and the Closed Positions row-expansion reveals every link in the
  chain (Analysis/Indicators/Decision/Candidate/Approval/Execution).

## Deployment

New migration: `supabase/migrations/0025_trade_performance.sql`. Trade performance persistence
reuses the same `HERMES_SUPABASE_USER_ID` + Supabase service-role configuration analysis persistence
and trade candidates already share — no new environment variables. Unlike trade-candidate
persistence (mandatory), this is optional: if unconfigured, `market-runtime.ts` logs "Trade
performance measurement disabled" and starts normally, exactly like analysis persistence's own
established precedent.

## Remaining limitations

- **"Open positions" is an approximation**, not a live broker/position read — `TradeLifecycleStore`
  (which knows the true state) is in-memory and unreachable from this app's process. A position
  opened by something other than an approved candidate (there is none today, but nothing enforces
  it structurally) would not appear.
- **`risk_multiple` is undefined for trades whose opening candidate can't be resolved** — e.g. a
  position that predates this pipeline, or where more than one BUY executed for the same
  strategy+instrument between closes in an unexpected order. Never fabricated as 0.
- **`maximum_drawdown` (per-trade) is an approximation**, not a true intra-trade peak-to-trough over
  a full price path — this pipeline retains no such path, only entry/exit/MFE/MAE snapshots.
- **No fee modelling** — `fees` is always 0; every figure here is pre-fee-adjustment paper-trading
  performance, not what a real brokerage account would net.
- **The chain is navigable only within this page**, not across pages — expanding a closed position
  shows every link inline; there is no deep link from here into the Trade Approval page's own UI
  (out of scope: that page is part of the protected trade approval workflow).
- **A cross-process gap **: because the hook lives in `trading-runtime.ts`, trade performance is
  only ever recorded by the standalone runtime process actually running the strategy — a
  candidate executed some other way (there is none today) would never produce a row.
