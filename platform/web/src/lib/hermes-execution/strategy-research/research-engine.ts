import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CONTENT_HASH_ALGORITHM, type StrategyDefinitionDocument } from "../strategy-definitions/strategy-definition";
import { loadStrategyDefinitions } from "../strategy-definitions/strategy-definition-registry";
import type { InstrumentCatalogueEntry } from "../instrument-catalogue/instrument-catalogue";
import { runBacktest, type BacktestRunConfig } from "../backtest/backtest-result";
import { BACKTEST_ENGINE_VERSION, type BacktestSegmentMetrics } from "../backtest/backtest-engine";
import { validateResearchPlan, type ResearchPlanDocument } from "./research-plan";
import { loadAndVerifyManifest, type ResolvedManifestEntry } from "./dataset-manifest";
import { generateExperimentMatrix, MAX_EXPERIMENT_VARIANTS_HARD_CAP, type ExperimentVariant } from "./experiment-matrix";
import { generateValidatedVariant, splitCostOverrides } from "./strategy-variant";
import {
  computeAggregateStatistics,
  computeResearchFingerprint,
  computeVariantResultFingerprint,
  determineOutcome,
  evaluateCriterion,
  buildResearchLimitations,
  isVariantAcceptable,
  PHASE3_RESEARCH_ENGINE_VERSION,
  type AggregateStatistics,
  type DatasetInstrumentMode,
  type ResearchResult,
  type VariantInstrumentResult,
  type VariantResult,
} from "./research-result";

// Phase 3 — Strategy Research Workflow. The one orchestrator: loads and validates the research plan
// and its exact strategy version, verifies every content/dataset hash, expands the deterministic
// experiment matrix, runs each variant through Phase 2's OWN, UNMODIFIED `runBacktest` (never a
// second execution engine), and assembles the final, immutable `ResearchResult`. No broker/
// execution/approval/lifecycle/risk import; no network call.

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type RunResearchStage = "plan" | "strategy" | "dataset" | "experiments" | "execution";
export type RunResearchOutput = { ok: true; result: ResearchResult } | { ok: false; stage: RunResearchStage; reason: string; detail: string };

export interface RunResearchOptions {
  planPath: string;
  strategiesDir: string;
  catalogueEntries: readonly InstrumentCatalogueEntry[];
  /** CLI-supplied ceiling — only ever LOWERS `MAX_EXPERIMENT_VARIANTS_HARD_CAP`, never raises it
   * (enforced via `Math.min` below, never trusted alone). */
  maxExperimentsOverride?: number;
  now?: () => string;
}

interface InstrumentDatasetPlan {
  instrument: string;
  mode: DatasetInstrumentMode;
  fullHistory?: ResolvedManifestEntry;
  inSample?: ResolvedManifestEntry;
  outOfSample?: ResolvedManifestEntry;
  stressPeriods: ResolvedManifestEntry[];
  splitAt?: string;
}

/**
 * Two supported ways of getting an in-sample/out-of-sample split for one instrument, chosen per-
 * instrument from the manifest's own declared roles — never both at once for the same instrument:
 *  - `SPLIT`: one `FULL_HISTORY` dataset plus a matching `chronologicalSplits` entry — reuses Phase
 *    2's OWN native `config.split` mechanism verbatim (see `runInstrumentForVariant` below), never a
 *    second, parallel split implementation.
 *  - `SEPARATE`: explicit `IN_SAMPLE` + `OUT_OF_SAMPLE` manifest entries for genuinely distinct
 *    files — two independent `runBacktest` calls, each with no split configured, whose own `.full`
 *    segments become this instrument's `inSample`/`outOfSample` results.
 *  - `FULL_ONLY`: a `FULL_HISTORY` dataset with no configured split — only a `.full` result is ever
 *    produced for this instrument; no in-sample/out-of-sample separation is possible.
 * Any number of `STRESS_PERIOD` entries run independently of whichever of the three modes above
 * applies, never blended into `.full`/`.inSample`/`.outOfSample`.
 */
function resolveInstrumentDatasetPlans(plan: ResearchPlanDocument, resolved: readonly ResolvedManifestEntry[]): { ok: true; plans: Map<string, InstrumentDatasetPlan> } | { ok: false; detail: string } {
  const byInstrument = new Map<string, ResolvedManifestEntry[]>();
  for (const entry of resolved) {
    const list = byInstrument.get(entry.entry.instrument) ?? [];
    list.push(entry);
    byInstrument.set(entry.entry.instrument, list);
  }
  const splitByInstrument = new Map(plan.chronologicalSplits.map((s) => [s.instrument, s.splitAt]));

  const plans = new Map<string, InstrumentDatasetPlan>();
  for (const instrument of plan.instruments) {
    const entries = byInstrument.get(instrument) ?? [];
    const fullHistory = entries.find((e) => e.entry.role === "FULL_HISTORY");
    const inSample = entries.find((e) => e.entry.role === "IN_SAMPLE");
    const outOfSample = entries.find((e) => e.entry.role === "OUT_OF_SAMPLE");
    const stressPeriods = entries.filter((e) => e.entry.role === "STRESS_PERIOD");
    const splitAt = splitByInstrument.get(instrument);

    if (fullHistory && splitAt) {
      plans.set(instrument, { instrument, mode: "SPLIT", fullHistory, stressPeriods, splitAt });
    } else if (fullHistory) {
      plans.set(instrument, { instrument, mode: "FULL_ONLY", fullHistory, stressPeriods });
    } else if (inSample && outOfSample) {
      plans.set(instrument, { instrument, mode: "SEPARATE", inSample, outOfSample, stressPeriods });
    } else {
      return { ok: false, detail: `instrument "${instrument}" has no usable dataset — declare either a FULL_HISTORY entry (optionally with a matching chronologicalSplits entry) or both an IN_SAMPLE and an OUT_OF_SAMPLE entry` };
    }
  }
  return { ok: true, plans };
}

function runInstrumentForVariant(document: StrategyDefinitionDocument, instrument: string, modePlan: InstrumentDatasetPlan, config: BacktestRunConfig, now: () => string): VariantInstrumentResult {
  const stressPeriods: { datasetFile: string; result: BacktestSegmentMetrics }[] = [];
  for (const stress of modePlan.stressPeriods) {
    const stressRun = runBacktest(document, stress.dataset, instrument, config, now);
    if (stressRun.ok) stressPeriods.push({ datasetFile: stress.entry.datasetFile, result: stressRun.result.full });
  }

  if (modePlan.mode === "SPLIT") {
    const run = runBacktest(document, modePlan.fullHistory!.dataset, instrument, { ...config, split: { splitAt: modePlan.splitAt! } }, now);
    if (!run.ok) return { instrument, mode: "SPLIT", stressPeriods, rejected: { reason: run.reason, detail: run.detail } };
    return { instrument, mode: "SPLIT", full: run.result.full, inSample: run.result.inSample, outOfSample: run.result.outOfSample, stressPeriods };
  }

  if (modePlan.mode === "SEPARATE") {
    const isRun = runBacktest(document, modePlan.inSample!.dataset, instrument, config, now);
    const oosRun = runBacktest(document, modePlan.outOfSample!.dataset, instrument, config, now);
    if (!isRun.ok) return { instrument, mode: "SEPARATE", stressPeriods, rejected: { reason: isRun.reason, detail: `in-sample: ${isRun.detail}` } };
    if (!oosRun.ok) return { instrument, mode: "SEPARATE", stressPeriods, rejected: { reason: oosRun.reason, detail: `out-of-sample: ${oosRun.detail}` } };
    return { instrument, mode: "SEPARATE", inSample: isRun.result.full, outOfSample: oosRun.result.full, stressPeriods };
  }

  const run = runBacktest(document, modePlan.fullHistory!.dataset, instrument, config, now);
  if (!run.ok) return { instrument, mode: "FULL_ONLY", stressPeriods, rejected: { reason: run.reason, detail: run.detail } };
  return { instrument, mode: "FULL_ONLY", full: run.result.full, stressPeriods };
}

function runVariant(baselineDocument: StrategyDefinitionDocument, variant: ExperimentVariant, plan: ResearchPlanDocument, instrumentPlans: ReadonlyMap<string, InstrumentDatasetPlan>, catalogueEntries: readonly InstrumentCatalogueEntry[], now: () => string): VariantResult {
  const generated = generateValidatedVariant(baselineDocument, catalogueEntries, variant.overrides, now());
  if (!generated.ok) {
    return { variantId: variant.variantId, contentHash: variant.contentHash, overrides: variant.overrides, isBaseline: variant.isBaseline, perInstrument: [], rejected: { reason: generated.reason, detail: generated.detail } };
  }

  const variantDocument = generated.record.document;
  const costOverrides = splitCostOverrides(variant.overrides);
  const config: BacktestRunConfig = {
    feeBps: costOverrides.feeBps ?? plan.baselineConfig.feeBps,
    slippageBps: costOverrides.slippageBps ?? plan.baselineConfig.slippageBps,
    startingCapital: plan.baselineConfig.startingCapital,
  };

  const perInstrument = plan.instruments.map((instrument) => runInstrumentForVariant(variantDocument, instrument, instrumentPlans.get(instrument)!, config, now));
  const strategyContentHash = generated.record.result.provenance.contentHash;
  const resultFingerprint = computeVariantResultFingerprint({ variantId: variant.variantId, contentHash: variant.contentHash, overrides: variant.overrides, strategyContentHash, perInstrument });

  return { variantId: variant.variantId, contentHash: variant.contentHash, overrides: variant.overrides, isBaseline: variant.isBaseline, strategyContentHash, perInstrument, resultFingerprint };
}

function instrumentSegment(result: VariantInstrumentResult): BacktestSegmentMetrics | undefined {
  return result.full ?? result.outOfSample ?? result.inSample;
}

/**
 * Warnings this module computes UNCONDITIONALLY (never gated behind a declared criterion) — see
 * requirement 7's own "add warnings when..." list. Every threshold here is a documented, fixed
 * constant, never user-configurable beyond what `robustnessChecks` already exposes.
 */
export function buildRobustnessWarnings(baseline: VariantResult, variants: readonly VariantResult[], aggregate: AggregateStatistics, plan: ResearchPlanDocument): string[] {
  const warnings: string[] = [];

  for (const concentration of aggregate.perInstrumentConcentration) {
    const sharePct = concentration.shareOfTotalNetProfit * 100;
    if (sharePct > plan.robustnessChecks.maxInstrumentConcentrationWarningThreshold) {
      warnings.push(`Instrument "${concentration.instrument}" accounts for ${sharePct.toFixed(1)}% of the baseline's total net profit — results depend heavily on a single instrument.`);
    }
  }

  const evaluable = variants.filter((v) => !v.rejected);
  if (evaluable.length > 1) {
    // Deliberately worded as "evaluated parameter grid," never "neighbourhood" — this is a flat
    // acceptable/total ratio over the WHOLE matrix, with no notion of which variants are close to
    // the baseline or to each other. See the single-parameter-neighbour check below for the
    // genuinely spatial version of this warning.
    const acceptabilityByVariant = evaluable.map((v) => isVariantAcceptable(v, plan));
    const acceptableCount = acceptabilityByVariant.filter(Boolean).length;
    if (acceptableCount > 0 && acceptableCount < evaluable.length) {
      const pct = (acceptableCount / evaluable.length) * 100;
      if (pct < 30) {
        warnings.push(`Only ${pct.toFixed(1)}% of the evaluated parameter grid is acceptable — this may indicate the strategy only works for a narrow parameter combination rather than a genuine, stable edge.`);
      } else if (pct < 80) {
        warnings.push(`Acceptability is mixed across the evaluated parameter grid (${pct.toFixed(1)}% acceptable) — treat any single passing configuration with caution.`);
      }
    }

    // The genuinely spatial check: variants that change EXACTLY one parameter from the baseline,
    // holding every other parameter fixed — an actual "immediate neighbour," not merely a member of
    // the same overall grid.
    const baselineAcceptable = isVariantAcceptable(baseline, plan);
    const singleParameterNeighbours = evaluable.filter((v) => !v.isBaseline && Object.keys(v.overrides).length === 1);
    if (singleParameterNeighbours.length > 0) {
      const disagreeing = singleParameterNeighbours.filter((v) => isVariantAcceptable(v, plan) !== baselineAcceptable);
      if (disagreeing.length > 0) {
        const pct = (disagreeing.length / singleParameterNeighbours.length) * 100;
        warnings.push(
          `${disagreeing.length} of ${singleParameterNeighbours.length} single-parameter neighbours of the baseline (${pct.toFixed(1)}%) disagree with the baseline's own acceptability (baseline is ${baselineAcceptable ? "acceptable" : "not acceptable"}) — small, single-parameter changes can reverse the result.`,
        );
      }
    }
  }

  for (const instrumentResult of baseline.perInstrument) {
    if (instrumentResult.rejected) continue;
    if (instrumentResult.inSample && instrumentResult.outOfSample) {
      const degradation = instrumentResult.inSample.totalReturn - instrumentResult.outOfSample.totalReturn;
      if (degradation > 0.1) {
        warnings.push(`${instrumentResult.instrument}: out-of-sample return is ${(degradation * 100).toFixed(1)} percentage points worse than in-sample — material IS-to-OOS degradation.`);
      }
    }
    const segment = instrumentSegment(instrumentResult);
    if (segment && segment.grossPnl > 0 && segment.netPnl <= segment.grossPnl * 0.1) {
      warnings.push(`${instrumentResult.instrument}: fees and slippage consumed ${segment.netPnl <= 0 ? "all" : "most"} of the gross profit (gross ${segment.grossPnl.toFixed(2)}, net ${segment.netPnl.toFixed(2)}) — cost assumptions materially affect this result.`);
    }
  }

  return warnings;
}

/**
 * The single Phase 3 orchestrator. Steps, matching requirement 6 exactly: (1) reads and validates
 * the plan file, (2) loads the exact strategy version through the REAL Phase 1 registry, (3)
 * verifies the plan's own `strategyContentHash` against it, (4) verifies every declared dataset's
 * actual hash against the manifest, (5) expands the deterministic experiment matrix, (6) runs every
 * variant through Phase 2's own `runBacktest` (never duplicated), (7) captures IS/OOS separately per
 * instrument, (8) evaluates the plan's predeclared criteria against the BASELINE, (9) computes
 * cross-instrument/cross-variant aggregate statistics, (10) returns one immutable `ResearchResult` —
 * this function performs no persistence itself (see research-persistence.ts).
 */
type PlanAndDatasetVerificationResult =
  | { ok: true; plan: ResearchPlanDocument; record: Awaited<ReturnType<typeof loadStrategyDefinitions>>["accepted"][number]; planContentHash: string; manifestResult: Extract<Awaited<ReturnType<typeof loadAndVerifyManifest>>, { ok: true }> }
  | { ok: false; stage: RunResearchStage; reason: string; detail: string };

/**
 * The shared prefix of `runResearch` and `validateResearchPlanDatasets`: read/parse the plan file,
 * validate it (first without, then with, the real strategy content hash), load the exact strategy
 * version through the REAL Phase 1 registry, and verify every declared dataset's actual hash against
 * the manifest. Factored out so plan/dataset-only validation (no backtest ever run) and the full
 * research run share this logic verbatim rather than maintaining two copies of it.
 */
async function loadAndVerifyPlanAndDatasets(options: Pick<RunResearchOptions, "planPath" | "strategiesDir" | "catalogueEntries">, now: () => string, nowIso: string): Promise<PlanAndDatasetVerificationResult> {
  let rawPlanText: string;
  try {
    rawPlanText = await fs.readFile(options.planPath, "utf-8");
  } catch (error) {
    return { ok: false, stage: "plan", reason: "READ_ERROR", detail: toErrorMessage(error) };
  }
  let rawPlan: unknown;
  try {
    rawPlan = JSON.parse(rawPlanText);
  } catch (error) {
    return { ok: false, stage: "plan", reason: "INVALID_JSON", detail: toErrorMessage(error) };
  }

  // First pass: validates everything EXCEPT the strategy-hash cross-check (we don't know the real
  // hash until the strategy is loaded below) — still rejects a structurally malformed plan outright.
  const preliminary = validateResearchPlan(rawPlan, undefined, nowIso);
  if (!preliminary.ok) return { ok: false, stage: "plan", reason: preliminary.reason, detail: preliminary.detail };
  const plan = preliminary.document;

  const strategyLoad = await loadStrategyDefinitions(options.strategiesDir, options.catalogueEntries, { now });
  const record = strategyLoad.accepted.find((r) => r.document.strategyId === plan.strategyId && r.document.strategyVersion === plan.strategyVersion);
  if (!record) {
    const rejection = strategyLoad.rejected.find((r) => r.filePath.includes(plan.strategyId) || r.filePath.includes(plan.strategyVersion));
    return {
      ok: false,
      stage: "strategy",
      reason: "STRATEGY_NOT_FOUND",
      detail: `Strategy "${plan.strategyId}" v${plan.strategyVersion} was not found as a valid, accepted strategy definition in ${options.strategiesDir}.` + (rejection ? ` A related file was rejected [${rejection.reason}]: ${rejection.detail}` : ""),
    };
  }

  const final = validateResearchPlan(rawPlan, record.result.provenance.contentHash, nowIso);
  if (!final.ok) return { ok: false, stage: "plan", reason: final.reason, detail: final.detail };

  if (!plan.instruments.every((i) => record.document.supportedInstruments.includes(i))) {
    return { ok: false, stage: "strategy", reason: "UNSUPPORTED_INSTRUMENT", detail: `plan declares instrument(s) not in the strategy's own supportedInstruments (${record.document.supportedInstruments.join(", ")})` };
  }
  if (plan.datasets.some((d) => !plan.instruments.includes(d.instrument))) {
    return { ok: false, stage: "dataset", reason: "UNKNOWN_INSTRUMENT", detail: "dataset manifest references an instrument not declared in plan.instruments" };
  }

  const manifestResult = await loadAndVerifyManifest(plan.datasets, now);
  if (!manifestResult.ok) return { ok: false, stage: "dataset", reason: manifestResult.reason, detail: manifestResult.detail };

  return { ok: true, plan, record, planContentHash: final.result.contentHash, manifestResult };
}

export type ValidateOnlyOutput =
  | {
      ok: true;
      plan: { researchPlanId: string; researchPlanVersion: string; planContentHash: string };
      strategy: { strategyId: string; strategyVersion: string; strategyContentHash: string };
      datasets: { instrument: string; role: string; datasetHash: string; filePath: string }[];
    }
  | { ok: false; stage: RunResearchStage; reason: string; detail: string };

/**
 * Verifies a plan and every dataset it declares — WITHOUT generating the experiment matrix or
 * running a single backtest — for a `--validate-only` CLI mode. Read-only, deterministic, and no
 * slower than the plan/dataset-verification prefix `runResearch` already performs before its first
 * backtest; this never duplicates that logic, it reuses `loadAndVerifyPlanAndDatasets` directly.
 */
export async function validateResearchPlanDatasets(options: Pick<RunResearchOptions, "planPath" | "strategiesDir" | "catalogueEntries" | "now">): Promise<ValidateOnlyOutput> {
  const now = options.now ?? (() => new Date().toISOString());
  const verification = await loadAndVerifyPlanAndDatasets(options, now, now());
  if (!verification.ok) return { ok: false, stage: verification.stage, reason: verification.reason, detail: verification.detail };
  return {
    ok: true,
    plan: { researchPlanId: verification.plan.researchPlanId, researchPlanVersion: verification.plan.researchPlanVersion, planContentHash: verification.planContentHash },
    strategy: { strategyId: verification.record.document.strategyId, strategyVersion: verification.record.document.strategyVersion, strategyContentHash: verification.record.result.provenance.contentHash },
    datasets: verification.manifestResult.resolved.map((r) => ({ instrument: r.entry.instrument, role: r.entry.role, datasetHash: r.dataset.datasetHash, filePath: r.entry.datasetFile })),
  };
}

export async function runResearch(options: RunResearchOptions): Promise<RunResearchOutput> {
  const now = options.now ?? (() => new Date().toISOString());
  const nowIso = now();

  const verification = await loadAndVerifyPlanAndDatasets(options, now, nowIso);
  if (!verification.ok) return verification;
  const { plan, record, manifestResult, planContentHash } = verification;

  const instrumentPlansResult = resolveInstrumentDatasetPlans(plan, manifestResult.resolved);
  if (!instrumentPlansResult.ok) return { ok: false, stage: "dataset", reason: "INCOMPLETE_MANIFEST", detail: instrumentPlansResult.detail };

  const effectiveCap = options.maxExperimentsOverride !== undefined ? Math.min(options.maxExperimentsOverride, MAX_EXPERIMENT_VARIANTS_HARD_CAP) : MAX_EXPERIMENT_VARIANTS_HARD_CAP;
  const matrixResult = generateExperimentMatrix(plan.parameterExperiments, effectiveCap);
  if (!matrixResult.ok) return { ok: false, stage: "experiments", reason: matrixResult.reason, detail: matrixResult.detail };

  const variantResults = matrixResult.variants.map((variant) => runVariant(record.document, variant, plan, instrumentPlansResult.plans, options.catalogueEntries, now));
  const baseline = variantResults.find((v) => v.isBaseline)!;
  if (baseline.rejected) {
    return { ok: false, stage: "execution", reason: baseline.rejected.reason, detail: `baseline variant failed to execute: ${baseline.rejected.detail}` };
  }

  const aggregate = computeAggregateStatistics(baseline, variantResults, plan);
  const allCriteria = [...plan.passCriteria, ...plan.failureCriteria];
  const criterionEvaluations = allCriteria.map((c) => evaluateCriterion(c, baseline, plan.instruments, aggregate));
  const passEvaluations = criterionEvaluations.slice(0, plan.passCriteria.length);
  const failureEvaluations = criterionEvaluations.slice(plan.passCriteria.length);

  const { outcome, warnings: outcomeWarnings } = determineOutcome(baseline, plan, passEvaluations, failureEvaluations);
  const warnings = [...outcomeWarnings, ...buildRobustnessWarnings(baseline, variantResults, aggregate, plan)];

  const datasetIdentities = manifestResult.resolved.map((r) => ({ instrument: r.entry.instrument, role: r.entry.role, datasetHash: r.dataset.datasetHash, filePath: r.entry.datasetFile }));
  const researchFingerprint = computeResearchFingerprint({
    planContentHash,
    strategyContentHash: record.result.provenance.contentHash,
    datasetHashes: datasetIdentities.map(({ instrument, role, datasetHash }) => ({ instrument, role, datasetHash })),
    experimentMatrixHash: matrixResult.experimentMatrixHash,
    phase2EngineVersion: BACKTEST_ENGINE_VERSION,
    phase3EngineVersion: PHASE3_RESEARCH_ENGINE_VERSION,
  });

  const result: ResearchResult = {
    researchRunId: randomUUID(),
    generatedAt: nowIso,
    phase2EngineVersion: BACKTEST_ENGINE_VERSION,
    phase3EngineVersion: PHASE3_RESEARCH_ENGINE_VERSION,
    plan: { researchPlanId: plan.researchPlanId, researchPlanVersion: plan.researchPlanVersion, planContentHash },
    planDocument: plan,
    strategy: { strategyId: record.document.strategyId, strategyVersion: record.document.strategyVersion, strategyContentHash: record.result.provenance.contentHash },
    datasets: datasetIdentities,
    experimentMatrixHash: matrixResult.experimentMatrixHash,
    excludedCombinations: matrixResult.excluded,
    researchFingerprint,
    researchFingerprintAlgorithm: CONTENT_HASH_ALGORITHM,
    baseline,
    variants: variantResults,
    aggregate,
    criterionEvaluations,
    outcome,
    warnings,
    limitations: buildResearchLimitations(plan.limitations),
  };

  return { ok: true, result };
}
