import { describe, expect, it } from "vitest";
import { MarketIntelligenceBuilder } from "@/lib/hermes-execution/market-intelligence-builder";
import { generateSyntheticCandles } from "@/lib/hermes-execution/mock-candle-generator";

const NOW = new Date("2026-01-01T12:00:00Z");

function buildFor(bias: "bullish" | "bearish" | "sideways", positionOpen = false) {
  const candles = generateSyntheticCandles({ instrument: "BTC", bias, count: 60, intervalMinutes: 60, endTimestamp: NOW });
  return MarketIntelligenceBuilder.build({
    instrument: "BTC",
    bid: 100,
    ask: 100.05,
    positionOpen,
    strategyId: "STRAT-0001",
    strategyVersion: 1,
    strategySourceType: "HERMES_APPROVED",
    candles,
    now: NOW,
  });
}

describe("MarketIntelligenceBuilder.build — bullish context", () => {
  it("produces a Bullish trend with EMA20 above EMA50", () => {
    const context = buildFor("bullish");
    expect(context.trend).toBe("Bullish");
    expect(context.ema20).toBeGreaterThan(context.ema50);
  });
});

describe("MarketIntelligenceBuilder.build — bearish context", () => {
  it("produces a Bearish trend with EMA20 below EMA50", () => {
    const context = buildFor("bearish");
    expect(context.trend).toBe("Bearish");
    expect(context.ema20).toBeLessThan(context.ema50);
  });
});

describe("MarketIntelligenceBuilder.build — sideways market", () => {
  it("produces a Sideways trend", () => {
    const context = buildFor("sideways");
    expect(context.trend).toBe("Sideways");
  });
});

describe("MarketIntelligenceBuilder.build — assembled fields", () => {
  it("carries through instrument/bid/ask/spread/midPrice/positionOpen/strategy metadata unchanged", () => {
    const context = buildFor("bullish", true);
    expect(context.instrument).toBe("BTC");
    expect(context.bid).toBe(100);
    expect(context.ask).toBe(100.05);
    expect(context.spread).toBeCloseTo(0.05, 5);
    expect(context.midPrice).toBeCloseTo(100.025, 5);
    expect(context.positionOpen).toBe(true);
    expect(context.strategy).toEqual({ strategyId: "STRAT-0001", version: 1, sourceType: "HERMES_APPROVED" });
    expect(context.timestamp).toBe(NOW.toISOString());
  });

  it("reports 'Crypto Always Open' for BTC regardless of hour", () => {
    const context = buildFor("bullish");
    expect(context.marketSession).toBe("Crypto Always Open");
  });

  it("attaches only a recent window of candles, not the full history", () => {
    const context = buildFor("bullish");
    expect(context.recentCandles.length).toBeLessThan(60);
    expect(context.recentCandles.length).toBeGreaterThan(0);
  });

  it("computes a daily high/low that bounds the recent candle range", () => {
    const context = buildFor("bullish");
    expect(context.dailyHigh).toBeGreaterThanOrEqual(context.dailyLow);
  });

  it("computes a defined 24h volatility when enough candle history exists", () => {
    const context = buildFor("bullish");
    expect(context.volatility24h).toBeDefined();
    expect(context.volatility24h).toBeGreaterThanOrEqual(0);
  });

  it("returns RSI within the valid 0-100 range", () => {
    for (const bias of ["bullish", "bearish", "sideways"] as const) {
      const context = buildFor(bias);
      expect(context.rsi14).toBeGreaterThanOrEqual(0);
      expect(context.rsi14).toBeLessThanOrEqual(100);
    }
  });
});
