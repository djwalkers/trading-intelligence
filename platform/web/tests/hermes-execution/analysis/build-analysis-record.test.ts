import { describe, expect, it } from "vitest";
import { buildAnalysisRecord } from "@/lib/hermes-execution/analysis/build-analysis-record";
import type { MarketDataSnapshot } from "@/lib/hermes-execution/market-data/market-data-provider";
import type { MarketDecisionContext } from "@/lib/hermes-execution/market-decision-engine";
import type { TradeLifecycleCycleResult } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-runner";
import { MarketDataProviderError } from "@/lib/hermes-execution/market-data/market-data-provider";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence.

const BASE_INPUT = {
  trigger: "scheduled" as const,
  runtimeMode: "demo" as const,
  brokerProvider: "etoro-demo" as const,
  marketProvider: "live" as const,
  timeframe: "1h",
  strategyId: "DEMO-0001",
  strategyVersion: 1,
  instrument: "BTC",
  runtimeDurationMs: 250,
};

function makeSnapshot(): MarketDataSnapshot {
  return {
    instrument: "BTC",
    timestamp: "2026-01-01T00:00:00.000Z",
    candles: [
      { symbol: "BTC", timestamp: "2025-12-31T23:00:00.000Z", open: 50_000, high: 50_100, low: 49_900, close: 50_050, volume: 12 },
      { symbol: "BTC", timestamp: "2026-01-01T00:00:00.000Z", open: 50_050, high: 50_150, low: 50_000, close: 50_100, volume: 15 },
    ],
    bid: 50_095,
    ask: 50_105,
    spread: 10,
    latestPrice: 50_100,
    volume: 15,
  };
}

function makeContext(overrides: Partial<MarketDecisionContext> = {}): MarketDecisionContext {
  return {
    instrument: "BTC",
    bid: 50_095,
    ask: 50_105,
    spread: 10,
    midPrice: 50_100,
    timestamp: "2026-01-01T00:00:00.000Z",
    positionOpen: false,
    strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "DEMO_ONLY" },
    recentCandles: makeSnapshot().candles,
    ema20: 50_080,
    ema50: 50_020,
    rsi14: 58,
    atr14: 110,
    volume: 15,
    dailyHigh: 50_150,
    dailyLow: 49_900,
    volatility24h: 0.001,
    marketSession: "Open" as MarketDecisionContext["marketSession"],
    trend: "Bullish",
    ...overrides,
  };
}

function makeResult(overrides: Partial<TradeLifecycleCycleResult> = {}): TradeLifecycleCycleResult {
  return {
    decision: { action: "HOLD", confidence: 0.5, reasoning: ["No entry signal"] },
    executed: false,
    ...overrides,
  };
}

describe("buildAnalysisRecord — success (HOLD)", () => {
  it("maps context/decision fields verbatim into the run", () => {
    const { run } = buildAnalysisRecord({
      ...BASE_INPUT,
      kind: "success",
      snapshot: makeSnapshot(),
      context: makeContext(),
      result: makeResult(),
    });

    expect(run.decision).toBe("HOLD");
    expect(run.ema20).toBe(50_080);
    expect(run.ema50).toBe(50_020);
    expect(run.rsi14).toBe(58);
    expect(run.atr14).toBe(110);
    expect(run.trend).toBe("Bullish");
    expect(run.currentBid).toBe(50_095);
    expect(run.currentAsk).toBe(50_105);
    expect(run.currentMid).toBe(50_100);
    expect(run.lastClose).toBe(50_100); // the last recentCandles entry's close
    expect(run.executedTrade).toBe(false);
    expect(run.tradeId).toBeUndefined();
    expect(run.validationOk).toBe(true);
    expect(run.fallbackUsed).toBe(false);
    expect(run.candleCount).toBe(2);
    expect(run.runtimeDurationMs).toBe(250);
  });

  it("joins the reasoning array into decisionReason and preserves the full array in metadata", () => {
    const { run } = buildAnalysisRecord({
      ...BASE_INPUT,
      kind: "success",
      snapshot: makeSnapshot(),
      context: makeContext(),
      result: makeResult({ decision: { action: "HOLD", confidence: 0.5, reasoning: ["Reason A", "Reason B"] } }),
    });
    expect(run.decisionReason).toBe("Reason A; Reason B");
    expect(run.metadata?.reasoning).toEqual(["Reason A", "Reason B"]);
  });

  it("produces CYCLE_STARTED, MARKET_DATA_FETCHED, INDICATORS_CALCULATED, DECISION_COMPLETED, and EXECUTION_SKIPPED events for a HOLD", () => {
    const { events } = buildAnalysisRecord({
      ...BASE_INPUT,
      kind: "success",
      snapshot: makeSnapshot(),
      context: makeContext(),
      result: makeResult(),
    });
    expect(events.map((e) => e.eventType)).toEqual([
      "CYCLE_STARTED",
      "MARKET_DATA_FETCHED",
      "INDICATORS_CALCULATED",
      "DECISION_COMPLETED",
      "EXECUTION_SKIPPED",
    ]);
  });
});

describe("buildAnalysisRecord — success (executed BUY)", () => {
  it("sets executedTrade and tradeId from result.position.positionId, and emits EXECUTION_COMPLETED", () => {
    const { run, events } = buildAnalysisRecord({
      ...BASE_INPUT,
      kind: "success",
      snapshot: makeSnapshot(),
      context: makeContext(),
      result: makeResult({
        decision: { action: "BUY", confidence: 0.75, reasoning: ["EMA20 above EMA50"] },
        executed: true,
        position: {
          positionId: "etoro-position-42",
          strategyId: "DEMO-0001",
          strategyVersion: 1,
          sourceType: "DEMO_ONLY",
          instrument: "BTC",
          side: "BUY",
          quantity: 50,
          entryPrice: 50_100,
          entryTimestamp: "2026-01-01T00:00:00.000Z",
          entryOrderId: "order-1",
        },
      }),
    });

    expect(run.executedTrade).toBe(true);
    expect(run.tradeId).toBe("etoro-position-42");
    expect(events.map((e) => e.eventType)).toContain("EXECUTION_COMPLETED");
    expect(events.map((e) => e.eventType)).not.toContain("EXECUTION_SKIPPED");
  });

  it("falls back to result.trade.tradeId for a closed SELL", () => {
    const { run } = buildAnalysisRecord({
      ...BASE_INPUT,
      kind: "success",
      snapshot: makeSnapshot(),
      context: makeContext({ trend: "Bearish", positionOpen: true }),
      result: makeResult({
        decision: { action: "SELL", confidence: 0.7, reasoning: ["Trend turned Bearish"] },
        executed: true,
        trade: {
          tradeId: "etoro-trade-7",
          positionId: "etoro-position-42",
          strategyId: "DEMO-0001",
          strategyVersion: 1,
          sourceType: "DEMO_ONLY",
          instrument: "BTC",
          side: "BUY",
          quantity: 50,
          entryPrice: 50_000,
          entryTimestamp: "2026-01-01T00:00:00.000Z",
          entryOrderId: "order-1",
          exitPrice: 50_100,
          exitTimestamp: "2026-01-01T01:00:00.000Z",
          exitOrderId: "order-2",
          realisedPnl: 0.1,
          closeReason: "market-decision-sell",
        },
      }),
    });
    expect(run.tradeId).toBe("etoro-trade-7");
  });

  it("records blockedReasons in metadata for a risk-blocked BUY, without marking executedTrade", () => {
    const { run, events } = buildAnalysisRecord({
      ...BASE_INPUT,
      kind: "success",
      snapshot: makeSnapshot(),
      context: makeContext(),
      result: makeResult({
        decision: { action: "BUY", confidence: 0.7, reasoning: ["EMA20 above EMA50"] },
        executed: false,
        blockedReasons: ["Daily trade limit reached"],
      }),
    });
    expect(run.executedTrade).toBe(false);
    expect(run.metadata?.blockedReasons).toEqual(["Daily trade limit reached"]);
    const skipEvent = events.find((e) => e.eventType === "EXECUTION_SKIPPED");
    expect(skipEvent?.message).toMatch(/blocked by portfolio risk/i);
  });
});

describe("buildAnalysisRecord — failure", () => {
  it("sets decision:'ERROR', executedTrade:false, validationOk:false, and captures the error message", () => {
    const { run } = buildAnalysisRecord({
      ...BASE_INPUT,
      kind: "failure",
      error: new Error("eToro connection refused"),
    });
    expect(run.decision).toBe("ERROR");
    expect(run.executedTrade).toBe(false);
    expect(run.validationOk).toBe(false);
    expect(run.errorMessage).toBe("eToro connection refused");
  });

  it("prefers a typed error's own .reason as errorCode over the generic class name", () => {
    const error = new MarketDataProviderError("insufficient candles", "malformed-data");
    const { run } = buildAnalysisRecord({ ...BASE_INPUT, kind: "failure", error });
    expect(run.errorCode).toBe("malformed-data");
  });

  it("falls back to the error's class name when it has no .reason", () => {
    const { run } = buildAnalysisRecord({ ...BASE_INPUT, kind: "failure", error: new TypeError("boom") });
    expect(run.errorCode).toBe("TypeError");
  });

  it("falls back to UNKNOWN_ERROR for a non-Error throw", () => {
    const { run } = buildAnalysisRecord({ ...BASE_INPUT, kind: "failure", error: "a plain string throw" });
    expect(run.errorCode).toBe("UNKNOWN_ERROR");
    expect(run.errorMessage).toBe("a plain string throw");
  });

  it("produces exactly CYCLE_STARTED and ERROR events", () => {
    const { events } = buildAnalysisRecord({ ...BASE_INPUT, kind: "failure", error: new Error("boom") });
    expect(events.map((e) => e.eventType)).toEqual(["CYCLE_STARTED", "ERROR"]);
    expect(events[1]?.severity).toBe("error");
  });

  it("never calls MarketDecisionEngine, the broker, or any execution method — it only reads the caught error", () => {
    // Structural guarantee, not a spy: buildAnalysisRecord's failure path takes only
    // {trigger, runtimeMode, brokerProvider, marketProvider, timeframe, strategyId,
    // strategyVersion, instrument, error, runtimeDurationMs} — there is no broker/engine reference
    // anywhere in its input type, so it is impossible for this call to reach one.
    expect(() => buildAnalysisRecord({ ...BASE_INPUT, kind: "failure", error: new Error("boom") })).not.toThrow();
  });
});
