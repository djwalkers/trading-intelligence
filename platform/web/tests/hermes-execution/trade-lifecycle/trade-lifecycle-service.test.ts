import { describe, expect, it } from "vitest";
import { TradeLifecycleService } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-service";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import { InvalidTradeLifecycleTransitionError } from "@/lib/hermes-execution/trade-lifecycle/types";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { MarketDataSnapshot } from "@/lib/hermes-execution/market-data/market-data-provider";
import type { MarketDecision, MarketDecisionContext } from "@/lib/hermes-execution/market-decision-engine";
import type { PortfolioRiskDecision } from "@/lib/hermes-execution/portfolio-risk-engine";

const MARKET_DATA_SNAPSHOT: MarketDataSnapshot = {
  instrument: "BTC",
  timestamp: "2026-01-01T00:00:00.000Z",
  candles: [],
  bid: 100,
  ask: 100.1,
  spread: 0.1,
  latestPrice: 100.05,
  volume: 10,
};

const INTELLIGENCE_SUMMARY: MarketDecisionContext = {
  instrument: "BTC",
  bid: 100,
  ask: 100.1,
  spread: 0.1,
  midPrice: 100.05,
  timestamp: "2026-01-01T00:00:00.000Z",
  positionOpen: false,
  strategy: { strategyId: "STRAT-0001", version: 1, sourceType: "HERMES_APPROVED" },
  recentCandles: [],
  ema20: 101,
  ema50: 99,
  rsi14: 55,
  atr14: 1,
  volume: 10,
  dailyHigh: 102,
  dailyLow: 98,
  volatility24h: 0.01,
  marketSession: "Crypto Always Open",
  trend: "Bullish",
};

const BUY_DECISION: MarketDecision = { action: "BUY", confidence: 0.72, reasoning: ["EMA20 above EMA50", "Bullish trend"] };

const PERMITTED_RISK: PortfolioRiskDecision & { permitted: true } = {
  permitted: true,
  checks: [{ name: "max-open-positions", passed: true, detail: "ok" }],
  accountEquity: 10_000,
  portfolioExposure: 0,
};

const REJECTED_RISK: PortfolioRiskDecision & { permitted: false } = {
  permitted: false,
  checks: [{ name: "max-open-positions", passed: false, detail: "at maximum" }],
  accountEquity: 10_000,
  portfolioExposure: 5_000,
  blockedReasons: ["at maximum"],
};

function makeService(overrides: { clock?: string[] } = {}) {
  const store = new InMemoryTradeLifecycleStore();
  const auditTrail = new InMemoryAuditTrail();
  let clockIndex = 0;
  const clock = overrides.clock;
  const service = new TradeLifecycleService({
    store,
    auditTrail,
    executionRunId: "test-run",
    now: clock ? () => new Date(clock[Math.min(clockIndex++, clock.length - 1)]!) : undefined,
  });
  return { store, auditTrail, service };
}

async function createRecord(service: TradeLifecycleService) {
  return service.createFromDecision({
    strategyId: "STRAT-0001",
    symbol: "BTC",
    side: "BUY",
    quantity: 10,
    decision: BUY_DECISION,
    marketDataSnapshot: MARKET_DATA_SNAPSHOT,
    intelligenceSummary: INTELLIGENCE_SUMMARY,
  });
}

describe("TradeLifecycleService.createFromDecision", () => {
  it("creates a DECISION_CREATED record carrying the decision's action/confidence/reasoning", async () => {
    const { service } = makeService();
    const record = await createRecord(service);

    expect(record.status).toBe("DECISION_CREATED");
    expect(record.decision).toBe("BUY");
    expect(record.confidence).toBe(0.72);
    expect(record.decisionReasons).toEqual(BUY_DECISION.reasoning);
    expect(record.strategyId).toBe("STRAT-0001");
    expect(record.symbol).toBe("BTC");
    expect(record.side).toBe("BUY");
    expect(record.quantity).toBe(10);
    expect(record.marketDataSnapshot).toEqual(MARKET_DATA_SNAPSHOT);
    expect(record.intelligenceSummary).toEqual(INTELLIGENCE_SUMMARY);
    expect(record.portfolioRiskDecision).toBeUndefined();
    expect(record.createdAt).toBe(record.updatedAt);
  });

  it("assigns a distinct id to each created record", async () => {
    const { service } = makeService();
    const first = await createRecord(service);
    const second = await createRecord(service);
    expect(first.id).not.toBe(second.id);
  });

  it("persists the record in the store", async () => {
    const { service, store } = makeService();
    const record = await createRecord(service);
    expect(await store.getById(record.id)).toEqual(record);
  });

  it("records a TRADE_LIFECYCLE_CREATED audit event", async () => {
    const { service, auditTrail } = makeService();
    const record = await createRecord(service);
    const events = await auditTrail.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "TRADE_LIFECYCLE_CREATED",
      strategyId: "STRAT-0001",
      instrument: "BTC",
      details: { tradeLifecycleId: record.id, decision: "BUY" },
    });
  });
});

describe("TradeLifecycleService — risk rejection", () => {
  it("transitions DECISION_CREATED -> RISK_REJECTED and stores the risk decision", async () => {
    const { service, store } = makeService();
    const created = await createRecord(service);
    const rejected = await service.recordRiskRejected(created, REJECTED_RISK);

    expect(rejected.status).toBe("RISK_REJECTED");
    expect(rejected.portfolioRiskDecision).toEqual(REJECTED_RISK);
    expect(await store.getById(created.id)).toEqual(rejected);
  });

  it("records a TRADE_RISK_REJECTED audit event with the blocked reasons", async () => {
    const { service, auditTrail } = makeService();
    const created = await createRecord(service);
    await service.recordRiskRejected(created, REJECTED_RISK);

    const events = await auditTrail.getEvents();
    expect(events[1]).toMatchObject({
      eventType: "TRADE_RISK_REJECTED",
      details: { blockedReasons: REJECTED_RISK.blockedReasons },
    });
  });

  it("refuses to reject a record that isn't DECISION_CREATED", async () => {
    const { service } = makeService();
    const created = await createRecord(service);
    const approved = await service.recordApproved(created, PERMITTED_RISK);
    await expect(service.recordRiskRejected(approved, REJECTED_RISK)).rejects.toThrow(InvalidTradeLifecycleTransitionError);
  });
});

describe("TradeLifecycleService — successful execution (APPROVED -> EXECUTION_SUBMITTED -> OPEN)", () => {
  it("walks the full approval/execution/open sequence", async () => {
    const { service, store, auditTrail } = makeService();
    let record = await createRecord(service);

    record = await service.recordApproved(record, PERMITTED_RISK);
    expect(record.status).toBe("APPROVED");
    expect(record.portfolioRiskDecision).toEqual(PERMITTED_RISK);

    record = await service.recordExecutionSubmitted(record);
    expect(record.status).toBe("EXECUTION_SUBMITTED");
    expect(record.submittedAt).toBeDefined();

    record = await service.recordOpened(record, { entryPrice: 101.5, brokerOrderId: "order-1" });
    expect(record.status).toBe("OPEN");
    expect(record.entryPrice).toBe(101.5);
    expect(record.brokerOrderId).toBe("order-1");
    expect(record.openedAt).toBeDefined();

    expect(await store.getById(record.id)).toEqual(record);
    const eventTypes = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(eventTypes).toEqual(["TRADE_LIFECYCLE_CREATED", "TRADE_APPROVED", "TRADE_EXECUTION_SUBMITTED", "TRADE_OPENED"]);
  });

  it("accepts an explicit openedAt instead of the service clock", async () => {
    const { service } = makeService();
    let record = await createRecord(service);
    record = await service.recordApproved(record, PERMITTED_RISK);
    record = await service.recordExecutionSubmitted(record);
    record = await service.recordOpened(record, { entryPrice: 100, brokerOrderId: "order-1", openedAt: "2026-06-01T00:00:00.000Z" });
    expect(record.openedAt).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("TradeLifecycleService — failed execution", () => {
  it("transitions EXECUTION_SUBMITTED -> EXECUTION_FAILED and records error details", async () => {
    const { service, auditTrail } = makeService();
    let record = await createRecord(service);
    record = await service.recordApproved(record, PERMITTED_RISK);
    record = await service.recordExecutionSubmitted(record);
    record = await service.recordExecutionFailed(record, { message: "broker unreachable", context: { code: "ECONNRESET" } });

    expect(record.status).toBe("EXECUTION_FAILED");
    expect(record.error).toMatchObject({ message: "broker unreachable", context: { code: "ECONNRESET" } });
    expect(record.error?.occurredAt).toBeDefined();

    const events = await auditTrail.getEvents();
    expect(events.at(-1)).toMatchObject({ eventType: "TRADE_EXECUTION_FAILED", details: { message: "broker unreachable" } });
  });

  it("EXECUTION_FAILED is terminal — no further transition is accepted", async () => {
    const { service } = makeService();
    let record = await createRecord(service);
    record = await service.recordApproved(record, PERMITTED_RISK);
    record = await service.recordExecutionSubmitted(record);
    record = await service.recordExecutionFailed(record, { message: "boom" });
    await expect(service.recordOpened(record, { entryPrice: 100, brokerOrderId: "x" })).rejects.toThrow(
      InvalidTradeLifecycleTransitionError,
    );
  });

  it("refuses to submit execution for a record that isn't APPROVED", async () => {
    const { service } = makeService();
    const record = await createRecord(service);
    await expect(service.recordExecutionSubmitted(record)).rejects.toThrow(InvalidTradeLifecycleTransitionError);
  });
});

async function openRecord(service: TradeLifecycleService) {
  let record = await createRecord(service);
  record = await service.recordApproved(record, PERMITTED_RISK);
  record = await service.recordExecutionSubmitted(record);
  record = await service.recordOpened(record, {
    entryPrice: 100,
    brokerOrderId: "order-1",
    openedAt: "2026-01-01T00:00:00.000Z",
  });
  return record;
}

describe("TradeLifecycleService — successful closure", () => {
  it("transitions OPEN -> CLOSE_REQUESTED -> CLOSED and computes P/L + duration", async () => {
    const { service, store } = makeService({ clock: ["2026-01-01T01:00:00.000Z"] });
    let record = await openRecord(service);

    record = await service.recordCloseRequested(record);
    expect(record.status).toBe("CLOSE_REQUESTED");

    record = await service.recordClosed(record, { exitPrice: 110, exitReason: "market-decision-sell" });
    expect(record.status).toBe("CLOSED");
    expect(record.exitPrice).toBe(110);
    expect(record.exitReason).toBe("market-decision-sell");
    expect(record.realisedPnl).toBeCloseTo(100, 10); // (110-100)*10, long
    expect(record.realisedPnlPercent).toBeCloseTo(10, 10);
    expect(record.holdingDurationMs).toBe(60 * 60 * 1000);
    expect(await store.getById(record.id)).toEqual(record);
  });

  it("computes correct P/L for a losing trade", async () => {
    const { service } = makeService();
    let record = await openRecord(service);
    record = await service.recordCloseRequested(record);
    record = await service.recordClosed(record, { exitPrice: 90, exitReason: "stop-loss", closedAt: "2026-01-01T02:00:00.000Z" });
    expect(record.realisedPnl).toBeCloseTo(-100, 10);
    expect(record.realisedPnlPercent).toBeCloseTo(-10, 10);
  });

  it("computes correct P/L for a short trade", async () => {
    const { service } = makeService();
    let record = await createRecord(service);
    record = { ...record, side: "SELL" };
    record = await service.recordApproved(record, PERMITTED_RISK);
    record = await service.recordExecutionSubmitted(record);
    record = await service.recordOpened(record, { entryPrice: 100, brokerOrderId: "o1", openedAt: "2026-01-01T00:00:00.000Z" });
    record = await service.recordCloseRequested(record);
    record = await service.recordClosed(record, { exitPrice: 90, exitReason: "market-decision-sell", closedAt: "2026-01-01T00:30:00.000Z" });
    expect(record.realisedPnl).toBeCloseTo(100, 10); // (100-90)*10, short
    expect(record.holdingDurationMs).toBe(30 * 60 * 1000);
  });

  it("records a TRADE_CLOSED audit event with the computed figures", async () => {
    const { service, auditTrail } = makeService();
    let record = await openRecord(service);
    record = await service.recordCloseRequested(record);
    await service.recordClosed(record, { exitPrice: 110, exitReason: "market-decision-sell", closedAt: "2026-01-01T01:00:00.000Z" });

    const events = await auditTrail.getEvents();
    expect(events.at(-1)).toMatchObject({
      eventType: "TRADE_CLOSED",
      details: { exitPrice: 110, realisedPnl: 100, exitReason: "market-decision-sell" },
    });
  });

  it("refuses to close a record that was never opened", async () => {
    const { service } = makeService();
    const record = await createRecord(service);
    // A record straight from createFromDecision has neither entryPrice nor openedAt —
    // recordClosed checks for those explicitly, before even considering the state transition,
    // since a P/L calculation is meaningless without an entry price to calculate against.
    await expect(service.recordClosed(record, { exitPrice: 100, exitReason: "x" })).rejects.toThrow(/never opened/);
  });
});

describe("TradeLifecycleService — failed closure", () => {
  it("transitions CLOSE_REQUESTED -> CLOSE_FAILED and records error details", async () => {
    const { service, auditTrail } = makeService();
    let record = await openRecord(service);
    record = await service.recordCloseRequested(record);
    record = await service.recordCloseFailed(record, { message: "close endpoint timed out" });

    expect(record.status).toBe("CLOSE_FAILED");
    expect(record.error?.message).toBe("close endpoint timed out");
    // A failed close leaves no realised P/L behind — the position's fate is unresolved, not zero.
    expect(record.realisedPnl).toBeUndefined();

    expect((await auditTrail.getEvents()).at(-1)).toMatchObject({ eventType: "TRADE_CLOSE_FAILED" });
  });

  it("CLOSE_FAILED is terminal", async () => {
    const { service } = makeService();
    let record = await openRecord(service);
    record = await service.recordCloseRequested(record);
    record = await service.recordCloseFailed(record, { message: "boom" });
    await expect(service.recordClosed(record, { exitPrice: 100, exitReason: "x" })).rejects.toThrow(
      InvalidTradeLifecycleTransitionError,
    );
  });

  it("refuses to request a close for a record that isn't OPEN", async () => {
    const { service } = makeService();
    const record = await createRecord(service);
    await expect(service.recordCloseRequested(record)).rejects.toThrow(InvalidTradeLifecycleTransitionError);
  });
});

describe("TradeLifecycleService.updateExcursion", () => {
  it("updates MFE for a favourable price move on a long trade", async () => {
    const { service, store } = makeService();
    const record = await openRecord(service); // entryPrice 100, quantity 10, side BUY
    const updated = await service.updateExcursion(record, 110);
    expect(updated.maximumFavourableExcursion).toBeCloseTo(100, 10);
    expect(updated.maximumAdverseExcursion).toBe(0);
    expect(await store.getById(record.id)).toEqual(updated);
  });

  it("updates MAE for an adverse price move on a long trade", async () => {
    const { service } = makeService();
    const record = await openRecord(service);
    const updated = await service.updateExcursion(record, 90);
    expect(updated.maximumAdverseExcursion).toBeCloseTo(-100, 10);
    expect(updated.maximumFavourableExcursion).toBe(0);
  });

  it("is monotonic across successive calls", async () => {
    const { service } = makeService();
    let record = await openRecord(service);
    record = await service.updateExcursion(record, 120); // MFE=200
    record = await service.updateExcursion(record, 105); // pullback, MFE unchanged
    expect(record.maximumFavourableExcursion).toBeCloseTo(200, 10);
  });

  it("is a no-op (no store write, no audit event) when the price hasn't moved past either extreme", async () => {
    const { service, auditTrail } = makeService();
    let record = await openRecord(service);
    record = await service.updateExcursion(record, 110); // establishes MFE=100
    const eventsBefore = await auditTrail.getEvents();
    const updatedAtBefore = record.updatedAt;

    const unchanged = await service.updateExcursion(record, 105); // still favourable, but less than 110's peak
    expect(unchanged.maximumFavourableExcursion).toBe(record.maximumFavourableExcursion);
    expect(unchanged.updatedAt).toBe(updatedAtBefore);
    expect(await auditTrail.getEvents()).toHaveLength(eventsBefore.length);
  });

  it("records a TRADE_EXCURSION_UPDATED audit event when the figures actually change", async () => {
    const { service, auditTrail } = makeService();
    const record = await openRecord(service);
    await service.updateExcursion(record, 115);
    expect((await auditTrail.getEvents()).at(-1)).toMatchObject({
      eventType: "TRADE_EXCURSION_UPDATED",
      details: { currentPrice: 115, maximumFavourableExcursion: 150 },
    });
  });

  it("also accepts CLOSE_REQUESTED (a position still open while its close is in flight)", async () => {
    const { service } = makeService();
    let record = await openRecord(service);
    record = await service.recordCloseRequested(record);
    const updated = await service.updateExcursion(record, 108);
    expect(updated.maximumFavourableExcursion).toBeCloseTo(80, 10);
  });

  it("refuses to update excursion for a record that was never opened", async () => {
    const { service } = makeService();
    const record = await createRecord(service);
    await expect(service.updateExcursion(record, 105)).rejects.toThrow(/not live/);
  });

  it("refuses to update excursion for a CLOSED record", async () => {
    const { service } = makeService();
    let record = await openRecord(service);
    record = await service.recordCloseRequested(record);
    record = await service.recordClosed(record, { exitPrice: 105, exitReason: "x" });
    await expect(service.updateExcursion(record, 108)).rejects.toThrow(/not live/);
  });
});

describe("TradeLifecycleService.findOpenRecord", () => {
  it("finds the open record matching strategyId + symbol", async () => {
    const { service } = makeService();
    const opened = await openRecord(service);
    const found = await service.findOpenRecord("STRAT-0001", "BTC");
    expect(found?.id).toBe(opened.id);
  });

  it("returns undefined when no open record matches", async () => {
    const { service } = makeService();
    await createRecord(service); // still DECISION_CREATED, not open
    expect(await service.findOpenRecord("STRAT-0001", "BTC")).toBeUndefined();
    expect(await service.findOpenRecord("STRAT-9999", "BTC")).toBeUndefined();
  });

  it("does not match a different symbol under the same strategy", async () => {
    const { service } = makeService();
    await openRecord(service); // symbol BTC
    expect(await service.findOpenRecord("STRAT-0001", "ETH")).toBeUndefined();
  });
});
