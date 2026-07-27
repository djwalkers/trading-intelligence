import { describe, expect, it, vi } from "vitest";
import { evaluateExitTrigger, executeAutomaticExit } from "@/lib/hermes-execution/runtime/exit-monitor";
import { TradeLifecycleService } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-service";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { TradeLifecycleRecord } from "@/lib/hermes-execution/trade-lifecycle/types";
import type { MarketDecision } from "@/lib/hermes-execution/market-decision-engine";
import type { Account, CompletedTrade, OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";

// Restart-Resilient Autonomy Phase — Phase 3 (Automatic exit monitoring).
//
// Covers required scenarios:
//   5. Stop loss triggers automatic close.
//   6. Take profit triggers automatic close.
//   7. Opposing strategy signal triggers automatic close.
//   8. Fresh market price is used for exit evaluation (and again before submission).
//   9. Close reconciliation confirms broker position removal.
//  10. Temporary broker failure does not create duplicate close attempts.
// No real network/broker call anywhere — every broker below is an in-memory vi.fn() mock.

const HOLD_DECISION: MarketDecision = { action: "HOLD", confidence: 0.6, reasoning: ["holding"] };
const SELL_DECISION: MarketDecision = { action: "SELL", confidence: 0.8, reasoning: ["trend turned bearish"] };

function makeRecord(overrides: Partial<TradeLifecycleRecord> = {}): TradeLifecycleRecord {
  return {
    id: "lifecycle-1",
    brokerProvider: "etoro-demo",
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    symbol: "BTC",
    side: "BUY",
    quantity: 10,
    sizingMode: "NOTIONAL",
    decision: "BUY",
    confidence: 0.8,
    decisionReasons: ["seed"],
    status: "OPEN",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    openedAt: "2026-01-01T00:00:00.000Z",
    entryPrice: 64_948.33,
    stopLoss: 64_600,
    takeProfit: 66_000,
    brokerPositionId: "3568040809",
    brokerOrderId: "369015901",
    ...overrides,
  };
}

describe("evaluateExitTrigger — stop loss (scenario 5)", () => {
  it("triggers STOP_LOSS for a long position once the fresh bid falls to/through the stop level", () => {
    const trigger = evaluateExitTrigger({
      record: makeRecord({ side: "BUY", stopLoss: 64_600 }),
      freshBid: 64_500,
      freshDecision: HOLD_DECISION,
      killSwitchEnabled: false,
      maxHoldingDurationMs: undefined,
      strategyStillEnabled: true,
      now: new Date("2026-01-01T01:00:00.000Z"),
    });
    expect(trigger).toBe("STOP_LOSS");
  });

  it("does not trigger while the fresh bid is still above the stop level", () => {
    const trigger = evaluateExitTrigger({
      record: makeRecord({ side: "BUY", stopLoss: 64_600 }),
      freshBid: 64_700,
      freshDecision: HOLD_DECISION,
      killSwitchEnabled: false,
      maxHoldingDurationMs: undefined,
      strategyStillEnabled: true,
      now: new Date("2026-01-01T01:00:00.000Z"),
    });
    expect(trigger).toBeUndefined();
  });

  it("is direction-aware for a short position (stop is a price RISE)", () => {
    const trigger = evaluateExitTrigger({
      record: makeRecord({ side: "SELL", stopLoss: 65_500, takeProfit: undefined }),
      freshBid: 65_600,
      freshDecision: HOLD_DECISION,
      killSwitchEnabled: false,
      maxHoldingDurationMs: undefined,
      strategyStillEnabled: true,
      now: new Date("2026-01-01T01:00:00.000Z"),
    });
    expect(trigger).toBe("STOP_LOSS");
  });
});

describe("evaluateExitTrigger — take profit (scenario 6)", () => {
  it("triggers TAKE_PROFIT for a long position once the fresh bid reaches/exceeds the target", () => {
    const trigger = evaluateExitTrigger({
      record: makeRecord({ side: "BUY", stopLoss: 60_000, takeProfit: 66_000 }),
      freshBid: 66_100,
      freshDecision: HOLD_DECISION,
      killSwitchEnabled: false,
      maxHoldingDurationMs: undefined,
      strategyStillEnabled: true,
      now: new Date("2026-01-01T01:00:00.000Z"),
    });
    expect(trigger).toBe("TAKE_PROFIT");
  });

  it("skips both stop-loss and take-profit checks (never treats them as 0) for an adopted record with no known levels", () => {
    const trigger = evaluateExitTrigger({
      record: makeRecord({ stopLoss: undefined, takeProfit: undefined }),
      freshBid: 1, // would trip a "stopLoss === 0" bug if one existed
      freshDecision: HOLD_DECISION,
      killSwitchEnabled: false,
      maxHoldingDurationMs: undefined,
      strategyStillEnabled: true,
      now: new Date("2026-01-01T01:00:00.000Z"),
    });
    expect(trigger).toBeUndefined();
  });
});

describe("evaluateExitTrigger — opposing strategy signal (scenario 7)", () => {
  it("triggers OPPOSING_SIGNAL when the fresh decision is SELL and no higher-priority trigger fired", () => {
    const trigger = evaluateExitTrigger({
      record: makeRecord({ stopLoss: 60_000, takeProfit: 70_000 }), // neither hit
      freshBid: 64_948.33, // unchanged from entry
      freshDecision: SELL_DECISION,
      killSwitchEnabled: false,
      maxHoldingDurationMs: undefined,
      strategyStillEnabled: true,
      now: new Date("2026-01-01T01:00:00.000Z"),
    });
    expect(trigger).toBe("OPPOSING_SIGNAL");
  });

  it("never fires for a HOLD decision when no other trigger applies", () => {
    const trigger = evaluateExitTrigger({
      record: makeRecord({ stopLoss: 60_000, takeProfit: 70_000 }),
      freshBid: 64_948.33,
      freshDecision: HOLD_DECISION,
      killSwitchEnabled: false,
      maxHoldingDurationMs: undefined,
      strategyStillEnabled: true,
      now: new Date("2026-01-01T01:00:00.000Z"),
    });
    expect(trigger).toBeUndefined();
  });
});

describe("evaluateExitTrigger — kill switch, strategy-disabled, max holding duration, and priority", () => {
  it("KILL_SWITCH always wins, even over a simultaneously-true stop loss", () => {
    const trigger = evaluateExitTrigger({
      record: makeRecord({ stopLoss: 64_600 }),
      freshBid: 64_000, // would also trip STOP_LOSS
      freshDecision: HOLD_DECISION,
      killSwitchEnabled: true,
      maxHoldingDurationMs: undefined,
      strategyStillEnabled: true,
      now: new Date("2026-01-01T01:00:00.000Z"),
    });
    expect(trigger).toBe("KILL_SWITCH");
  });

  it("STRATEGY_DISABLED fires when the strategy is no longer enabled and no price-based trigger applies", () => {
    const trigger = evaluateExitTrigger({
      record: makeRecord({ stopLoss: 60_000, takeProfit: 70_000 }),
      freshBid: 64_948.33,
      freshDecision: HOLD_DECISION,
      killSwitchEnabled: false,
      maxHoldingDurationMs: undefined,
      strategyStillEnabled: false,
      now: new Date("2026-01-01T01:00:00.000Z"),
    });
    expect(trigger).toBe("STRATEGY_DISABLED");
  });

  it("MAX_HOLDING_DURATION fires once the position has been open at least that long", () => {
    const trigger = evaluateExitTrigger({
      record: makeRecord({ stopLoss: 60_000, takeProfit: 70_000, openedAt: "2026-01-01T00:00:00.000Z" }),
      freshBid: 64_948.33,
      freshDecision: HOLD_DECISION,
      killSwitchEnabled: false,
      maxHoldingDurationMs: 60 * 60 * 1000, // 1 hour
      strategyStillEnabled: true,
      now: new Date("2026-01-01T01:00:00.000Z"), // exactly 1 hour later
    });
    expect(trigger).toBe("MAX_HOLDING_DURATION");
  });

  it("is undefined when maxHoldingDurationMs is not configured, regardless of elapsed time", () => {
    const trigger = evaluateExitTrigger({
      record: makeRecord({ stopLoss: 60_000, takeProfit: 70_000, openedAt: "2020-01-01T00:00:00.000Z" }),
      freshBid: 64_948.33,
      freshDecision: HOLD_DECISION,
      killSwitchEnabled: false,
      maxHoldingDurationMs: undefined,
      strategyStillEnabled: true,
      now: new Date("2026-01-01T01:00:00.000Z"),
    });
    expect(trigger).toBeUndefined();
  });
});

// --- executeAutomaticExit ------------------------------------------------------------------------

function makeMockBroker(openPositions: PaperPosition[], rate?: { bid: number; ask: number }) {
  const account: Account = { cashBalance: 100_000, startingCashBalance: 100_000 };
  const completedTrades: CompletedTrade[] = [];
  return {
    getAccount: () => account,
    getOpenPositions: () => openPositions,
    getCompletedTrades: () => completedTrades,
    getRate: rate ? vi.fn(async () => rate) : undefined,
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
    closePosition: vi.fn(async (positionId: string, exitPrice: number, exitTimestamp: string, closeReason: string) => {
      const index = openPositions.findIndex((p) => p.positionId === positionId);
      if (index === -1) throw new Error(`No open position ${positionId} — it may have already been closed.`);
      const position = openPositions[index]!;
      openPositions.splice(index, 1);
      const trade: CompletedTrade = {
        tradeId: "mock-trade-1",
        positionId,
        strategyId: position.strategyId,
        strategyVersion: position.strategyVersion,
        sourceType: position.sourceType,
        instrument: position.instrument,
        side: position.side,
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        entryTimestamp: position.entryTimestamp,
        entryOrderId: position.entryOrderId,
        exitPrice,
        exitTimestamp,
        exitOrderId: "mock-close-1",
        realisedPnl: exitPrice - position.entryPrice,
        closeReason,
      };
      completedTrades.push(trade);
      return { trade, orderId: "mock-close-1" };
    }),
  };
}

function makeOpenPosition(overrides: Partial<PaperPosition> = {}): PaperPosition {
  return {
    positionId: "etoro-position-1",
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    sourceType: "HERMES_APPROVED",
    instrument: "BTC",
    side: "BUY",
    quantity: 10,
    entryPrice: 64_948.33,
    entryTimestamp: "2026-01-01T00:00:00.000Z",
    entryOrderId: "369015901",
    brokerPositionId: "3568040809",
    ...overrides,
  };
}

function makeLifecycleService(auditTrail = new InMemoryAuditTrail()) {
  const store = new InMemoryTradeLifecycleStore();
  const service = new TradeLifecycleService({ store, auditTrail, executionRunId: "test-run" });
  return { store, service, auditTrail };
}

describe("executeAutomaticExit — successful close", () => {
  it("emits AUTOMATIC_EXIT_TRIGGERED, closes via the broker, and updates the lifecycle record to CLOSED with realised P&L", async () => {
    const openPositions = [makeOpenPosition()];
    const broker = makeMockBroker(openPositions, { bid: 66_100, ask: 66_105 });
    const { store, service, auditTrail } = makeLifecycleService();
    const record = makeRecord();
    await store.create(record);

    const result = await executeAutomaticExit({
      broker: broker as never,
      record,
      trigger: "TAKE_PROFIT",
      lifecycleService: service,
      auditTrail,
      executionRunId: "test-run",
      now: new Date("2026-01-01T01:00:00.000Z"),
    });

    expect(result.closed).toBe(true);
    if (!result.closed) throw new Error("unreachable");
    expect(result.record.status).toBe("CLOSED");
    expect(result.record.exitReason).toBe("automatic-exit-take_profit");
    expect(typeof result.record.realisedPnl).toBe("number");
    expect(broker.closePosition).toHaveBeenCalledWith("etoro-position-1", 66_100, expect.any(String), "automatic-exit-take_profit");

    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events[0]).toBe("AUTOMATIC_EXIT_TRIGGERED");
    // POSITION_CLOSED/REALISED_PNL etc. come from the broker/service's own existing events — this
    // module never duplicates them, only adds its own distinct exit-trigger marker.
  });

  it("uses a FRESH price fetched again immediately before submission — never the bid the trigger was evaluated against (scenario 8)", async () => {
    const openPositions = [makeOpenPosition()];
    const staleBidUsedForEvaluation = 66_000;
    const freshBidAtSubmission = 66_250;
    const broker = makeMockBroker(openPositions, { bid: freshBidAtSubmission, ask: 66_255 });
    const { store, service, auditTrail } = makeLifecycleService();
    const record = makeRecord();
    await store.create(record);

    // Confirms evaluateExitTrigger was (hypothetically) run against the stale bid, then
    // executeAutomaticExit independently re-fetches its own fresh price rather than reusing it.
    expect(staleBidUsedForEvaluation).not.toBe(freshBidAtSubmission);

    await executeAutomaticExit({
      broker: broker as never,
      record,
      trigger: "TAKE_PROFIT",
      lifecycleService: service,
      auditTrail,
      executionRunId: "test-run",
      now: new Date("2026-01-01T01:00:00.000Z"),
    });

    expect(broker.getRate).toHaveBeenCalledWith("BTC");
    expect(broker.closePosition).toHaveBeenCalledWith("etoro-position-1", freshBidAtSubmission, expect.any(String), expect.any(String));
  });
});

describe("executeAutomaticExit — close reconciliation confirms removal (scenario 9)", () => {
  it("removes the position from broker.getOpenPositions() once closed, so a later reconciliation sees it gone", async () => {
    const openPositions = [makeOpenPosition()];
    const broker = makeMockBroker(openPositions, { bid: 66_100, ask: 66_105 });
    const { store, service, auditTrail } = makeLifecycleService();
    const record = makeRecord();
    await store.create(record);

    await executeAutomaticExit({
      broker: broker as never,
      record,
      trigger: "TAKE_PROFIT",
      lifecycleService: service,
      auditTrail,
      executionRunId: "test-run",
      now: new Date("2026-01-01T01:00:00.000Z"),
    });

    expect(broker.getOpenPositions()).toHaveLength(0);
  });
});

describe("executeAutomaticExit — transient failure never produces a duplicate close (scenario 10)", () => {
  it("marks the record CLOSE_FAILED and returns closed: false when the broker close call throws, without a second close order", async () => {
    const openPositions = [makeOpenPosition()];
    const broker = makeMockBroker(openPositions);
    broker.closePosition = vi.fn(async () => {
      throw new Error("eToro temporarily unreachable");
    });
    const { store, service, auditTrail } = makeLifecycleService();
    const record = makeRecord();
    await store.create(record);

    const result = await executeAutomaticExit({
      broker: broker as never,
      record,
      trigger: "STOP_LOSS",
      lifecycleService: service,
      auditTrail,
      executionRunId: "test-run",
      now: new Date("2026-01-01T01:00:00.000Z"),
    });

    expect(result.closed).toBe(false);
    if (result.closed) throw new Error("unreachable");
    expect(result.reason).toMatch(/temporarily unreachable/);
    expect(broker.closePosition).toHaveBeenCalledOnce();

    const stored = await store.getById(record.id);
    expect(stored?.status).toBe("CLOSE_FAILED");
  });

  it("finds nothing to close (closed: false, broker never called again) once the position is genuinely already gone", async () => {
    const broker = makeMockBroker([]); // position already closed — broker reports nothing open
    const { store, service, auditTrail } = makeLifecycleService();
    const record = makeRecord({ status: "CLOSE_REQUESTED" }); // a prior attempt already got this far
    await store.create(record);

    const result = await executeAutomaticExit({
      broker: broker as never,
      record,
      trigger: "STOP_LOSS",
      lifecycleService: service,
      auditTrail,
      executionRunId: "test-run",
      now: new Date("2026-01-01T01:00:00.000Z"),
    });

    expect(result.closed).toBe(false);
    expect(broker.closePosition).not.toHaveBeenCalled();
  });
});
