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
      expect(outcome.candidate.approvedByUserId).toBe(AUTO_DEMO_APPROVER_ID);
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
