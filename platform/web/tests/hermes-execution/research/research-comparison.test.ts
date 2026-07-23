import { describe, expect, it } from "vitest";
import { compareResearchRuns } from "@/lib/hermes-execution/research/research-comparison";
import { computeResearchMetrics, buildResearchEquityCurve } from "@/lib/hermes-execution/research/research-metrics";
import type { ResearchDecisionPoint, ResearchRunResult, SimulatedTrade } from "@/lib/hermes-execution/research/types";

function makeContext(overrides: Partial<ResearchDecisionPoint["context"]> = {}) {
  return {
    instrument: "BTC",
    bid: 100,
    ask: 100.05,
    spread: 0.05,
    midPrice: 100.025,
    timestamp: "2026-01-01T00:00:00.000Z",
    positionOpen: false,
    strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "DEMO_ONLY" as const },
    recentCandles: [],
    ema20: 110,
    ema50: 100,
    rsi14: 55,
    atr14: 1.5,
    volume: 0,
    dailyHigh: 100.05,
    dailyLow: 100,
    volatility24h: undefined,
    marketSession: "Crypto Always Open" as const,
    trend: "Bullish" as const,
    ...overrides,
  };
}

function makeDecisionPoint(analysisRunId: string, action: "BUY" | "SELL" | "HOLD", timestamp: string): ResearchDecisionPoint {
  return { analysisRunId, action, confidence: 0.7, reasoning: [], context: makeContext({ timestamp }) };
}

function makeTrade(overrides: Partial<SimulatedTrade> = {}): SimulatedTrade {
  return {
    entryTime: "2026-01-01T01:00:00.000Z",
    entryPrice: 100.05,
    exitTime: "2026-01-01T03:00:00.000Z",
    exitPrice: 112,
    holdingTimeMs: 2 * 3_600_000,
    grossPnl: 119.5,
    returnPercent: 11.9,
    riskMultiple: 1.5,
    maxFavourableExcursion: 130,
    maxAdverseExcursion: 0,
    ...overrides,
  };
}

function makeResult(strategyId: string, decisionPoints: ResearchDecisionPoint[], trades: SimulatedTrade[]): ResearchRunResult {
  const window = { since: "2026-01-01T00:00:00.000Z", until: "2026-01-01T04:00:00.000Z" };
  return {
    strategyId,
    strategyVersion: 1,
    instrument: "BTC",
    ...window,
    decisionPoints,
    trades,
    equityCurve: buildResearchEquityCurve(trades),
    metrics: computeResearchMetrics(decisionPoints, trades, window),
  };
}

describe("compareResearchRuns", () => {
  it("computes a delta for every numeric metric", () => {
    const a = makeResult("DEMO-0001", [makeDecisionPoint("r1", "HOLD", "t1")], []);
    const b = makeResult("RESEARCH-0001", [makeDecisionPoint("r1", "BUY", "t1")], [makeTrade()]);

    const comparison = compareResearchRuns(a, b);
    const tradeCountDelta = comparison.metricDeltas.find((d) => d.metric === "tradeCount");
    expect(tradeCountDelta).toEqual({ metric: "tradeCount", a: 0, b: 1, delta: 1 });
  });

  it("leaves delta undefined when either side's metric is undefined (e.g. profitFactor with no losses on either side)", () => {
    const a = makeResult("DEMO-0001", [], [makeTrade({ grossPnl: 50 })]);
    const b = makeResult("RESEARCH-0001", [], []);
    const comparison = compareResearchRuns(a, b);
    const profitFactorDelta = comparison.metricDeltas.find((d) => d.metric === "profitFactor");
    expect(profitFactorDelta?.delta).toBeUndefined();
  });

  it("finds decision differences matched by analysisRunId, ignoring points only one side has", () => {
    const a = makeResult(
      "DEMO-0001",
      [makeDecisionPoint("r1", "BUY", "t1"), makeDecisionPoint("r2", "HOLD", "t2"), makeDecisionPoint("r3", "SELL", "t3")],
      [],
    );
    const b = makeResult(
      "RESEARCH-0001",
      [makeDecisionPoint("r1", "HOLD", "t1"), makeDecisionPoint("r2", "HOLD", "t2"), makeDecisionPoint("r3", "SELL", "t3")],
      [],
    );

    const comparison = compareResearchRuns(a, b);
    expect(comparison.decisionDifferences).toEqual([{ analysisRunId: "r1", timestamp: "t1", actionA: "BUY", actionB: "HOLD" }]);
  });

  it("classifies trades as onlyInA, onlyInB, or divergent (matched by entryTime, differing net P/L)", () => {
    const sharedTradeA = makeTrade({ entryTime: "2026-01-01T01:00:00.000Z", grossPnl: 100 });
    const sharedTradeB = makeTrade({ entryTime: "2026-01-01T01:00:00.000Z", grossPnl: 40 }); // same entry, different outcome
    const onlyInA = makeTrade({ entryTime: "2026-01-02T01:00:00.000Z", exitTime: "2026-01-02T03:00:00.000Z" });
    const onlyInB = makeTrade({ entryTime: "2026-01-03T01:00:00.000Z", exitTime: "2026-01-03T03:00:00.000Z" });

    const a = makeResult("DEMO-0001", [], [sharedTradeA, onlyInA]);
    const b = makeResult("RESEARCH-0001", [], [sharedTradeB, onlyInB]);

    const comparison = compareResearchRuns(a, b);
    expect(comparison.tradeDifferences.tradesOnlyInA).toEqual([onlyInA]);
    expect(comparison.tradeDifferences.tradesOnlyInB).toEqual([onlyInB]);
    expect(comparison.tradeDifferences.divergentTrades).toEqual([{ a: sharedTradeA, b: sharedTradeB }]);
  });

  it("does not flag a shared trade as divergent when its outcome matches within the 1-cent tolerance", () => {
    const tradeA = makeTrade({ entryTime: "2026-01-01T01:00:00.000Z", grossPnl: 100 });
    const tradeB = makeTrade({ entryTime: "2026-01-01T01:00:00.000Z", grossPnl: 100.005 });
    const comparison = compareResearchRuns(makeResult("A", [], [tradeA]), makeResult("B", [], [tradeB]));
    expect(comparison.tradeDifferences.divergentTrades).toEqual([]);
    expect(comparison.tradeDifferences.tradesOnlyInA).toEqual([]);
    expect(comparison.tradeDifferences.tradesOnlyInB).toEqual([]);
  });
});
