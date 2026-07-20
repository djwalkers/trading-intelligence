import { describe, expect, it } from "vitest";
import { loadEnabledStrategies } from "@/lib/hermes-execution/strategy-loader";
import type { RegistryClient } from "@/lib/hermes-execution/registry-client";
import type { RawRegistryStrategy, RegistryLoadResult } from "@/lib/hermes-execution/types";

function makeRegistryClient(result: RegistryLoadResult, connected: boolean): RegistryClient {
  return {
    async isConnected() {
      return connected;
    },
    async listActiveStrategies() {
      return result;
    },
  };
}

const validDoc: RawRegistryStrategy = {
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
  entryDefinition: { rule: "test", parameters: { ruleType: "CROSSES_ABOVE_MA", period: 20 } },
  exitDefinition: { rule: "test", parameters: { rules: [{ ruleType: "TAKE_PROFIT", percent: 5 }] } },
  riskDefinition: { maxPositionSize: 1000, maxDrawdownHalt: null },
  confidence: { level: "moderate", reasoning: "test" },
  createdAt: "2026-01-01T00:00:00Z",
  lastReviewedAt: "2026-01-01T00:00:00Z",
};

describe("loadEnabledStrategies", () => {
  it("treats an empty registry as a valid state: zero strategies, zero rejections", async () => {
    const client = makeRegistryClient({ strategies: [], rejected: [] }, true);
    const result = await loadEnabledStrategies({
      registryClient: client,
      demoExecutionModeEnabled: false,
      executionRunId: "test-run",
    });
    expect(result.strategies).toEqual([]);
    expect(result.hermesApprovedCount).toBe(0);
    expect(result.demoModeActive).toBe(false);
    expect(result.registryConnected).toBe(true);
    expect(result.rejections).toEqual([]);
  });

  it("maps a valid registry strategy and emits a STRATEGY_LOADED event", async () => {
    const client = makeRegistryClient({ strategies: [validDoc], rejected: [] }, true);
    const result = await loadEnabledStrategies({
      registryClient: client,
      demoExecutionModeEnabled: false,
      executionRunId: "test-run",
    });
    expect(result.hermesApprovedCount).toBe(1);
    expect(result.strategies[0]?.strategyId).toBe("STRAT-0001");
    expect(result.events.some((e) => e.eventType === "STRATEGY_LOADED" && e.strategyId === "STRAT-0001")).toBe(true);
  });

  it("records registry-level rejections as STRATEGY_REJECTED events", async () => {
    const client = makeRegistryClient(
      { strategies: [], rejected: [{ source: "bad.json", reason: "missing fields" }] },
      true,
    );
    const result = await loadEnabledStrategies({
      registryClient: client,
      demoExecutionModeEnabled: false,
      executionRunId: "test-run",
    });
    expect(result.rejections).toEqual([{ source: "bad.json", reason: "missing fields" }]);
    expect(result.events.some((e) => e.eventType === "STRATEGY_REJECTED")).toBe(true);
  });

  it("records mapping-level rejections (e.g. unsupported rule) without throwing", async () => {
    const unsupported: RawRegistryStrategy = {
      ...validDoc,
      strategyId: "STRAT-0002",
      entryDefinition: { rule: "test", parameters: { ruleType: "UNSUPPORTED" } },
    };
    const client = makeRegistryClient({ strategies: [unsupported], rejected: [] }, true);
    const result = await loadEnabledStrategies({
      registryClient: client,
      demoExecutionModeEnabled: false,
      executionRunId: "test-run",
    });
    expect(result.strategies).toEqual([]);
    expect(result.hermesApprovedCount).toBe(0);
    expect(result.rejections.some((r) => r.source === "STRAT-0002")).toBe(true);
  });

  it("includes the demo strategy only when demo mode is enabled", async () => {
    const client = makeRegistryClient({ strategies: [], rejected: [] }, true);

    const disabled = await loadEnabledStrategies({
      registryClient: client,
      demoExecutionModeEnabled: false,
      executionRunId: "test-run",
    });
    expect(disabled.demoModeActive).toBe(false);
    expect(disabled.strategies).toEqual([]);

    const enabled = await loadEnabledStrategies({
      registryClient: client,
      demoExecutionModeEnabled: true,
      executionRunId: "test-run",
    });
    expect(enabled.demoModeActive).toBe(true);
    expect(enabled.strategies).toHaveLength(1);
    expect(enabled.strategies[0]?.sourceType).toBe("DEMO_ONLY");
  });
});
