# Strategy Research Laboratory — Phase 5

## Purpose

The platform could measure how well the one live strategy actually performed (Phase 4), but had no
way to ask "would a different strategy have done better on the same market?" Phase 5 adds a research
framework: run any registered strategy against already-recorded historical analysis data, compare
two strategies side by side, and see exactly where and why their decisions and trades diverge — all
without affecting live trading in any way.

This phase touches **nothing** in the runtime, scheduler, broker, indicators, persistence layer,
Supabase schema, trade approval workflow, Phase 4 analytics, or any existing dashboard. It adds no
migration and no new table — every research run is computed on demand, in memory, and never
persisted anywhere.

## Architecture

```
Historical analysis data          market_analysis_runs (Phase 2B, unmodified — already-persisted)
        │
        │  SupabaseAnalysisRepository.getRecentAnalyses()     (existing, unmodified READ)
        ▼
reconstructContext()              pure: AnalysisRun -> MarketDecisionContext
        │                         (positionOpen supplied by the simulator below, not the
        │                          originally-recorded outcome)
        ▼
runStrategyResearch()              THE simulation loop, per strategy:
        │                            for each historical context, in chronological order:
        │                              strategy.evaluate(context)   (unmodified Strategy interface)
        │                              simulate entry/exit against the SAME price the live system
        │                              would have used (BUY at ask, SELL at bid), using the exact
        │                              same, unmodified P/L formulas trade-lifecycle/calculations.ts
        │                              already established (calculateRealisedPnl,
        │                              calculateHoldingDurationMs, calculateUnrealizedPnl) and the
        │                              same stop-loss formula build-trade-candidate.ts's
        │                              computeTradeLevels already established
        ▼
research-metrics.ts               pure: trades -> win rate/expectancy/profit factor/R/Sharpe/
        │                         drawdown/holding time/frequency/skipped, self-contained (does not
        │                         import Phase 4's own trade-performance-analytics.ts)
        ▼
research-comparison.ts            pure: two ResearchRunResult -> metric deltas, decision
                                   differences (matched by analysis_run_id), trade differences
                                   (matched by entry time)
```

Nothing above ever calls a broker, `PortfolioRiskEngine`, `TradeCandidateRepository`, or
`TradeLifecycleService` — a strategy's `evaluate()` call is pure, and the simulation that surrounds
it only ever appends to in-memory arrays. **Never places a trade. Never modifies production
history. Research mode is read-only** — enforced structurally: the research module has no import of
any write-capable interface at all.

## Two strategies to compare

The live registry (`trade-approval/default-strategy-registry.ts`, unmodified, never touched this
phase) has only ever had one strategy — DEMO-0001. For "Run Strategy A / Run Strategy B / Compare"
to mean anything, this phase adds a genuine second strategy: **RESEARCH-0001**
(`research/research-variant-strategy.ts`) — same overall rule shape as DEMO-0001 (EMA-trend entry
with an RSI band, Bearish-trend exit) but a materially tighter entry filter (a narrower 48-58 RSI
band vs. DEMO-0001's 45-65, and a higher EMA-gap-saturation threshold). Both are registered in a
**separate, research-only registry** (`research/research-strategy-registry.ts`) — a new
`InMemoryStrategyRegistry` instance that nothing outside this module ever imports.
`RESEARCH-0001` is never registered in the live registry and is therefore structurally unreachable
by `executeApprovedTradeCandidate` or any other live code path.

## Context reconstruction — what's approximated, and why it doesn't matter here

`market_analysis_runs` does not retain every field `MarketDecisionContext` defines — no raw
candles, no volume/dailyHigh/dailyLow/volatility24h. `reconstruct-context.ts` fills these in with
defensible defaults (empty candles, volume 0, dailyHigh/dailyLow from bid/ask) and computes
`marketSession` properly via the existing, unmodified `resolveMarketSession`. `positionOpen` is
never taken from the historical record — the simulator tracks its own, independent position state
per strategy per run, which is the entire point of a research comparison.

Critically, **`reconstruct-context.test.ts` proves this approximation is decision-neutral** for the
strategies this lab actually runs: it evaluates `Demo0001Strategy` against both a reconstructed
context and a fully-specified original context (with deliberately different volume/dailyHigh/
dailyLow/marketSession/recentCandles) and asserts identical actions, confidence, and criteria —
because DEMO-0001-family entry/exit/confidence logic only ever reads `ema20`/`ema50`/`rsi14`/
`atr14`/`trend`/`positionOpen`, all of which come from the real, stored analysis row, never
approximated. A future strategy that reads `volume` or `recentCandles` directly in its own decision
logic would need this documented as a real limitation for that strategy specifically (see
"Remaining limitations").

## Metrics (per strategy run)

`research-metrics.ts`, self-contained pure functions:

| Metric | Definition |
|---|---|
| Trades | Count of simulated closed trades |
| Win rate / loss rate | Wins or losses / trades (£0.01 threshold, same convention used throughout this platform) |
| Expectancy | Mean gross P/L per trade |
| Profit factor | Gross winnings / \|gross losses\| — undefined (never `Infinity`) with no losing trades |
| Average R | Mean risk multiple across trades with a resolvable stop-loss (via `computeTradeLevels`) — never fabricated as 0 for the rest |
| Sharpe ratio ("if possible") | mean(per-trade return %) / stdev(per-trade return %). **Not** an annualised, daily-returns Sharpe — trades are irregularly spaced, so there is no single period to annualise against. Undefined with fewer than 2 trades or zero variance. |
| Maximum drawdown | Peak-to-trough decline of the cumulative gross-P/L curve, in exit order |
| Holding time | Mean simulated holding duration |
| Trade frequency | Trades / opportunities (a 0–1 ratio: what fraction of decision points became a trade) |
| Opportunity frequency | Decision points evaluated, per day, across the requested window |
| Skipped trades | Count of HOLD decisions |

## Research page — `/strategy-lab`

Select Strategy A, Strategy B, an instrument, and a date range, then run. Reads
`market_analysis_runs` directly from the browser (anon key + the signed-in user's session, RLS-
scoped — the same pattern the Decision Intelligence, Trade Approval, and Performance Analytics
pages already established; no server action exists here either). Shows:

- **Equity curves** — both strategies' cumulative gross P/L, by trade sequence (not calendar time,
  since the two strategies take a different number of trades at different moments).
- **Performance differences** — every metric above, side by side, with a signed delta (B − A).
- **Decision differences** — every historical moment (matched by `analysis_run_id`) where the two
  strategies, shown the identical market data, decided differently.
- **Trade differences** — trades only one strategy took, and trades both took (matched by entry
  time) that closed with a different net result.

## Tests

- `reconstruct-context.test.ts` — field-by-field reconstruction, missing-field rejection, and the
  decision-neutrality proof described above.
- `research-metrics.test.ts` — every metric formula, including the profit-factor/Sharpe undefined-
  rather-than-Infinity/NaN edge cases.
- `run-strategy-research.test.ts` — a full chronological replay producing a real BUY→SELL trade,
  proof that only `getRecentAnalyses` is ever called (never a write method), two strategies
  genuinely diverging on the same historical window, fail-closed on an unregistered strategy id, and
  graceful filtering of ERROR/incomplete rows.
- `research-comparison.test.ts` — metric deltas, decision-difference matching, and trade-difference
  classification (only-A / only-B / divergent).
- `tests/components/strategy-lab/*.test.tsx` — every chart/table renders correctly for empty and
  populated comparisons.

## Deployment

No new migration, no new environment variable, no new Supabase configuration. The page requires
Supabase to be configured (same as every other data-backed page in this app) since there is nowhere
to read historical analysis data from otherwise.

## Remaining limitations

- **Depends entirely on `market_analysis_runs` already having rows** for the requested
  instrument/date range — a strategy research run over a window with no analysis history returns an
  empty result, not an error, but also cannot discover anything.
- **A future strategy that reads `volume`, `recentCandles`, `dailyHigh`/`dailyLow`, or
  `volatility24h` directly in its own decision logic** would see approximated values here (see
  "Context reconstruction" above) — not a concern for DEMO-0001 or RESEARCH-0001 today (proven by
  test), but worth re-verifying for any new strategy added to the research registry later.
- **Sharpe ratio is a simplified, per-trade-return approximation**, not a textbook annualised Sharpe
  ratio — documented explicitly, per this phase's own "if possible" framing.
- **A simulated position can end the research window still open** — trades that never closed within
  the requested date range are not counted (matches Phase 4's own "closed trades only" convention).
- **Research runs are ephemeral** — nothing is persisted; re-running the same parameters recomputes
  from scratch. There is no saved history of past research runs to browse later.
