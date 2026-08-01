import { describe, expect, it } from "vitest";
import { computeVariantContentHash, generateExperimentMatrix, MAX_EXPERIMENT_VARIANTS_HARD_CAP, validateParameterExperimentConfig, type ParameterExperimentConfig } from "@/lib/hermes-execution/strategy-research/experiment-matrix";

// Phase 3 — Strategy Research Workflow. Deterministic experiment generation — no randomness, no
// Bayesian/gradient search, a hard, enforced cap.

describe("generateExperimentMatrix — determinism", () => {
  it("always includes the baseline first, with empty overrides", () => {
    const config: ParameterExperimentConfig = { dimensions: { emaFastPeriod: { kind: "EXPLICIT_VALUES", values: [10, 15] } }, maxExperiments: 20 };
    const result = generateExperimentMatrix(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.variants[0]!.variantId).toBe("BASELINE");
      expect(result.variants[0]!.isBaseline).toBe(true);
      expect(result.variants[0]!.overrides).toEqual({});
    }
  });

  it("produces the identical variant list, in the identical order, across repeated calls with the same config", () => {
    const config: ParameterExperimentConfig = {
      dimensions: { emaFastPeriod: { kind: "RANGE", min: 10, max: 20, step: 5 }, emaSlowPeriod: { kind: "RANGE", min: 40, max: 50, step: 10 } },
      maxExperiments: 50,
    };
    const a = generateExperimentMatrix(config);
    const b = generateExperimentMatrix(config);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.variants.map((v) => v.variantId)).toEqual(b.variants.map((v) => v.variantId));
      expect(a.variants).toEqual(b.variants);
      expect(a.experimentMatrixHash).toBe(b.experimentMatrixHash);
    }
  });

  it("assigns deterministic, content-derived hashes — identical overrides always hash identically", () => {
    const hashA = computeVariantContentHash({ emaFastPeriod: 10, emaSlowPeriod: 40 });
    const hashB = computeVariantContentHash({ emaSlowPeriod: 40, emaFastPeriod: 10 }); // different key order
    expect(hashA).toBe(hashB);
  });

  it("changes the content hash when any override value changes", () => {
    const hashA = computeVariantContentHash({ emaFastPeriod: 10 });
    const hashB = computeVariantContentHash({ emaFastPeriod: 11 });
    expect(hashA).not.toBe(hashB);
  });
});

describe("generateExperimentMatrix — invalid combination exclusion", () => {
  it("excludes combinations where emaFastPeriod >= emaSlowPeriod, never rejecting the whole matrix", () => {
    const config: ParameterExperimentConfig = {
      dimensions: { emaFastPeriod: { kind: "EXPLICIT_VALUES", values: [10, 50] }, emaSlowPeriod: { kind: "EXPLICIT_VALUES", values: [20, 40] } },
      maxExperiments: 20,
    };
    const result = generateExperimentMatrix(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const variant of result.variants) {
        if (variant.overrides.emaFastPeriod !== undefined && variant.overrides.emaSlowPeriod !== undefined) {
          expect(variant.overrides.emaFastPeriod).toBeLessThan(variant.overrides.emaSlowPeriod);
        }
      }
      // (10,20), (10,40), (50, ??? none valid since 50>=20 and 50>=40) -> only 2 valid combos + baseline = 3
      expect(result.variants).toHaveLength(3);
    }
  });

  it("excludes combinations where rsiLowerBound >= rsiUpperBound", () => {
    const config: ParameterExperimentConfig = {
      dimensions: { rsiLowerBound: { kind: "EXPLICIT_VALUES", values: [30, 80] }, rsiUpperBound: { kind: "EXPLICIT_VALUES", values: [70] } },
      maxExperiments: 20,
    };
    const result = generateExperimentMatrix(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // (30,70) valid; (80,70) invalid -> excluded
      expect(result.variants).toHaveLength(2); // baseline + (30,70)
    }
  });

  it("excludes a non-positive integer period", () => {
    const config: ParameterExperimentConfig = { dimensions: { atrPeriod: { kind: "EXPLICIT_VALUES", values: [-1, 14] } }, maxExperiments: 20 };
    const result = generateExperimentMatrix(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.variants.every((v) => v.overrides.atrPeriod === undefined || v.overrides.atrPeriod > 0)).toBe(true);
    }
  });
});

describe("generateExperimentMatrix — hard cap enforcement", () => {
  it("rejects a matrix whose total variant count exceeds the effective cap, never silently truncating", () => {
    const config: ParameterExperimentConfig = { dimensions: { atrPeriod: { kind: "RANGE", min: 1, max: 100, step: 1 } }, maxExperiments: 10 };
    const result = generateExperimentMatrix(config, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("EXPERIMENT_CAP_EXCEEDED");
  });

  it("never allows more than MAX_EXPERIMENT_VARIANTS_HARD_CAP even if maxExperiments requests more", () => {
    const config: ParameterExperimentConfig = { dimensions: { atrPeriod: { kind: "RANGE", min: 1, max: 600, step: 1 } }, maxExperiments: 1000 };
    const result = generateExperimentMatrix(config, MAX_EXPERIMENT_VARIANTS_HARD_CAP);
    expect(result.ok).toBe(false); // 600 variants + baseline exceeds the hard cap of 500
  });

  it("accepts a matrix at exactly the cap", () => {
    const config: ParameterExperimentConfig = { dimensions: { atrPeriod: { kind: "RANGE", min: 1, max: 9, step: 1 } }, maxExperiments: 10 };
    const result = generateExperimentMatrix(config, 10); // 9 variants + baseline = 10
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.variants).toHaveLength(10);
  });
});

describe("validateParameterExperimentConfig", () => {
  it("accepts a valid config", () => {
    expect(validateParameterExperimentConfig({ dimensions: { atrPeriod: { kind: "RANGE", min: 1, max: 10, step: 1 } }, maxExperiments: 5 })).toEqual([]);
  });

  it("rejects maxExperiments above the hard cap", () => {
    expect(validateParameterExperimentConfig({ dimensions: {}, maxExperiments: MAX_EXPERIMENT_VARIANTS_HARD_CAP + 1 }).length).toBeGreaterThan(0);
  });

  it("rejects a RANGE with non-positive step", () => {
    expect(validateParameterExperimentConfig({ dimensions: { atrPeriod: { kind: "RANGE", min: 1, max: 10, step: 0 } }, maxExperiments: 5 }).length).toBeGreaterThan(0);
  });

  it("rejects fractional values for an integer-only dimension", () => {
    expect(validateParameterExperimentConfig({ dimensions: { atrPeriod: { kind: "EXPLICIT_VALUES", values: [1.5] } }, maxExperiments: 5 }).length).toBeGreaterThan(0);
  });

  it("rejects an unrecognised dimension key", () => {
    expect(validateParameterExperimentConfig({ dimensions: { bogusDimension: { kind: "EXPLICIT_VALUES", values: [1] } }, maxExperiments: 5 }).length).toBeGreaterThan(0);
  });
});
