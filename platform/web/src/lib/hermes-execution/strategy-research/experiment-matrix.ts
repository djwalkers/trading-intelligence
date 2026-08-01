import { createHash } from "node:crypto";
import { canonicalStringify, CONTENT_HASH_ALGORITHM } from "../strategy-definitions/strategy-definition";

// Phase 3 — Strategy Research Workflow. Deterministic experiment generation: every variant is
// declared explicitly or through a bounded, deterministic numeric range — never a random search,
// never a Bayesian/gradient-based optimiser, never anything that could pick a different set of
// variants on a re-run of the identical plan. Pure module — no I/O, no broker/execution import.

/** The exact, closed set of strategy/cost parameters Phase 3 knows how to vary — see
 * strategy-variant.ts's own doc comment for exactly which `StrategyDefinitionDocument` field each
 * one edits (or, for the two cost dimensions, that neither ever touches the strategy document at
 * all — see requirement "cost assumptions remain research config, never strategy-controlled
 * execution settings"). */
export type ExperimentDimensionKey = "emaFastPeriod" | "emaSlowPeriod" | "rsiPeriod" | "rsiLowerBound" | "rsiUpperBound" | "atrPeriod" | "maxBarsHeld" | "feeBps" | "slippageBps";
const EXPERIMENT_DIMENSION_KEYS: readonly ExperimentDimensionKey[] = ["emaFastPeriod", "emaSlowPeriod", "rsiPeriod", "rsiLowerBound", "rsiUpperBound", "atrPeriod", "maxBarsHeld", "feeBps", "slippageBps"];

/** Integer-period dimensions must never be varied over a fractional range — `atrPeriod`, EMA/RSI
 * periods, and `maxBarsHeld` are always bar counts. `rsiLowerBound`/`rsiUpperBound`/`feeBps`/
 * `slippageBps` may be fractional. */
const INTEGER_ONLY_DIMENSIONS: ReadonlySet<ExperimentDimensionKey> = new Set(["emaFastPeriod", "emaSlowPeriod", "rsiPeriod", "atrPeriod", "maxBarsHeld"]);

export interface ExplicitValueSet {
  kind: "EXPLICIT_VALUES";
  values: number[];
}
export interface BoundedRange {
  kind: "RANGE";
  min: number;
  max: number;
  step: number;
}
export type ExperimentDimension = ExplicitValueSet | BoundedRange;

export interface ParameterExperimentConfig {
  dimensions: Partial<Record<ExperimentDimensionKey, ExperimentDimension>>;
  /** Hard cap on the TOTAL number of generated variants (including the always-included baseline) —
   * validated to never exceed `MAX_EXPERIMENT_VARIANTS_HARD_CAP`; the matrix is REJECTED outright
   * (never silently truncated) if the cartesian product — after excluding structurally invalid
   * combinations, see `generateExperimentMatrix`'s own doc comment — would exceed this. */
  maxExperiments: number;
}

/** Absolute ceiling regardless of what a plan itself declares — `--max-experiments` (the CLI's own
 * flag) may only ever LOWER this, never raise it (see strategy-research-cli.ts). */
export const MAX_EXPERIMENT_VARIANTS_HARD_CAP = 500;

export interface VariantParameterOverrides {
  emaFastPeriod?: number;
  emaSlowPeriod?: number;
  rsiPeriod?: number;
  rsiLowerBound?: number;
  rsiUpperBound?: number;
  atrPeriod?: number;
  maxBarsHeld?: number;
  feeBps?: number;
  slippageBps?: number;
}

export interface ExperimentVariant {
  /** Stable, index-based handle for reporting — always assigned in the SAME deterministic order
   * for the same input config (baseline first, as `"BASELINE"`, then every cartesian combination in
   * fixed dimension-key order). Never derived from content — `contentHash` is that. */
  variantId: string;
  /** SHA-256 over the canonicalised `overrides` object alone — the variant's own parameter-identity,
   * independent of whatever strategy document it's later applied to. Two variants with identical
   * overrides (however that arose) always hash identically. */
  contentHash: string;
  overrides: VariantParameterOverrides;
  isBaseline: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const DIMENSION_KEYS = ["kind", "values", "min", "max", "step"] as const;

function dimensionErrors(raw: unknown, key: ExperimentDimensionKey, path: string): string[] {
  if (!isRecord(raw)) return [`${path}: missing or malformed`];
  const errors: string[] = [];
  const extra = Object.keys(raw).filter((k) => !(DIMENSION_KEYS as readonly string[]).includes(k));
  if (extra.length > 0) errors.push(`${path}: unsupported field(s) ${extra.join(", ")}`);

  if (raw.kind === "EXPLICIT_VALUES") {
    if (!Array.isArray(raw.values) || raw.values.length === 0 || !raw.values.every(isFiniteNumber)) {
      errors.push(`${path}.values: must be a non-empty array of finite numbers`);
    } else if (INTEGER_ONLY_DIMENSIONS.has(key) && !raw.values.every((v: number) => Number.isInteger(v))) {
      errors.push(`${path}.values: ${key} only accepts integer values`);
    }
  } else if (raw.kind === "RANGE") {
    if (!isFiniteNumber(raw.min) || !isFiniteNumber(raw.max) || !isFiniteNumber(raw.step) || raw.step <= 0 || raw.min > raw.max) {
      errors.push(`${path}: RANGE requires finite min <= max and a positive finite step`);
    } else if (INTEGER_ONLY_DIMENSIONS.has(key) && !(Number.isInteger(raw.min) && Number.isInteger(raw.max) && Number.isInteger(raw.step))) {
      errors.push(`${path}: ${key} only accepts integer min/max/step`);
    }
  } else {
    errors.push(`${path}.kind: must be "EXPLICIT_VALUES" or "RANGE" (got ${JSON.stringify(raw.kind)})`);
  }
  return errors;
}

/** Pure field-shape validation, mirroring every other Phase 1/2/3 validator's "collect every error,
 * report once" convention — never throws, never mutates. */
export function validateParameterExperimentConfig(raw: unknown): string[] {
  if (!isRecord(raw)) return ["parameterExperiments: missing or malformed"];
  const errors: string[] = [];
  const extra = Object.keys(raw).filter((k) => k !== "dimensions" && k !== "maxExperiments");
  if (extra.length > 0) errors.push(`parameterExperiments: unsupported field(s) ${extra.join(", ")}`);

  const dimensions = raw.dimensions;
  if (!isRecord(dimensions)) {
    errors.push("parameterExperiments.dimensions: missing or malformed");
  } else {
    const extraDims = Object.keys(dimensions).filter((k) => !(EXPERIMENT_DIMENSION_KEYS as readonly string[]).includes(k));
    if (extraDims.length > 0) errors.push(`parameterExperiments.dimensions: unsupported key(s) ${extraDims.join(", ")}`);
    for (const key of EXPERIMENT_DIMENSION_KEYS) {
      if (dimensions[key] !== undefined) errors.push(...dimensionErrors(dimensions[key], key, `parameterExperiments.dimensions.${key}`).map((e) => e));
    }
  }

  if (!Number.isInteger(raw.maxExperiments) || (raw.maxExperiments as number) < 1 || (raw.maxExperiments as number) > MAX_EXPERIMENT_VARIANTS_HARD_CAP) {
    errors.push(`parameterExperiments.maxExperiments must be an integer in [1, ${MAX_EXPERIMENT_VARIANTS_HARD_CAP}]`);
  }

  return errors;
}

function expandDimension(dim: ExperimentDimension): number[] {
  if (dim.kind === "EXPLICIT_VALUES") return [...dim.values];
  const values: number[] = [];
  // Rounds away floating-point drift (e.g. 0.1 + 0.2) to the step's own decimal precision — never
  // accumulates error across many iterations, and always terminates in a bounded number of steps
  // since min/max/step are all finite and step > 0 (already enforced by validation).
  const decimals = Math.max(0, `${dim.step}`.split(".")[1]?.length ?? 0);
  const count = Math.floor((dim.max - dim.min) / dim.step + 1e-9) + 1;
  for (let i = 0; i < count; i++) {
    values.push(Number((dim.min + i * dim.step).toFixed(decimals)));
  }
  return values;
}

/** Returns `undefined` when `overrides` is structurally valid, else a human-readable reason —
 * surfaced (never silently dropped) in `ExperimentMatrixResult.excluded` so a consumer can see
 * EXACTLY which combinations were excluded and why, not just a smaller-than-expected variant count. */
function structuralInvalidityReason(overrides: VariantParameterOverrides): string | undefined {
  if (overrides.emaFastPeriod !== undefined && overrides.emaSlowPeriod !== undefined && overrides.emaFastPeriod >= overrides.emaSlowPeriod) {
    return `emaFastPeriod (${overrides.emaFastPeriod}) must be strictly less than emaSlowPeriod (${overrides.emaSlowPeriod})`;
  }
  if (overrides.rsiLowerBound !== undefined && overrides.rsiUpperBound !== undefined && overrides.rsiLowerBound >= overrides.rsiUpperBound) {
    return `rsiLowerBound (${overrides.rsiLowerBound}) must be strictly less than rsiUpperBound (${overrides.rsiUpperBound})`;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (INTEGER_ONLY_DIMENSIONS.has(key as ExperimentDimensionKey) && (value as number) <= 0) {
      return `${key} (${value}) must be a positive integer`;
    }
  }
  return undefined;
}

export function computeVariantContentHash(overrides: VariantParameterOverrides): string {
  return createHash(CONTENT_HASH_ALGORITHM).update(canonicalStringify(overrides)).digest("hex");
}

export interface ExcludedCombination {
  overrides: VariantParameterOverrides;
  reason: string;
}

export type ExperimentMatrixResult =
  | { ok: true; variants: ExperimentVariant[]; experimentMatrixHash: string; excluded: ExcludedCombination[] }
  | { ok: false; reason: string; detail: string };

/**
 * Deterministic cartesian expansion over every declared dimension, in the FIXED
 * `EXPERIMENT_DIMENSION_KEYS` order (never the JSON object's own key order, which is not guaranteed
 * meaningful) — the same input `config` always produces the same variant list, in the same order,
 * every time. The baseline (empty overrides) is always variant `"BASELINE"`, first, regardless of
 * whether it also happens to appear inside the declared ranges.
 *
 * Structurally invalid combinations (`emaFastPeriod >= emaSlowPeriod`, `rsiLowerBound >=
 * rsiUpperBound`, a non-positive integer period) are EXCLUDED from the matrix, never rejected as a
 * whole-plan error — a neighbourhood sweep that varies two related dimensions independently over
 * overlapping ranges naturally produces some invalid combinations; excluding them (deterministically
 * — the same combinations are always excluded) is more useful than refusing to run at all.
 *
 * The total variant count (after exclusion, including the baseline) is checked against
 * `min(config.maxExperiments, hardCap)` and the WHOLE matrix is rejected (never silently truncated —
 * silently dropping variants would silently bias which parameter neighbourhood gets evidenced)
 * if it would exceed that. This cap is checked TWICE: once cheaply against the raw (pre-exclusion)
 * combination count, BEFORE the cartesian product is actually built (so a plan declaring, say, six
 * dimensions of 20 values each is rejected immediately rather than materialising 64 million objects
 * first), and once again against the real, post-exclusion count.
 *
 * If every declared dimension is populated but EVERY generated combination turns out structurally
 * invalid, the matrix is rejected outright (`NO_VALID_VARIANTS`) rather than silently degrading to a
 * "run" of just the baseline — a plan author who declared a sweep almost certainly did not intend for
 * it to silently evaluate nothing.
 */
export function generateExperimentMatrix(config: ParameterExperimentConfig, hardCap: number = MAX_EXPERIMENT_VARIANTS_HARD_CAP): ExperimentMatrixResult {
  const effectiveCap = Math.min(config.maxExperiments, hardCap);
  const dimensionEntries = EXPERIMENT_DIMENSION_KEYS.filter((key) => config.dimensions[key] !== undefined).map((key) => ({ key, values: expandDimension(config.dimensions[key]!) }));

  const rawCombinationCount = dimensionEntries.reduce((product, d) => product * d.values.length, 1);
  if (1 + rawCombinationCount > effectiveCap) {
    return {
      ok: false,
      reason: "EXPERIMENT_CAP_EXCEEDED",
      detail: `the declared dimensions would generate up to ${rawCombinationCount} combination(s) before any exclusion, plus the baseline (${1 + rawCombinationCount} total), exceeding the effective cap of ${effectiveCap} — narrow the declared dimensions/ranges or raise maxExperiments (never above the hard cap of ${hardCap})`,
    };
  }

  const combinations: VariantParameterOverrides[] = [{}];
  for (const { key, values } of dimensionEntries) {
    const next: VariantParameterOverrides[] = [];
    for (const partial of combinations) {
      for (const value of values) next.push({ ...partial, [key]: value });
    }
    combinations.length = 0;
    combinations.push(...next);
  }

  const uniqueByHash = new Map<string, VariantParameterOverrides>();
  const excludedByHash = new Map<string, ExcludedCombination>();
  for (const overrides of combinations) {
    const reason = structuralInvalidityReason(overrides);
    if (reason) excludedByHash.set(computeVariantContentHash(overrides), { overrides, reason });
    else uniqueByHash.set(computeVariantContentHash(overrides), overrides);
  }

  const nonBaselineOverrides = [...uniqueByHash.entries()].filter(([, overrides]) => Object.keys(overrides).length > 0);

  if (dimensionEntries.length > 0 && nonBaselineOverrides.length === 0) {
    return {
      ok: false,
      reason: "NO_VALID_VARIANTS",
      detail: `every one of the ${combinations.length} generated combination(s) was structurally invalid and excluded (e.g. ${[...excludedByHash.values()][0]?.reason ?? "no valid combination"}) — the declared dimensions produce no runnable variant beyond the baseline`,
    };
  }

  const totalCount = 1 + nonBaselineOverrides.length; // +1 for the always-included baseline
  if (totalCount > effectiveCap) {
    return {
      ok: false,
      reason: "EXPERIMENT_CAP_EXCEEDED",
      detail: `generated ${totalCount} variant(s) (including baseline), exceeding the effective cap of ${effectiveCap} — narrow the declared dimensions/ranges or raise maxExperiments (never above the hard cap of ${hardCap})`,
    };
  }

  const baselineHash = computeVariantContentHash({});
  const variants: ExperimentVariant[] = [{ variantId: "BASELINE", contentHash: baselineHash, overrides: {}, isBaseline: true }];
  nonBaselineOverrides.forEach(([hash, overrides], index) => {
    variants.push({ variantId: `VARIANT-${String(index).padStart(4, "0")}`, contentHash: hash, overrides, isBaseline: false });
  });

  const experimentMatrixHash = createHash(CONTENT_HASH_ALGORITHM)
    .update(canonicalStringify(variants.map((v) => ({ variantId: v.variantId, overrides: v.overrides }))))
    .digest("hex");

  return { ok: true, variants, experimentMatrixHash, excluded: [...excludedByHash.values()] };
}
