import { createHash } from "node:crypto";
import {
  canonicalStringify,
  CONTENT_HASH_ALGORITHM,
  compareSemver,
  findProhibitedFields,
  parseSemver,
  SUPPORTED_TIMEFRAMES,
  type ComparisonOperator,
  type SupportedTimeframe,
} from "../strategy-definitions/strategy-definition";
import type { DatasetManifestEntry } from "./dataset-manifest";
import { checkNoDuplicateManifestEntries, validateDatasetManifestEntry } from "./dataset-manifest";
import type { ParameterExperimentConfig } from "./experiment-matrix";
import { validateParameterExperimentConfig } from "./experiment-matrix";

// Phase 3 — Strategy Research Workflow. A research PLAN is validated DATA, never executable code —
// exactly Phase 1's own "never a formula string, never evaluated as code" discipline
// (strategy-definitions/strategy-definition.ts), applied one layer up: this schema describes WHICH
// backtests to run and WHAT would count as evidence of anything, decided BEFORE any result exists.
// Pure module — no filesystem I/O, no broker/execution/approval/lifecycle/risk import, no network
// call. Reuses Phase 1's own canonicalStringify/findProhibitedFields/compareSemver/parseSemver
// rather than re-deriving a second, parallel implementation of any of them.

export const RESEARCH_PLAN_SCHEMA_VERSION = 1;

const RESEARCH_PLAN_ID_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export type EvaluationScope = "OVERALL" | "IN_SAMPLE" | "OUT_OF_SAMPLE" | "PER_INSTRUMENT" | "ACROSS_VARIANTS";
const EVALUATION_SCOPES: readonly EvaluationScope[] = ["OVERALL", "IN_SAMPLE", "OUT_OF_SAMPLE", "PER_INSTRUMENT", "ACROSS_VARIANTS"];

/**
 * Deliberately small and closed — the exact "small typed set of metrics" requirement 2 calls for.
 * Each maps 1:1 to a value this module can compute from Phase 2's own `BacktestSegmentMetrics` (or,
 * for the two `ACROSS_VARIANTS`-shaped metrics, from this module's own aggregate statistics) — never
 * a formula string, never an arbitrary expression.
 */
export type CriterionMetric =
  | "MIN_TRADE_COUNT"
  | "MIN_NET_RETURN"
  | "MAX_DRAWDOWN"
  | "MIN_PROFIT_FACTOR"
  | "MIN_WIN_RATE"
  | "MIN_OOS_NET_RETURN"
  | "MAX_IS_TO_OOS_DEGRADATION"
  | "MAX_INSTRUMENT_CONCENTRATION"
  | "MIN_ACCEPTABLE_VARIANT_PERCENTAGE";
const CRITERION_METRICS: readonly CriterionMetric[] = [
  "MIN_TRADE_COUNT",
  "MIN_NET_RETURN",
  "MAX_DRAWDOWN",
  "MIN_PROFIT_FACTOR",
  "MIN_WIN_RATE",
  "MIN_OOS_NET_RETURN",
  "MAX_IS_TO_OOS_DEGRADATION",
  "MAX_INSTRUMENT_CONCENTRATION",
  "MIN_ACCEPTABLE_VARIANT_PERCENTAGE",
];

/**
 * Per-metric valid threshold range — used to reject an "impossible" threshold outright (e.g. a
 * MIN_WIN_RATE of 1.5, which nothing could ever satisfy since a win rate can never exceed 1). `null`
 * bounds mean "no natural ceiling/floor beyond finiteness itself."
 *
 * Units, spelled out explicitly since two different scales are deliberately in play: MIN_NET_RETURN/
 * MIN_OOS_NET_RETURN/MAX_DRAWDOWN/MIN_WIN_RATE are FRACTIONS (0.1 = 10%), matching
 * `BacktestSegmentMetrics.totalReturn`/`maxDrawdown`/`winRate` exactly — never percentages.
 * MAX_INSTRUMENT_CONCENTRATION/MIN_ACCEPTABLE_VARIANT_PERCENTAGE are PERCENTAGES (0-100), matching
 * their own names literally.
 */
const CRITERION_THRESHOLD_RANGES: Record<CriterionMetric, { min: number | null; max: number | null }> = {
  MIN_TRADE_COUNT: { min: 0, max: null },
  MIN_NET_RETURN: { min: -1, max: null },
  MAX_DRAWDOWN: { min: 0, max: 1 },
  MIN_PROFIT_FACTOR: { min: 0, max: null },
  MIN_WIN_RATE: { min: 0, max: 1 },
  MIN_OOS_NET_RETURN: { min: -1, max: null },
  MAX_IS_TO_OOS_DEGRADATION: { min: null, max: null },
  MAX_INSTRUMENT_CONCENTRATION: { min: 0, max: 100 },
  MIN_ACCEPTABLE_VARIANT_PERCENTAGE: { min: 0, max: 100 },
};

const COMPARISON_OPERATORS: readonly ComparisonOperator[] = ["GREATER_THAN", "LESS_THAN", "GREATER_THAN_OR_EQUAL", "LESS_THAN_OR_EQUAL"];

export interface PassFailCriterion {
  metric: CriterionMetric;
  operator: ComparisonOperator;
  threshold: number;
  scope: EvaluationScope;
}

const CRITERION_KEYS = ["metric", "operator", "threshold", "scope"] as const;

export interface ResearchBaselineConfig {
  feeBps: number;
  slippageBps: number;
  startingCapital: number;
}
const BASELINE_CONFIG_KEYS = ["feeBps", "slippageBps", "startingCapital"] as const;

export interface ChronologicalSplitConfig {
  instrument: string;
  splitAt: string;
}
const SPLIT_KEYS = ["instrument", "splitAt"] as const;

export interface RobustnessChecksConfig {
  /** Below this many trades in a segment, the research result carries a low-trade-count warning
   * (see research-engine.ts's own doc comment) — declarative configuration only, never itself a
   * pass/fail gate (use a MIN_TRADE_COUNT criterion for that). */
  minTradeCountWarningThreshold: number;
  /** Percentage (0-100): if any single instrument contributes more than this share of the baseline's
   * total net profit across instruments, a concentration warning is added. Same 0-100 scale as the
   * `MAX_INSTRUMENT_CONCENTRATION` criterion metric — deliberately consistent, never a 0-1 fraction
   * here and a percentage there. */
  maxInstrumentConcentrationWarningThreshold: number;
  notes: string[];
}
const ROBUSTNESS_KEYS = ["minTradeCountWarningThreshold", "maxInstrumentConcentrationWarningThreshold", "notes"] as const;

export interface ResearchPlanProvenance {
  author: string;
  createdAt: string;
  notes: string[];
}
const PROVENANCE_KEYS = ["author", "createdAt", "notes"] as const;

export interface ResearchPlanDocument {
  schemaVersion: number;
  researchPlanId: string;
  researchPlanVersion: string;
  name: string;
  description: string;
  /** The exact Phase 1 strategy this plan researches — never a range, never "latest." */
  strategyId: string;
  strategyVersion: string;
  /** The BASELINE strategy document's own `contentHash` (strategy-definition.ts's
   * `computeContentHash`), preserved here so a plan is pinned to an EXACT, immutable strategy
   * document — never merely a mutable "id + version" pointer that could silently start meaning a
   * different document if a file were ever (wrongly) edited in place. Verified against the actually-
   * loaded strategy at research-run time (research-engine.ts) — a mismatch is rejected outright. */
  strategyContentHash: string;
  instruments: string[];
  timeframe: SupportedTimeframe;
  datasets: DatasetManifestEntry[];
  baselineConfig: ResearchBaselineConfig;
  parameterExperiments: ParameterExperimentConfig;
  chronologicalSplits: ChronologicalSplitConfig[];
  /** ALL must be satisfied for the research outcome to be PASS. */
  passCriteria: PassFailCriterion[];
  /** If ANY is satisfied (triggered), the outcome is FAIL regardless of `passCriteria` — an
   * explicit "kill switch" condition (e.g. "per-instrument max drawdown above 60%"), evaluated with
   * the identical mechanism as `passCriteria`, just the opposite verdict on trigger. */
  failureCriteria: PassFailCriterion[];
  robustnessChecks: RobustnessChecksConfig;
  limitations: string[];
  provenance: ResearchPlanProvenance;
}

const ROOT_KEYS = [
  "schemaVersion",
  "researchPlanId",
  "researchPlanVersion",
  "name",
  "description",
  "strategyId",
  "strategyVersion",
  "strategyContentHash",
  "instruments",
  "timeframe",
  "datasets",
  "baselineConfig",
  "parameterExperiments",
  "chronologicalSplits",
  "passCriteria",
  "failureCriteria",
  "robustnessChecks",
  "limitations",
  "provenance",
] as const;

// Mirrors strategy-definition.ts's own PROHIBITED_FIELD_NAMES_NORMALISED list exactly — a research
// plan must never carry a broker/execution/approval/lifecycle/sizing/risk-shaped field any more than
// a strategy document may. `findProhibitedFields` (imported from strategy-definition.ts, not
// reimplemented here) already normalises case/punctuation and recurses the whole document.

export type ResearchPlanRejectionReason =
  | "UNEXPECTED_SHAPE"
  | "MISSING_REQUIRED_FIELD"
  | "SCHEMA_VERSION_TOO_OLD"
  | "INVALID_PLAN_ID"
  | "INVALID_PLAN_VERSION"
  | "INVALID_STRATEGY_VERSION"
  | "INVALID_TIMEFRAME"
  | "INVALID_INSTRUMENTS"
  | "INVALID_DATASET_MANIFEST"
  | "INVALID_EXPERIMENT_CONFIG"
  | "INVALID_SPLIT"
  | "INVALID_CRITERION"
  | "PROHIBITED_FIELD"
  | "UNEXPECTED_FIELD";

export interface ResearchPlanValidationResult {
  valid: boolean;
  validationErrors: string[];
  contentHash: string;
  contentHashAlgorithm: typeof CONTENT_HASH_ALGORITHM;
  loadedAt: string;
}

export type ValidateResearchPlanResult =
  | { ok: true; document: ResearchPlanDocument; result: ResearchPlanValidationResult }
  | { ok: false; reason: ResearchPlanRejectionReason; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * `MIN_*` metrics only make sense guarded by a "must be at least" operator, and `MAX_*` metrics only
 * by a "must be at most" one — pairing e.g. `MIN_NET_RETURN` with `LESS_THAN` would silently declare
 * a criterion that means the opposite of what its own name says. For `failureCriteria` the required
 * direction is the mirror image: a `passCriteria` `MIN_*` entry asserts "this floor must be met to
 * pass," while a `failureCriteria` `MIN_*` entry asserts "falling BELOW this floor triggers a fail" —
 * hence `LESS_THAN`/`LESS_THAN_OR_EQUAL` for `MIN_*` and `GREATER_THAN`/`GREATER_THAN_OR_EQUAL` for
 * `MAX_*` on the failure side.
 */
function requiredOperatorsForMetric(metric: CriterionMetric, kind: "pass" | "failure"): readonly ComparisonOperator[] {
  const isMinMetric = metric.startsWith("MIN_");
  const passOperators: readonly ComparisonOperator[] = isMinMetric ? ["GREATER_THAN", "GREATER_THAN_OR_EQUAL"] : ["LESS_THAN", "LESS_THAN_OR_EQUAL"];
  const failureOperators: readonly ComparisonOperator[] = isMinMetric ? ["LESS_THAN", "LESS_THAN_OR_EQUAL"] : ["GREATER_THAN", "GREATER_THAN_OR_EQUAL"];
  return kind === "pass" ? passOperators : failureOperators;
}

function criterionErrors(raw: unknown, path: string, kind: "pass" | "failure"): string[] {
  if (!isRecord(raw)) return [`${path}: missing or malformed`];
  const extra = Object.keys(raw).filter((k) => !(CRITERION_KEYS as readonly string[]).includes(k));
  const errors: string[] = extra.length > 0 ? [`${path}: unsupported field(s) ${extra.join(", ")}`] : [];
  if (typeof raw.metric !== "string" || !CRITERION_METRICS.includes(raw.metric as CriterionMetric)) {
    errors.push(`${path}.metric: must be one of ${CRITERION_METRICS.join(", ")} (got ${JSON.stringify(raw.metric)})`);
    return errors;
  }
  if (typeof raw.operator !== "string" || !COMPARISON_OPERATORS.includes(raw.operator as ComparisonOperator)) {
    errors.push(`${path}.operator: must be one of ${COMPARISON_OPERATORS.join(", ")} (got ${JSON.stringify(raw.operator)})`);
  } else {
    const required = requiredOperatorsForMetric(raw.metric as CriterionMetric, kind);
    if (!required.includes(raw.operator as ComparisonOperator)) {
      errors.push(`${path}.operator: ${raw.metric} in a ${kind} criterion must use ${required.join(" or ")} (got ${raw.operator}) — the wrong direction would silently mean the opposite of what this criterion's name says`);
    }
  }
  if (typeof raw.scope !== "string" || !EVALUATION_SCOPES.includes(raw.scope as EvaluationScope)) {
    errors.push(`${path}.scope: must be one of ${EVALUATION_SCOPES.join(", ")} (got ${JSON.stringify(raw.scope)})`);
  }
  if (!isFiniteNumber(raw.threshold)) {
    errors.push(`${path}.threshold: must be a finite number (got ${JSON.stringify(raw.threshold)})`);
  } else {
    const range = CRITERION_THRESHOLD_RANGES[raw.metric as CriterionMetric];
    if (range.min !== null && raw.threshold < range.min) errors.push(`${path}.threshold: ${raw.metric} must be >= ${range.min} (got ${raw.threshold}) — an impossible threshold below this can never be satisfied`);
    if (range.max !== null && raw.threshold > range.max) errors.push(`${path}.threshold: ${raw.metric} must be <= ${range.max} (got ${raw.threshold}) — an impossible threshold above this can never be satisfied`);
    if (raw.metric === "MIN_TRADE_COUNT" && !Number.isInteger(raw.threshold)) errors.push(`${path}.threshold: MIN_TRADE_COUNT must be an integer (got ${raw.threshold})`);
  }
  return errors;
}

/**
 * Validates one already-parsed JSON value as a Phase 3 research plan. Cross-checked against the
 * ALREADY-LOADED, ALREADY-VALIDATED baseline strategy document (never re-fetches or re-derives
 * strategy state itself) — a plan referencing the wrong `strategyContentHash` for the given
 * `strategyId`/`strategyVersion` is rejected outright, exactly like a strategy document referencing
 * an unknown instrument is rejected in Phase 1. `datasets`/`parameterExperiments` are delegated to
 * their own dedicated validators (dataset-manifest.ts / experiment-matrix.ts) so this function never
 * duplicates their own field-by-field logic.
 */
export function validateResearchPlan(raw: unknown, baselineStrategyContentHash: string | undefined, loadedAt: string = new Date().toISOString()): ValidateResearchPlanResult {
  const prohibitedFieldsFound = findProhibitedFields(raw);
  if (prohibitedFieldsFound.length > 0) {
    return { ok: false, reason: "PROHIBITED_FIELD", detail: `research plan contains prohibited field(s): ${prohibitedFieldsFound.join(", ")}` };
  }
  if (!isRecord(raw)) {
    return { ok: false, reason: "UNEXPECTED_SHAPE", detail: "expected a JSON object at the document root" };
  }

  const extraRootKeys = Object.keys(raw).filter((k) => !(ROOT_KEYS as readonly string[]).includes(k));
  if (extraRootKeys.length > 0) {
    return { ok: false, reason: "UNEXPECTED_FIELD", detail: `unsupported top-level field(s): ${extraRootKeys.join(", ")} — never silently ignored` };
  }

  const schemaVersion = raw.schemaVersion;
  if (typeof schemaVersion !== "number") return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "schemaVersion missing or not a number" };
  if (schemaVersion < RESEARCH_PLAN_SCHEMA_VERSION) {
    return { ok: false, reason: "SCHEMA_VERSION_TOO_OLD", detail: `schemaVersion ${schemaVersion} < ${RESEARCH_PLAN_SCHEMA_VERSION}` };
  }

  const researchPlanId = raw.researchPlanId;
  if (typeof researchPlanId !== "string" || !RESEARCH_PLAN_ID_PATTERN.test(researchPlanId)) {
    return { ok: false, reason: "INVALID_PLAN_ID", detail: `researchPlanId must match ${RESEARCH_PLAN_ID_PATTERN} (got ${JSON.stringify(researchPlanId)})` };
  }
  const researchPlanVersion = raw.researchPlanVersion;
  if (typeof researchPlanVersion !== "string" || !parseSemver(researchPlanVersion)) {
    return { ok: false, reason: "INVALID_PLAN_VERSION", detail: `researchPlanVersion must be strict MAJOR.MINOR.PATCH semver (got ${JSON.stringify(researchPlanVersion)})` };
  }
  const strategyVersion = raw.strategyVersion;
  if (typeof strategyVersion !== "string" || !parseSemver(strategyVersion)) {
    return { ok: false, reason: "INVALID_STRATEGY_VERSION", detail: `strategyVersion must be strict MAJOR.MINOR.PATCH semver (got ${JSON.stringify(strategyVersion)})` };
  }

  const validationErrors: string[] = [];

  if (typeof raw.name !== "string" || raw.name.trim().length === 0) validationErrors.push("name missing or not a non-empty string");
  if (typeof raw.description !== "string") validationErrors.push("description missing or not a string");
  if (typeof raw.strategyId !== "string" || raw.strategyId.trim().length === 0) validationErrors.push("strategyId missing or not a non-empty string");
  if (typeof raw.strategyContentHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.strategyContentHash)) {
    validationErrors.push("strategyContentHash missing or not a 64-hex-char sha256 digest");
  } else if (baselineStrategyContentHash !== undefined && raw.strategyContentHash !== baselineStrategyContentHash) {
    validationErrors.push(`strategyContentHash "${raw.strategyContentHash}" does not match the actually-loaded strategy's own content hash "${baselineStrategyContentHash}" — a plan must be pinned to the exact strategy document it was authored against`);
  }

  const timeframe = raw.timeframe;
  if (typeof timeframe !== "string" || !(SUPPORTED_TIMEFRAMES as readonly string[]).includes(timeframe)) {
    validationErrors.push(`timeframe must be one of ${SUPPORTED_TIMEFRAMES.join(", ")} (got ${JSON.stringify(timeframe)})`);
  }

  const instruments = Array.isArray(raw.instruments) ? raw.instruments.filter((i): i is string => typeof i === "string") : [];
  if (!Array.isArray(raw.instruments) || instruments.length === 0) {
    validationErrors.push("instruments must be a non-empty array of strings");
  } else if (new Set(instruments).size !== instruments.length) {
    validationErrors.push("instruments must not contain duplicate entries");
  }

  if (!Array.isArray(raw.datasets)) {
    validationErrors.push("datasets must be an array");
  } else {
    const datasetEntryErrors = raw.datasets.flatMap((entry, index) => validateDatasetManifestEntry(entry, `datasets[${index}]`));
    validationErrors.push(...datasetEntryErrors);
    // Only meaningful once every entry already has the right shape — a malformed entry's own
    // instrument/role fields aren't trustworthy enough to de-duplicate or cross-check yet. Scoped to
    // datasets' own errors, not the whole plan's, so an unrelated failure elsewhere (e.g. a missing
    // `name`) never suppresses this check.
    if (datasetEntryErrors.length === 0) {
      const duplicateCheck = checkNoDuplicateManifestEntries(raw.datasets as DatasetManifestEntry[]);
      if (!duplicateCheck.ok) validationErrors.push(`datasets: ${duplicateCheck.detail}`);
      const unknownInstrumentEntry = (raw.datasets as DatasetManifestEntry[]).find((d) => !instruments.includes(d.instrument));
      if (unknownInstrumentEntry) {
        validationErrors.push(`datasets: entry for instrument "${unknownInstrumentEntry.instrument}" is not declared in this plan's own instruments list`);
      }
    }
  }

  const baselineConfig = raw.baselineConfig;
  if (!isRecord(baselineConfig)) {
    validationErrors.push("baselineConfig missing or malformed");
  } else {
    const extra = Object.keys(baselineConfig).filter((k) => !(BASELINE_CONFIG_KEYS as readonly string[]).includes(k));
    if (extra.length > 0) validationErrors.push(`baselineConfig: unsupported field(s) ${extra.join(", ")}`);
    if (!isFiniteNumber(baselineConfig.feeBps) || baselineConfig.feeBps < 0) validationErrors.push("baselineConfig.feeBps must be a finite number >= 0");
    if (!isFiniteNumber(baselineConfig.slippageBps) || baselineConfig.slippageBps < 0 || baselineConfig.slippageBps >= 10_000) validationErrors.push("baselineConfig.slippageBps must be a finite number in [0, 10000)");
    if (!isFiniteNumber(baselineConfig.startingCapital) || baselineConfig.startingCapital <= 0) validationErrors.push("baselineConfig.startingCapital must be a finite number > 0");
  }

  validationErrors.push(...validateParameterExperimentConfig(raw.parameterExperiments));

  if (!Array.isArray(raw.chronologicalSplits)) {
    validationErrors.push("chronologicalSplits must be an array");
  } else {
    const seenInstruments = new Set<string>();
    for (const [index, rawSplit] of raw.chronologicalSplits.entries()) {
      if (!isRecord(rawSplit)) {
        validationErrors.push(`chronologicalSplits[${index}]: missing or malformed`);
        continue;
      }
      const extra = Object.keys(rawSplit).filter((k) => !(SPLIT_KEYS as readonly string[]).includes(k));
      if (extra.length > 0) validationErrors.push(`chronologicalSplits[${index}]: unsupported field(s) ${extra.join(", ")}`);
      if (typeof rawSplit.instrument !== "string" || !instruments.includes(rawSplit.instrument)) {
        validationErrors.push(`chronologicalSplits[${index}].instrument: must reference a declared instrument (got ${JSON.stringify(rawSplit.instrument)})`);
      } else if (seenInstruments.has(rawSplit.instrument)) {
        validationErrors.push(`chronologicalSplits[${index}].instrument: duplicate split declared for "${rawSplit.instrument}"`);
      } else {
        seenInstruments.add(rawSplit.instrument);
      }
      if (typeof rawSplit.splitAt !== "string" || Number.isNaN(Date.parse(rawSplit.splitAt))) {
        validationErrors.push(`chronologicalSplits[${index}].splitAt: must be a parseable ISO timestamp (got ${JSON.stringify(rawSplit.splitAt)})`);
      }
    }
  }

  if (!Array.isArray(raw.passCriteria)) {
    validationErrors.push("passCriteria must be an array");
  } else {
    raw.passCriteria.forEach((c, i) => validationErrors.push(...criterionErrors(c, `passCriteria[${i}]`, "pass")));
  }
  if (!Array.isArray(raw.failureCriteria)) {
    validationErrors.push("failureCriteria must be an array");
  } else {
    raw.failureCriteria.forEach((c, i) => validationErrors.push(...criterionErrors(c, `failureCriteria[${i}]`, "failure")));
  }

  const robustnessChecks = raw.robustnessChecks;
  if (!isRecord(robustnessChecks)) {
    validationErrors.push("robustnessChecks missing or malformed");
  } else {
    const extra = Object.keys(robustnessChecks).filter((k) => !(ROBUSTNESS_KEYS as readonly string[]).includes(k));
    if (extra.length > 0) validationErrors.push(`robustnessChecks: unsupported field(s) ${extra.join(", ")}`);
    if (!Number.isInteger(robustnessChecks.minTradeCountWarningThreshold) || (robustnessChecks.minTradeCountWarningThreshold as number) < 0) {
      validationErrors.push("robustnessChecks.minTradeCountWarningThreshold must be a non-negative integer");
    }
    if (!isFiniteNumber(robustnessChecks.maxInstrumentConcentrationWarningThreshold) || (robustnessChecks.maxInstrumentConcentrationWarningThreshold as number) < 0 || (robustnessChecks.maxInstrumentConcentrationWarningThreshold as number) > 100) {
      validationErrors.push("robustnessChecks.maxInstrumentConcentrationWarningThreshold must be a finite number in [0, 100]");
    }
  }

  if (raw.limitations !== undefined && (!Array.isArray(raw.limitations) || raw.limitations.some((l) => typeof l !== "string"))) {
    validationErrors.push("limitations must be an array of strings when present");
  }

  const provenance = raw.provenance;
  if (!isRecord(provenance) || typeof provenance.author !== "string" || typeof provenance.createdAt !== "string" || Number.isNaN(Date.parse(provenance.createdAt))) {
    validationErrors.push("provenance missing or malformed — requires author (string) and a parseable createdAt");
  } else {
    const extra = Object.keys(provenance).filter((k) => !(PROVENANCE_KEYS as readonly string[]).includes(k));
    if (extra.length > 0) validationErrors.push(`provenance: unsupported field(s) ${extra.join(", ")}`);
  }

  const contentHash = createHash(CONTENT_HASH_ALGORITHM).update(canonicalStringify(raw)).digest("hex");
  const valid = validationErrors.length === 0;

  if (!valid) {
    const reason: ResearchPlanRejectionReason = validationErrors[0]!.includes("strategyContentHash") || validationErrors[0]!.includes("strategyId")
      ? "MISSING_REQUIRED_FIELD"
      : validationErrors.some((e) => e.startsWith("datasets"))
        ? "INVALID_DATASET_MANIFEST"
        : validationErrors.some((e) => e.startsWith("parameterExperiments"))
          ? "INVALID_EXPERIMENT_CONFIG"
          : validationErrors.some((e) => e.startsWith("chronologicalSplits"))
            ? "INVALID_SPLIT"
            : validationErrors.some((e) => e.startsWith("passCriteria") || e.startsWith("failureCriteria"))
              ? "INVALID_CRITERION"
              : validationErrors.some((e) => e.includes("instruments"))
                ? "INVALID_INSTRUMENTS"
                : "MISSING_REQUIRED_FIELD";
    return { ok: false, reason, detail: validationErrors.join("; ") };
  }

  return {
    ok: true,
    document: raw as unknown as ResearchPlanDocument,
    result: { valid: true, validationErrors: [], contentHash, contentHashAlgorithm: CONTENT_HASH_ALGORITHM, loadedAt },
  };
}

export { compareSemver };
