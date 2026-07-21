import { describe, expect, it, vi } from "vitest";
import { runMarketDecisionCycleWithLifecycle } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-runner";
import { TradeLifecycleService } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-service";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { MarketDecisionContext } from "@/lib/hermes-execution/market-decision-engine";
import type { MarketDataSnapshot } from "@/lib/hermes-execution/market-data/market-data-provider";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";
import type { PaperBroker } from "@/lib/hermes-execution/paper-broker";
import type { Account, CompletedTrade, OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";

const PERMISSIVE_RISK_CONFIG: PortfolioRiskConfig = {
  portfolioMaxOpenPositions: 5,
  maxDailyTrades: 5,
  maxPortfolioExposure: 100_000,
};

function makeMarketContext(overrides: Partial<MarketDecisionContext> = {}): MarketDecisionContext {
  return {
    instrument: "BTC",
    bid: 100,
    ask: 100.05,
    spread: 0.05,
    midPrice: 100.025,
    timestamp: "2026-01-01T00:00:00.000Z",
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

const MARKET_DATA_SNAPSHOT: MarketDataSnapshot = {
  instrument: "BTC",
  timestamp: "2026-01-01T00:00:00.000Z",
  candles: [],
  bid: 100,
  ask: 100.05,
  spread: 0.05,
  latestPrice: 100.025,
  volume: 120,
};

function makeMockBroker(openPositions: PaperPosition[] = []): PaperBroker & {
  placeMarketOrder: ReturnType<typeof vi.fn>;
  closePosition: ReturnType<typeof vi.fn>;
} {
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
        strategyId: "STRAT-0001",
        strategyVersion: 1,
        sourceType: "HERMES_APPROVED",
        instrument: "BTC",
        side: "BUY",
        quantity: 50,
        entryPrice: 100,
        entryTimestamp: "2026-01-01T00:00:00.000Z",
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

function makeLifecycle() {
  const store = new InMemoryTradeLifecycleStore();
  const service = new TradeLifecycleService({ store, auditTrail: new InMemoryAuditTrail(), executionRunId: "test-run" });
  return { store, service };
}

describe("runMarketDecisionCycleWithLifecycle — BUY, approved and executed", () => {
  it("drives DECISION_CREATED -> APPROVED -> EXECUTION_SUBMITTED -> OPEN and still calls the real broker", async () => {
    const broker = makeMockBroker([]);
    const auditTrail = new InMemoryAuditTrail();
    const { service } = makeLifecycle();

    const result = await runMarketDecisionCycleWithLifecycle({
      broker,
      auditTrail,
      executionRunId: "test-run",
      marketContext: makeMarketContext(),
      amount: 50,
      portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
      lifecycleService: service,
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
    });

    expect(result.decision.action).toBe("BUY");
    expect(result.executed).toBe(true);
    expect(broker.placeMarketOrder).toHaveBeenCalledOnce();

    expect(result.lifecycleRecord).toBeDefined();
    expect(result.lifecycleRecord!.status).toBe("OPEN");
    expect(result.lifecycleRecord!.entryPrice).toBe(result.position!.entryPrice);
    expect(result.lifecycleRecord!.brokerOrderId).toBe(result.orderId);
    expect(result.lifecycleRecord!.portfolioRiskDecision?.permitted).toBe(true);

    const stored = await service.findOpenRecord("STRAT-0001", "BTC");
    expect(stored?.id).toBe(result.lifecycleRecord!.id);
  });

  it("pre-computed decision always matches the runner's own returned decision", async () => {
    const broker = makeMockBroker([]);
    const { service } = makeLifecycle();
    const context = makeMarketContext();

    const result = await runMarketDecisionCycleWithLifecycle({
      broker,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      marketContext: context,
      amount: 50,
      portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
      lifecycleService: service,
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
    });

    expect(result.lifecycleRecord!.decision).toBe(result.decision.action);
    expect(result.lifecycleRecord!.confidence).toBe(result.decision.confidence);
  });
});

describe("runMarketDecisionCycleWithLifecycle — BUY, blocked by portfolio risk", () => {
  it("drives DECISION_CREATED -> RISK_REJECTED without calling placeMarketOrder", async () => {
    const broker = makeMockBroker([]);
    const { service } = makeLifecycle();
    const blockingConfig: PortfolioRiskConfig = { ...PERMISSIVE_RISK_CONFIG, portfolioMaxOpenPositions: 0 };

    const result = await runMarketDecisionCycleWithLifecycle({
      broker,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      marketContext: makeMarketContext(),
      amount: 50,
      portfolioRisk: { config: blockingConfig, dailyTradeCount: 0, brokerAvailable: true },
      lifecycleService: service,
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
    });

    expect(result.executed).toBe(false);
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
    expect(result.lifecycleRecord!.status).toBe("RISK_REJECTED");
    expect(result.lifecycleRecord!.portfolioRiskDecision?.permitted).toBe(false);
  });
});

describe("runMarketDecisionCycleWithLifecycle — BUY, broker execution fails", () => {
  it("drives APPROVED -> EXECUTION_SUBMITTED -> EXECUTION_FAILED and rethrows the original error", async () => {
    const broker = makeMockBroker([]);
    broker.placeMarketOrder.mockRejectedValueOnce(new Error("connection reset"));
    const { service } = makeLifecycle();

    await expect(
      runMarketDecisionCycleWithLifecycle({
        broker,
        auditTrail: new InMemoryAuditTrail(),
        executionRunId: "test-run",
        marketContext: makeMarketContext(),
        amount: 50,
        portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
        lifecycleService: service,
        marketDataSnapshot: MARKET_DATA_SNAPSHOT,
      }),
    ).rejects.toThrow("connection reset");

    const all = await service.findOpenRecord("STRAT-0001", "BTC");
    expect(all).toBeUndefined(); // never reached OPEN

    const records = await new InMemoryTradeLifecycleStore().list(); // sanity: separate store stays empty
    expect(records).toEqual([]);
  });

  it("the failed record itself ends in EXECUTION_FAILED with error details", async () => {
    const broker = makeMockBroker([]);
    broker.placeMarketOrder.mockRejectedValueOnce(new Error("connection reset"));
    const { service, store } = makeLifecycle();

    await expect(
      runMarketDecisionCycleWithLifecycle({
        broker,
        auditTrail: new InMemoryAuditTrail(),
        executionRunId: "test-run",
        marketContext: makeMarketContext(),
        amount: 50,
        portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
        lifecycleService: service,
        marketDataSnapshot: MARKET_DATA_SNAPSHOT,
      }),
    ).rejects.toThrow();

    const [record] = await store.list();
    expect(record?.status).toBe("EXECUTION_FAILED");
    expect(record?.error?.message).toBe("connection reset");
  });
});

describe("runMarketDecisionCycleWithLifecycle — SELL, closes the tracked open position", () => {
  async function openPositionAndRecord(broker: ReturnType<typeof makeMockBroker>, service: TradeLifecycleService) {
    return runMarketDecisionCycleWithLifecycle({
      broker,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      marketContext: makeMarketContext(),
      amount: 50,
      portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
      lifecycleService: service,
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
    });
  }

  it("drives OPEN -> CLOSE_REQUESTED -> CLOSED and computes realised P/L", async () => {
    const openPosition: PaperPosition = {
      positionId: "existing-position-1",
      strategyId: "STRAT-0001",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "BTC",
      side: "BUY",
      quantity: 50,
      entryPrice: 90,
      entryTimestamp: "2025-12-31T00:00:00.000Z",
      entryOrderId: "prior-order-1",
    };
    const broker = makeMockBroker([openPosition]);
    const { service } = makeLifecycle();

    // Seed a matching OPEN lifecycle record the way a prior BUY cycle would have produced one.
    let record = await service.createFromDecision({
      strategyId: "STRAT-0001",
      symbol: "BTC",
      side: "BUY",
      quantity: 50,
      decision: { action: "BUY", confidence: 0.7, reasoning: ["seed"] },
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
      intelligenceSummary: makeMarketContext(),
    });
    record = await service.recordApproved(record, {
      permitted: true,
      checks: [],
      accountEquity: 100_000,
      portfolioExposure: 0,
    });
    record = await service.recordExecutionSubmitted(record);
    record = await service.recordOpened(record, {
      entryPrice: 90,
      brokerOrderId: "prior-order-1",
      openedAt: "2025-12-31T00:00:00.000Z",
    });

    const result = await runMarketDecisionCycleWithLifecycle({
      broker,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      marketContext: makeMarketContext({ positionOpen: true, trend: "Bearish", ema20: 90, ema50: 100 }),
      amount: 50,
      portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
      lifecycleService: service,
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
    });

    expect(result.decision.action).toBe("SELL");
    expect(broker.closePosition).toHaveBeenCalledOnce();
    expect(result.lifecycleRecord!.id).toBe(record.id);
    expect(result.lifecycleRecord!.status).toBe("CLOSED");
    expect(result.lifecycleRecord!.exitPrice).toBe(result.trade!.exitPrice);
    expect(result.lifecycleRecord!.realisedPnl).toBeCloseTo((result.trade!.exitPrice - 90) * 50, 10);
    expect(result.lifecycleRecord!.exitReason).toBe(result.trade!.closeReason);
  });

  it("falls back to the plain cycle (no lifecycle record) when no matching open record exists", async () => {
    const openPosition: PaperPosition = {
      positionId: "existing-position-1",
      strategyId: "STRAT-0001",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "BTC",
      side: "BUY",
      quantity: 50,
      entryPrice: 90,
      entryTimestamp: "2025-12-31T00:00:00.000Z",
      entryOrderId: "prior-order-1",
    };
    const broker = makeMockBroker([openPosition]);
    const { service } = makeLifecycle(); // no lifecycle record ever seeded

    const result = await runMarketDecisionCycleWithLifecycle({
      broker,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      marketContext: makeMarketContext({ positionOpen: true, trend: "Bearish", ema20: 90, ema50: 100 }),
      amount: 50,
      portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
      lifecycleService: service,
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
    });

    expect(result.decision.action).toBe("SELL");
    expect(broker.closePosition).toHaveBeenCalledOnce(); // the underlying pipeline still ran normally
    expect(result.lifecycleRecord).toBeUndefined();
  });

  it("on a broker close failure, transitions CLOSE_REQUESTED -> CLOSE_FAILED and rethrows", async () => {
    const openPosition: PaperPosition = {
      positionId: "existing-position-1",
      strategyId: "STRAT-0001",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "BTC",
      side: "BUY",
      quantity: 50,
      entryPrice: 90,
      entryTimestamp: "2025-12-31T00:00:00.000Z",
      entryOrderId: "prior-order-1",
    };
    const broker = makeMockBroker([openPosition]);
    broker.closePosition.mockRejectedValueOnce(new Error("close endpoint timed out"));
    const { service, store } = makeLifecycle();

    let record = await service.createFromDecision({
      strategyId: "STRAT-0001",
      symbol: "BTC",
      side: "BUY",
      quantity: 50,
      decision: { action: "BUY", confidence: 0.7, reasoning: ["seed"] },
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
      intelligenceSummary: makeMarketContext(),
    });
    record = await service.recordApproved(record, { permitted: true, checks: [], accountEquity: 100_000, portfolioExposure: 0 });
    record = await service.recordExecutionSubmitted(record);
    await service.recordOpened(record, { entryPrice: 90, brokerOrderId: "prior-order-1" });

    await expect(
      runMarketDecisionCycleWithLifecycle({
        broker,
        auditTrail: new InMemoryAuditTrail(),
        executionRunId: "test-run",
        marketContext: makeMarketContext({ positionOpen: true, trend: "Bearish", ema20: 90, ema50: 100 }),
        amount: 50,
        portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
        lifecycleService: service,
        marketDataSnapshot: MARKET_DATA_SNAPSHOT,
      }),
    ).rejects.toThrow("close endpoint timed out");

    const [stored] = await store.list();
    expect(stored?.status).toBe("CLOSE_FAILED");
    expect(stored?.error?.message).toBe("close endpoint timed out");
  });
});

describe("runMarketDecisionCycleWithLifecycle — HOLD", () => {
  it("creates no lifecycle record for a HOLD decision with no existing position", async () => {
    const broker = makeMockBroker([]);
    const { service, store } = makeLifecycle();

    const result = await runMarketDecisionCycleWithLifecycle({
      broker,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      marketContext: makeMarketContext({ rsi14: 90 }), // overbought, outside entry band -> HOLD
      amount: 50,
      portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
      lifecycleService: service,
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
    });

    expect(result.decision.action).toBe("HOLD");
    expect(result.lifecycleRecord).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("updates MFE/MAE on an existing open record even though this cycle's own decision is HOLD", async () => {
    const openPosition: PaperPosition = {
      positionId: "existing-position-1",
      strategyId: "STRAT-0001",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "BTC",
      side: "BUY",
      quantity: 50,
      entryPrice: 90,
      entryTimestamp: "2025-12-31T00:00:00.000Z",
      entryOrderId: "prior-order-1",
    };
    const broker = makeMockBroker([openPosition]);
    const { service } = makeLifecycle();

    let record = await service.createFromDecision({
      strategyId: "STRAT-0001",
      symbol: "BTC",
      side: "BUY",
      quantity: 50,
      decision: { action: "BUY", confidence: 0.7, reasoning: ["seed"] },
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
      intelligenceSummary: makeMarketContext(),
    });
    record = await service.recordApproved(record, { permitted: true, checks: [], accountEquity: 100_000, portfolioExposure: 0 });
    record = await service.recordExecutionSubmitted(record);
    await service.recordOpened(record, { entryPrice: 90, brokerOrderId: "prior-order-1" });

    // Bid 105, trend still Bullish and positionOpen true -> HOLD (per holdReasoning: an open
    // position in a non-Bearish trend is held, not sold).
    const result = await runMarketDecisionCycleWithLifecycle({
      broker,
      auditTrail: new InMemoryAuditTrail(),
      executionRunId: "test-run",
      marketContext: makeMarketContext({ positionOpen: true, bid: 105, ask: 105.05, trend: "Bullish" }),
      amount: 50,
      portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
      lifecycleService: service,
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
    });

    expect(result.decision.action).toBe("HOLD");
    const updated = await service.findOpenRecord("STRAT-0001", "BTC");
    expect(updated?.maximumFavourableExcursion).toBeCloseTo((105 - 90) * 50, 10);
  });
});
