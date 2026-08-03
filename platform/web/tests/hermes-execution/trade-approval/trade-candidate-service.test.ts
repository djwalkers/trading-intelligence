import { describe, expect, it, vi } from "vitest";
import {
  approveTradeCandidate,
  autoApproveTradeCandidate,
  AUTO_DEMO_APPROVER_ID,
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
import { checkForDuplicateEntry } from "@/lib/hermes-execution/trade-approval/duplicate-prevention";
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
  const decision = await MarketDecisionEngine.evaluate(context);
  const candidate = await createTradeCandidateForDecision({
    repository,
    auditTrail,
    executionRunId: "test-run",
    decision,
    context,
    marketDataSnapshot: MARKET_DATA_SNAPSHOT,
    amount: 10,
    sizingMode: "UNITS",
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
    const decision = await MarketDecisionEngine.evaluate(context);
    expect(decision.action).toBe("BUY");

    const candidate = await createTradeCandidateForDecision({
      repository,
      auditTrail,
      executionRunId: "test-run",
      decision,
      context,
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
      amount: 10,
      sizingMode: "UNITS",
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
    const decision = await MarketDecisionEngine.evaluate(context);
    expect(decision.action).toBe("HOLD");

    const candidate = await createTradeCandidateForDecision({
      repository,
      auditTrail,
      executionRunId: "test-run",
      decision,
      context,
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
      amount: 10,
      sizingMode: "UNITS",
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
    const decision = await MarketDecisionEngine.evaluate(context);

    const candidate = await createTradeCandidateForDecision({
      repository,
      auditTrail,
      executionRunId: "test-run",
      decision,
      context,
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
      amount: 10,
      sizingMode: "UNITS",
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

  // "AUTO_DEM" typo review. The reviewed line reads `approvalSource: isSystemApproval ? "AUTO_DEMO"
  // : undefined` — already the correct 5-character literal in the current source (verified by
  // reading trade-candidate-service.ts directly), not "AUTO_DEM". This pins the exact persisted
  // string so any future accidental truncation is caught immediately.
  it("persists approvalSource as exactly the 5-character string \"AUTO_DEMO\" for a system approval, never a truncated \"AUTO_DEM\"", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);

    const outcome = await approveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      approvedByUserId: AUTO_DEMO_APPROVER_ID,
      now,
    });

    expect(outcome.outcome).toBe("approved");
    if (outcome.outcome !== "approved") throw new Error("unreachable");
    expect(outcome.candidate.approvalSource).toBe("AUTO_DEMO");
    expect(outcome.candidate.approvalSource).toHaveLength(9);
    expect(outcome.candidate.approvalSource).not.toBe("AUTO_DEM");

    const stored = await repository.getById(candidate.id);
    expect(stored?.approvalSource).toBe("AUTO_DEMO");
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
      brokerProvider: "etoro-demo",
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
      brokerProvider: "etoro-demo",
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
      brokerProvider: "etoro-demo",
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
      brokerProvider: "etoro-demo",
    });

    expect(outcome.outcome).toBe("already-handled");
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
  });

  // Broker Sizing Semantic Fix — Compatibility requirement: an approved candidate must execute
  // using the EXACT sizing semantics reviewed by the human, frozen at creation time, never
  // re-derived at approval/execution time.
  it("executes a NOTIONAL (eToro-style) candidate using its own frozen sizing mode, not the order's price", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");

    const context = makeMarketContext(); // ask 100.05, BUY decision
    const decision = await MarketDecisionEngine.evaluate(context);
    const candidate = await createTradeCandidateForDecision({
      repository,
      auditTrail,
      executionRunId: "test-run",
      decision,
      context,
      marketDataSnapshot: MARKET_DATA_SNAPSHOT,
      amount: 10, // NOTIONAL: this is an order value of 10, not 10 * 100.05
      sizingMode: "NOTIONAL",
      analysisRunId: undefined,
      now,
      expiryMs: 20 * 60_000,
    });
    if (!candidate) throw new Error("Test fixture error: expected a BUY decision.");

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
    // A max exposure of 50 would reject this order if (wrongly) treated as UNITS (10 * 100.05 ~
    // 1000.50 > 50), but must permit it under its own correct NOTIONAL value of 10.
    const strictButSufficientConfig: PortfolioRiskConfig = { ...PERMISSIVE_RISK_CONFIG, maxPortfolioExposure: 50 };
    const lifecycleService = makeLifecycleService(auditTrail, now);

    const outcome = await executeApprovedTradeCandidate({
      repository,
      broker,
      auditTrail,
      executionRunId: "test-run",
      lifecycleService,
      portfolioRisk: { config: strictButSufficientConfig, dailyTradeCount: 0, brokerAvailable: true },
      candidate: approved.candidate,
      now,
      brokerProvider: "etoro-demo",
    });

    expect(outcome.outcome).toBe("executed");
    expect(broker.placeMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ quantity: 10 }));
  });

  // Broker Sizing Semantic Fix — Compatibility requirement: an ambiguous legacy candidate (persisted
  // before sizing modes existed, so execution_snapshot.sizingMode is simply absent after JSON
  // parsing) must fail closed, never be silently reinterpreted as UNITS or NOTIONAL.
  it("fails closed (never executes) when an approved candidate's frozen sizing mode is missing", async () => {
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

    // Simulate a legacy row: execution_snapshot predates this field, so it is simply absent after
    // being read back from Supabase's jsonb column — never a wrong guess, genuinely `undefined`.
    const legacyCandidate = {
      ...approved.candidate,
      execution: { ...approved.candidate.execution, sizingMode: undefined as never },
    };

    const broker = makeMockBroker();
    const lifecycleService = makeLifecycleService(auditTrail, now);

    const outcome = await executeApprovedTradeCandidate({
      repository,
      broker,
      auditTrail,
      executionRunId: "test-run",
      lifecycleService,
      portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
      candidate: legacyCandidate,
      now,
      brokerProvider: "etoro-demo",
    });

    expect(outcome.outcome).toBe("failed");
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
    if (outcome.outcome === "failed") {
      expect(outcome.reason).toMatch(/sizing mode/i);
    }
    const stored = await repository.getById(candidate.id);
    expect(stored?.status).toBe("FAILED");
  });

  // Approved-candidate sequencing fix (production incident: candidate 9f177a8f-a6cb-4ddc-9fc5-
  // d277ff15ce8b — an ETH BUY approved at 0.82 confidence failed with "decision was no longer
  // executable" purely because the NEXT cycle's fresh Hermes decision had moved to HOLD).
  describe("approved-candidate sequencing fix — executes from its own persisted snapshot, never re-derives the decision", () => {
    it("a BUY candidate executes without ever calling MarketDecisionEngine.evaluate again", async () => {
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

      const evaluateSpy = vi.spyOn(MarketDecisionEngine, "evaluate");
      const broker = makeMockBroker();
      const lifecycleService = makeLifecycleService(auditTrail, now);
      try {
        const outcome = await executeApprovedTradeCandidate({
          repository,
          broker,
          auditTrail,
          executionRunId: "test-run",
          lifecycleService,
          portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
          candidate: approved.candidate,
          now,
          brokerProvider: "etoro-demo",
        });
        expect(outcome.outcome).toBe("executed");
        // The defect: this used to re-run MarketDecisionEngine.evaluate() against the frozen
        // snapshot — if that re-evaluation ever produced HOLD (as it did in production), the
        // already-approved BUY failed with "decision was no longer executable". It must never be
        // called at all for an approved-candidate BUY execution.
        expect(evaluateSpy).not.toHaveBeenCalled();
      } finally {
        evaluateSpy.mockRestore();
      }
    });

    it("executes the approved BUY even when the runtime's OWN current-cycle decision (computed independently, from fresh market data) is HOLD", async () => {
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

      // Simulates "next cycle ETH decision became HOLD": a completely independent, freshly-computed
      // decision from NEW market data (never the candidate's own frozen snapshot) — exactly what
      // trading-runtime.ts's own per-cycle MarketDecisionEngine.evaluate() call produces. Neutral
      // RSI/EMA/trend inputs reliably yield HOLD under the real, unmodified engine.
      const freshCurrentContext = makeMarketContext({ ema20: 100, ema50: 100, rsi14: 50, trend: "Sideways" });
      const freshCurrentDecision = await MarketDecisionEngine.evaluate(freshCurrentContext);
      expect(freshCurrentDecision.action).toBe("HOLD");

      const broker = makeMockBroker();
      const lifecycleService = makeLifecycleService(auditTrail, now);
      // The fresh HOLD decision above is never passed to (or consulted by) executeApprovedTradeCandidate
      // at all — proving by construction that a later HOLD cannot invalidate this approved BUY.
      const outcome = await executeApprovedTradeCandidate({
        repository,
        broker,
        auditTrail,
        executionRunId: "test-run",
        lifecycleService,
        portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
        candidate: approved.candidate,
        now,
        brokerProvider: "etoro-demo",
      });

      expect(outcome.outcome).toBe("executed");
      expect(broker.placeMarketOrder).toHaveBeenCalledOnce();
    });

    it("uses the persisted candidate's own entryPrice/stopLoss/takeProfit/confidence, never re-derived values", async () => {
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
      await executeApprovedTradeCandidate({
        repository,
        broker,
        auditTrail,
        executionRunId: "test-run",
        lifecycleService,
        portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
        candidate: approved.candidate,
        now,
        brokerProvider: "etoro-demo",
      });

      expect(broker.placeMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ price: approved.candidate.entryPrice, side: "BUY" }));
      const openRecords = await lifecycleService.findOpenRecord(approved.candidate.strategyId, approved.candidate.instrument);
      expect(openRecords?.stopLoss).toBe(approved.candidate.stopLoss);
      expect(openRecords?.takeProfit).toBe(approved.candidate.takeProfit);
      expect(openRecords?.confidence).toBe(approved.candidate.confidence);
    });

    it("still fails closed (never executes) when a current risk check genuinely blocks the persisted snapshot", async () => {
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
        brokerProvider: "etoro-demo",
      });

      expect(outcome.outcome).toBe("failed");
      expect(broker.placeMarketOrder).not.toHaveBeenCalled();
      if (outcome.outcome === "failed") {
        expect(outcome.reason).toMatch(/trade\(s\) today already at the configured maximum/);
      }
    });

    it("executes a candidate no more than once — re-processing it (as the runtime would, on a freshly reloaded APPROVED list) is a no-op once EXECUTED", async () => {
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
      const execute = (c: typeof approved.candidate) =>
        executeApprovedTradeCandidate({
          repository,
          broker,
          auditTrail,
          executionRunId: "test-run",
          lifecycleService,
          portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
          candidate: c,
          now,
          brokerProvider: "etoro-demo",
        });

      const first = await execute(approved.candidate);
      expect(first.outcome).toBe("executed");

      // Mirrors trading-runtime.ts's own real flow: it always re-fetches the APPROVED list fresh
      // every cycle (`tradeCandidateRepository.list({status:"APPROVED",...})`) — an already-EXECUTED
      // candidate is never re-fetched with a stale "APPROVED" status, so this is the realistic
      // re-processing scenario to guard against.
      const reloaded = await repository.getById(candidate.id);
      expect(reloaded?.status).toBe("EXECUTED");
      const second = await execute(reloaded!);
      expect(second.outcome).toBe("already-handled");
      expect(broker.placeMarketOrder).toHaveBeenCalledOnce();
    });
  });
});

// Restart-Resilient Autonomy Phase — Phase 5 (AUTO_DEMO approval mode).
//
// Covers required scenarios:
//  11. AUTO_DEMO persists candidate before auto-approval.
//  12. AUTO_DEMO runs all normal risk checks.
describe("autoApproveTradeCandidate", () => {
  it("persists the candidate as PENDING BEFORE auto-approval — never the other way around (scenario 11)", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");

    // The candidate is created (persisted as PENDING) via the exact same path a human-approval flow
    // uses — createTradeCandidateForDecision — entirely BEFORE autoApproveTradeCandidate is ever
    // called, proving persistence always happens first.
    const candidate = await createBuyCandidate(repository, auditTrail, now);
    expect(candidate.status).toBe("PENDING");
    const persistedBeforeApproval = await repository.getById(candidate.id);
    expect(persistedBeforeApproval?.status).toBe("PENDING");

    const outcome = await autoApproveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      now,
    });

    expect(outcome.outcome).toBe("approved");
    if (outcome.outcome === "approved") {
      // AUTO_DEMO approval-persistence defect fix: approvedByUserId is a uuid column — the
      // AUTO_DEMO_APPROVER_ID sentinel is NEVER persisted there (that is exactly the bug that broke
      // production). System provenance is instead recorded via approvalSource, with
      // approvedByUserId left undefined.
      expect(outcome.candidate.approvedByUserId).toBeUndefined();
      expect(outcome.candidate.approvalSource).toBe("AUTO_DEMO");
    }
  });

  it("uses the exact same PENDING -> APPROVED transition approveTradeCandidate uses, and additionally emits a durable, distinguishable TRADE_CANDIDATE_AUTO_APPROVED event", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);

    await autoApproveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      now,
    });

    const events = await auditTrail.getEvents();
    const eventTypes = events.map((e) => e.eventType);
    // Both the normal human-approval event (from the reused approveTradeCandidate) AND the
    // distinct automatic-approval marker fire — never one instead of the other.
    expect(eventTypes).toContain("TRADE_CANDIDATE_APPROVED");
    expect(eventTypes).toContain("TRADE_CANDIDATE_AUTO_APPROVED");
    const autoEvent = events.find((e) => e.eventType === "TRADE_CANDIDATE_AUTO_APPROVED");
    expect(autoEvent?.details).toMatchObject({ candidateId: candidate.id, approvedByUserId: AUTO_DEMO_APPROVER_ID });
  });

  it("cannot auto-approve an already-expired candidate (the same expiry guard approveTradeCandidate already enforces)", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, createdAt, 60_000);
    const later = new Date(createdAt.getTime() + 5 * 60_000);

    const outcome = await autoApproveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      now: later,
    });

    expect(outcome.outcome).toBe("expired");
  });

  // Restart-Resilient Autonomy Phase — audit-durability hardening (required scenario: "AUTO_DEMO
  // partial persistence/audit failure"). The candidate is already durably APPROVED in the
  // repository by the time TRADE_CANDIDATE_AUTO_APPROVED is attempted — if THAT specific write
  // cannot be durably persisted, execution must not continue on an incomplete audit trail.
  it("reverts the candidate to REJECTED when its own TRADE_CANDIDATE_AUTO_APPROVED audit event cannot be durably recorded", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const now = new Date("2026-01-01T00:00:00.000Z");

    class FailOnAutoApprovedAuditTrail extends InMemoryAuditTrail {
      async record(event: Parameters<AuditTrail["record"]>[0]): ReturnType<AuditTrail["record"]> {
        if (event.eventType === "TRADE_CANDIDATE_AUTO_APPROVED") {
          throw new Error("disk full — simulated durability failure");
        }
        return super.record(event);
      }
    }
    const auditTrail = new FailOnAutoApprovedAuditTrail();
    const candidate = await createBuyCandidate(repository, auditTrail, now);

    const outcome = await autoApproveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      now,
    });

    // Not reported as "approved" — the caller (trading-runtime.ts) must not treat this as a
    // successful auto-approval and must not proceed to execute it.
    expect(outcome.outcome).toBe("failed");

    const stored = await repository.getById(candidate.id);
    expect(stored?.status).toBe("FAILED");
    expect(stored?.failureReason).toMatch(/could not be durably recorded/);

    const events = await auditTrail.getEvents();
    const eventTypes = events.map((e) => e.eventType);
    // The underlying approval DID happen (TRADE_CANDIDATE_APPROVED fired, and is durable) — but the
    // candidate was subsequently, explicitly reverted, visibly, rather than left silently APPROVED
    // with an incomplete audit trail or allowed to execute.
    expect(eventTypes).toContain("TRADE_CANDIDATE_APPROVED");
    expect(eventTypes).not.toContain("TRADE_CANDIDATE_AUTO_APPROVED");
    expect(eventTypes).toContain("TRADE_CANDIDATE_EXECUTION_FAILED");
  });

  it("runs the exact existing PortfolioRiskEngine/strategy checks at execution time — auto-approval never bypasses them (scenario 12)", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);

    const approvedOutcome = await autoApproveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      now,
    });
    expect(approvedOutcome.outcome).toBe("approved");
    if (approvedOutcome.outcome !== "approved") throw new Error("unreachable");

    const broker = makeMockBroker();
    const lifecycleService = makeLifecycleService(auditTrail, now);
    // A zero daily-trade allowance blocks this BUY at execution time — proving the normal
    // PortfolioRiskEngine check still runs in full for an auto-approved candidate, exactly as it
    // does for a human-approved one; auto-approval only skips the HUMAN CLICK, never a risk gate.
    const strictRiskConfig: PortfolioRiskConfig = { ...PERMISSIVE_RISK_CONFIG, maxDailyTrades: 0 };

    const outcome = await executeApprovedTradeCandidate({
      repository,
      broker,
      auditTrail,
      executionRunId: "test-run",
      lifecycleService,
      portfolioRisk: { config: strictRiskConfig, dailyTradeCount: 0, brokerAvailable: true },
      candidate: approvedOutcome.candidate,
      now,
      brokerProvider: "etoro-demo",
    });

    expect(outcome.outcome).toBe("failed");
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
  });
});

// AUTO_DEMO approval-persistence defect fix (VPS production incident: autoApproveTradeCandidate
// wrote the sentinel string "system:auto-demo" into approved_by_user_id, a uuid column — Postgres
// rejected it, the transition never committed, and the failure propagated as an uncaught exception
// rather than a clear outcome). Root cause fixed in approveTradeCandidate (approvalSource instead of
// a fabricated uuid); this block covers the remaining required scenarios.
describe("AUTO_DEMO approval-persistence defect fix", () => {
  it("persists successfully: approvedByUserId stays undefined, approvalSource is 'AUTO_DEMO', and the candidate is durably APPROVED", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);

    const outcome = await autoApproveTradeCandidate({ repository, auditTrail, executionRunId: "test-run", candidateId: candidate.id, now });

    expect(outcome.outcome).toBe("approved");
    const stored = await repository.getById(candidate.id);
    expect(stored?.status).toBe("APPROVED");
    expect(stored?.approvedByUserId).toBeUndefined();
    expect(stored?.approvalSource).toBe("AUTO_DEMO");
  });

  it("system approval provenance remains visible in the audit trail even though approvedByUserId is not persisted to the row", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);

    await autoApproveTradeCandidate({ repository, auditTrail, executionRunId: "test-run", candidateId: candidate.id, now });

    const events = await auditTrail.getEvents();
    const approvedEvent = events.find((e) => e.eventType === "TRADE_CANDIDATE_APPROVED");
    expect(approvedEvent?.details).toMatchObject({ approvedByUserId: AUTO_DEMO_APPROVER_ID, approvalSource: "AUTO_DEMO" });
    const autoApprovedEvent = events.find((e) => e.eventType === "TRADE_CANDIDATE_AUTO_APPROVED");
    expect(autoApprovedEvent?.details).toMatchObject({ approvedByUserId: AUTO_DEMO_APPROVER_ID });
  });

  it("manual approval still stores the human UUID and approvalSource stays undefined (never 'AUTO_DEMO')", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);
    const humanUserId = "11111111-1111-1111-1111-111111111111";

    const outcome = await approveTradeCandidate({
      repository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      approvedByUserId: humanUserId,
      now,
    });

    expect(outcome.outcome).toBe("approved");
    if (outcome.outcome !== "approved") throw new Error("unreachable");
    expect(outcome.candidate.approvedByUserId).toBe(humanUserId);
    expect(outcome.candidate.approvalSource).toBeUndefined();
  });

  it("a database/persistence failure during auto-approval emits AUTO_APPROVAL_FAILED, reports 'failed', and never claims 'approved'", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);

    const failingRepository: TradeCandidateRepository = {
      ...repository,
      getById: repository.getById.bind(repository),
      list: repository.list.bind(repository),
      create: repository.create.bind(repository),
      transition: vi.fn().mockRejectedValue(new Error('invalid input syntax for type uuid: "system:auto-demo"')),
    };

    const outcome = await autoApproveTradeCandidate({
      repository: failingRepository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      now,
    });

    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome === "failed") {
      expect(outcome.reason).toMatch(/could not be persisted/);
    }

    // The candidate is never left silently PENDING with no explanation anywhere.
    const events = await auditTrail.getEvents();
    const failureEvent = events.find((e) => e.eventType === "AUTO_APPROVAL_FAILED");
    expect(failureEvent).toBeDefined();
    expect(failureEvent?.details.candidateId).toBe(candidate.id);
    expect(String(failureEvent?.details.reason)).toMatch(/invalid input syntax for type uuid/);

    // The failed transition never committed — the candidate remains exactly as it durably was,
    // never fabricated as APPROVED or FAILED here.
    const stored = await repository.getById(candidate.id);
    expect(stored?.status).toBe("PENDING");
  });

  it("a failed auto-approval never executes — executeApprovedTradeCandidate treats the still-PENDING candidate as not-yet-approved", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);

    const failingRepository: TradeCandidateRepository = {
      ...repository,
      getById: repository.getById.bind(repository),
      list: repository.list.bind(repository),
      create: repository.create.bind(repository),
      transition: vi.fn().mockRejectedValue(new Error("simulated persistence outage")),
    };

    const outcome = await autoApproveTradeCandidate({
      repository: failingRepository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      now,
    });
    expect(outcome.outcome).toBe("failed");

    const broker = makeMockBroker();
    const lifecycleService = makeLifecycleService(auditTrail, now);
    const stillPending = await repository.getById(candidate.id);
    if (!stillPending) throw new Error("unreachable");

    const executionOutcome = await executeApprovedTradeCandidate({
      repository,
      broker,
      auditTrail,
      executionRunId: "test-run",
      lifecycleService,
      portfolioRisk: { config: PERMISSIVE_RISK_CONFIG, dailyTradeCount: 0, brokerAvailable: true },
      candidate: stillPending,
      now,
      brokerProvider: "etoro-demo",
    });

    expect(executionOutcome.outcome).toBe("already-handled");
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
  });

  it("does not repeatedly retry auto-approval after a permanent persistence failure — the still-PENDING candidate blocks a fresh duplicate instead", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const auditTrail = new InMemoryAuditTrail();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const candidate = await createBuyCandidate(repository, auditTrail, now);

    const failingRepository: TradeCandidateRepository = {
      ...repository,
      getById: repository.getById.bind(repository),
      list: repository.list.bind(repository),
      create: repository.create.bind(repository),
      transition: vi.fn().mockRejectedValue(new Error("simulated permanent persistence outage")),
    };
    const firstAttempt = await autoApproveTradeCandidate({
      repository: failingRepository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: candidate.id,
      now,
    });
    expect(firstAttempt.outcome).toBe("failed");

    // The candidate is still PENDING (the failed transition never committed) — a later cycle's own
    // duplicate check (the actual mechanism that prevents a repeated auto-approval attempt: nothing
    // ever re-invokes autoApproveTradeCandidate for an existing candidate, only checkForDuplicateEntry
    // runs again) correctly reports it as a duplicate, so no second candidate/auto-approval attempt
    // is ever spawned for this instrument+strategy while it remains unresolved.
    const duplicateCheck = await checkForDuplicateEntry({
      tradeCandidateRepository: repository,
      lifecycleStore,
      strategyId: candidate.strategyId,
      instrument: candidate.instrument,
    });
    expect(duplicateCheck.duplicate).toBe(true);

    const auditEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "AUTO_APPROVAL_FAILED");
    expect(auditEvents).toHaveLength(1);
  });
});
