import { describe, expect, it, vi } from "vitest";
import { runMarketDecisionCycle, type MarketDecisionCycleInput } from "@/lib/hermes-execution/market-decision-runner";
import type { MarketDecisionContext } from "@/lib/hermes-execution/market-decision-engine";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { PaperBroker } from "@/lib/hermes-execution/paper-broker";
import type { Account, CompletedTrade, OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";

const PERMISSIVE_RISK_CONFIG: PortfolioRiskConfig = {
  portfolioMaxOpenPositions: 5,
  maxDailyTrades: 5,
  maxPortfolioExposure: 10_000,
};

function makePortfolioRisk(
  overrides: Partial<MarketDecisionCycleInput["portfolioRisk"]> = {},
): MarketDecisionCycleInput["portfolioRisk"] {
  return {
    config: PERMISSIVE_RISK_CONFIG,
    dailyTradeCount: 0,
    brokerAvailable: true,
    ...overrides,
  };
}

function makeMarketContext(overrides: Partial<MarketDecisionContext> = {}): MarketDecisionContext {
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

function makeMockBroker(openPositions: PaperPosition[] = []): PaperBroker & {
  placeMarketOrder: ReturnType<typeof vi.fn>;
  closePosition: ReturnType<typeof vi.fn>;
} {
  // Large enough that a BUY of quantity 50 @ ~100.05 (order value ~5002.50) always passes the
  // sufficient-cash risk check by default — tests that specifically exercise that check override
  // getAccount() explicitly (see "BUY blocked by insufficient cash" below).
  const account: Account = { cashBalance: 100_000, startingCashBalance: 100_000 };
  const completedTrades: CompletedTrade[] = [];

  return {
    getAccount: () => account,
    getOpenPositions: () => openPositions,
    getCompletedTrades: () => completedTrades,
    placeMarketOrder: vi.fn(async (order: OrderRequest) => ({
      position: {
        positionId: "mock-position-1",
        strategyId: order.strategyId,
        strategyVersion: order.strategyVersion,
        sourceType: order.sourceType,
        instrument: order.instrument,
        side: order.side,
        quantity: order.quantity,
        entryPrice: order.price,
        entryTimestamp: order.timestamp,
        entryOrderId: "mock-order-1",
      } satisfies PaperPosition,
      orderId: "mock-order-1",
    })),
    closePosition: vi.fn(async (positionId: string, exitPrice: number, exitTimestamp: string, closeReason: string) => ({
      trade: {
        tradeId: "mock-trade-1",
        positionId,
        strategyId: "DEMO-0001",
        strategyVersion: 1,
        sourceType: "HERMES_APPROVED",
        instrument: "BTC",
        side: "BUY",
        quantity: 50,
        entryPrice: 100,
        entryTimestamp: "2026-01-01T00:00:00Z",
        entryOrderId: "mock-order-1",
        exitPrice,
        exitTimestamp,
        exitOrderId: "mock-close-1",
        realisedPnl: exitPrice - 100,
        closeReason,
      } satisfies CompletedTrade,
      orderId: "mock-close-1",
    })),
  };
}

describe("runMarketDecisionCycle — BUY (execution triggered)", () => {
  it("calls placeMarketOrder and records MARKET_DECISION_RECEIVED then EXECUTION_TRIGGERED", async () => {
    const broker = makeMockBroker([]);
    const auditTrail = new InMemoryAuditTrail();

    const result = await runMarketDecisionCycle({
      broker,
      auditTrail,
      executionRunId: "test-run",
      marketContext: makeMarketContext(),
      amount: 50,
      portfolioRisk: makePortfolioRisk(),
    });

    expect(result.decision.action).toBe("BUY");
    expect(result.executed).toBe(true);
    expect(result.position).toBeDefined();
    expect(result.blockedReasons).toBeUndefined();
    expect(broker.placeMarketOrder).toHaveBeenCalledOnce();
    expect(broker.placeMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ instrument: "BTC", side: "BUY", quantity: 50, price: 100.05 }),
    );
    expect(broker.closePosition).not.toHaveBeenCalled();

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual([
      "MARKET_DECISION_RECEIVED",
      "RISK_CHECK_STARTED",
      "RISK_CHECK_PASSED",
      "EXECUTION_TRIGGERED",
    ]);
    expect(events[0]?.details).toMatchObject({ action: "BUY", trend: "Bullish", rsi14: 55 });
    expect(events[0]?.details.confidence).toBeTypeOf("number");
    expect(Array.isArray(events[0]?.details.reasoning)).toBe(true);
    expect(events[0]?.details.emaRelationship).toBe("EMA20>EMA50");
  });
});

describe("runMarketDecisionCycle — BUY blocked by open position limit (converted to no-trade)", () => {
  it("does not call placeMarketOrder and records RISK_CHECK_FAILED then EXECUTION_SKIPPED", async () => {
    const existingPositions: PaperPosition[] = [
      {
        positionId: "existing-1",
        strategyId: "DEMO-0001",
        strategyVersion: 1,
        sourceType: "HERMES_APPROVED",
        instrument: "ETH",
        side: "BUY",
        quantity: 1,
        entryPrice: 100,
        entryTimestamp: "2026-01-01T00:00:00Z",
        entryOrderId: "prior-order-1",
      },
    ];
    const broker = makeMockBroker(existingPositions);
    const auditTrail = new InMemoryAuditTrail();

    const result = await runMarketDecisionCycle({
      broker,
      auditTrail,
      executionRunId: "test-run",
      marketContext: makeMarketContext(),
      amount: 50,
      portfolioRisk: makePortfolioRisk({ config: { ...PERMISSIVE_RISK_CONFIG, portfolioMaxOpenPositions: 1 } }),
    });

    expect(result.decision.action).toBe("BUY");
    expect(result.executed).toBe(false);
    expect(result.blockedReasons?.some((r) => /open position/i.test(r))).toBe(true);
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual([
      "MARKET_DECISION_RECEIVED",
      "RISK_CHECK_STARTED",
      "RISK_CHECK_FAILED",
      "EXECUTION_SKIPPED",
    ]);
    expect(events[2]?.details.blockedReasons).toEqual(result.blockedReasons);
    expect(events[3]?.details).toMatchObject({ action: "NO_TRADE", originalAction: "BUY" });
  });
});

describe("runMarketDecisionCycle — BUY blocked by insufficient cash (converted to no-trade)", () => {
  it("does not call placeMarketOrder and records RISK_CHECK_FAILED then EXECUTION_SKIPPED", async () => {
    const broker = makeMockBroker([]);
    broker.getAccount = () => ({ cashBalance: 10, startingCashBalance: 1000 });
    const auditTrail = new InMemoryAuditTrail();

    // amount 50 * price 100.05 (the ask) = 5002.50, far beyond the mocked cashBalance of 10.
    const result = await runMarketDecisionCycle({
      broker,
      auditTrail,
      executionRunId: "test-run",
      marketContext: makeMarketContext(),
      amount: 50,
      portfolioRisk: makePortfolioRisk(),
    });

    expect(result.decision.action).toBe("BUY");
    expect(result.executed).toBe(false);
    expect(result.blockedReasons?.some((r) => /exceeds available cash/i.test(r))).toBe(true);
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual([
      "MARKET_DECISION_RECEIVED",
      "RISK_CHECK_STARTED",
      "RISK_CHECK_FAILED",
      "EXECUTION_SKIPPED",
    ]);
  });
});

describe("runMarketDecisionCycle — SELL (execution triggered)", () => {
  it("calls closePosition on the existing open position and records the decision + trigger", async () => {
    const openPosition: PaperPosition = {
      positionId: "existing-position-1",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "BTC",
      side: "BUY",
      quantity: 50,
      entryPrice: 90,
      entryTimestamp: "2025-12-31T00:00:00Z",
      entryOrderId: "prior-order-1",
    };
    const broker = makeMockBroker([openPosition]);
    const auditTrail = new InMemoryAuditTrail();

    const result = await runMarketDecisionCycle({
      broker,
      auditTrail,
      executionRunId: "test-run",
      marketContext: makeMarketContext({ positionOpen: true, trend: "Bearish", ema20: 90, ema50: 100 }),
      amount: 50,
      // Deliberately a risk config that would block a BUY (zero open positions allowed) — proves
      // SELL is never risk-gated, per the milestone's own "SELL still permitted" requirement.
      portfolioRisk: makePortfolioRisk({ config: { ...PERMISSIVE_RISK_CONFIG, portfolioMaxOpenPositions: 0 } }),
    });

    expect(result.decision.action).toBe("SELL");
    expect(result.executed).toBe(true);
    expect(result.trade).toBeDefined();
    expect(result.blockedReasons).toBeUndefined();
    expect(broker.closePosition).toHaveBeenCalledOnce();
    expect(broker.closePosition).toHaveBeenCalledWith("existing-position-1", 100, "2026-01-01T00:00:00Z", "market-decision-sell");
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["MARKET_DECISION_RECEIVED", "EXECUTION_TRIGGERED"]);
    expect(events[0]?.details).toMatchObject({ action: "SELL", trend: "Bearish" });
  });
});

describe("runMarketDecisionCycle — HOLD (execution skipped)", () => {
  it("calls neither placeMarketOrder nor closePosition, and records EXECUTION_SKIPPED instead of EXECUTION_TRIGGERED", async () => {
    const broker = makeMockBroker([]);
    const auditTrail = new InMemoryAuditTrail();

    const result = await runMarketDecisionCycle({
      broker,
      auditTrail,
      executionRunId: "test-run",
      marketContext: makeMarketContext({ rsi14: 90 }), // overbought — outside the 45-65 entry band
      amount: 50,
      portfolioRisk: makePortfolioRisk(),
    });

    expect(result.decision.action).toBe("HOLD");
    expect(result.executed).toBe(false);
    expect(result.position).toBeUndefined();
    expect(result.trade).toBeUndefined();
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
    expect(broker.closePosition).not.toHaveBeenCalled();

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["MARKET_DECISION_RECEIVED", "EXECUTION_SKIPPED"]);
    expect(events[1]?.details).toMatchObject({ action: "HOLD" });
  });
});

describe("runMarketDecisionCycle — does not duplicate existing execution audit", () => {
  it("only ever records its own two new event types, never re-emitting broker-level events itself", async () => {
    const broker = makeMockBroker([]);
    const auditTrail = new InMemoryAuditTrail();

    await runMarketDecisionCycle({
      broker,
      auditTrail,
      executionRunId: "test-run",
      marketContext: makeMarketContext(),
      amount: 50,
      portfolioRisk: makePortfolioRisk(),
    });

    const events = await auditTrail.getEvents();
    const eventTypes = new Set(events.map((e) => e.eventType));
    expect(eventTypes).toEqual(
      new Set(["MARKET_DECISION_RECEIVED", "RISK_CHECK_STARTED", "RISK_CHECK_PASSED", "EXECUTION_TRIGGERED"]),
    );
    // ORDER_SUBMITTED / POSITION_OPENED etc. are the mock broker's own responsibility (a real
    // broker emits them from inside placeMarketOrder/closePosition) — this runner must never emit
    // them itself.
    expect(eventTypes.has("ORDER_SUBMITTED")).toBe(false);
    expect(eventTypes.has("POSITION_OPENED")).toBe(false);
  });
});
