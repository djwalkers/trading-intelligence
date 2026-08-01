# Strategy Research Workflow — Phase 3

**Status:** Deterministic, offline, read-only research workflow built on top of the Phase 2 backtest
engine. No provider/broker call, no PM2 action, no live runtime integration, no automatic promotion
mechanism. This phase builds a research PROCESS and EVIDENCE MODEL — it does not itself prove that
CRYPTO_EMA_TREND_V1, or any strategy, is profitable.

## Purpose

Phase 2 could run one deterministic backtest. Phase 3 adds everything needed to turn that into a
disciplined research process: a plan declared BEFORE results exist, a bounded and deterministic
parameter sweep, in-sample/out-of-sample separation, robustness analysis across the whole
neighbourhood (never just the best variant), and an explicit, evidence-backed outcome — while making
it structurally impossible for a successful run to promote a strategy's status.

## Files

- `src/lib/hermes-execution/strategy-research/research-plan.ts` — the research plan schema and its
  pure validator.
- `src/lib/hermes-execution/strategy-research/dataset-manifest.ts` — dataset manifest schema, hash
  verification, IS/OOS overlap check.
- `src/lib/hermes-execution/strategy-research/experiment-matrix.ts` — deterministic experiment
  generation.
- `src/lib/hermes-execution/strategy-research/strategy-variant.ts` — in-memory strategy variant
  generation, revalidated through the real Phase 1 validator.
- `src/lib/hermes-execution/strategy-research/research-result.ts` — result types, the research
  fingerprint, criterion evaluation, and aggregate statistics.
- `src/lib/hermes-execution/strategy-research/research-engine.ts` — the one orchestrator.
- `src/lib/hermes-execution/strategy-research/research-persistence.ts` — atomic, create-only evidence
  writer.
- `src/hermes-execution/strategy-research-cli.ts` — the `npm run strategy:research` entrypoint.
- `strategies/research-plans/CRYPTO_EMA_TREND_V1_BASELINE_NEIGHBOURHOOD__1.0.0.json` — example plan
  (non-runnable as committed — see below).
- Tests: `tests/hermes-execution/strategy-research/*.test.ts`,
  `tests/hermes-execution/strategy-research-cli.test.ts`.

Nothing in this phase is imported by, or imports, `runtime/trading-runtime.ts`, any broker adapter,
`trade-lifecycle/`, `trade-approval/`, `portfolio-risk-engine.ts`, or `telegram/`. `buildBacktestCatalogueStub`
is reused directly from Phase 2's own CLI (`strategy-backtest-cli.ts`, now exported) — the identical,
honest, fixed BTC/ETH/SOL catalogue stub, never a second one.

## Research plan schema

One JSON document: `schemaVersion`, `researchPlanId` (`^[A-Z][A-Z0-9_]*$`), `researchPlanVersion`
(strict semver), `name`, `description`, `strategyId`/`strategyVersion`/`strategyContentHash` (the
plan is pinned to an EXACT, immutable strategy document — a mismatch against the actually-loaded
strategy is rejected outright), `instruments`, `timeframe`, `datasets` (see the manifest below),
`baselineConfig` (fee/slippage/starting capital), `parameterExperiments`, `chronologicalSplits`,
`passCriteria`/`failureCriteria`, `robustnessChecks`, `limitations`, `provenance`. Closed key sets at
every level, mirroring Phase 1's `strategy-definition.ts` exactly — an unrecognised field is rejected,
never silently ignored — and the same `findProhibitedFields` scanner runs over the whole document, so
a plan can no more carry a `positionSize`/`leverage`/`brokerProvider`-shaped field than a strategy
document can. There is no expression/formula field anywhere in this schema — a plan is validated
DATA, never executable code.

**Predeclaration principle:** `passCriteria`/`failureCriteria` are part of the plan document itself,
authored and content-hashed BEFORE any backtest runs. `research-engine.ts` never adjusts, adds, or
drops a criterion based on what a result turns out to look like.

### Pass/fail criteria

A small, closed metric set: `MIN_TRADE_COUNT`, `MIN_NET_RETURN`, `MAX_DRAWDOWN`, `MIN_PROFIT_FACTOR`,
`MIN_WIN_RATE`, `MIN_OOS_NET_RETURN`, `MAX_IS_TO_OOS_DEGRADATION`, `MAX_INSTRUMENT_CONCENTRATION`,
`MIN_ACCEPTABLE_VARIANT_PERCENTAGE` — never a formula string. Each criterion has a `metric`, a
Phase-1-style `operator` (`GREATER_THAN`/`LESS_THAN`/`GREATER_THAN_OR_EQUAL`/`LESS_THAN_OR_EQUAL`), a
`threshold`, and a `scope` (`OVERALL`/`IN_SAMPLE`/`OUT_OF_SAMPLE`/`PER_INSTRUMENT`/`ACROSS_VARIANTS`).
Units: `MIN_NET_RETURN`/`MIN_OOS_NET_RETURN`/`MAX_DRAWDOWN`/`MIN_WIN_RATE` are FRACTIONS (0.1 = 10%),
matching `BacktestSegmentMetrics` exactly; `MAX_INSTRUMENT_CONCENTRATION`/
`MIN_ACCEPTABLE_VARIANT_PERCENTAGE` are PERCENTAGES (0-100) — as is
`robustnessChecks.maxInstrumentConcentrationWarningThreshold`, deliberately kept on the SAME 0-100
scale as `MAX_INSTRUMENT_CONCENTRATION` rather than a separate 0-1 fraction. An impossible threshold
(e.g. a win rate above 1) is rejected at validation time, never accepted and silently unsatisfiable
forever. The `operator` direction is enforced against the metric's own name and against which list the
criterion is in: a `passCriteria` `MIN_*` entry must use `GREATER_THAN`/`GREATER_THAN_OR_EQUAL` and a
`MAX_*` entry must use `LESS_THAN`/`LESS_THAN_OR_EQUAL`; a `failureCriteria` entry requires the MIRROR
direction (a `failureCriteria` `MIN_*` entry — "trigger a fail when we fall below this floor" — uses
`LESS_THAN`/`LESS_THAN_OR_EQUAL`, and a `MAX_*` entry uses `GREATER_THAN`/`GREATER_THAN_OR_EQUAL`) — the
wrong direction is rejected outright rather than silently declaring a criterion that means the
opposite of its own name. `passCriteria` must ALL be satisfied for PASS; `failureCriteria` are a kill
switch — ANY one being satisfied FAILs the run regardless of `passCriteria`.

`PER_INSTRUMENT` criteria are evaluated per instrument and require EVERY declared instrument to
satisfy them (the worst instrument's value is what's checked) — never merely the average.
`ACROSS_VARIANTS` criteria (`MIN_ACCEPTABLE_VARIANT_PERCENTAGE`, `MAX_INSTRUMENT_CONCENTRATION`) read
from the aggregate statistics across the whole variant population, never a single variant.

## Dataset manifest

Maps each instrument to a local dataset file, an `expectedDatasetHash`, a declared date range, and a
`role` (`IN_SAMPLE`/`OUT_OF_SAMPLE`/`FULL_HISTORY`/`STRESS_PERIOD`). `datasetFile` is an INPUT, never
identity — two manifests pointing at different paths for byte-for-byte identical content verify
identically. The actual dataset hash (Phase 2's own `computeDatasetHash`, never re-derived) must
match `expectedDatasetHash` exactly; the dataset's own instrument/timeframe must match the manifest
entry's; the dataset's actual candle range must fall within the manifest's declared range. Any single
mismatch rejects the WHOLE manifest. For any instrument with both an `IN_SAMPLE` and an
`OUT_OF_SAMPLE` entry, the in-sample range must end at or before the out-of-sample range begins. Two
manifest entries sharing the same `(instrument, role)` pair are rejected outright — both at pure
plan-schema validation time (`research-plan.ts`, before any file is even read) and again in
`loadAndVerifyManifest` itself — rather than silently resolved by picking whichever one happened to
be declared first. A dataset entry naming an instrument the plan itself never declared in its own
`instruments` list is likewise rejected at schema-validation time.

**No dataset is ever generated or fetched automatically** — `loadAndVerifyManifest`'s only I/O is
reading local files the plan itself names, via Phase 2's own `loadCandleDataset`.

## Experiment generation

Nine variable dimensions: `emaFastPeriod`, `emaSlowPeriod`, `rsiPeriod`, `rsiLowerBound`,
`rsiUpperBound`, `atrPeriod`, `maxBarsHeld`, `feeBps`, `slippageBps`. Each is either
`EXPLICIT_VALUES` (a declared list) or a `RANGE` (bounded `min`/`max`/`step`, expanded
deterministically). The cartesian product is generated in a FIXED dimension-key order — never the
JSON object's own key order — so the same config always produces the same variant list in the same
order. Structurally invalid combinations (`emaFastPeriod >= emaSlowPeriod`, `rsiLowerBound >=
rsiUpperBound`, a non-positive integer period) are EXCLUDED, never causing a whole-plan rejection, and
are reported back on the result as `excludedCombinations` (each with its own `overrides` and
human-readable `reason`) — never silently vanishing. If EVERY generated combination turns out
structurally invalid (nothing survives beyond the baseline), the whole matrix is rejected
(`NO_VALID_VARIANTS`) rather than silently degrading to "ran only the baseline." The baseline (empty
overrides) is always variant `"BASELINE"`, first. The total count (including baseline) is checked
against `min(plan.maxExperiments, 500)` — `MAX_EXPERIMENT_VARIANTS_HARD_CAP` — and the WHOLE matrix is
REJECTED (never silently truncated) if it would exceed that; this cap is checked once cheaply against
the RAW (pre-exclusion) combination count before the cartesian product is even built, and again
against the real post-exclusion count, so a plan declaring an enormous sweep is rejected immediately
rather than after materialising millions of combinations. No random search, no Bayesian/gradient
optimisation, anywhere.

## Strategy variant boundaries

Exactly which `StrategyDefinitionDocument` fields Phase 3 may vary (see `strategy-variant.ts`'s own
top-of-file comment for the full detail): the two `EMA` indicators' `parameters.period` (identified
by baseline period — smaller is "fast," larger is "slow"; requires exactly 2 EMA indicators), the
single `RSI` indicator's `parameters.period`, the `lowerBound`/`upperBound` constants of the `BETWEEN`
rule node referencing that RSI indicator's alias, the single `ATR` indicator's `parameters.period`,
and the single `MAX_BARS_HELD` exit rule's `maxBars`. `feeBps`/`slippageBps` NEVER touch the strategy
document at all — they become part of the backtest run's own cost config, exactly the same
"cost is research config, never strategy content" boundary Phase 2 itself draws. Every other field
(identity, status, `supportedInstruments`, timeframe, eligibility, provenance, limitations) is copied
verbatim. Every variant is revalidated through the REAL Phase 1 `validateStrategyDefinition` — never
a relaxed variant validator — and `generateValidatedVariant` additionally asserts `strategyId`/
`strategyVersion`/`status`/`supportedInstruments` are unchanged from the baseline and `usableForDemo`
is still `false`. No filesystem I/O anywhere in this module — a variant is never written to
`strategies/`, never registered with any registry. Overriding only ONE side of a two-sided pair
(`emaFastPeriod` alone, or `rsiUpperBound` alone) is checked AFTER the override is applied — the
result must still have fast strictly less than slow, and lowerBound strictly less than upperBound —
rejected (`INVALID_EMA_ORDERING` / `INVALID_RSI_BOUNDS_ORDERING`) rather than silently producing a
strategy whose trend/range logic is inverted relative to the baseline's own intent.

## IS/OOS treatment

Two supported modes, chosen per instrument from the manifest's own roles:
- **`SPLIT`**: one `FULL_HISTORY` dataset plus a matching `chronologicalSplits` entry — reuses Phase
  2's own native `config.split` mechanism verbatim (never a second, parallel split).
- **`SEPARATE`**: explicit `IN_SAMPLE` + `OUT_OF_SAMPLE` manifest entries for genuinely distinct
  files — two independent `runBacktest` calls, no split configured on either.
- **`FULL_ONLY`**: a `FULL_HISTORY` dataset with no split configured — only `.full` is produced.

Any number of `STRESS_PERIOD` entries run independently of whichever mode applies, never blended into
`.full`/`.inSample`/`.outOfSample`. Out-of-sample NEVER inherits an in-sample open position, warmed
indicator state, or capital — both IS and OOS start from the SAME configured `startingCapital`
(explicit, documented, never implicit). Nothing in this phase selects or tunes a parameter from OOS
results — there is no parameter-fitting step at all.

## Robustness analysis

Every research result reports more than the baseline: `AggregateStatistics` (variant/acceptable-
variant counts and percentage, net-return percentiles, trade-count and drawdown ranges, best/worst
variant IDs, per-instrument concentration) plus unconditional warnings for: only a narrow parameter
combination working, out-of-sample degradation, one instrument dominating total profit, a low
baseline trade count, mixed acceptability across the evaluated parameter grid (a flat acceptable/total
ratio — deliberately never called a "neighbourhood," since it carries no notion of which variants are
close to each other or to the baseline), and costs consuming most or all gross profit. A SEPARATE,
genuinely spatial check flags disagreement between the baseline's own acceptability and its immediate
single-parameter neighbours (variants that change EXACTLY one parameter from the baseline, holding
every other parameter fixed) — this is the actual "small parameter changes can reverse the result"
signal. `acceptableVariantPercentage`'s denominator is `variantCount` — every variant the matrix
generated, INCLUDING ones rejected during generation or execution — never `evaluableVariantCount`
alone, so a batch that mostly failed to even run never reads as robust merely because the few that did
run happened to be acceptable. A variant is "acceptable" when it satisfies every non-`ACROSS_VARIANTS`
`passCriteria` entry and triggers no non-`ACROSS_VARIANTS` `failureCriteria` entry, evaluated
independently per variant.

**Outcome is always decided against the BASELINE alone**, never "whichever variant did best" — this
is the direct mechanism that makes it structurally impossible for one strong outlier variant to
produce PASS when the baseline (and, via `MIN_ACCEPTABLE_VARIANT_PERCENTAGE`, the declared
neighbourhood) does not itself support it.

## Outcome model

- **PASS**: every mandatory `passCriteria` entry is satisfied against the baseline, and no
  `failureCriteria` entry triggered.
- **FAIL**: valid evidence exists but at least one mandatory criterion failed, or a `failureCriteria`
  entry triggered.
- **INCONCLUSIVE**: valid evidence exists but is insufficient — zero baseline trades, or every
  declared criterion had no computable evidence at all.
- **INVALID**: the plan, strategy, dataset, or execution evidence itself was invalid — surfaced as a
  top-level `{ok: false, stage, reason, detail}` from `runResearch`, before any `ResearchResult` is
  even produced.

PASS never means approved for demo, safe to trade, profitable in the future, or production ready —
every result's own `limitations` array always states this, plus the permanent disclaimer:

```
RESEARCH EVIDENCE ONLY — NOT APPROVED FOR DEMO OR LIVE TRADING
```

## Reproducibility

`researchFingerprint` (SHA-256, via Phase 1's own `canonicalStringify`) covers: the plan's own content
hash, the strategy's own content hash, every verified dataset hash (sorted by instrument+role — order-
independent), the complete experiment matrix hash, and BOTH engine versions
(`BACKTEST_ENGINE_VERSION` = 2, `PHASE3_RESEARCH_ENGINE_VERSION` = 1). It deliberately excludes
`researchRunId` (a fresh random UUID every run — an operational identifier only; use the fingerprint,
never the run ID, to detect "these two runs are the same underlying research"), `generatedAt`, any
absolute path, the output directory, and host information — none of the latter four are even passed
into the fingerprint computation at all. Identical trusted inputs always produce an identical
fingerprint and byte-for-byte identical `baseline`/`variants`/`aggregate`/`criterionEvaluations`. Every
`VariantResult` additionally carries its own `resultFingerprint` (same SHA-256-over-canonical-JSON
mechanism, scoped to just that variant's identity and evidence) so a single variant can be verified or
diffed in isolation without re-hashing the whole run. The `ResearchResult` also embeds the complete
`planDocument` (not just its identity/hash) — a consumer reading only a persisted evidence file can
recover the exact predeclared criteria/experiments/robustness thresholds the run was evaluated
against, without trusting a separate, un-pinned plan file that could since have been edited or
deleted.

## Evidence persistence

Written only when `--output-dir` is explicitly supplied — atomic, create-only (`fs.link`, never
`fs.rename`), mirroring `backtest-persistence.ts`'s own design exactly. The filename is derived from
`researchFingerprint` (never `researchRunId`): a repeat run of the identical plan+strategy+datasets+
experiment matrix reports `"already-exists"` — an explicit success, never a silent overwrite, never a
failure. The temp file is removed on every path (success, already-exists, or an outright error) via
one `finally`. The persisted copy redacts every `datasets[].filePath` down to its bare filename — no
absolute local path is ever embedded in an evidence file that may end up shared or archived; the
in-memory/stdout result an operator sees in their own terminal keeps the full paths. Evidence contains
the full plan/strategy/dataset identity and hashes, the complete experiment matrix, every variant's
configuration and result, the baseline, aggregate statistics, criterion evaluations, outcome,
warnings, and limitations — no secrets anywhere (nothing in this pipeline ever touches a credential).

## CLI

```
npm run strategy:research -- --plan <research-plan.json> [--json] [--output-dir <path>] [--max-experiments <n>] [--fail-fast] [--validate-only]
```

- `--validate-only` (Phase 4 addition): verifies the plan schema, the strategy content hash, and
  every declared dataset's hash/instrument/timeframe/date-range — WITHOUT generating the experiment
  matrix or running a single backtest. Reuses `runResearch`'s own verification prefix
  (`loadAndVerifyPlanAndDatasets` in research-engine.ts) rather than a second, parallel check. See
  `docs/project-status/DATASET_INTAKE_PHASE4.md` for the dataset-preparation workflow this pairs with.
- `--max-experiments` may only LOWER the built-in 500 cap, never raise it — rejected explicitly
  otherwise.
- `--fail-fast` is accepted for forward-compatibility and to document intent: `runResearch` already
  stops at the first invalid stage before any experiment runs, which IS "fail fast on invalid input";
  it never affects a FAIL/INCONCLUSIVE outcome, which is always valid, complete evidence reported in
  full.
- `--json` prints exactly one `JSON.stringify` call on stdout, on success (`{ok: true, ...}`), on an
  explicit rejection (`{ok: false, stage, reason, detail}`), and on an unexpected crash
  (`{ok: false, stage: "execution", reason: "UNEXPECTED_ERROR", detail}`, from the top-level
  `main().catch(...)` handler) alike — never plain text mixed into stdout, and never a `--json` caller
  forced to fall back to scraping stderr text just because a run happened to crash.
- Exit codes: **0** — the plan executed to a real, valid verdict (PASS, FAIL, or INCONCLUSIVE all
  count; a FAIL research outcome is evidence, never a crash — a produced `ResearchResult.outcome` is
  typed to exclude `INVALID` entirely, since that case is always represented structurally by
  `RunResearchOutput.ok === false` instead, never as a value of this field). **1** — an explicit,
  expected rejection (bad arguments, or an invalid plan/strategy/dataset/experiment-matrix). **2** —
  an unexpected crash, caught only by the top-level handler.
- Human output always prints the permanent disclaimer, plan/strategy identity, dataset hashes,
  experiment count, baseline metrics, acceptable-variant count, every mandatory criterion's own
  pass/fail line, the outcome, warnings (stderr), limitations, and the evidence path or
  already-exists result.

## Example plan

`strategies/research-plans/CRYPTO_EMA_TREND_V1_BASELINE_NEIGHBOURHOOD__1.0.0.json` pins
CRYPTO_EMA_TREND_V1 v1.0.0 by its real content hash, declares a modest neighbourhood around its own
EMA20/EMA50/RSI14 baseline, explicit fees/slippage, chronological IS/OOS splits, and predeclared
pass/failure criteria including a `MIN_ACCEPTABLE_VARIANT_PERCENTAGE` neighbourhood-stability check.
**It is NOT runnable as committed** — every `datasets` entry is an explicit placeholder (a
non-existent file path and an all-zero hash), because this repository has no established convention
for committing real market datasets and this phase does not fabricate one. Its own `description`
field explains exactly how to make it runnable: supply real local dataset files and replace the
placeholder path/hash pair with the real ones (obtainable via any `strategy:backtest` run against
that file, or `computeDatasetHash` directly).

## Current limitations

- `OVERALL`/`IN_SAMPLE`/`OUT_OF_SAMPLE` criteria blend across instruments via a plain, unweighted
  average — never trade-count-weighted or otherwise.
- `MAX_IS_TO_OOS_DEGRADATION` is the average, across instruments, of `(IS totalReturn - OOS
  totalReturn)` — a plain difference in return-fraction terms, not a ratio.
- Concentration is measured against the BASELINE's own total net profit only, never recomputed per
  variant.
- Inherits every Phase 2 limitation unchanged (long-only, O(n²) indicator computation, 20,000-candle
  dataset cap, no equity market-closure awareness, fixed 100% capital allocation).
- No parameter-fitting/optimisation step exists, and none is planned to be added silently — any
  future automated parameter SELECTION mechanism would be an explicit, separate, and clearly
  DIFFERENT capability from this phase's own fixed, predeclared neighbourhood sweep.

## No automatic promotion, no claim of future profitability

A `ResearchResult` has no `status`/`usableForDemo`-shaped field anywhere in its type, is never written
back into any strategy definition file, and is never read by any other part of this codebase. A PASS
outcome proves only that the predeclared, mandatory criteria were satisfied against fixed historical
evidence under this engine's own documented assumptions — it is never evidence of future performance,
and no code path in this repository treats it as authorization for demo or live trading.
