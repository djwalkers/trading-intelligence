import { describe, expect, it, vi } from "vitest";
import {
  approveTradeCandidate,
  createTradeCandidateForDecision,
  executeApprovedTradeCandidate,
  rejectTradeCandidate,
  sweepExpiredCandidates,
} from "@/lib/hermes-execution/trade-approval/trade-candidate-service";
import {
  InMemoryTradeCandidateRepository,
  type TradeCandidateRepository,
} from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { MarketDecisionEngine, type MarketDecisionContext } from "@/lib/hermes-execution/market-decision-engine";
import { TradeLifecycleService } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-service";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import type { MarketDataSnapshot } from "@/lib/hermes-execution/market-data/market-data-provider";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";
import type { PaperBroker } from "@/lib/hermes-execution/paper-broker";
import type { AuditTrail } from "@/lib/hermes-execution/audit-trail";
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
        strategyId: "DEMO-0001",
        strategyVersion: 1,
        sourceType: "HERMES_APPROVED",
        instrument: "BTC",
        side: "BUY",
        quantity: 50,
        entryPrice: 100,
        entryTimestamp: "2026-01-01T00:00:00.000Z",
        entryOrderId: "mock-order-0",
        exitPrice,
        exitTimestamp,
        exitOrderId: "mock-order-2",
        realisedPnl: 0,
        closeReason,
      } satisfies CompletedTrade,
      orderId: "mock-order-2",
    })),
  };
}

function makeLifecycleService(auditTrail: InMemoryAuditTrail, now: Date = new Date("2026-01-01T00:00:00.000Z")) {
  return new TradeLifecycleService({
    store: new InMemoryTradeLifecycleStore(),
    auditTrail,
    executionRunId: "test-run",
    now: () => now,
  });
}

/** Test helper: evaluates a BUY-shaped context through the real, unmodified MarketDecisionEngine
 * and creates a candidate from it — every test below a candidate is needed for uses this instead of
 * repeating "evaluate, then create" inline. */
async function createBuyCandidate(
  repository: TradeCandidateRepository,
  auditTrail: AuditTrail,
  now: Date,
  expiryMs = 20 * 60_000,
  contextOverrides: Partial<MarketDecisionContext> = {},
) {
  const context = makeMarketContext(contextOverrides);
  const decision = MarketDecisionEngine.evaluate(context);
  const candidate = await createTradeCandidateForDecision({
    repository,
    auditTrail,
    executionRunId: "test-run",
    decision,
    context,
    marketDataSnapshot: MARKET_DATA_SNAPSHOT,
    amount: 10,
    analysisRunId: undefined,
    now,
    expiryMs,
  });
  if (!candidate) throw new Error("Test fixture error: expected makeMarketContext() defaults to produce a BUY decision.");
  return candidate;
}

describe("createTradeCandidateForDecision", () => {
  it("creates a PENDING candidate for a BUY decision and records TRADE_CANDIDATE_CREATED", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");

    const context = makeMarketContext();
    const decision = MarketDecisionEngine.evaluate(context);
    expect(decision.action).toBe("BUY");

    const candidate = await createTradeCandidateForDecision({
      repository,
      auditTrail,
      executionRunId: "test-run",
      decision,
      context,
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
      amount: 10,
      analysisRunId: undefined,
      now,
      expiryMs: 20 * 60_000,
    });

    expect(candidate).toBeDefined();
    expect(candidate?.status).toBe("PENDING");

    const events = await auditTrail.getEvents();
    expect(events.some((e) => e.eventType === "TRADE_CANDIDATE_CREATED")).toBe(true);
  });

  it("creates no candidate for a HOLD decision", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();

    const context = makeMarketContext({ trend: "Sideways", ema20: 100.02, ema50: 100 });
    const decision = MarketDecisionEngine.evaluate(context);
    expect(decision.action).toBe("HOLD");

    const candidate = await createTradeCandidateForDecision({
      repository,
      auditTrail,
      executionRunId: "test-run",
      decision,
      context,
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
      amount: 10,
      analysisRunId: undefined,
      now: new Date(),
      expiryMs: 20 * 60_000,
    });

    expect(candidate).toBeUndefined();
    expect(await repository.list()).toHaveLength(0);
  });

  it("cross-references an analysisRunId when the caller supplies one", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const context = makeMarketContext();
    const decision = MarketDecisionEngine.evaluate(context);

    const candidate = await createTradeCandidateForDecision({
      repository,
      auditTrail,
      executionRunId: "test-run",
      decision,
      context,
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
      amount: 10,
      analysisRunId: "analysis-run-42",
      now: new Date(),
      expiryMs: 20 * 60_000,
    });

    expect(candidate?.analysisRunId).toBe("analysis-run-42");
  });
});

describe("approveTradeCandidate", () => {
  it("approves a PENDING candidate and records TRADE_CANDIDATE_APPROVED", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);

    const outcome = await approveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      approvedByUserId: "user-1",
      now,
    });

    expect(outcome.outcome).toBe("approved");
    if (outcome.outcome === "approved") {
      expect(outcome.candidate.status).toBe("APPROVED");
      expect(outcome.candidate.approvedByUserId).toBe("user-1");
    }
    const events = await auditTrail.getEvents();
    expect(events.some((e) => e.eventType === "TRADE_CANDIDATE_APPROVED")).toBe(true);
  });

  it("returns not-found for an unknown candidate id", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const outcome = await approveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: "does-not-exist",
      approvedByUserId: "user-1",
      now: new Date(),
    });
    expect(outcome.outcome).toBe("not-found");
  });

  it("expires (rather than approves) a candidate whose expiresAt has already passed", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, createdAt, 60_000); // expires 1 minute after creation

    const attemptTime = new Date(createdAt.getTime() + 5 * 60_000); // 5 minutes later — already expired
    const outcome = await approveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      approvedByUserId: "user-1",
      now: attemptTime,
    });

    expect(outcome.outcome).toBe("expired");
    const stored = await repository.getById(candidate.id);
    expect(stored?.status).toBe("EXPIRED");
  });

  it("rejects a duplicate approval attempt on an already-approved candidate", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);

    const first = await approveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      approvedByUserId: "user-1",
      now,
    });
    expect(first.outcome).toBe("approved");

    const second = await approveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      approvedByUserId: "user-2",
      now,
    });
    expect(second.outcome).toBe("already-handled");

    // Only one TRADE_CANDIDATE_APPROVED event was ever recorded — the duplicate attempt did not
    // silently re-approve or re-record anything.
    const events = await auditTrail.getEvents();
    expect(events.filter((e) => e.eventType === "TRADE_CANDIDATE_APPROVED")).toHaveLength(1);
    // The original approver is preserved, not overwritten by the second attempt.
    const stored = await repository.getById(candidate.id);
    expect(stored?.approvedByUserId).toBe("user-1");
  });

  it("refuses to approve an already-rejected candidate", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);

    await rejectTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      rejectedByUserId: "user-1",
      now,
    });

    const outcome = await approveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      approvedByUserId: "user-2",
      now,
    });
    expect(outcome.outcome).toBe("already-handled");
  });
});

describe("rejectTradeCandidate", () => {
  it("rejects a PENDING candidate, recording the reason and TRADE_CANDIDATE_REJECTED", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);

    const outcome = await rejectTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      rejectedByUserId: "user-1",
      reason: "Confidence too low for current volatility.",
      now,
    });

    expect(outcome.outcome).toBe("rejected");
    if (outcome.outcome === "rejected") {
      expect(outcome.candidate.status).toBe("REJECTED");
      expect(outcome.candidate.rejectionReason).toBe("Confidence too low for current volatility.");
    }
    const events = await auditTrail.getEvents();
    expect(events.some((e) => e.eventType === "TRADE_CANDIDATE_REJECTED")).toBe(true);
  });

  it("rejects an already-rejected candidate's second rejection attempt as already-handled", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);

    const first = await rejectTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      rejectedByUserId: "user-1",
      now,
    });
    expect(first.outcome).toBe("rejected");

    const second = await rejectTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      rejectedByUserId: "user-2",
      now,
    });
    expect(second.outcome).toBe("already-handled");
  });
});

describe("sweepExpiredCandidates", () => {
  it("expires PENDING and APPROVED candidates past their expiresAt, and leaves fresh ones alone", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");

    const stale = await createBuyCandidate(repository, auditTrail, createdAt, 60_000);
    const fresh = await createBuyCandidate(repository, auditTrail, createdAt, 60 * 60_000);

    const later = new Date(createdAt.getTime() + 10 * 60_000);
    const expired = await sweepExpiredCandidates({
      repository,
      auditTrail,
      executionRunId: "test-run",
      strategyId: "DEMO-0001",
      instrument: "BTC",
      now: later,
    });

    expect(expired.map((c) => c.id)).toEqual([stale.id]);
    expect((await repository.getById(stale.id))?.status).toBe("EXPIRED");
    expect((await repository.getById(fresh.id))?.status).toBe("PENDING");
  });
});

describe("executeApprovedTradeCandidate", () => {
  it("executes an approved BUY candidate via the existing broker pipeline, marking it EXECUTED", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);
    const approved = await approveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      approvedByUserId: "user-1",
      now,
    });
    expect(approved.outcome).toBe("approved");
    if (approved.outcome !== "approved") throw new Error("unreachable");

    const broker = makeMockBroker();
    const lifecycleService = makeLifecycleService(auditTrail, now);

    const outcome = await executeApprovedTradeCandidate({
      repository,
      broker,
      auditTrail,
      executionRunId: "test-run",
      lifecycleService,
      portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
      candidate: approved.candidate,
      now,
    });

    expect(outcome.outcome).toBe("executed");
    expect(broker.placeMarketOrder).toHaveBeenCalledOnce();
    const stored = await repository.getById(candidate.id);
    expect(stored?.status).toBe("EXECUTED");
    expect(stored?.brokerOrderId).toBeDefined();

    const events = await auditTrail.getEvents();
    expect(events.some((e) => e.eventType === "TRADE_CANDIDATE_EXECUTED")).toBe(true);
  });

  it("marks a candidate FAILED (never partially executed) when portfolio risk now blocks it", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);
    const approved = await approveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      approvedByUserId: "user-1",
      now,
    });
    expect(approved.outcome).toBe("approved");
    if (approved.outcome !== "approved") throw new Error("unreachable");

    const broker = makeMockBroker();
    const lifecycleService = makeLifecycleService(auditTrail, now);
    // A zero daily-trade allowance guarantees PortfolioRiskEngine blocks this BUY now, even though
    // it was permitted when the candidate was first created (state can change between creation and
    // approval — that's exactly what this guards against).
    const strictRiskConfig: PortfolioRiskConfig = { ...PERMISSIVE_RISK_CONFIG, maxDailyTrades: 0 };

    const outcome = await executeApprovedTradeCandidate({
      repository,
      broker,
      auditTrail,
      executionRunId: "test-run",
      lifecycleService,
      portfolioRisk: { config: strictRiskConfig, dailyTradeCount: 0, brokerAvailable: true },
      candidate: approved.candidate,
      now,
    });

    expect(outcome.outcome).toBe("failed");
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
    const stored = await repository.getById(candidate.id);
    expect(stored?.status).toBe("FAILED");
    expect(stored?.failureReason).toBeTruthy();
  });

  it("expires an approved candidate instead of executing it once its expiresAt has passed", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now, 60_000);
    const approved = await approveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      approvedByUserId: "user-1",
      now,
    });
    expect(approved.outcome).toBe("approved");
    if (approved.outcome !== "approved") throw new Error("unreachable");

    const broker = makeMockBroker();
    const lifecycleService = makeLifecycleService(auditTrail, now);
    const later = new Date(now.getTime() + 5 * 60_000);

    const outcome = await executeApprovedTradeCandidate({
      repository,
      broker,
      auditTrail,
      executionRunId: "test-run",
      lifecycleService,
      portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
      candidate: approved.candidate,
      now: later,
    });

    expect(outcome.outcome).toBe("expired");
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
  });

  it("is a no-op (already-handled) when the candidate is not APPROVED (e.g. still PENDING)", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);

    const broker = makeMockBroker();
    const lifecycleService = makeLifecycleService(auditTrail, now);

    const outcome = await executeApprovedTradeCandidate({
      repository,
      broker,
      auditTrail,
      executionRunId: "test-run",
      lifecycleService,
      portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
      candidate,
      now,
    });

    expect(outcome.outcome).toBe("already-handled");
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
  });
});
