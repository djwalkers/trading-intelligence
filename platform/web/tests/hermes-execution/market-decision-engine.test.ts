import { describe, expect, it } from "vitest";
import { MarketDecisionEngine, type MarketDecisionContext } from "@/lib/hermes-execution/market-decision-engine";

function makeContext(overrides: Partial<MarketDecisionContext> = {}): MarketDecisionContext {
  return {
    instrument: "BTC",
    bid: 100,
    ask: 100.05,
    spread: 0.05,
    midPrice: 100.025,
    timestamp: "2026-01-01T00:00:00Z",
    positionOpen: false,
    strategy: { strategyId: "STRAT-0001", version: 1, sourceType: "HERMES_APPROVED" },
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

describe("MarketDecisionEngine.evaluate — bullish context (BUY)", () => {
  it("returns BUY when EMA20 > EMA50, RSI is healthy, trend is Bullish, and no position is open", () => {
    const decision = MarketDecisionEngine.evaluate(makeContext());
    expect(decision.action).toBe("BUY");
    expect(decision.confidence).toBeGreaterThan(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
  });

  it("includes the expected structured reasoning bullets", () => {
    const decision = MarketDecisionEngine.evaluate(makeContext());
    expect(Array.isArray(decision.reasoning)).toBe(true);
    expect(decision.reasoning.some((r) => /EMA20 above EMA50/i.test(r))).toBe(true);
    expect(decision.reasoning.some((r) => /RSI healthy/i.test(r))).toBe(true);
    expect(decision.reasoning.some((r) => /Bullish trend/i.test(r))).toBe(true);
    expect(decision.reasoning.some((r) => /No existing position/i.test(r))).toBe(true);
  });

  it("gives higher confidence the closer RSI is to the centre of the entry band", () => {
    const centred = MarketDecisionEngine.evaluate(makeContext({ rsi14: 55 }));
    const edge = MarketDecisionEngine.evaluate(makeContext({ rsi14: 46 }));
    expect(centred.confidence).toBeGreaterThan(edge.confidence);
  });
});

describe("MarketDecisionEngine.evaluate — high RSI (overbought, outside entry band)", () => {
  it("does not BUY when RSI is above 65, even with a Bullish trend and no position", () => {
    const decision = MarketDecisionEngine.evaluate(makeContext({ rsi14: 80 }));
    expect(decision.action).toBe("HOLD");
    expect(decision.reasoning.some((r) => /outside the 45-65 entry band/i.test(r))).toBe(true);
  });
});

describe("MarketDecisionEngine.evaluate — low RSI (oversold, outside entry band)", () => {
  it("does not BUY when RSI is below 45, even with a Bullish trend and no position", () => {
    const decision = MarketDecisionEngine.evaluate(makeContext({ rsi14: 20 }));
    expect(decision.action).toBe("HOLD");
    expect(decision.reasoning.some((r) => /outside the 45-65 entry band/i.test(r))).toBe(true);
  });
});

describe("MarketDecisionEngine.evaluate — sideways market (HOLD)", () => {
  it("does not BUY when the trend is Sideways, even with healthy RSI and no position", () => {
    const decision = MarketDecisionEngine.evaluate(makeContext({ trend: "Sideways", ema20: 100.02, ema50: 100 }));
    expect(decision.action).toBe("HOLD");
    expect(decision.reasoning.some((r) => /not Bullish/i.test(r))).toBe(true);
  });
});

describe("MarketDecisionEngine.evaluate — bearish context (SELL)", () => {
  it("returns SELL when a position is open and the trend has turned Bearish", () => {
    const decision = MarketDecisionEngine.evaluate(
      makeContext({ positionOpen: true, trend: "Bearish", ema20: 90, ema50: 100 }),
    );
    expect(decision.action).toBe("SELL");
    expect(decision.confidence).toBeGreaterThan(0);
    expect(decision.reasoning.some((r) => /Position already open/i.test(r))).toBe(true);
    expect(decision.reasoning.some((r) => /Bearish/i.test(r))).toBe(true);
  });

  it("never returns BUY when a position is already open, regardless of trend", () => {
    const bullishWithPosition = MarketDecisionEngine.evaluate(makeContext({ positionOpen: true, trend: "Bullish" }));
    expect(bullishWithPosition.action).not.toBe("BUY");
  });
});

describe("MarketDecisionEngine.evaluate — existing position, non-Bearish trend (HOLD, not SELL)", () => {
  it("holds an open position when the trend is still Bullish rather than closing it", () => {
    const decision = MarketDecisionEngine.evaluate(makeContext({ positionOpen: true, trend: "Bullish" }));
    expect(decision.action).toBe("HOLD");
    expect(decision.reasoning.some((r) => /Position already open/i.test(r))).toBe(true);
    expect(decision.reasoning.some((r) => /not Bearish/i.test(r))).toBe(true);
  });

  it("holds an open position when the trend is Sideways rather than closing it", () => {
    const decision = MarketDecisionEngine.evaluate(makeContext({ positionOpen: true, trend: "Sideways" }));
    expect(decision.action).toBe("HOLD");
  });
});

describe("MarketDecisionEngine.evaluate — confidence and reasoning are always present", () => {
  it("returns a numeric confidence and a non-empty reasoning array for every branch", () => {
    const scenarios: Partial<MarketDecisionContext>[] = [
      {}, // BUY
      { positionOpen: true, trend: "Bearish", ema20: 90, ema50: 100 }, // SELL
      { rsi14: 90 }, // HOLD (overbought)
      { positionOpen: true, trend: "Bullish" }, // HOLD (holding a position)
    ];
    for (const overrides of scenarios) {
      const decision = MarketDecisionEngine.evaluate(makeContext(overrides));
      expect(typeof decision.confidence).toBe("number");
      expect(Number.isFinite(decision.confidence)).toBe(true);
      expect(decision.confidence).toBeGreaterThanOrEqual(0);
      expect(decision.confidence).toBeLessThanOrEqual(1);
      expect(Array.isArray(decision.reasoning)).toBe(true);
      expect(decision.reasoning.length).toBeGreaterThan(0);
      for (const line of decision.reasoning) expect(typeof line).toBe("string");
    }
  });

  it("references the strategy's identity in the reasoning, distinguishing DEMO_ONLY from HERMES_APPROVED", () => {
    const decision = MarketDecisionEngine.evaluate(
      makeContext({ strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "DEMO_ONLY" } }),
    );
    expect(decision.reasoning.some((r) => r.includes("DEMO-0001") && r.includes("DEMO_ONLY"))).toBe(true);
  });
});
