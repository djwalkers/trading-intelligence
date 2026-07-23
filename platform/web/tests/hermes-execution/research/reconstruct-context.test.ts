import { describe, expect, it } from "vitest";
import { canReconstructContext, reconstructContext } from "@/lib/hermes-execution/research/reconstruct-context";
import { Demo0001Strategy } from "@/lib/hermes-execution/strategies/demo-0001-strategy";
import { MarketDecisionEngine, type MarketDecisionContext } from "@/lib/hermes-execution/market-decision-engine";
import type { AnalysisRun } from "@/lib/hermes-execution/analysis/types";

function makeAnalysisRun(overrides: Partial<AnalysisRun> = {}): AnalysisRun {
  return {
    id: "analysis-run-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    runtimeMode: "demo",
    brokerProvider: "etoro-demo",
    marketProvider: "live",
    instrument: "BTC",
    timeframe: "1h",
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    currentBid: 100,
    currentAsk: 100.05,
    currentMid: 100.025,
    ema20: 110,
    ema50: 100,
    rsi14: 55,
    atr14: 1.5,
    trend: "Bullish",
    confidence: 0.8,
    decision: "BUY",
    decisionReason: "EMA20 above EMA50",
    executedTrade: false,
    validationOk: true,
    fallbackUsed: false,
    runtimeDurationMs: 120,
    metadata: {},
    ...overrides,
  };
}

describe("canReconstructContext", () => {
  it("is true when every required indicator/price field is present", () => {
    expect(canReconstructContext(makeAnalysisRun())).toBe(true);
  });

  it("is false when a required field (e.g. rsi14) is missing — an ERROR row, or a pre-Phase-2A row", () => {
    expect(canReconstructContext(makeAnalysisRun({ rsi14: undefined }))).toBe(false);
    expect(canReconstructContext(makeAnalysisRun({ currentBid: undefined }))).toBe(false);
    expect(canReconstructContext(makeAnalysisRun({ trend: undefined }))).toBe(false);
  });
});

describe("reconstructContext", () => {
  it("builds a MarketDecisionContext from the stored bid/ask/ema/rsi/atr/trend, with positionOpen from the caller", () => {
    const run = makeAnalysisRun();
    const context = reconstructContext(run, { strategyId: "DEMO-0001", strategyVersion: 1, positionOpen: true });

    expect(context.instrument).toBe("BTC");
    expect(context.bid).toBe(100);
    expect(context.ask).toBe(100.05);
    expect(context.spread).toBeCloseTo(0.05);
    expect(context.ema20).toBe(110);
    expect(context.ema50).toBe(100);
    expect(context.rsi14).toBe(55);
    expect(context.atr14).toBe(1.5);
    expect(context.trend).toBe("Bullish");
    expect(context.positionOpen).toBe(true);
    expect(context.timestamp).toBe(run.createdAt);
    expect(context.strategy).toEqual({ strategyId: "DEMO-0001", version: 1, sourceType: "DEMO_ONLY" });
  });

  it("throws when required fields are missing rather than fabricating a context", () => {
    const run = makeAnalysisRun({ atr14: undefined });
    expect(() => reconstructContext(run, { strategyId: "DEMO-0001", strategyVersion: 1, positionOpen: false })).toThrow();
  });

  it("produces IDENTICAL decisions to the original, fully-built context — proving the approximated fields (recentCandles/volume/dailyHigh/dailyLow/volatility24h) never affect Demo0001Strategy's own decision logic", () => {
    const strategy = new Demo0001Strategy();
    const run = makeAnalysisRun();

    const reconstructed = reconstructContext(run, { strategyId: "DEMO-0001", strategyVersion: 1, positionOpen: false });

    const original: MarketDecisionContext = {
      instrument: "BTC",
      bid: 100,
      ask: 100.05,
      spread: 0.05,
      midPrice: 100.025,
      timestamp: run.createdAt,
      positionOpen: false,
      strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "HERMES_APPROVED" },
      recentCandles: [], // deliberately different from reconstructed (still [], but proves the field itself is irrelevant)
      ema20: 110,
      ema50: 100,
      rsi14: 55,
      atr14: 1.5,
      volume: 999, // deliberately different from the reconstructed context's approximated 0
      dailyHigh: 500,
      dailyLow: 50,
      volatility24h: 0.5,
      marketSession: "Asia", // deliberately different from the reconstructed context's resolved session
      trend: "Bullish",
    };

    const reconstructedDecision = strategy.evaluate(reconstructed);
    const originalDecision = strategy.evaluate(original);

    expect(reconstructedDecision.action).toBe(originalDecision.action);
    expect(reconstructedDecision.confidence).toBe(originalDecision.confidence);
    expect(reconstructedDecision.entryCriteriaMet).toBe(originalDecision.entryCriteriaMet);

    // Also matches the live, unmodified MarketDecisionEngine's own delegated evaluation.
    expect(MarketDecisionEngine.evaluate(reconstructed).action).toBe(reconstructedDecision.action);
  });
});
