import { createHash } from "node:crypto";
import { canonicalStringify, CONTENT_HASH_ALGORITHM } from "../strategy-definitions/strategy-definition";
import { BACKTEST_ENGINE_VERSION, type BacktestSegmentMetrics } from "../backtest/backtest-engine";
import type { DatasetRole } from "./dataset-manifest";
import type { CriterionMetric, EvaluationScope, PassFailCriterion, ResearchPlanDocument } from "./research-plan";
import type { ExcludedCombination, VariantParameterOverrides } from "./experiment-matrix";
import type { ComparisonOperator } from "../strategy-definitions/strategy-definition";

// Phase 3 — Strategy Research Workflow. Result types, the deterministic research fingerprint, and
// the pure (no I/O) evaluation/aggregation logic — never re-implements any Phase 2 execution
// semantics itself, only reads the `BacktestSegmentMetrics` Phase 2 already produced.

export const PHASE3_RESEARCH_ENGINE_VERSION = 1;

export type DatasetInstrumentMode = "SPLIT" | "SEPARATE" | "FULL_ONLY";

export interface VariantInstrumentResult {
  instrument: string;
  mode: DatasetInstrumentMode;
  full?: BacktestSegmentMetrics;
  inSample?: BacktestSegmentMetrics;
  outOfSample?: BacktestSegmentMetrics;
  stressPeriods: { datasetFile: string; result: BacktestSegmentMetrics }[];
  /** Set when THIS instrument's own backtest(s) could not be produced for this variant (e.g. the
   * variant's mutated indicator periods made `backtestPolicy.warmupBars` unreachable for a short
   * dataset) — the variant's OTHER instruments (if any succeeded) remain valid evidence; only this
   * one instrument is excluded from aggregation for this variant. */
  rejected?: { reason: string; detail: string };
}

export interface VariantResult {
  variantId: string;
  contentHash: string;
  overrides: VariantParameterOverrides;
  isBaseline: boolean;
  /** Undefined only when `rejected` is set — variant generation itself failed before any instrument
   * could even be attempted. */
  strategyContentHash?: string;
  perInstrument: VariantInstrumentResult[];
  /** Set when the variant's OWN strategy document could not be generated/validated at all (see
   * strategy-variant.ts) — the whole variant is excluded from aggregation; never fatal to the
   * overall research run (the baseline and every other variant are unaffected). */
  rejected?: { reason: string; detail: string };
  /** SHA-256 over this variant's own identity and evidence (`variantId`, `contentHash`, `overrides`,
   * `strategyContentHash`, and every `perInstrument` entry) — lets a consumer verify or diff a SINGLE
   * variant's evidence in isolation without re-hashing the entire `ResearchResult`. Undefined only
   * when `rejected` is set, mirroring `strategyContentHash`'s own convention: a rejected variant has
   * no evidence to fingerprint. */
  resultFingerprint?: string;
}

export interface CriterionEvaluation {
  criterion: PassFailCriterion;
  /** `null` when the criterion's own metric/scope combination had no computable evidence for this
   * run (e.g. `MIN_OOS_NET_RETURN` when no instrument has an out-of-sample segment at all) — such a
   * criterion is NEVER treated as silently satisfied; see `satisfied`'s own doc comment. */
  observedValue: number | null;
  /** `false` whenever `observedValue` is `null` — a criterion this run has no evidence for can never
   * count as satisfied, only as unevaluable (surfaced via `warnings`, not through a false PASS). */
  satisfied: boolean;
  detail: string;
}

export interface InstrumentConcentration {
  instrument: string;
  /** This instrument's own share (0-1) of the BASELINE's total net profit summed across every
   * instrument that has a `full` (or, absent that, `inSample`+`outOfSample`) result — `0` when total
   * net profit is zero or negative across the board (concentration is only a meaningful concern when
   * there IS profit to be concentrated). */
  shareOfTotalNetProfit: number;
}

export interface AggregateStatistics {
  variantCount: number;
  /** Variants successfully generated/executed (excludes any with `rejected` set). */
  evaluableVariantCount: number;
  acceptableVariantCount: number;
  /** 0-100 — see `PassFailCriterion` metric `MIN_ACCEPTABLE_VARIANT_PERCENTAGE`'s own doc comment
   * for the percentage (not fraction) convention. Denominator is `variantCount` (every generated
   * variant, INCLUDING ones rejected during generation/execution), never `evaluableVariantCount` — a
   * batch of variants that mostly failed to even execute must not read as robust just because the
   * few that DID run happened to be acceptable; a rejected variant counts against this percentage. */
  acceptableVariantPercentage: number;
  /** OVERALL-scope net return (see `extractMetricValue`) across every evaluable variant, including
   * the baseline. */
  netReturnPercentiles: { p10: number; p25: number; median: number; p75: number; p90: number };
  tradeCountRange: { min: number; max: number; median: number };
  drawdownRange: { min: number; max: number; median: number };
  bestVariantId: string | null;
  worstVariantId: string | null;
  perInstrumentConcentration: InstrumentConcentration[];
}

/**
 * `INVALID` exists only for callers (e.g. the CLI) that need to talk about the union of "a
 * `ResearchResult` was produced with this outcome" and "no `ResearchResult` was produced at all"
 * (`RunResearchOutput`'s `{ ok: false }` branch, in research-engine.ts) in one type. A successfully
 * produced `ResearchResult.outcome` can never actually BE `"INVALID"` — that state is represented
 * structurally by `RunResearchOutput.ok === false` instead, never by this field — so
 * `ResolvedResearchOutcome` (below) is the type actually used there.
 */
export type ResearchOutcome = "PASS" | "FAIL" | "INCONCLUSIVE" | "INVALID";

/** The only outcomes a produced `ResearchResult` can ever carry — see `ResearchOutcome`'s own doc
 * comment for why `INVALID` is excluded here. */
export type ResolvedResearchOutcome = "PASS" | "FAIL" | "INCONCLUSIVE";

export const RESEARCH_DISCLAIMER = "RESEARCH EVIDENCE ONLY — NOT APPROVED FOR DEMO OR LIVE TRADING";

const STANDING_RESEARCH_LIMITATIONS: readonly string[] = [
  RESEARCH_DISCLAIMER,
  "PASS never means: approved for demo, safe to trade, profitable in the future, or production ready — it means only that the predeclared, mandatory criteria were satisfied against this fixed historical evidence.",
  "This workflow builds a research process and evidence model — it does not itself prove that any strategy, including the illustrative CRYPTO_EMA_TREND_V1 example, is profitable.",
  "A successful research run never promotes a strategy's status, never sets usableForDemo, and is never automatically wired into any approval, execution, lifecycle, or live-trading path.",
];

export interface ResearchIdentity {
  researchPlanId: string;
  researchPlanVersion: string;
  planContentHash: string;
}
export interface ResearchStrategyIdentity {
  strategyId: string;
  strategyVersion: string;
  strategyContentHash: string;
}
export interface ResearchDatasetIdentity {
  instrument: string;
  role: DatasetRole;
  datasetHash: string;
  filePath: string;
}

export interface ResearchResult {
  researchRunId: string;
  generatedAt: string;
  phase2EngineVersion: number;
  phase3EngineVersion: number;
  plan: ResearchIdentity;
  /** The complete, exact plan document this run was evaluated against — not just its identity/hash
   * (`plan` above). Without this, a consumer reading only the persisted evidence file could never
   * recover WHAT the predeclared criteria/experiments/robustness thresholds actually were; they'd
   * have to trust a separate, un-pinned plan file that could have since been edited or deleted. */
  planDocument: ResearchPlanDocument;
  strategy: ResearchStrategyIdentity;
  datasets: ResearchDatasetIdentity[];
  experimentMatrixHash: string;
  /** Every generated cartesian combination that was structurally invalid and excluded from the
   * matrix (see `generateExperimentMatrix`'s own doc comment) — kept visible here rather than
   * silently vanishing, so a consumer can see exactly which combinations were skipped and why,
   * distinct from a variant that ran but was merely unacceptable against the plan's criteria. */
  excludedCombinations: ExcludedCombination[];
  researchFingerprint: string;
  researchFingerprintAlgorithm: typeof CONTENT_HASH_ALGORITHM;
  baseline: VariantResult;
  variants: VariantResult[];
  aggregate: AggregateStatistics;
  criterionEvaluations: CriterionEvaluation[];
  outcome: ResolvedResearchOutcome;
  warnings: string[];
  limitations: string[];
}

/**
 * Deterministic SHA-256 over exactly the inputs that can change this research run's outcome — plan
 * content hash, strategy content hash, every verified dataset hash (sorted by instrument+role for a
 * canonical, input-order-independent ordering), the complete experiment matrix hash, and BOTH engine
 * versions. Deliberately EXCLUDES `researchRunId`, `generatedAt`, any absolute path, the output
 * directory, and any host information — none of those are even passed in here at all.
 */
export function computeResearchFingerprint(input: {
  planContentHash: string;
  strategyContentHash: string;
  datasetHashes: readonly { instrument: string; role: DatasetRole; datasetHash: string }[];
  experimentMatrixHash: string;
  phase2EngineVersion: number;
  phase3EngineVersion: number;
}): string {
  const sortedDatasetHashes = [...input.datasetHashes].sort((a, b) => `${a.instrument}:${a.role}`.localeCompare(`${b.instrument}:${b.role}`));
  return createHash(CONTENT_HASH_ALGORITHM)
    .update(canonicalStringify({ ...input, datasetHashes: sortedDatasetHashes }))
    .digest("hex");
}

/**
 * A per-variant counterpart to `computeResearchFingerprint` — same SHA-256-over-canonical-JSON
 * mechanism, scoped down to one variant's own identity and evidence so it can be verified or diffed
 * independently of the rest of the run. Deliberately excludes nothing that affects the variant's own
 * meaning (unlike the run-level fingerprint, there's no `runId`/`generatedAt`/path to exclude here in
 * the first place — `perInstrument` already carries only computed metrics, never a file path).
 */
export function computeVariantResultFingerprint(variant: Pick<VariantResult, "variantId" | "contentHash" | "overrides" | "strategyContentHash" | "perInstrument">): string {
  return createHash(CONTENT_HASH_ALGORITHM).update(canonicalStringify(variant)).digest("hex");
}

function compare(operator: ComparisonOperator, observed: number, threshold: number): boolean {
  switch (operator) {
    case "GREATER_THAN":
      return observed > threshold;
    case "LESS_THAN":
      return observed < threshold;
    case "GREATER_THAN_OR_EQUAL":
      return observed >= threshold;
    case "LESS_THAN_OR_EQUAL":
      return observed <= threshold;
  }
}

/** Prefers `full` (available in SPLIT/FULL_ONLY modes); falls back to a simple average of
 * `inSample`/`outOfSample` (SEPARATE mode, which never has a unified `full`) — documented,
 * deterministic, and the SAME rule used for both `OVERALL` and `PER_INSTRUMENT` scope. */
function instrumentOverallValue(instrumentResult: VariantInstrumentResult, metric: CriterionMetric): number | null {
  const segment = instrumentResult.full ?? (instrumentResult.inSample && instrumentResult.outOfSample ? undefined : (instrumentResult.inSample ?? instrumentResult.outOfSample));
  if (segment) return segmentMetricValue(segment, metric);
  if (instrumentResult.inSample && instrumentResult.outOfSample) {
    const a = segmentMetricValue(instrumentResult.inSample, metric);
    const b = segmentMetricValue(instrumentResult.outOfSample, metric);
    if (a === null || b === null) return null;
    return (a + b) / 2;
  }
  return null;
}

function segmentMetricValue(segment: BacktestSegmentMetrics, metric: CriterionMetric): number | null {
  switch (metric) {
    case "MIN_TRADE_COUNT":
      return segment.tradeCount;
    case "MIN_NET_RETURN":
    case "MIN_OOS_NET_RETURN":
      return segment.totalReturn;
    case "MAX_DRAWDOWN":
      return segment.maxDrawdown;
    case "MIN_PROFIT_FACTOR":
      if (segment.profitFactor !== null) return segment.profitFactor;
      return segment.tradeCount > 0 ? Number.POSITIVE_INFINITY : null; // all-winners -> trivially satisfies any finite floor; zero trades -> no evidence
    case "MIN_WIN_RATE":
      return segment.winRate;
    case "MAX_IS_TO_OOS_DEGRADATION":
    case "MAX_INSTRUMENT_CONCENTRATION":
    case "MIN_ACCEPTABLE_VARIANT_PERCENTAGE":
      return null; // computed separately — never from a single segment (see extractMetricValue)
  }
}

/**
 * Resolves one criterion's `observedValue` for one variant, given `plan.instruments` and (for
 * `ACROSS_VARIANTS` scope only) the already-computed `aggregate` statistics. `OVERALL`/
 * `IN_SAMPLE`/`OUT_OF_SAMPLE` blend across every instrument with a computable value via a plain,
 * unweighted AVERAGE (a deliberate, documented, simple choice — never trade-count-weighted or
 * otherwise). `PER_INSTRUMENT` returns the WORST (minimum, for a MIN_* metric — maximum, for a MAX_*
 * metric) value across instruments, so a `PER_INSTRUMENT` criterion genuinely requires EVERY
 * instrument to satisfy it, not merely the average.
 */
export function extractMetricValue(criterion: PassFailCriterion, variant: VariantResult, instruments: readonly string[], aggregate: AggregateStatistics | undefined): number | null {
  if (criterion.scope === "ACROSS_VARIANTS") {
    if (!aggregate) return null;
    if (criterion.metric === "MIN_ACCEPTABLE_VARIANT_PERCENTAGE") return aggregate.acceptableVariantPercentage;
    if (criterion.metric === "MAX_INSTRUMENT_CONCENTRATION") {
      if (aggregate.perInstrumentConcentration.length === 0) return null;
      return Math.max(...aggregate.perInstrumentConcentration.map((c) => c.shareOfTotalNetProfit)) * 100;
    }
    return null;
  }

  const relevant = variant.perInstrument.filter((r) => instruments.includes(r.instrument) && !r.rejected);
  if (relevant.length === 0) return null;

  if (criterion.scope === "PER_INSTRUMENT") {
    const isMaxMetric = criterion.metric.startsWith("MAX_");
    const values = relevant.map((r) => instrumentOverallValue(r, criterion.metric)).filter((v): v is number => v !== null);
    if (values.length !== relevant.length) return null; // every instrument must have a computable value, or this criterion has no evidence
    return isMaxMetric ? Math.max(...values) : Math.min(...values);
  }

  if (criterion.metric === "MAX_IS_TO_OOS_DEGRADATION") {
    const degradations = relevant
      .map((r) => {
        if (!r.inSample || !r.outOfSample) return null;
        return r.inSample.totalReturn - r.outOfSample.totalReturn;
      })
      .filter((v): v is number => v !== null);
    if (degradations.length === 0) return null;
    return degradations.reduce((sum, v) => sum + v, 0) / degradations.length;
  }

  if (criterion.scope === "IN_SAMPLE" || criterion.scope === "OUT_OF_SAMPLE") {
    const values = relevant
      .map((r) => {
        const segment = criterion.scope === "IN_SAMPLE" ? r.inSample : r.outOfSample;
        return segment ? segmentMetricValue(segment, criterion.metric) : null;
      })
      .filter((v): v is number => v !== null);
    if (values.length === 0) return null;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  // OVERALL
  const values = relevant.map((r) => instrumentOverallValue(r, criterion.metric)).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function evaluateCriterion(criterion: PassFailCriterion, variant: VariantResult, instruments: readonly string[], aggregate: AggregateStatistics | undefined): CriterionEvaluation {
  const observedValue = extractMetricValue(criterion, variant, instruments, aggregate);
  if (observedValue === null) {
    return { criterion, observedValue: null, satisfied: false, detail: `no computable evidence for ${criterion.metric} at scope ${criterion.scope}` };
  }
  const satisfied = compare(criterion.operator, observedValue, criterion.threshold);
  return { criterion, observedValue, satisfied, detail: `${criterion.metric} (${criterion.scope}) observed ${observedValue} ${criterion.operator} ${criterion.threshold} -> ${satisfied ? "satisfied" : "not satisfied"}` };
}

/** A variant is "acceptable" (feeds `MIN_ACCEPTABLE_VARIANT_PERCENTAGE`) when it satisfies every
 * NON-`ACROSS_VARIANTS`-scoped `passCriteria` entry and triggers none of the NON-`ACROSS_VARIANTS`
 * `failureCriteria` — `ACROSS_VARIANTS` criteria are excluded here deliberately (they describe a
 * property of the whole population, not of one variant, and evaluating them per-variant would be
 * circular). */
export function isVariantAcceptable(variant: VariantResult, plan: ResearchPlanDocument): boolean {
  if (variant.rejected) return false;
  const passOk = plan.passCriteria.filter((c) => c.scope !== "ACROSS_VARIANTS").every((c) => evaluateCriterion(c, variant, plan.instruments, undefined).satisfied);
  const failTriggered = plan.failureCriteria.filter((c) => c.scope !== "ACROSS_VARIANTS").some((c) => evaluateCriterion(c, variant, plan.instruments, undefined).satisfied);
  return passOk && !failTriggered;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index]!;
}

export function computeAggregateStatistics(baseline: VariantResult, variants: readonly VariantResult[], plan: ResearchPlanDocument): AggregateStatistics {
  const evaluable = variants.filter((v) => !v.rejected);
  const netReturns = evaluable.map((v) => extractMetricValue({ metric: "MIN_NET_RETURN", operator: "GREATER_THAN_OR_EQUAL", threshold: 0, scope: "OVERALL" }, v, plan.instruments, undefined)).filter((v): v is number => v !== null);
  const tradeCounts = evaluable.map((v) => extractMetricValue({ metric: "MIN_TRADE_COUNT", operator: "GREATER_THAN_OR_EQUAL", threshold: 0, scope: "OVERALL" }, v, plan.instruments, undefined)).filter((v): v is number => v !== null);
  const drawdowns = evaluable.map((v) => extractMetricValue({ metric: "MAX_DRAWDOWN", operator: "LESS_THAN_OR_EQUAL", threshold: 1, scope: "OVERALL" }, v, plan.instruments, undefined)).filter((v): v is number => v !== null);

  const sortedReturns = [...netReturns].sort((a, b) => a - b);
  const sortedTrades = [...tradeCounts].sort((a, b) => a - b);
  const sortedDrawdowns = [...drawdowns].sort((a, b) => a - b);

  const acceptableVariants = evaluable.filter((v) => isVariantAcceptable(v, plan));

  let bestVariantId: string | null = null;
  let worstVariantId: string | null = null;
  let bestReturn = Number.NEGATIVE_INFINITY;
  let worstReturn = Number.POSITIVE_INFINITY;
  for (const v of evaluable) {
    const r = extractMetricValue({ metric: "MIN_NET_RETURN", operator: "GREATER_THAN_OR_EQUAL", threshold: 0, scope: "OVERALL" }, v, plan.instruments, undefined);
    if (r === null) continue;
    if (r > bestReturn) {
      bestReturn = r;
      bestVariantId = v.variantId;
    }
    if (r < worstReturn) {
      worstReturn = r;
      worstVariantId = v.variantId;
    }
  }

  const totalNetProfitByInstrument = new Map<string, number>();
  for (const r of baseline.perInstrument) {
    if (r.rejected) continue;
    const segment = r.full ?? r.outOfSample ?? r.inSample;
    if (!segment) continue;
    totalNetProfitByInstrument.set(r.instrument, Math.max(0, segment.netPnl));
  }
  const totalProfit = [...totalNetProfitByInstrument.values()].reduce((sum, v) => sum + v, 0);
  const perInstrumentConcentration: InstrumentConcentration[] = [...totalNetProfitByInstrument.entries()].map(([instrument, profit]) => ({
    instrument,
    shareOfTotalNetProfit: totalProfit > 0 ? profit / totalProfit : 0,
  }));

  return {
    variantCount: variants.length,
    evaluableVariantCount: evaluable.length,
    acceptableVariantCount: acceptableVariants.length,
    acceptableVariantPercentage: variants.length > 0 ? (acceptableVariants.length / variants.length) * 100 : 0,
    netReturnPercentiles: { p10: percentile(sortedReturns, 10), p25: percentile(sortedReturns, 25), median: percentile(sortedReturns, 50), p75: percentile(sortedReturns, 75), p90: percentile(sortedReturns, 90) },
    tradeCountRange: { min: sortedTrades[0] ?? 0, max: sortedTrades[sortedTrades.length - 1] ?? 0, median: percentile(sortedTrades, 50) },
    drawdownRange: { min: sortedDrawdowns[0] ?? 0, max: sortedDrawdowns[sortedDrawdowns.length - 1] ?? 0, median: percentile(sortedDrawdowns, 50) },
    bestVariantId,
    worstVariantId,
    perInstrumentConcentration,
  };
}

export interface OutcomeDetermination {
  outcome: ResolvedResearchOutcome;
  warnings: string[];
}

/**
 * Evaluated against the BASELINE alone for `passCriteria`/non-`ACROSS_VARIANTS` `failureCriteria` —
 * NEVER against "whichever variant did best" — so a single lucky variant can never manufacture a
 * PASS the baseline (and the declared neighbourhood, via `MIN_ACCEPTABLE_VARIANT_PERCENTAGE`) does
 * not itself support. This is the direct mechanism behind "one strong outlier cannot produce PASS
 * when the neighbourhood fails."
 */
export function determineOutcome(baseline: VariantResult, plan: ResearchPlanDocument, passEvaluations: readonly CriterionEvaluation[], failureEvaluations: readonly CriterionEvaluation[]): OutcomeDetermination {
  const warnings: string[] = [];

  const totalBaselineTrades = plan.instruments.reduce((sum, instrument) => {
    const r = baseline.perInstrument.find((p) => p.instrument === instrument && !p.rejected);
    const segment = r?.full ?? r?.outOfSample ?? r?.inSample;
    return sum + (segment?.tradeCount ?? 0);
  }, 0);

  if (totalBaselineTrades < plan.robustnessChecks.minTradeCountWarningThreshold) {
    warnings.push(`Baseline produced only ${totalBaselineTrades} total trade(s) across all instruments, below the configured warning threshold of ${plan.robustnessChecks.minTradeCountWarningThreshold} — results may be statistically meaningless.`);
  }

  const failTriggered = failureEvaluations.some((e) => e.satisfied);
  if (failTriggered) return { outcome: "FAIL", warnings };

  const allEvaluationsUncomputable = passEvaluations.length > 0 && passEvaluations.every((e) => e.observedValue === null);
  if (totalBaselineTrades === 0 || allEvaluationsUncomputable) {
    return { outcome: "INCONCLUSIVE", warnings };
  }

  const passOk = passEvaluations.every((e) => e.satisfied);
  return { outcome: passOk ? "PASS" : "FAIL", warnings };
}

export function buildResearchLimitations(planLimitations: readonly string[]): string[] {
  return [...STANDING_RESEARCH_LIMITATIONS, ...planLimitations];
}

export type { EvaluationScope };
export { BACKTEST_ENGINE_VERSION };
