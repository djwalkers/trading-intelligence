import { describe, expect, it } from "vitest";
import { filterAnalysisRuns } from "@/lib/hermes-execution/analysis/filter-runs";
import type { AnalysisRun } from "@/lib/hermes-execution/analysis/types";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence.

function makeRun(overrides: Partial<AnalysisRun> = {}): AnalysisRun {
  return {
    id: "run-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    runtimeMode: "demo",
    brokerProvider: "etoro-demo",
    marketProvider: "live",
    instrument: "BTC",
    timeframe: "1h",
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    decision: "HOLD",
    executedTrade: false,
    validationOk: true,
    fallbackUsed: false,
    runtimeDurationMs: 100,
    ...overrides,
  };
}

describe("filterAnalysisRuns — exact-match filters", () => {
  it("filters by instrument", () => {
    const runs = [makeRun({ id: "1", instrument: "BTC" }), makeRun({ id: "2", instrument: "ETH" })];
    expect(filterAnalysisRuns(runs, { instrument: "ETH" }).map((r) => r.id)).toEqual(["2"]);
  });

  it("filters by decision", () => {
    const runs = [makeRun({ id: "1", decision: "BUY" }), makeRun({ id: "2", decision: "SELL" })];
    expect(filterAnalysisRuns(runs, { decision: "BUY" }).map((r) => r.id)).toEqual(["1"]);
  });

  it("filters by strategyId", () => {
    const runs = [makeRun({ id: "1", strategyId: "A" }), makeRun({ id: "2", strategyId: "B" })];
    expect(filterAnalysisRuns(runs, { strategyId: "B" }).map((r) => r.id)).toEqual(["2"]);
  });

  it("an empty filter object returns every run unchanged", () => {
    const runs = [makeRun({ id: "1" }), makeRun({ id: "2" })];
    expect(filterAnalysisRuns(runs, {})).toHaveLength(2);
  });

  it("combines multiple filters with AND semantics", () => {
    const runs = [
      makeRun({ id: "1", instrument: "BTC", decision: "BUY" }),
      makeRun({ id: "2", instrument: "BTC", decision: "SELL" }),
      makeRun({ id: "3", instrument: "ETH", decision: "BUY" }),
    ];
    expect(filterAnalysisRuns(runs, { instrument: "BTC", decision: "BUY" }).map((r) => r.id)).toEqual(["1"]);
  });
});

describe("filterAnalysisRuns — free-text search", () => {
  it("matches on instrument, case-insensitively", () => {
    const runs = [makeRun({ id: "1", instrument: "BTC" }), makeRun({ id: "2", instrument: "ETH" })];
    expect(filterAnalysisRuns(runs, { search: "btc" }).map((r) => r.id)).toEqual(["1"]);
  });

  it("matches on strategyId", () => {
    const runs = [makeRun({ id: "1", strategyId: "DEMO-0001" }), makeRun({ id: "2", strategyId: "STRAT-0042" })];
    expect(filterAnalysisRuns(runs, { search: "strat-0042" }).map((r) => r.id)).toEqual(["2"]);
  });

  it("matches on decisionReason", () => {
    const runs = [
      makeRun({ id: "1", decisionReason: "EMA20 above EMA50" }),
      makeRun({ id: "2", decisionReason: "No entry signal" }),
    ];
    expect(filterAnalysisRuns(runs, { search: "ema20" }).map((r) => r.id)).toEqual(["1"]);
  });

  it("a blank/whitespace-only search matches everything", () => {
    const runs = [makeRun({ id: "1" }), makeRun({ id: "2" })];
    expect(filterAnalysisRuns(runs, { search: "   " })).toHaveLength(2);
  });

  it("never throws when decisionReason is undefined", () => {
    const runs = [makeRun({ id: "1", decisionReason: undefined })];
    expect(() => filterAnalysisRuns(runs, { search: "anything" })).not.toThrow();
    expect(filterAnalysisRuns(runs, { search: "anything" })).toHaveLength(0);
  });
});

describe("filterAnalysisRuns — purity", () => {
  it("never mutates the input array", () => {
    const runs = [makeRun({ id: "1" }), makeRun({ id: "2" })];
    const snapshot = [...runs];
    filterAnalysisRuns(runs, { instrument: "BTC" });
    expect(runs).toEqual(snapshot);
  });
});
