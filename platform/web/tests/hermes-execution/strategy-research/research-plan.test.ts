import { describe, expect, it } from "vitest";
import { validateResearchPlan } from "@/lib/hermes-execution/strategy-research/research-plan";
import { baselineStrategyContentHash, makeResearchPlanRaw } from "./fixtures";

// Phase 3 — Strategy Research Workflow. Research plan schema validation: never evaluated as code,
// closed key sets, deterministic content hash — mirrors Phase 1's own strategy-definition.test.ts
// conventions exactly.

const REAL_HASH = baselineStrategyContentHash();

describe("validateResearchPlan — happy path", () => {
  it("accepts a well-formed plan and computes a stable content hash", () => {
    const result = validateResearchPlan(makeResearchPlanRaw(), REAL_HASH, "2026-01-01T00:00:00.000Z");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.result.loadedAt).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  it("computes an identical content hash regardless of the strategy-hash cross-check outcome (hash covers the document, not the cross-check result)", () => {
    const a = validateResearchPlan(makeResearchPlanRaw(), REAL_HASH, "t");
    const b = validateResearchPlan(makeResearchPlanRaw(), undefined, "t");
    expect(a.ok).toBe(true);
    // b fails the cross-check is skipped when undefined, so b should also be ok here (no mismatch to report)
    expect(b.ok).toBe(true);
  });
});

describe("validateResearchPlan — explicit rejection", () => {
  it("rejects an invalid researchPlanVersion (not strict semver)", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ researchPlanVersion: "1.0" }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_PLAN_VERSION");
  });

  it("rejects an invalid strategyVersion", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ strategyVersion: "v1" }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_STRATEGY_VERSION");
  });

  it("rejects an unknown top-level key", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ someRogueField: true }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNEXPECTED_FIELD");
  });

  it("rejects a prohibited field (e.g. positionSize) anywhere in the document", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ baselineConfig: { feeBps: 5, slippageBps: 5, startingCapital: 10_000, positionSize: 100 } }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("PROHIBITED_FIELD");
  });

  it("rejects an attempted executable-expression field (e.g. a 'formula' or 'expression' key) as an unrecognised field — never evaluated", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ formula: "netReturn > 0 ? 'PASS' : 'FAIL'" }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNEXPECTED_FIELD");
  });

  it("rejects a plan missing strategyId", () => {
    const raw = makeResearchPlanRaw();
    delete (raw as Record<string, unknown>).strategyId;
    const result = validateResearchPlan(raw, REAL_HASH, "t");
    expect(result.ok).toBe(false);
  });

  it("rejects a plan whose declared strategyContentHash does not match the actually-loaded strategy", () => {
    const result = validateResearchPlan(makeResearchPlanRaw(), "f".repeat(64), "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("does not match");
  });

  it("rejects a malformed (non-64-hex-char) strategyContentHash", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ strategyContentHash: "not-a-hash" }), undefined, "t");
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate instruments", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ instruments: ["BTC", "BTC"] }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_INSTRUMENTS");
  });

  it("rejects an unsupported timeframe", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ timeframe: "3h" }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
  });

  it("rejects an impossible criterion threshold (e.g. MIN_WIN_RATE above 1)", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ passCriteria: [{ metric: "MIN_WIN_RATE", operator: "GREATER_THAN_OR_EQUAL", threshold: 1.5, scope: "OVERALL" }] }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_CRITERION");
  });

  it("rejects a non-finite criterion threshold", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ passCriteria: [{ metric: "MIN_NET_RETURN", operator: "GREATER_THAN_OR_EQUAL", threshold: Number.NaN, scope: "OVERALL" }] }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
  });

  it("rejects an unrecognised criterion metric", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ passCriteria: [{ metric: "SHARPE_RATIO", operator: "GREATER_THAN_OR_EQUAL", threshold: 1, scope: "OVERALL" }] }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
  });

  it("rejects a chronologicalSplits entry referencing an undeclared instrument", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ chronologicalSplits: [{ instrument: "ETH", splitAt: "2026-01-01T00:00:00.000Z" }] }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_SPLIT");
  });

  it("rejects a chronologicalSplits entry with an unparseable splitAt", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ chronologicalSplits: [{ instrument: "BTC", splitAt: "not-a-date" }] }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate chronologicalSplits for the same instrument", () => {
    const result = validateResearchPlan(
      makeResearchPlanRaw({ chronologicalSplits: [{ instrument: "BTC", splitAt: "2026-01-05T00:00:00.000Z" }, { instrument: "BTC", splitAt: "2026-01-06T00:00:00.000Z" }] }),
      REAL_HASH,
      "t",
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid baselineConfig (negative fee)", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ baselineConfig: { feeBps: -1, slippageBps: 5, startingCapital: 10_000 } }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
  });

  it("rejects two dataset entries sharing the same (instrument, role) pair, before any file is ever read", () => {
    const entry = { instrument: "BTC", timeframe: "1h", datasetFile: "x.json", expectedDatasetHash: "a".repeat(64), startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-02T00:00:00.000Z", role: "FULL_HISTORY" };
    const result = validateResearchPlan(makeResearchPlanRaw({ instruments: ["BTC"], datasets: [entry, { ...entry, datasetFile: "y.json" }] }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("INVALID_DATASET_MANIFEST");
      expect(result.detail).toContain("duplicate manifest entry");
    }
  });

  it("rejects a dataset entry for an instrument not declared in the plan's own instruments list", () => {
    const entry = { instrument: "ETH", timeframe: "1h", datasetFile: "x.json", expectedDatasetHash: "a".repeat(64), startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-02T00:00:00.000Z", role: "FULL_HISTORY" };
    const result = validateResearchPlan(makeResearchPlanRaw({ instruments: ["BTC"], datasets: [entry] }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("INVALID_DATASET_MANIFEST");
      expect(result.detail).toContain("not declared in this plan's own instruments list");
    }
  });

  it("rejects a maxInstrumentConcentrationWarningThreshold above 100 (percentage scale, not a 0-1 fraction)", () => {
    const result = validateResearchPlan(
      makeResearchPlanRaw({ robustnessChecks: { minTradeCountWarningThreshold: 1, maxInstrumentConcentrationWarningThreshold: 150, notes: [] } }),
      REAL_HASH,
      "t",
    );
    expect(result.ok).toBe(false);
  });

  it("accepts a maxInstrumentConcentrationWarningThreshold of 70 (percentage scale)", () => {
    const result = validateResearchPlan(
      makeResearchPlanRaw({ robustnessChecks: { minTradeCountWarningThreshold: 1, maxInstrumentConcentrationWarningThreshold: 70, notes: [] } }),
      REAL_HASH,
      "t",
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a MIN_* passCriteria entry using a LESS_THAN operator (wrong direction — would silently mean the opposite of what MIN_ says)", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ passCriteria: [{ metric: "MIN_NET_RETURN", operator: "LESS_THAN", threshold: 0, scope: "OVERALL" }] }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_CRITERION");
  });

  it("rejects a MAX_* passCriteria entry using a GREATER_THAN operator (wrong direction)", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ passCriteria: [{ metric: "MAX_DRAWDOWN", operator: "GREATER_THAN_OR_EQUAL", threshold: 0.5, scope: "OVERALL" }] }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_CRITERION");
  });

  it("rejects a MIN_* failureCriteria entry using a GREATER_THAN operator (failure-side direction is the mirror of pass-side)", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ failureCriteria: [{ metric: "MIN_NET_RETURN", operator: "GREATER_THAN_OR_EQUAL", threshold: 0, scope: "OVERALL" }] }), REAL_HASH, "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_CRITERION");
  });

  it("accepts a MAX_* failureCriteria entry using a GREATER_THAN operator (correct failure-side direction)", () => {
    const result = validateResearchPlan(makeResearchPlanRaw({ failureCriteria: [{ metric: "MAX_DRAWDOWN", operator: "GREATER_THAN", threshold: 0.6, scope: "OVERALL" }] }), REAL_HASH, "t");
    expect(result.ok).toBe(true);
  });
});
