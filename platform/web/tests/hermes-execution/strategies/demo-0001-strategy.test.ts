import { describe, expect, it } from "vitest";
import { Demo0001Strategy } from "@/lib/hermes-execution/strategies/demo-0001-strategy";
import type { MarketDecisionContext } from "@/lib/hermes-execution/market-decision-engine";

function makeContext(overrides: Partial<MarketDecisionContext> = {}): MarketDecisionContext {
  return {
    instrument: "BTC",
    bid: 100,
    ask: 100.05,
    spread: 0.05,
    midPrice: 100.025,
    timestamp: "2026-01-01T00:00:00Z",
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

describe("Demo0001Strategy identity", () => {
  it("exposes id DEMO-0001 and version 1", () => {
    const strategy = new Demo0001Strategy();
    expect(strategy.id).toBe("DEMO-0001");
    expect(strategy.version).toBe(1);
  });
});

describe("Demo0001Strategy.checkEntryConditions", () => {
  const strategy = new Demo0001Strategy();

  it("is met when EMA20 > EMA50, RSI is within the entry band, and trend is Bullish", () => {
    const result = strategy.checkEntryConditions(makeContext());
    expect(result.met).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("is not met when EMA20 is not above EMA50", () => {
    const result = strategy.checkEntryConditions(makeContext({ ema20: 90, ema50: 100 }));
    expect(result.met).toBe(false);
    expect(result.reasons.some((r) => /not above EMA50/.test(r))).toBe(true);
  });

  it("is not met when RSI is outside the entry band", () => {
    const result = strategy.checkEntryConditions(makeContext({ rsi14: 80 }));
    expect(result.met).toBe(false);
    expect(result.reasons.some((r) => /outside the 45-65 entry band/.test(r))).toBe(true);
  });

  it("is not met when trend is not Bullish", () => {
    const result = strategy.checkEntryConditions(makeContext({ trend: "Sideways" }));
    expect(result.met).toBe(false);
    expect(result.reasons.some((r) => /not Bullish/.test(r))).toBe(true);
  });
});

describe("Demo0001Strategy.checkExitConditions", () => {
  const strategy = new Demo0001Strategy();

  it("is met when trend is Bearish", () => {
    const result = strategy.checkExitConditions(makeContext({ trend: "Bearish" }));
    expect(result.met).toBe(true);
  });

  it("is not met when trend is not Bearish", () => {
    const result = strategy.checkExitConditions(makeContext({ trend: "Bullish" }));
    expect(result.met).toBe(false);
  });
});

describe("Demo0001Strategy.applyFilters", () => {
  it("always passes (no additional filters)", () => {
    const strategy = new Demo0001Strategy();
    expect(strategy.applyFilters(makeContext())).toEqual({ met: true, reasons: [] });
  });
});

describe("Demo0001Strategy.calculateEntryConfidence / calculateExitConfidence", () => {
  const strategy = new Demo0001Strategy();

  it("gives higher entry confidence the closer RSI is to the centre of the entry band", () => {
    const centred = strategy.calculateEntryConfidence(makeContext({ rsi14: 55 }));
    const edge = strategy.calculateEntryConfidence(makeContext({ rsi14: 46 }));
    expect(centred).toBeGreaterThan(edge);
  });

  it("returns exit confidence within [0, 1]", () => {
    const confidence = strategy.calculateExitConfidence(makeContext({ ema20: 90, ema50: 100 }));
    expect(confidence).toBeGreaterThan(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });
});

describe("Demo0001Strategy.evaluate — equivalence with the pre-Phase-3 engine's own fixed ruleset", () => {
  const strategy = new Demo0001Strategy();

  it("returns BUY with entryCriteriaMet true for a clean bullish setup", () => {
    const decision = strategy.evaluate(makeContext());
    expect(decision.action).toBe("BUY");
    expect(decision.entryCriteriaMet).toBe(true);
    expect(decision.exitCriteriaMet).toBe(false);
    expect(decision.reasoning.some((r) => /Entry authorised under strategy DEMO-0001/.test(r))).toBe(true);
  });

  it("returns SELL with exitCriteriaMet true when a position is open and trend turns Bearish", () => {
    const decision = strategy.evaluate(makeContext({ positionOpen: true, trend: "Bearish", ema20: 90, ema50: 100 }));
    expect(decision.action).toBe("SELL");
    expect(decision.exitCriteriaMet).toBe(true);
    expect(decision.entryCriteriaMet).toBe(false);
  });

  it("returns HOLD and never BUY while a position is already open, regardless of trend", () => {
    const decision = strategy.evaluate(makeContext({ positionOpen: true, trend: "Bullish" }));
    expect(decision.action).toBe("HOLD");
    expect(decision.reasoning.some((r) => /Position already open/.test(r))).toBe(true);
  });

  it("returns HOLD with entryCriteriaMet false when RSI is outside the entry band", () => {
    const decision = strategy.evaluate(makeContext({ rsi14: 90 }));
    expect(decision.action).toBe("HOLD");
    expect(decision.entryCriteriaMet).toBe(false);
  });

  it("always returns a finite confidence in [0, 1] and a non-empty reasoning array", () => {
    const scenarios: Partial<MarketDecisionContext>[] = [
      {},
      { positionOpen: true, trend: "Bearish", ema20: 90, ema50: 100 },
      { rsi14: 90 },
      { positionOpen: true, trend: "Bullish" },
    ];
    for (const overrides of scenarios) {
      const decision = strategy.evaluate(makeContext(overrides));
      expect(Number.isFinite(decision.confidence)).toBe(true);
      expect(decision.confidence).toBeGreaterThanOrEqual(0);
      expect(decision.confidence).toBeLessThanOrEqual(1);
      expect(decision.reasoning.length).toBeGreaterThan(0);
      expect(Array.isArray(decision.validationNotes)).toBe(true);
    }
  });
});
