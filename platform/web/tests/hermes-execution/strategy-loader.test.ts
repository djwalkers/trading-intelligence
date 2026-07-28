import { describe, expect, it } from "vitest";
import { loadEnabledStrategies } from "@/lib/hermes-execution/strategy-loader";
import { HERMES_AGENT_STRATEGY_ID } from "@/lib/hermes-execution/hermes-agent/hermes-agent-strategy";
import type { RegistryClient } from "@/lib/hermes-execution/registry-client";
import type { RawRegistryStrategy, RegistryLoadResult } from "@/lib/hermes-execution/types";

// Prototype 1.0 — official Hermes Agent decision integration. loadEnabledStrategies now ALWAYS
// includes the Hermes-agent InternalStrategy (unconditionally, pushed first, sourceType
// HERMES_APPROVED) — see strategy-loader.ts's own doc comment — so every test below accounts for
// that one additional, always-present entry alongside whatever the registry/demo-mode loads.

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
  it("an empty registry still loads exactly the always-present Hermes-agent strategy, zero rejections", async () => {
    const client = makeRegistryClient({ strategies: [], rejected: [] }, true);
    const result = await loadEnabledStrategies({
      registryClient: client,
      demoExecutionModeEnabled: false,
      executionRunId: "test-run",
    });
    expect(result.strategies).toHaveLength(1);
    expect(result.strategies[0]?.strategyId).toBe(HERMES_AGENT_STRATEGY_ID);
    expect(result.hermesApprovedCount).toBe(1);
    expect(result.demoModeActive).toBe(false);
    expect(result.registryConnected).toBe(true);
    expect(result.rejections).toEqual([]);
  });

  it("maps a valid registry strategy and emits a STRATEGY_LOADED event, alongside the always-present Hermes-agent strategy", async () => {
    const client = makeRegistryClient({ strategies: [validDoc], rejected: [] }, true);
    const result = await loadEnabledStrategies({
      registryClient: client,
      demoExecutionModeEnabled: false,
      executionRunId: "test-run",
    });
    expect(result.hermesApprovedCount).toBe(2); // HERMES-AGENT + STRAT-0001
    expect(result.strategies.some((s) => s.strategyId === "STRAT-0001")).toBe(true);
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

  it("records mapping-level rejections (e.g. unsupported rule) without throwing, leaving only the always-present Hermes-agent strategy", async () => {
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
    expect(result.strategies).toHaveLength(1);
    expect(result.strategies[0]?.strategyId).toBe(HERMES_AGENT_STRATEGY_ID);
    expect(result.hermesApprovedCount).toBe(1); // just the Hermes-agent entry; STRAT-0002 was rejected
    expect(result.rejections.some((r) => r.source === "STRAT-0002")).toBe(true);
  });

  it("includes the demo strategy only when demo mode is enabled, alongside the always-present Hermes-agent strategy", async () => {
    const client = makeRegistryClient({ strategies: [], rejected: [] }, true);

    const disabled = await loadEnabledStrategies({
      registryClient: client,
      demoExecutionModeEnabled: false,
      executionRunId: "test-run",
    });
    expect(disabled.demoModeActive).toBe(false);
    expect(disabled.strategies).toHaveLength(1);
    expect(disabled.strategies[0]?.strategyId).toBe(HERMES_AGENT_STRATEGY_ID);

    const enabled = await loadEnabledStrategies({
      registryClient: client,
      demoExecutionModeEnabled: true,
      executionRunId: "test-run",
    });
    expect(enabled.demoModeActive).toBe(true);
    expect(enabled.strategies).toHaveLength(2); // Hermes-agent + demo
    expect(enabled.strategies.find((s) => s.sourceType === "DEMO_ONLY")).toBeDefined();
    expect(enabled.strategies.find((s) => s.strategyId === HERMES_AGENT_STRATEGY_ID)).toBeDefined();
  });
});
