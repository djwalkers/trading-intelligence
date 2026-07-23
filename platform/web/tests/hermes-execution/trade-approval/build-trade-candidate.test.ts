import { describe, expect, it } from "vitest";
import { buildTradeCandidateInput, computeTradeLevels } from "@/lib/hermes-execution/trade-approval/build-trade-candidate";
import { MarketDecisionEngine, type MarketDecisionContext } from "@/lib/hermes-execution/market-decision-engine";
import type { MarketDataSnapshot } from "@/lib/hermes-execution/market-data/market-data-provider";

function makeContext(overrides: Partial<MarketDecisionContext> = {}): MarketDecisionContext {
  return {
    instrument: "BTC",
    bid: 100,
    ask: 100.05,
    spread: 0.05,
    midPrice: 100.025,
    timestamp: "2026-01-01T00:00:00.000Z",
    positionOpen: false,
    strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "HERMES_APPROVED" },
    recentCandles: [],
    ema20: 110,
    ema50: 100,
    rsi14: 55,
    atr14: 1.5,
    volume: 120,
    dailyHigh: 112,
    dailyLow: 98,
    volatility24h: 0.01,
    marketSession: "Crypto Always Open",
    trend: "Bullish",
    ...overrides,
  };
}

const SNAPSHOT: MarketDataSnapshot = {
  instrument: "BTC",
  timestamp: "2026-01-01T00:00:00.000Z",
  candles: [],
  bid: 100,
  ask: 100.05,
  spread: 0.05,
  latestPrice: 100.025,
  volume: 120,
};

describe("computeTradeLevels", () => {
  it("BUY: enters at ask, stop below entry, target above entry", () => {
    const context = makeContext();
    const levels = computeTradeLevels(context, "BUY");
    expect(levels.entryPrice).toBe(context.ask);
    expect(levels.stopLoss).toBeLessThan(levels.entryPrice);
    expect(levels.takeProfit).toBeGreaterThan(levels.entryPrice);
    expect(levels.riskReward).toBeGreaterThan(0);
  });

  it("SELL: enters at bid, stop above entry, target below entry", () => {
    const context = makeContext({ positionOpen: true, trend: "Bearish", ema20: 90, ema50: 100 });
    const levels = computeTradeLevels(context, "SELL");
    expect(levels.entryPrice).toBe(context.bid);
    expect(levels.stopLoss).toBeGreaterThan(levels.entryPrice);
    expect(levels.takeProfit).toBeLessThan(levels.entryPrice);
  });

  it("never produces a zero-width stop even when atr14 is 0", () => {
    const context = makeContext({ atr14: 0 });
    const levels = computeTradeLevels(context, "BUY");
    expect(levels.stopLoss).not.toBe(levels.entryPrice);
    expect(Number.isFinite(levels.riskReward)).toBe(true);
  });
});

describe("buildTradeCandidateInput", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("builds a candidate input from a BUY decision, carrying reasoning/confidence/expiry through", () => {
    const context = makeContext();
    const decision = MarketDecisionEngine.evaluate(context);
    expect(decision.action).toBe("BUY");

    const input = buildTradeCandidateInput({
      decision,
      context,
      marketDataSnapshot: SNAPSHOT,
      amount: 10,
      analysisRunId: "analysis-run-1",
      now,
      expiryMs: 20 * 60_000,
    });

    expect(input.strategyId).toBe("DEMO-0001");
    expect(input.instrument).toBe("BTC");
    expect(input.direction).toBe("BUY");
    expect(input.confidence).toBe(decision.confidence);
    expect(input.reasoning).toEqual(decision.reasoning);
    expect(input.analysisRunId).toBe("analysis-run-1");
    expect(input.expiresAt).toBe(new Date(now.getTime() + 20 * 60_000).toISOString());
    expect(input.execution).toEqual({ marketContext: context, marketDataSnapshot: SNAPSHOT, amount: 10 });
  });

  it("carries validationNotes through, defaulting to an empty array when the decision has none", () => {
    const context = makeContext();
    const decision = MarketDecisionEngine.evaluate(context);
    const input = buildTradeCandidateInput({
      decision,
      context,
      marketDataSnapshot: SNAPSHOT,
      amount: 10,
      analysisRunId: undefined,
      now,
      expiryMs: 1000,
    });
    expect(Array.isArray(input.validationNotes)).toBe(true);
  });
});
