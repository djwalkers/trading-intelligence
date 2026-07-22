import { describe, expect, it } from "vitest";
import {
  deriveObservedRuntimeState,
  latestFailureOrWarning,
  listDecisions,
  sumRealisedPnlSinceLastStart,
} from "@/lib/hermes-integration/audit-derivations";
import type { AuditEvent, AuditEventType } from "@/lib/hermes-execution/types";

function event(eventType: AuditEventType, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    eventType,
    executionRunId: "test-run",
    details: {},
    ...overrides,
  };
}

describe("deriveObservedRuntimeState", () => {
  it("returns state 'unknown' and all-zero counts for an empty event list", () => {
    expect(deriveObservedRuntimeState([])).toEqual({
      state: "unknown",
      startedAt: null,
      lastRunAt: null,
      successfulRunCount: 0,
      failedRunCount: 0,
      skippedOverlapCount: 0,
      lastError: null,
    });
  });

  it("reports RUNNING with startedAt after a TRADING_RUNTIME_STARTED event", () => {
    const events = [event("TRADING_RUNTIME_STARTED", { timestamp: "2026-01-01T00:00:00.000Z", details: { intervalMs: 60000 } })];
    const result = deriveObservedRuntimeState(events);
    expect(result.state).toBe("RUNNING");
    expect(result.startedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("reports STOPPED after a later TRADING_RUNTIME_STOPPED event", () => {
    const events = [
      event("TRADING_RUNTIME_STARTED", { timestamp: "2026-01-01T00:00:00.000Z" }),
      event("TRADING_RUNTIME_STOPPED", { timestamp: "2026-01-01T01:00:00.000Z" }),
    ];
    expect(deriveObservedRuntimeState(events).state).toBe("STOPPED");
  });

  it("reports PAUSED then RUNNING again after resume", () => {
    const events = [
      event("TRADING_RUNTIME_STARTED", { timestamp: "2026-01-01T00:00:00.000Z" }),
      event("TRADING_RUNTIME_PAUSED", { timestamp: "2026-01-01T00:10:00.000Z" }),
    ];
    expect(deriveObservedRuntimeState(events).state).toBe("PAUSED");

    events.push(event("TRADING_RUNTIME_RESUMED", { timestamp: "2026-01-01T00:20:00.000Z" }));
    expect(deriveObservedRuntimeState(events).state).toBe("RUNNING");
  });

  it("counts successful/failed/skipped-overlap cycles only since the most recent start", () => {
    const events = [
      event("TRADING_RUNTIME_STARTED", { timestamp: "2026-01-01T00:00:00.000Z" }),
      event("TRADING_CYCLE_COMPLETED", { timestamp: "2026-01-01T00:01:00.000Z" }),
      event("TRADING_CYCLE_FAILED", { timestamp: "2026-01-01T00:02:00.000Z", details: { message: "boom" } }),
      event("TRADING_CYCLE_SKIPPED_OVERLAP", { timestamp: "2026-01-01T00:03:00.000Z" }),
      event("TRADING_RUNTIME_STOPPED", { timestamp: "2026-01-01T00:04:00.000Z" }),
      event("TRADING_RUNTIME_STARTED", { timestamp: "2026-01-01T01:00:00.000Z" }),
      event("TRADING_CYCLE_COMPLETED", { timestamp: "2026-01-01T01:01:00.000Z" }),
    ];
    const result = deriveObservedRuntimeState(events);
    // Only the second run's own single TRADING_CYCLE_COMPLETED should be counted.
    expect(result.successfulRunCount).toBe(1);
    expect(result.failedRunCount).toBe(0);
    expect(result.skippedOverlapCount).toBe(0);
    expect(result.lastError).toBeNull();
    expect(result.lastRunAt).toBe("2026-01-01T01:01:00.000Z");
  });

  it("reports the most recent failure's message and timestamp", () => {
    const events = [
      event("TRADING_RUNTIME_STARTED", { timestamp: "2026-01-01T00:00:00.000Z" }),
      event("TRADING_CYCLE_FAILED", { timestamp: "2026-01-01T00:05:00.000Z", details: { message: "broker unreachable" } }),
    ];
    const result = deriveObservedRuntimeState(events);
    expect(result.lastError).toEqual({ message: "broker unreachable", occurredAt: "2026-01-01T00:05:00.000Z" });
  });
});

describe("sumRealisedPnlSinceLastStart", () => {
  it("returns null when there are no closed trades", () => {
    expect(sumRealisedPnlSinceLastStart([])).toBeNull();
    expect(sumRealisedPnlSinceLastStart([event("TRADING_RUNTIME_STARTED")])).toBeNull();
  });

  it("sums realisedPnl across TRADE_CLOSED events since the last start", () => {
    const events = [
      event("TRADING_RUNTIME_STARTED", { timestamp: "2026-01-01T00:00:00.000Z" }),
      event("TRADE_CLOSED", { details: { realisedPnl: 10 } }),
      event("TRADE_CLOSED", { details: { realisedPnl: -4 } }),
    ];
    expect(sumRealisedPnlSinceLastStart(events)).toBe(6);
  });

  it("ignores TRADE_CLOSED events from before the most recent start", () => {
    const events = [
      event("TRADE_CLOSED", { details: { realisedPnl: 999 } }),
      event("TRADING_RUNTIME_STARTED", { timestamp: "2026-01-02T00:00:00.000Z" }),
      event("TRADE_CLOSED", { details: { realisedPnl: 5 } }),
    ];
    expect(sumRealisedPnlSinceLastStart(events)).toBe(5);
  });
});

describe("latestFailureOrWarning", () => {
  it("returns null when no failure-worthy event exists", () => {
    expect(latestFailureOrWarning([event("TRADING_CYCLE_COMPLETED")])).toBeNull();
  });

  it("returns the most recent matching failure event", () => {
    const events = [
      event("TRADING_CYCLE_FAILED", { timestamp: "2026-01-01T00:00:00.000Z", details: { message: "first" } }),
      event("BROKER_CONNECTION_FAILED", { timestamp: "2026-01-01T01:00:00.000Z", details: { reason: "second" }, instrument: "BTC" }),
    ];
    expect(latestFailureOrWarning(events)).toEqual({
      eventType: "BROKER_CONNECTION_FAILED",
      timestamp: "2026-01-01T01:00:00.000Z",
      instrument: "BTC",
      message: "second",
    });
  });

  it("summarises TRADE_RISK_REJECTED using blockedReasons when no message field is present", () => {
    const events = [event("TRADE_RISK_REJECTED", { details: { blockedReasons: ["max exposure", "daily limit"] } })];
    expect(latestFailureOrWarning(events)?.message).toBe("max exposure; daily limit");
  });
});

const MARKET_SNAPSHOT_DETAILS = { action: "BUY", confidence: 0.8, reasoning: ["EMA20 above EMA50"], trend: "Bullish", rsi14: 61.2 };

describe("listDecisions", () => {
  it("maps a MARKET_DECISION_RECEIVED event into a decision DTO", () => {
    const events = [
      event("MARKET_DECISION_RECEIVED", {
        timestamp: "2026-01-01T00:00:00.000Z",
        instrument: "BTC",
        strategyId: "STRAT-0001",
        details: MARKET_SNAPSHOT_DETAILS,
      }),
    ];
    const [decision] = listDecisions(events, { limit: 20 });
    expect(decision).toMatchObject({
      timestamp: "2026-01-01T00:00:00.000Z",
      symbol: "BTC",
      outcome: "BUY",
      confidence: 0.8,
      reasons: ["EMA20 above EMA50"],
      strategy: "STRAT-0001",
      marketSnapshot: { trend: "Bullish", rsi14: 61.2 },
    });
    expect(decision!.marketSnapshot).not.toHaveProperty("action");
    expect(decision!.marketSnapshot).not.toHaveProperty("confidence");
    expect(decision!.marketSnapshot).not.toHaveProperty("reasoning");
  });

  it("derives executionResult HOLD for a HOLD decision", () => {
    const events = [event("MARKET_DECISION_RECEIVED", { instrument: "BTC", details: { action: "HOLD", confidence: 0.5, reasoning: [] } })];
    expect(listDecisions(events, { limit: 20 })[0]!.executionResult).toEqual({ executed: false, status: "HOLD" });
  });

  it("derives executionResult OPENED for a BUY followed by TRADE_OPENED", () => {
    const events = [
      event("MARKET_DECISION_RECEIVED", { instrument: "BTC", details: MARKET_SNAPSHOT_DETAILS }),
      event("TRADE_OPENED", { instrument: "BTC", details: { entryPrice: 100 } }),
    ];
    expect(listDecisions(events, { limit: 20 })[0]!.executionResult).toEqual({ executed: true, status: "OPENED" });
  });

  it("derives executionResult CLOSED with realisedPnl for a SELL followed by TRADE_CLOSED", () => {
    const events = [
      event("MARKET_DECISION_RECEIVED", { instrument: "BTC", details: { action: "SELL", confidence: 0.6, reasoning: [] } }),
      event("TRADE_CLOSED", { instrument: "BTC", details: { realisedPnl: 12.5 } }),
    ];
    expect(listDecisions(events, { limit: 20 })[0]!.executionResult).toEqual({ executed: true, status: "CLOSED", realisedPnl: 12.5 });
  });

  it("derives executionResult RISK_REJECTED", () => {
    const events = [
      event("MARKET_DECISION_RECEIVED", { instrument: "BTC", details: MARKET_SNAPSHOT_DETAILS }),
      event("TRADE_RISK_REJECTED", { instrument: "BTC", details: { blockedReasons: ["daily limit"] } }),
    ];
    expect(listDecisions(events, { limit: 20 })[0]!.executionResult.status).toBe("RISK_REJECTED");
  });

  it("filters by symbol", () => {
    const events = [
      event("MARKET_DECISION_RECEIVED", { instrument: "BTC", details: MARKET_SNAPSHOT_DETAILS }),
      event("MARKET_DECISION_RECEIVED", { instrument: "ETH", details: MARKET_SNAPSHOT_DETAILS }),
    ];
    const decisions = listDecisions(events, { limit: 20, symbol: "ETH" });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.symbol).toBe("ETH");
  });

  it("filters by outcome", () => {
    const events = [
      event("MARKET_DECISION_RECEIVED", { instrument: "BTC", details: { action: "BUY", confidence: 0.7, reasoning: [] } }),
      event("MARKET_DECISION_RECEIVED", { instrument: "BTC", details: { action: "HOLD", confidence: 0.5, reasoning: [] } }),
    ];
    const decisions = listDecisions(events, { limit: 20, outcome: "HOLD" });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.outcome).toBe("HOLD");
  });

  it("filters by since (inclusive lower bound)", () => {
    const events = [
      event("MARKET_DECISION_RECEIVED", { timestamp: "2026-01-01T00:00:00.000Z", instrument: "BTC", details: MARKET_SNAPSHOT_DETAILS }),
      event("MARKET_DECISION_RECEIVED", { timestamp: "2026-01-02T00:00:00.000Z", instrument: "BTC", details: MARKET_SNAPSHOT_DETAILS }),
    ];
    const decisions = listDecisions(events, { limit: 20, since: "2026-01-02T00:00:00.000Z" });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.timestamp).toBe("2026-01-02T00:00:00.000Z");
  });

  it("returns newest first", () => {
    const events = [
      event("MARKET_DECISION_RECEIVED", { timestamp: "2026-01-01T00:00:00.000Z", instrument: "BTC", details: MARKET_SNAPSHOT_DETAILS }),
      event("MARKET_DECISION_RECEIVED", { timestamp: "2026-01-03T00:00:00.000Z", instrument: "BTC", details: MARKET_SNAPSHOT_DETAILS }),
      event("MARKET_DECISION_RECEIVED", { timestamp: "2026-01-02T00:00:00.000Z", instrument: "BTC", details: MARKET_SNAPSHOT_DETAILS }),
    ];
    const timestamps = listDecisions(events, { limit: 20 }).map((d) => d.timestamp);
    expect(timestamps).toEqual(["2026-01-03T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
  });

  it("respects the limit", () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      event("MARKET_DECISION_RECEIVED", {
        timestamp: `2026-01-0${i + 1}T00:00:00.000Z`,
        instrument: "BTC",
        details: MARKET_SNAPSHOT_DETAILS,
      }),
    );
    expect(listDecisions(events, { limit: 2 })).toHaveLength(2);
  });
});
