import { describe, expect, it } from "vitest";
import {
  InMemoryStrategyRegistry,
  InvalidStrategyError,
  UnknownStrategyError,
} from "@/lib/hermes-execution/strategies/strategy-registry";
import type { Decision, Strategy } from "@/lib/hermes-execution/strategies/strategy";

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: "TEST-STRATEGY",
    version: 1,
    checkEntryConditions: () => ({ met: true, reasons: [] }),
    checkExitConditions: () => ({ met: false, reasons: [] }),
    applyFilters: () => ({ met: true, reasons: [] }),
    calculateEntryConfidence: () => 0.5,
    calculateExitConfidence: () => 0.5,
    explainHold: () => [],
    evaluate: (): Decision => ({
      action: "HOLD",
      confidence: 0.5,
      reasoning: [],
      entryCriteriaMet: false,
      exitCriteriaMet: false,
      validationNotes: [],
    }),
    ...overrides,
  };
}

describe("InMemoryStrategyRegistry", () => {
  it("registers a valid strategy and returns it from get/require/has/list", () => {
    const registry = new InMemoryStrategyRegistry();
    const strategy = makeStrategy();
    registry.register(strategy);

    expect(registry.get("TEST-STRATEGY")).toBe(strategy);
    expect(registry.require("TEST-STRATEGY")).toBe(strategy);
    expect(registry.has("TEST-STRATEGY")).toBe(true);
    expect(registry.list()).toEqual([strategy]);
  });

  it("get() returns undefined and has() returns false for an unregistered id", () => {
    const registry = new InMemoryStrategyRegistry();
    expect(registry.get("MISSING")).toBeUndefined();
    expect(registry.has("MISSING")).toBe(false);
  });

  it("require() throws UnknownStrategyError for an unregistered id", () => {
    const registry = new InMemoryStrategyRegistry();
    expect(() => registry.require("MISSING")).toThrow(UnknownStrategyError);
  });

  it("register() throws InvalidStrategyError for an empty id", () => {
    const registry = new InMemoryStrategyRegistry();
    expect(() => registry.register(makeStrategy({ id: "" }))).toThrow(InvalidStrategyError);
  });

  it("register() throws InvalidStrategyError for a non-positive-integer version", () => {
    const registry = new InMemoryStrategyRegistry();
    expect(() => registry.register(makeStrategy({ version: 0 }))).toThrow(InvalidStrategyError);
    expect(() => registry.register(makeStrategy({ version: 1.5 }))).toThrow(InvalidStrategyError);
  });

  it("register() throws InvalidStrategyError when a required method is missing", () => {
    const registry = new InMemoryStrategyRegistry();
    const malformed = makeStrategy();
    // @ts-expect-error deliberately constructing a malformed strategy for this test
    delete malformed.evaluate;
    expect(() => registry.register(malformed)).toThrow(InvalidStrategyError);
  });

  it("registering a strategy under an id that is already registered overwrites the previous one", () => {
    const registry = new InMemoryStrategyRegistry();
    const first = makeStrategy({ version: 1 });
    const second = makeStrategy({ version: 2 });
    registry.register(first);
    registry.register(second);
    expect(registry.require("TEST-STRATEGY")).toBe(second);
    expect(registry.list()).toHaveLength(1);
  });
});
