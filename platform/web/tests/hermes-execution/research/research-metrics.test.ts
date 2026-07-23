import { describe, expect, it } from "vitest";
import { buildResearchEquityCurve, computeResearchMetrics } from "@/lib/hermes-execution/research/research-metrics";
import type { ResearchDecisionPoint, SimulatedTrade } from "@/lib/hermes-execution/research/types";

function makeTrade(overrides: Partial<SimulatedTrade> = {}): SimulatedTrade {
  return {
    entryTime: "2026-01-01T00:00:00.000Z",
    entryPrice: 100,
    exitTime: "2026-01-01T01:00:00.000Z",
    exitPrice: 106,
    holdingTimeMs: 3_600_000,
    grossPnl: 60,
    returnPercent: 6,
    riskMultiple: 1.2,
    maxFavourableExcursion: 80,
    maxAdverseExcursion: -10,
    ...overrides,
  };
}

function makeDecisionPoint(action: "BUY" | "SELL" | "HOLD", analysisRunId: string): ResearchDecisionPoint {
  return {
    analysisRunId,
    action,
    confidence: 0.7,
    reasoning: [],
    context: {
      instrument: "BTC",
      bid: 100,
      ask: 100.05,
      spread: 0.05,
      midPrice: 100.025,
      timestamp: "2026-01-01T00:00:00.000Z",
      positionOpen: false,
      strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "DEMO_ONLY" },
      recentCandles: [],
      ema20: 110,
      ema50: 100,
      rsi14: 55,
      atr14: 1.5,
      volume: 0,
      dailyHigh: 100.05,
      dailyLow: 100,
      volatility24h: undefined,
      marketSession: "Crypto Always Open",
      trend: "Bullish",
    },
  };
}

describe("computeResearchMetrics", () => {
  it("computes trade counts, win/loss rate, expectancy, profit factor, and average R", () => {
    const trades = [makeTrade({ grossPnl: 100, returnPercent: 10, riskMultiple: 2 }), makeTrade({ grossPnl: -40, returnPercent: -4, riskMultiple: -0.8 })];
    const decisionPoints = [makeDecisionPoint("BUY", "r1"), makeDecisionPoint("SELL", "r2"), makeDecisionPoint("HOLD", "r3")];

    const metrics = computeResearchMetrics(decisionPoints, trades, { since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z" });

    expect(metrics.tradeCount).toBe(2);
    expect(metrics.opportunityCount).toBe(3);
    expect(metrics.skippedCount).toBe(1);
    expect(metrics.winRate).toBeCloseTo(0.5);
    expect(metrics.lossRate).toBeCloseTo(0.5);
    expect(metrics.expectancy).toBeCloseTo(30); // (100 - 40) / 2
    expect(metrics.profitFactor).toBeCloseTo(2.5); // 100 / 40
    expect(metrics.averageRiskMultiple).toBeCloseTo(0.6); // (2 + -0.8) / 2
  });

  it("tradeFrequency is trades/opportunities; opportunityFrequencyPerDay is opportunities/day", () => {
    const decisionPoints = Array.from({ length: 10 }, (_, i) => makeDecisionPoint("HOLD", `r${i}`));
    const trades = [makeTrade()];
    const metrics = computeResearchMetrics(decisionPoints, trades, { since: "2026-01-01T00:00:00.000Z", until: "2026-01-06T00:00:00.000Z" });
    expect(metrics.tradeFrequency).toBeCloseTo(0.1); // 1/10
    expect(metrics.opportunityFrequencyPerDay).toBeCloseTo(2); // 10 opportunities / 5 days
  });

  it("profitFactor is undefined (never Infinity) with no losing trades", () => {
    const metrics = computeResearchMetrics([], [makeTrade({ grossPnl: 50 })], { since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z" });
    expect(metrics.profitFactor).toBeUndefined();
  });

  it("sharpeRatio is undefined with fewer than 2 trades, and a real ratio with 2+ trades of varying return", () => {
    const oneTradeMetrics = computeResearchMetrics([], [makeTrade()], { since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z" });
    expect(oneTradeMetrics.sharpeRatio).toBeUndefined();

    const trades = [makeTrade({ returnPercent: 5 }), makeTrade({ returnPercent: 10 }), makeTrade({ returnPercent: -2 })];
    const metrics = computeResearchMetrics([], trades, { since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z" });
    expect(metrics.sharpeRatio).toBeDefined();
    expect(Number.isFinite(metrics.sharpeRatio)).toBe(true);
  });

  it("sharpeRatio is undefined (never NaN/Infinity) when every trade has an identical return (zero standard deviation)", () => {
    const trades = [makeTrade({ returnPercent: 5 }), makeTrade({ returnPercent: 5 })];
    const metrics = computeResearchMetrics([], trades, { since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z" });
    expect(metrics.sharpeRatio).toBeUndefined();
  });

  it("maximumDrawdown measures the peak-to-trough decline of the cumulative gross P/L curve in exit order", () => {
    const trades = [
      makeTrade({ exitTime: "2026-01-01T00:00:00.000Z", grossPnl: 100 }),
      makeTrade({ exitTime: "2026-01-02T00:00:00.000Z", grossPnl: 50 }),
      makeTrade({ exitTime: "2026-01-03T00:00:00.000Z", grossPnl: -60 }),
    ];
    const metrics = computeResearchMetrics([], trades, { since: "2026-01-01T00:00:00.000Z", until: "2026-01-04T00:00:00.000Z" });
    expect(metrics.maximumDrawdown).toBe(60); // peak 150, trough 90
  });

  it("averageRiskMultiple excludes trades with an undefined risk_multiple, never treating them as 0", () => {
    const trades = [makeTrade({ riskMultiple: 2 }), makeTrade({ riskMultiple: undefined })];
    const metrics = computeResearchMetrics([], trades, { since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z" });
    expect(metrics.averageRiskMultiple).toBe(2);
  });
});

describe("buildResearchEquityCurve", () => {
  it("returns a running cumulative gross P/L series ordered by exit time", () => {
    const trades = [makeTrade({ exitTime: "2026-01-02T00:00:00.000Z", grossPnl: -30 }), makeTrade({ exitTime: "2026-01-01T00:00:00.000Z", grossPnl: 100 })];
    const curve = buildResearchEquityCurve(trades);
    expect(curve.map((p) => p.cumulativeNetPnl)).toEqual([100, 70]);
  });
});
