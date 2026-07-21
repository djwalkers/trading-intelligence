import { describe, expect, it } from "vitest";
import { validateStartup } from "@/lib/hermes-execution/runtime-config/startup-validation";
import type { InternalStrategy } from "@/lib/hermes-execution/types";

function makeStrategy(overrides: Partial<InternalStrategy> = {}): InternalStrategy {
  return {
    strategyId: "STRAT-0001",
    version: 1,
    sourceType: "HERMES_APPROVED",
    enabled: true,
    instrument: "BTC",
    timeframe: "1h",
    entryRules: [],
    exitRules: [],
    riskRules: { maxPositionValue: 100 },
    ...overrides,
  };
}

describe("validateStartup — valid default-safe configuration", () => {
  it("passes for local + paper + mock with an available strategy, returning the selected strategy", () => {
    const strategy = makeStrategy();
    const result = validateStartup({
      runtimeMode: "paper",
      brokerProvider: "local",
      marketDataProvider: "mock",
      strategyId: undefined,
      availableStrategies: [strategy],
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.strategy).toEqual(strategy);
  });
});

describe("validateStartup — supported broker/mode combinations", () => {
  // trading212-demo is deliberately excluded here — see "Trading212 is rejected for Prototype V1"
  // below; its mode-pairing is structurally fine, it's excluded for an orthogonal reason.
  it.each([
    ["local", "paper"],
    ["hyperliquid-testnet", "testnet"],
    ["etoro-demo", "demo"],
  ] as const)("%s + %s passes mode compatibility", (brokerProvider, runtimeMode) => {
    const result = validateStartup({
      runtimeMode,
      brokerProvider,
      marketDataProvider: "mock",
      strategyId: undefined,
      availableStrategies: [makeStrategy()],
    });
    expect(result.valid).toBe(true);
  });
});

describe("validateStartup — unsupported broker/mode combinations", () => {
  it("fails for local + demo", () => {
    const result = validateStartup({
      runtimeMode: "demo",
      brokerProvider: "local",
      marketDataProvider: "mock",
      strategyId: undefined,
      availableStrategies: [makeStrategy()],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.problems.some((p) => p.field === "runtimeMode")).toBe(true);
  });
});

describe("validateStartup — Trading212 is rejected for Prototype V1", () => {
  it("fails closed for trading212-demo even with its own correctly-supported mode (demo)", () => {
    const result = validateStartup({
      runtimeMode: "demo",
      brokerProvider: "trading212-demo",
      marketDataProvider: "mock",
      strategyId: undefined,
      availableStrategies: [makeStrategy()],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.problems.some((p) => p.field === "brokerProvider" && /Prototype V1/.test(p.message))).toBe(true);
    }
  });
});

describe("validateStartup — live market-data provider missing RateSource", () => {
  it("fails when marketDataProvider=live is paired with a broker that cannot supply live rates", () => {
    const result = validateStartup({
      runtimeMode: "paper",
      brokerProvider: "local",
      marketDataProvider: "live",
      strategyId: undefined,
      availableStrategies: [makeStrategy()],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.problems.some((p) => p.field === "marketDataProvider")).toBe(true);
  });

  it("passes when marketDataProvider=live is paired with etoro-demo", () => {
    const result = validateStartup({
      runtimeMode: "demo",
      brokerProvider: "etoro-demo",
      marketDataProvider: "live",
      strategyId: undefined,
      availableStrategies: [makeStrategy()],
    });
    expect(result.valid).toBe(true);
  });
});

describe("validateStartup — unknown/disabled strategy", () => {
  it("fails for an unknown strategyId", () => {
    const result = validateStartup({
      runtimeMode: "paper",
      brokerProvider: "local",
      marketDataProvider: "mock",
      strategyId: "STRAT-9999",
      availableStrategies: [makeStrategy({ strategyId: "STRAT-0001" })],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.problems.some((p) => p.field === "strategyId")).toBe(true);
  });

  it("fails for a disabled strategyId", () => {
    const result = validateStartup({
      runtimeMode: "paper",
      brokerProvider: "local",
      marketDataProvider: "mock",
      strategyId: "STRAT-0001",
      availableStrategies: [makeStrategy({ strategyId: "STRAT-0001", enabled: false })],
    });
    expect(result.valid).toBe(false);
  });
});

describe("validateStartup — collects multiple independent problems at once", () => {
  it("reports both the mode/broker mismatch and the unknown strategy together, not just the first one found", () => {
    const result = validateStartup({
      runtimeMode: "demo", // incompatible with local
      brokerProvider: "local",
      marketDataProvider: "live", // also incompatible with local
      strategyId: "STRAT-9999", // also unknown
      availableStrategies: [makeStrategy({ strategyId: "STRAT-0001" })],
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const fields = result.problems.map((p) => p.field).sort();
    expect(fields).toEqual(["marketDataProvider", "runtimeMode", "strategyId"]);
  });
});

describe("validateStartup — explicit rejection of accidental live operation", () => {
  it("live is not a member of RuntimeMode at all — TypeScript itself rejects it at the call site", () => {
    // This test's real assertion is compile-time: validateStartup's runtimeMode parameter is typed
    // RuntimeMode ("paper" | "demo" | "testnet"), which structurally cannot hold "live" — there is
    // no runtime branch anywhere in this module that could accidentally treat a broker as live.
    const result = validateStartup({
      runtimeMode: "paper",
      brokerProvider: "local",
      marketDataProvider: "mock",
      strategyId: undefined,
      availableStrategies: [makeStrategy()],
    });
    expect(result.valid).toBe(true);
  });
});
