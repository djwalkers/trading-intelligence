import { describe, expect, it } from "vitest";
import { mapRegistryStrategyToInternal } from "@/lib/hermes-execution/internal-strategy-mapper";
import type { RawRegistryStrategy } from "@/lib/hermes-execution/types";

function baseDoc(overrides: Partial<RawRegistryStrategy> = {}): RawRegistryStrategy {
  return {
    schemaVersion: "1.0.0",
    strategyId: "STRAT-0001",
    version: 1,
    status: "active",
    sourceHypothesisId: "h02",
    supportingResearchRuns: ["run-1"],
    promotionStatus: {
      decision: "ELIGIBLE",
      evaluatedAt: "2026-01-01T00:00:00Z",
      reasoning: "test",
      evaluatedAgainstGovernanceVersion: "1.0",
    },
    supportedMarkets: ["SPY"],
    timeframe: "1D",
    entryDefinition: {
      rule: "test",
      parameters: { ruleType: "CROSSES_ABOVE_MA", period: 20 },
    },
    exitDefinition: {
      rule: "test",
      parameters: { rules: [{ ruleType: "TAKE_PROFIT", percent: 5 }] },
    },
    riskDefinition: { maxPositionSize: 1000, maxDrawdownHalt: null },
    confidence: { level: "moderate", reasoning: "test" },
    createdAt: "2026-01-01T00:00:00Z",
    lastReviewedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("mapRegistryStrategyToInternal", () => {
  it("maps a well-formed ELIGIBLE strategy to an InternalStrategy", () => {
    const result = mapRegistryStrategyToInternal(baseDoc());
    expect("strategy" in result).toBe(true);
    if ("strategy" in result) {
      expect(result.strategy.strategyId).toBe("STRAT-0001");
      expect(result.strategy.sourceType).toBe("HERMES_APPROVED");
      expect(result.strategy.enabled).toBe(true);
      expect(result.strategy.instrument).toBe("SPY");
      expect(result.strategy.entryRules).toEqual([{ type: "CROSSES_ABOVE_MA", period: 20 }]);
      expect(result.strategy.exitRules).toEqual([{ type: "TAKE_PROFIT", percent: 5 }]);
      expect(result.strategy.riskRules.maxPositionValue).toBe(1000);
    }
  });

  it("rejects a strategy whose promotionStatus.decision is not ELIGIBLE", () => {
    const result = mapRegistryStrategyToInternal(
      baseDoc({ promotionStatus: { ...baseDoc().promotionStatus, decision: "REQUIRES_HUMAN_REVIEW" } }),
    );
    expect("rejection" in result).toBe(true);
    if ("rejection" in result) expect(result.rejection.reason).toMatch(/not "ELIGIBLE"/);
  });

  it("rejects a strategy scoped to more than one market", () => {
    const result = mapRegistryStrategyToInternal(baseDoc({ supportedMarkets: ["SPY", "QQQ"] }));
    expect("rejection" in result).toBe(true);
    if ("rejection" in result) expect(result.rejection.reason).toMatch(/exactly one instrument/);
  });

  it("rejects unsupported entryDefinition.parameters", () => {
    const result = mapRegistryStrategyToInternal(
      baseDoc({ entryDefinition: { rule: "test", parameters: { ruleType: "SOMETHING_ELSE" } } }),
    );
    expect("rejection" in result).toBe(true);
    if ("rejection" in result) expect(result.rejection.reason).toMatch(/Unsupported entryDefinition/);
  });

  it("rejects missing entryDefinition.parameters entirely", () => {
    const result = mapRegistryStrategyToInternal(baseDoc({ entryDefinition: { rule: "test" } }));
    expect("rejection" in result).toBe(true);
  });

  it("rejects an unsupported exit rule type", () => {
    const result = mapRegistryStrategyToInternal(
      baseDoc({ exitDefinition: { rule: "test", parameters: { rules: [{ ruleType: "TRAILING_STOP", percent: 5 }] } } }),
    );
    expect("rejection" in result).toBe(true);
    if ("rejection" in result) expect(result.rejection.reason).toMatch(/Unsupported exit rule type/);
  });

  it("rejects a non-positive riskDefinition.maxPositionSize", () => {
    const result = mapRegistryStrategyToInternal(
      baseDoc({ riskDefinition: { maxPositionSize: null, maxDrawdownHalt: null } }),
    );
    expect("rejection" in result).toBe(true);
    if ("rejection" in result) expect(result.rejection.reason).toMatch(/maxPositionSize/);
  });
});
