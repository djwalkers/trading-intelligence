import { describe, expect, it } from "vitest";
import { selectStrategy } from "@/lib/hermes-execution/runtime-config/strategy-selection";
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

describe("selectStrategy — no strategyId configured (preserves existing fallback behaviour)", () => {
  it("prefers the first HERMES_APPROVED strategy over DEMO_ONLY", () => {
    const approved = makeStrategy({ strategyId: "STRAT-0001", sourceType: "HERMES_APPROVED" });
    const demo = makeStrategy({ strategyId: "DEMO-0001", sourceType: "DEMO_ONLY" });
    const result = selectStrategy([demo, approved], undefined);
    expect(result).toEqual({ found: true, strategy: approved });
  });

  it("falls back to DEMO_ONLY when no HERMES_APPROVED strategy is loaded", () => {
    const demo = makeStrategy({ strategyId: "DEMO-0001", sourceType: "DEMO_ONLY" });
    const result = selectStrategy([demo], undefined);
    expect(result).toEqual({ found: true, strategy: demo });
  });

  it("reports not-found when no strategy is loaded at all", () => {
    const result = selectStrategy([], undefined);
    expect(result.found).toBe(false);
  });
});

describe("selectStrategy — explicit strategyId", () => {
  it("selects the exact matching strategy by id", () => {
    const target = makeStrategy({ strategyId: "STRAT-0042" });
    const other = makeStrategy({ strategyId: "STRAT-0001" });
    const result = selectStrategy([other, target], "STRAT-0042");
    expect(result).toEqual({ found: true, strategy: target });
  });

  it("selects the demo strategy by its own id when configured explicitly", () => {
    const demo = makeStrategy({ strategyId: "DEMO-0001", sourceType: "DEMO_ONLY" });
    const result = selectStrategy([demo], "DEMO-0001");
    expect(result).toEqual({ found: true, strategy: demo });
  });
});

describe("selectStrategy — unknown strategy", () => {
  it("reports not-found for an id that matches nothing loaded", () => {
    const result = selectStrategy([makeStrategy({ strategyId: "STRAT-0001" })], "STRAT-9999");
    expect(result.found).toBe(false);
    if (!result.found) expect(result.reason).toMatch(/STRAT-9999/);
  });

  it("reports not-found for an empty loaded set", () => {
    const result = selectStrategy([], "STRAT-0001");
    expect(result.found).toBe(false);
  });
});

describe("selectStrategy — disabled strategy", () => {
  it("reports not-found, with a distinct 'disabled' reason, for a matching but disabled strategy", () => {
    const disabled = makeStrategy({ strategyId: "STRAT-0007", enabled: false });
    const result = selectStrategy([disabled], "STRAT-0007");
    expect(result.found).toBe(false);
    if (!result.found) expect(result.reason).toMatch(/disabled/i);
  });
});
