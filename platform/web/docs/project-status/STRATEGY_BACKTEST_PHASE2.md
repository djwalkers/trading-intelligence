# Deterministic Backtesting Foundation — Phase 2

**Status:** Deterministic, offline, read-only backtest engine + CLI for Phase 1 declarative
strategies. No provider/broker call, no PM2 action, no live runtime integration, no automatic
promotion mechanism. No risk, approval, execution, lifecycle, reconciliation, or Telegram behaviour
changes as a result of this phase.

## Purpose

Phase 1 (`strategy-definitions/`) gave the platform a validated, versioned, declarative strategy
schema with no execution semantics of its own. Phase 2 adds the first thing that can actually *run*
one of those documents: a deterministic simulation against a fixed, local historical candle dataset,
producing a self-contained, reproducible result — never a claim about future performance, never a
path into demo/live trading.

## Files

- `src/lib/hermes-execution/backtest/backtest-dataset.ts` — the fixed local candle dataset schema,
  its pure validator, its SHA-256 content hash, and the one piece of file I/O in this phase
  (`loadCandleDataset`).
- `src/lib/hermes-execution/backtest/rule-evaluator.ts` — causal indicator series computation
  (reuses `technical-indicators.ts`'s existing `calculateEma`/`calculateRsi`/`calculateAtr`
  unmodified) and `RuleNode` evaluation against those series — the one place a Phase 1 rule tree is
  ever evaluated, still never as code.
- `src/lib/hermes-execution/backtest/backtest-engine.ts` — the long-only, one-position,
  next-bar-execution simulation loop, cost application, and per-segment metrics.
- `src/lib/hermes-execution/backtest/backtest-result.ts` — orchestrates a full run (optionally split
  into in-sample/out-of-sample segments), computes the run fingerprint, and assembles the final
  result object.
- `src/lib/hermes-execution/backtest/backtest-persistence.ts` — atomic, create-only evidence file
  writer, used only when a caller explicitly asks for it.
- `src/hermes-execution/strategy-backtest-cli.ts` — the `npm run strategy:backtest` entrypoint.
- Tests: `tests/hermes-execution/backtest/*.test.ts`, `tests/hermes-execution/strategy-backtest-cli.test.ts`.

## Relationship to everything else

Nothing in this phase is imported by, or imports, any of: `runtime/trading-runtime.ts`, any broker
adapter, `trade-lifecycle/`, `trade-approval/`, `portfolio-risk-engine.ts`, `telegram/`, or
`registry-client.ts`. A backtest result is a plain, inert JSON value — nothing in this codebase reads
one back and acts on it. Promoting a strategy from `APPROVED_FOR_BACKTEST` (or any other status) to
something demo/live-eligible remains entirely outside this phase's scope and does not happen anywhere
in this code, automatically or otherwise — see `strategy-definition.ts`'s own `usableForDemo`, still
unconditionally `false`.

## Dataset requirements (`backtest-dataset.ts`)

A dataset is one local JSON file:

```json
{
  "schemaVersion": 1,
  "instrument": "BTC",
  "timeframe": "1h",
  "source": "free-text provenance, e.g. \"eToro historical export, 2026-01-01..2026-03-01\"",
  "candles": [
    { "timestamp": "2026-01-01T00:00:00.000Z", "open": 100, "high": 101, "low": 99, "close": 100.5, "volume": 10 }
  ]
}
```

Validated explicitly, never repaired:

- `timeframe` must be one of the existing `SUPPORTED_MARKET_TIMEFRAMES` (`candle-validation.ts`).
- At least 2 candles.
- Every OHLC value finite and positive; `high >= low`; `open`/`close` within `[low, high]`.
- `volume`, if present, finite and non-negative.
- Timestamps strictly increasing, no duplicates.
- **Every consecutive gap must exactly equal the declared timeframe's duration** — deliberately
  stricter than the live pipeline's own `candle-validation.ts` (which tolerates jitter and, for
  equities, market-closure gaps): a *fixed, already-captured* dataset has no live-feed jitter to
  absorb, so any deviation is treated as a malformed/incomplete file, not something to route around.

A validated dataset's `datasetHash` (SHA-256, via the same `canonicalStringify` Phase 1 uses for
strategy content hashing) covers only `{schemaVersion, instrument, timeframe, candles}` — never the
file path, `source` text, or load time, mirroring Phase 1's own content-hash-vs-provenance split.

## No-look-ahead

- Every declared indicator's value at bar `i` is computed from `candles[0..i]` alone
  (`computeIndicatorSeries`) — appending, removing, or mutating any bar after `i` never changes bar
  `i`'s own value. Proven directly in `tests/hermes-execution/backtest/no-look-ahead.test.ts`.
- `CROSSES_ABOVE`/`CROSSES_BELOW` compare the prior completed bar (`i - 1`) against the current one
  (`i`) — always `false` at `i === 0` (never a vacuous true from an assumed prior state).
- Every other operator (comparisons, `BETWEEN`, `AND`/`OR`) reads bar `i` only.
- An order detected at bar `i` never executes before bar `i + 1`'s own open (see below) — a signal on
  the very last bar of a segment is therefore never actioned within that segment at all.

## Execution model (`backtest-engine.ts`)

- **Long-only, one position per instrument, no pyramiding, no leverage.** A new entry signal is
  never actioned while a position is already open.
- **Entry and signal exits both execute at the OPEN of the bar *after* the signal was detected** —
  never the signal bar's own price. This is the one piece of explicit queued state
  (`pendingEntrySignalBar`/`pendingExitReason`) in the engine.
- **`MAX_BARS_HELD`** is evaluated the same way as a `CONDITION` exit rule: it produces a *signal* at
  the bar the threshold is reached, executed at the next bar's open — a position can therefore be
  held for `maxBars + 1` bars in practice, since the exit itself needs one more bar to execute. This
  is a deliberate, documented consequence of "no execution earlier than the next bar," not a bug.
- **Deterministic end-of-data close policy:** a position still open after the last bar is closed at
  that bar's own **close** price, `exitReason: "END_OF_DATA"`. This is explicitly a RESEARCH
  CONVENTION for making the run's metrics computable — never a claim the strategy itself generated
  an exit signal there. `runBacktest` adds an explicit warning (naming the segment) whenever this
  occurs, so it's never silently conflated with a genuine, rule-driven exit.
- **Position sizing (fixed engine policy, `FULL_CAPITAL_ALLOCATION_FRACTION = 1`):** every entry
  invests 100% of current cash, with the entry fee reserved UP FRONT —
  `quantity = cash / (entryPriceExecuted * (1 + feeRate))` — so notional plus fee never exceeds
  available cash. This is a fixed engine constant, never configurable and never read from the
  strategy document (Phase 1's own prohibited-field scanner already rejects any sizing-shaped field
  in strategy JSON). Cash can never go negative and this engine never models implicit leverage.

## Cost model

- `feeBps`/`slippageBps` — basis points, must be finite and `>= 0` (rejected explicitly otherwise,
  never clamped). `slippageBps` is additionally rejected at or above 10,000 (100%) — at or beyond
  that, a sell would execute at a zero or negative price, which can never be a real execution price.
- Applied on **both** entry and exit: slippage always makes the executed price worse than the raw
  open (entry pays more, exit receives less) — this engine never assumes a favourable fill.
- Every trade reports `grossPnl` (raw-price P&L, no costs), `feesPaid`, `slippageCost`, and `netPnl`
  — related by `netPnl = grossPnl - feesPaid - slippageCost` exactly (asserted directly in
  `backtest-engine.test.ts`). Summed `netPnl` across every trade reconciles `startingCapital` to
  `endingCapital` exactly, for every exit type (`SIGNAL`, `MAX_BARS_HELD`, `END_OF_DATA` all share one
  `closeTrade` implementation — a prior duplicated version of this logic once double-counted the
  entry fee in one branch only).

## Result model (`backtest-result.ts`)

One `BacktestResult` per run: `runId` (a fresh random UUID — an OPERATIONAL identifier, never
deterministic and never part of `runFingerprint`; use `runFingerprint`, never `runId`, to detect "two
runs represent the same underlying backtest"), `generatedAt`, `engineVersion`, `strategy`
(id/version/contentHash), `dataset` (hash/source/filePath), `instrument`, `timeframe`, `config`,
`runFingerprint`, a `full` segment (`BacktestSegmentMetrics`: bar range, capital, total return, gross/
net P&L, fees, slippage, trade count, **win rate and profit factor both computed on NET P&L** — a
trade with positive gross P&L but negative net P&L counts as a loser, never a winner — max drawdown
(**marked-to-market**, from a bar-by-bar equity curve that includes the unrealised value of any open
position, not merely closed-trade P&L — see Execution model above), average trade, profit factor
(`null` when there are no losing trades, never `Infinity`), exposure percentage (bars from the entry
bar inclusive to the exit bar exclusive), and the full trade ledger), optional `inSample`/
`outOfSample` segments, and always-populated `warnings`/`limitations` (which always include the
standing `BACKTEST ONLY — NOT APPROVED FOR DEMO OR LIVE TRADING` disclaimer plus the strategy
document's own declared limitations, and a warning whenever any trade closed via `END_OF_DATA`).

## Reproducibility

`runFingerprint` is a SHA-256 (via `canonicalStringify`) over exactly: strategy content hash, dataset
hash, instrument, timeframe, the full cost/capital/split config, and `engineVersion`. It deliberately
**excludes** `runId` (fresh random UUID every run) and `generatedAt` (wall-clock time) — two runs of
the identical strategy+dataset+config on different days produce an identical fingerprint AND
byte-for-byte identical `full`/`inSample`/`outOfSample` segments (asserted directly in
`backtest-result.test.ts`) — this claim is always scoped to those segment objects specifically, never
to the whole `BacktestResult` (which also carries the necessarily-different `runId`/`generatedAt`).
`engineVersion` exists so a future change to the simulation logic itself can be reflected in the
fingerprint even when every other input is unchanged — currently **2**, following this review's own
fee-reserved-sizing and marked-to-market-drawdown corrections (both changed computed results for
otherwise-unchanged inputs relative to version 1).

## In-sample / out-of-sample split

An optional `config.split.splitAt` (an ISO timestamp) partitions the dataset chronologically:
in-sample = every candle at or before `splitAt`, out-of-sample = strictly after it. Rejected
explicitly if `splitAt` doesn't fall strictly inside the dataset's own range (leaving at least one
candle on each side). The two segments are run as **fully independent** backtests — out-of-sample
never inherits an open position, a partially-warmed indicator series, or any other state from
in-sample. Nothing in this phase selects or tunes a strategy parameter from either segment — there is
no parameter-fitting step to feed. The split is always a fixed, caller-supplied timestamp; nothing in
this phase ever randomises anything.

## CLI

```
npm run strategy:backtest -- --strategy CRYPTO_EMA_TREND_V1 --version 1.0.0 --data <path> --instrument BTC \
  [--json] [--fee-bps <n>] [--slippage-bps <n>] [--starting-capital <n>] [--output-dir <path>] [--split-at <ISO>]
```

- `--instrument` accepts only `BTC`, `ETH`, or `SOL` (case-insensitive — normalised to uppercase),
  rejected immediately and explicitly otherwise. Loads the strategy through the existing Phase 1
  registry (`loadStrategyDefinitions`), against a small, synthetic, backtest-only instrument-catalogue
  stub covering exactly those three symbols — never whatever instrument happens to be requested (a
  prior version merged the requested instrument straight into the catalogue, which meant ANY
  instrument name automatically "existed," defeating the whole boundary). Every capability-shaped
  field in that stub (`readOnlyCapabilityStatus`, `configuredInUniverse`, etc.) is the honest,
  conservative `NOT_TESTED`/`false` value — this CLI has no live capability evidence and never
  fabricates one; it only ever proves "this symbol is one of the three this tool supports," never
  anything about real broker/demo/trading-universe eligibility. This CLI never reads live eToro
  capability evidence and never calls a provider.
- An unrecognised flag, a flag missing its required value, or a non-numeric value for `--fee-bps`/
  `--slippage-bps`/`--starting-capital` is rejected explicitly and immediately, never silently
  ignored or deferred to a generic downstream error.
- `--json` prints exactly one `JSON.stringify` call and nothing else to stdout, on **both** success
  (`{ ok: true, ...result }`) and every failure path (`{ ok: false, stage, reason, detail }`) — a
  prior version only ever wrote plain text to stderr on failure, even when `--json` was requested.
  Human-mode warnings and the usage line both go to stderr; the disclaimer, metrics, and limitations
  go to stdout.
- Exit codes: **0** success, **1** an explicit, expected rejection (bad arguments, malformed
  dataset/strategy, unsupported instrument, invalid backtest config — every case this CLI itself
  detects), **2** an unexpected crash caught only by the top-level handler.
- Human output always prints `BACKTEST ONLY — NOT APPROVED FOR DEMO OR LIVE TRADING` plus concise
  per-segment metrics, warnings, and limitations.
- `--output-dir` is the only way any file is ever written. The evidence filename is derived from the
  run fingerprint (not the random `runId`), and the write is atomic and create-only (`fs.link`,
  never `fs.rename`, with the temp file cleaned up on every path — success, "already exists," or an
  outright error): a repeat run of the identical inputs reports `"already-exists"` — an explicit,
  expected SUCCESS outcome (not a failure, not a silent overwrite) — rather than overwriting the
  first evidence file. The persisted copy redacts `dataset.filePath` down to its bare filename (the
  operator's own absolute local path is never embedded in a file that may end up shared or archived);
  the in-memory/stdout result the operator sees in their own terminal keeps the full path.

## Current limitations

- Long-only; no shorting, no leverage, no pyramiding, no partial fills, no configurable position
  sizing beyond "invest everything" (fixed engine policy — see Execution model above).
- Indicator computation re-slices the candle array per bar (`O(n²)` for a strategy's own indicator
  count) — adequate for a foundation and for the datasets this phase targets, not optimised for very
  long histories. A dataset above `MAX_DATASET_CANDLES` (20,000 rows — about 2.3 years of hourly
  data) is rejected outright rather than risking a hang.
- No exchange fee tiers, funding rates, or borrow costs — a single flat `feeBps` applies to every
  trade leg.
- No holiday/market-closure calendar awareness for equities (this phase's own strict, jitter-free gap
  check would reject a real equity dataset's weekend/overnight gaps outright — Phase 2 targets
  crypto's continuous-timeline case first; an equity-aware dataset validator is a future extension,
  not something this phase claims to support).
- `backtestPolicy.minHistoryBars` short-of-ideal is a warning, not a hard rejection — only a dataset
  at or below `warmupBars` is rejected outright (`INSUFFICIENT_HISTORY`).
- The dataset validator does not detect duplicate JSON object keys (`JSON.parse` itself silently
  keeps only the last occurrence before validation ever sees the value) — pre-validate with a JSON
  linter first if that distinction matters for an evidence trail.
- In-sample/out-of-sample segments are fully independent: out-of-sample's own capital always starts
  from the same configured `startingCapital` (never carried over from in-sample's ending capital),
  and its own indicators warm up from its own bar 0 (never inheriting in-sample history) — see
  In-sample / out-of-sample split above.

## No runtime integration, no automatic promotion

This phase changes nothing about `TradingRuntime`, any broker adapter, trade lifecycle/approval/risk
processing, reconciliation, or Telegram alerting — none of those modules import anything from
`backtest/`, and nothing in `backtest/` imports from them. A `BacktestResult` is never written back
into a strategy definition file, never changes a strategy's `status` or `usableForDemo`, and is never
read by any other part of this codebase. Any future mechanism to use a backtest result as evidence
toward promoting a strategy to demo/live status is explicitly out of scope here and does not exist.
