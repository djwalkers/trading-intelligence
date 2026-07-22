import { describe, expect, it } from "vitest";
import { computeStrategyPerformance, computeStrategyUsage } from "@/lib/hermes-execution/analysis/analysis-analytics";
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

describe("computeStrategyPerformance — decision percentages", () => {
  it("computes BUY/SELL/HOLD percentages against the total run count", () => {
    const runs = [
      makeRun({ decision: "BUY" }),
      makeRun({ decision: "BUY" }),
      makeRun({ decision: "SELL" }),
      makeRun({ decision: "HOLD" }),
    ];
    const summary = computeStrategyPerformance(runs);
    expect(summary.totalRuns).toBe(4);
    expect(summary.buyPercent).toBe(50);
    expect(summary.sellPercent).toBe(25);
    expect(summary.holdPercent).toBe(25);
  });

  it("returns 0% for every figure on an empty set, never NaN or a division-by-zero crash", () => {
    const summary = computeStrategyPerformance([]);
    expect(summary.totalRuns).toBe(0);
    expect(summary.buyPercent).toBe(0);
    expect(summary.executionPercent).toBe(0);
    expect(summary.errorRatePercent).toBe(0);
    expect(summary.averageRsi14).toBeNull();
    expect(summary.averageConfidence).toBeNull();
    expect(summary.mostCommonTrend).toBeNull();
  });
});

describe("computeStrategyPerformance — execution/error/fallback rates", () => {
  it("computes execution percent from executedTrade", () => {
    const runs = [makeRun({ executedTrade: true }), makeRun({ executedTrade: false }), makeRun({ executedTrade: false })];
    expect(computeStrategyPerformance(runs).executionPercent).toBeCloseTo(33.33, 1);
  });

  it("counts a decision:'ERROR' run and an errorCode-bearing run toward the error rate", () => {
    const runs = [
      makeRun({ decision: "ERROR", errorCode: "CANDLE_FETCH_FAILED" }),
      makeRun({ decision: "HOLD" }),
      makeRun({ decision: "HOLD" }),
      makeRun({ decision: "HOLD" }),
    ];
    expect(computeStrategyPerformance(runs).errorRatePercent).toBe(25);
  });

  it("fallback rate is always 0% given this pipeline's own no-fallback invariant", () => {
    const runs = [makeRun({ fallbackUsed: false }), makeRun({ fallbackUsed: false })];
    expect(computeStrategyPerformance(runs).fallbackRatePercent).toBe(0);
  });
});

describe("computeStrategyPerformance — averages", () => {
  it("averages RSI14/ATR14/confidence/runtime only over runs that actually have a value", () => {
    const runs = [
      makeRun({ rsi14: 40, atr14: 10, confidence: 0.6, runtimeDurationMs: 100 }),
      makeRun({ rsi14: 60, atr14: 20, confidence: 0.8, runtimeDurationMs: 200 }),
      makeRun({ rsi14: undefined, atr14: undefined, confidence: undefined, runtimeDurationMs: 300 }),
    ];
    const summary = computeStrategyPerformance(runs);
    expect(summary.averageRsi14).toBe(50);
    expect(summary.averageAtr14).toBe(15);
    expect(summary.averageConfidence).toBeCloseTo(0.7, 5);
    expect(summary.averageRuntimeDurationMs).toBeCloseTo(200, 5);
  });
});

describe("computeStrategyPerformance — top instruments and trend distribution", () => {
  it("ranks instruments by frequency, most-traded first, capped at 5", () => {
    const runs = [
      ...Array.from({ length: 3 }, () => makeRun({ instrument: "BTC" })),
      ...Array.from({ length: 2 }, () => makeRun({ instrument: "ETH" })),
      makeRun({ instrument: "SOL" }),
    ];
    const summary = computeStrategyPerformance(runs);
    expect(summary.topInstruments[0]).toEqual({ instrument: "BTC", count: 3 });
    expect(summary.topInstruments[1]).toEqual({ instrument: "ETH", count: 2 });
    expect(summary.topInstruments[2]).toEqual({ instrument: "SOL", count: 1 });
  });

  it("identifies the most common trend and reports a full distribution", () => {
    const runs = [
      makeRun({ trend: "Bullish" }),
      makeRun({ trend: "Bullish" }),
      makeRun({ trend: "Bearish" }),
      makeRun({ trend: undefined }),
    ];
    const summary = computeStrategyPerformance(runs);
    expect(summary.mostCommonTrend).toBe("Bullish");
    expect(summary.trendDistribution).toEqual({ Bullish: 2, Bearish: 1, Sideways: 0 });
  });

  it("never mutates the input array", () => {
    const runs = [makeRun({ instrument: "BTC" }), makeRun({ instrument: "ETH" })];
    const snapshot = [...runs];
    computeStrategyPerformance(runs);
    expect(runs).toEqual(snapshot);
  });
});

describe("computeStrategyUsage", () => {
  it("counts runs and executed trades per strategy, sorted by count descending", () => {
    const runs = [
      makeRun({ strategyId: "A", executedTrade: true }),
      makeRun({ strategyId: "A", executedTrade: false }),
      makeRun({ strategyId: "B", executedTrade: true }),
    ];
    const usage = computeStrategyUsage(runs);
    expect(usage).toEqual([
      { strategyId: "A", count: 2, executedCount: 1 },
      { strategyId: "B", count: 1, executedCount: 1 },
    ]);
  });

  it("returns an empty array for no runs", () => {
    expect(computeStrategyUsage([])).toEqual([]);
  });
});
