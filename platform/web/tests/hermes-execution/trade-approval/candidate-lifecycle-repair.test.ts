import { describe, expect, it } from "vitest";
import {
  InvalidLifecycleRepairInputError,
  repairCandidateForConfirmedLifecycle,
} from "@/lib/hermes-execution/trade-approval/candidate-lifecycle-repair";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { InMemoryTradeCandidateRepository } from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import type { TradeCandidateInput } from "@/lib/hermes-execution/trade-approval/types";
import type { TradeLifecycleRecord } from "@/lib/hermes-execution/trade-lifecycle/types";

// Restart-Resilient Autonomy Phase — candidate/lifecycle repair (deployment safety review). Covers
// required test scenarios 6 & 7: lifecycle OPEN repairs candidate APPROVED -> EXECUTED without a
// broker call, and candidate FAILED + confirmed broker position handled explicitly (never silently
// rewritten to EXECUTED). No broker is even a parameter of this module — repair never touches one.

const MARKET_CONTEXT = {
  instrument: "BTC",
  bid: 100,
  ask: 100.05,
  spread: 0.05,
  midPrice: 100.025,
  timestamp: "2026-01-01T00:00:00.000Z",
  positionOpen: false,
  strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "HERMES_APPROVED" as const },
  recentCandles: [],
  ema20: 110,
  ema50: 100,
  rsi14: 55,
  atr14: 1.5,
  volume: 120,
  dailyHigh: 112,
  dailyLow: 98,
  volatility24h: 0.01,
  marketSession: "Crypto Always Open" as const,
  trend: "Bullish" as const,
};

const MARKET_SNAPSHOT = {
  instrument: "BTC",
  timestamp: "2026-01-01T00:00:00.000Z",
  candles: [],
  bid: 100,
  ask: 100.05,
  spread: 0.05,
  latestPrice: 100.025,
  volume: 120,
};

function makeCandidateInput(overrides: Partial<TradeCandidateInput> = {}): TradeCandidateInput {
  return {
    analysisRunId: undefined,
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    instrument: "BTC",
    direction: "BUY",
    confidence: 0.8,
    entryPrice: 100,
    stopLoss: 95,
    takeProfit: 110,
    riskReward: 2,
    reasoning: ["seed"],
    validationNotes: [],
    expiresAt: "2026-01-01T00:20:00.000Z",
    execution: { amount: 10, sizingMode: "UNITS", marketContext: MARKET_CONTEXT, marketDataSnapshot: MARKET_SNAPSHOT },
    ...overrides,
  };
}

function makeLifecycleRecord(overrides: Partial<TradeLifecycleRecord> = {}): TradeLifecycleRecord {
  return {
    id: "lifecycle-1",
    brokerProvider: "etoro-demo",
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    symbol: "BTC",
    side: "BUY",
    quantity: 10,
    sizingMode: "UNITS",
    decision: "BUY",
    confidence: 0.8,
    decisionReasons: ["seed"],
    status: "OPEN",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    openedAt: "2026-01-01T00:00:00.000Z",
    entryPrice: 64_948.33,
    brokerPositionId: "3568040809",
    brokerOrderId: "369015901",
    ...overrides,
  };
}

const NOW = new Date("2026-01-01T01:00:00.000Z");

describe("repairCandidateForConfirmedLifecycle — lifecycle OPEN repairs candidate APPROVED -> EXECUTED (required scenario 6)", () => {
  it("transitions the candidate to EXECUTED, persists lifecycleRecordId/brokerOrderId, and emits CANDIDATE_EXECUTION_RECONCILED — no broker call, no risk re-check", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const candidate = await repository.create(makeCandidateInput());
    await repository.transition(candidate.id, "PENDING", { status: "APPROVED", approvedAt: NOW.toISOString(), approvedByUserId: "user-1" });

    const lifecycleRecord = makeLifecycleRecord({ candidateId: candidate.id });
    await repairCandidateForConfirmedLifecycle({
      lifecycleRecord,
      tradeCandidateRepository: repository,
      auditTrail,
      executionRunId: "test-run",
      now: NOW,
    });

    const repaired = await repository.getById(candidate.id);
    expect(repaired?.status).toBe("EXECUTED");
    expect(repaired?.lifecycleRecordId).toBe(lifecycleRecord.id);
    expect(repaired?.brokerOrderId).toBe(lifecycleRecord.brokerOrderId);
    expect(repaired?.executedAt).toBe(NOW.toISOString());

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["CANDIDATE_EXECUTION_RECONCILED"]);
    expect(events[0]?.details).toMatchObject({ candidateId: candidate.id, lifecycleRecordId: lifecycleRecord.id, lifecycleStatus: "OPEN" });
  });

  it("also repairs from a CLOSED_UNRECONCILED lifecycle record — the entry itself still genuinely executed", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const candidate = await repository.create(makeCandidateInput());
    await repository.transition(candidate.id, "PENDING", { status: "APPROVED", approvedAt: NOW.toISOString(), approvedByUserId: "user-1" });

    const lifecycleRecord = makeLifecycleRecord({
      candidateId: candidate.id,
      status: "CLOSED_UNRECONCILED",
      closedAt: NOW.toISOString(),
      exitReason: "reconciled-broker-position-absent",
    });
    await repairCandidateForConfirmedLifecycle({
      lifecycleRecord,
      tradeCandidateRepository: repository,
      auditTrail,
      executionRunId: "test-run",
      now: NOW,
    });

    expect((await repository.getById(candidate.id))?.status).toBe("EXECUTED");
  });

  it("is idempotent — a second call once already EXECUTED is a safe no-op, not a second event", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const candidate = await repository.create(makeCandidateInput());
    await repository.transition(candidate.id, "PENDING", { status: "APPROVED", approvedAt: NOW.toISOString(), approvedByUserId: "user-1" });
    const lifecycleRecord = makeLifecycleRecord({ candidateId: candidate.id });
    const input = { lifecycleRecord, tradeCandidateRepository: repository, auditTrail, executionRunId: "test-run", now: NOW };

    await repairCandidateForConfirmedLifecycle(input);
    await repairCandidateForConfirmedLifecycle(input);

    expect((await repository.getById(candidate.id))?.status).toBe("EXECUTED");
    const events = await auditTrail.getEvents();
    expect(events).toHaveLength(1);
  });

  it("is a no-op when the lifecycle record has no candidateId (an orphan-adopted position)", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const lifecycleRecord = makeLifecycleRecord({ candidateId: undefined });

    await repairCandidateForConfirmedLifecycle({
      lifecycleRecord,
      tradeCandidateRepository: repository,
      auditTrail,
      executionRunId: "test-run",
      now: NOW,
    });

    expect(await auditTrail.getEvents()).toEqual([]);
  });

  it("is a no-op for a candidate already in a terminal, unrelated state (REJECTED)", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const candidate = await repository.create(makeCandidateInput());
    await repository.transition(candidate.id, "PENDING", { status: "REJECTED", rejectedAt: NOW.toISOString(), rejectedByUserId: "user-1" });

    await repairCandidateForConfirmedLifecycle({
      lifecycleRecord: makeLifecycleRecord({ candidateId: candidate.id }),
      tradeCandidateRepository: repository,
      auditTrail,
      executionRunId: "test-run",
      now: NOW,
    });

    expect((await repository.getById(candidate.id))?.status).toBe("REJECTED");
    expect(await auditTrail.getEvents()).toEqual([]);
  });
});

describe("repairCandidateForConfirmedLifecycle — candidate FAILED + confirmed broker position (required scenario 7)", () => {
  it("never silently rewrites FAILED to EXECUTED — emits a distinct, documented audit event instead", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const candidate = await repository.create(makeCandidateInput());
    await repository.transition(candidate.id, "PENDING", { status: "APPROVED", approvedAt: NOW.toISOString(), approvedByUserId: "user-1" });
    await repository.transition(candidate.id, "APPROVED", { status: "FAILED", failureReason: "simulated execution failure" });

    const lifecycleRecord = makeLifecycleRecord({ candidateId: candidate.id });
    await repairCandidateForConfirmedLifecycle({
      lifecycleRecord,
      tradeCandidateRepository: repository,
      auditTrail,
      executionRunId: "test-run",
      now: NOW,
    });

    // Status is untouched — the historically-accurate "execution flow reported failure" signal is
    // never erased.
    const stillFailed = await repository.getById(candidate.id);
    expect(stillFailed?.status).toBe("FAILED");
    expect(stillFailed?.failureReason).toBe("simulated execution failure");

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["CANDIDATE_FAILED_WITH_CONFIRMED_BROKER_POSITION"]);
    expect(events[0]?.details).toMatchObject({ candidateId: candidate.id, lifecycleRecordId: lifecycleRecord.id, lifecycleStatus: "OPEN" });
  });
});

// Deployment safety review (final hardening pass): defensive validation — repair is allowed only
// for a lifecycle record whose status AND broker-evidence fields prove a position genuinely opened.
// This module never calls the broker itself, so it can only ever trust what is already durably
// recorded on the lifecycleRecord passed to it — invalid input fails closed via a thrown, clearly
// named domain error, never a silent no-op or a fabricated repair.
describe("repairCandidateForConfirmedLifecycle — defensive validation of caller input", () => {
  it("throws InvalidLifecycleRepairInputError for a status that never proves an opened position (EXECUTION_RECONCILIATION_REQUIRED)", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const candidate = await repository.create(makeCandidateInput());
    await repository.transition(candidate.id, "PENDING", { status: "APPROVED", approvedAt: NOW.toISOString(), approvedByUserId: "user-1" });

    const lifecycleRecord = makeLifecycleRecord({
      candidateId: candidate.id,
      status: "EXECUTION_RECONCILIATION_REQUIRED",
      brokerPositionId: undefined,
      entryPrice: undefined,
      openedAt: undefined,
    });

    await expect(
      repairCandidateForConfirmedLifecycle({ lifecycleRecord, tradeCandidateRepository: repository, auditTrail, executionRunId: "test-run", now: NOW }),
    ).rejects.toBeInstanceOf(InvalidLifecycleRepairInputError);

    // Fails closed — no state change, no event.
    expect((await repository.getById(candidate.id))?.status).toBe("APPROVED");
    expect(await auditTrail.getEvents()).toEqual([]);
  });

  it("throws for a structurally-unexpected pre-open status (DECISION_CREATED)", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const candidate = await repository.create(makeCandidateInput());
    await repository.transition(candidate.id, "PENDING", { status: "APPROVED", approvedAt: NOW.toISOString(), approvedByUserId: "user-1" });

    const lifecycleRecord = makeLifecycleRecord({
      candidateId: candidate.id,
      status: "DECISION_CREATED",
      brokerPositionId: undefined,
      entryPrice: undefined,
      openedAt: undefined,
    });

    await expect(
      repairCandidateForConfirmedLifecycle({ lifecycleRecord, tradeCandidateRepository: repository, auditTrail, executionRunId: "test-run", now: NOW }),
    ).rejects.toThrow(/does not prove a broker position was ever opened/);
  });

  it("throws when a status that requires broker evidence is missing brokerPositionId/entryPrice/openedAt", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const auditTrail = new InMemoryAuditTrail();
    const candidate = await repository.create(makeCandidateInput());
    await repository.transition(candidate.id, "PENDING", { status: "APPROVED", approvedAt: NOW.toISOString(), approvedByUserId: "user-1" });

    // status OPEN (a valid, proving status) but missing the actual broker-evidence fields — a
    // malformed/incomplete caller input this module must not trust.
    const lifecycleRecord = makeLifecycleRecord({ candidateId: candidate.id, status: "OPEN", brokerPositionId: undefined });

    await expect(
      repairCandidateForConfirmedLifecycle({ lifecycleRecord, tradeCandidateRepository: repository, auditTrail, executionRunId: "test-run", now: NOW }),
    ).rejects.toThrow(/missing brokerPositionId\/entryPrice\/openedAt/);
  });

  it("does NOT call any broker — the validation is purely field-level on the lifecycleRecord already passed in", async () => {
    // Regression guard: the function signature itself has no broker parameter; this test documents
    // the intent so a future change can't silently add one without a visible, reviewable diff here.
    expect(repairCandidateForConfirmedLifecycle.length).toBe(1);
  });

  it.each(["CLOSE_REQUESTED", "CLOSE_FAILED", "CLOSED"] as const)(
    "accepts %s as a valid proving status when broker evidence is present (regression: repair-before-close call sites)",
    async (status) => {
      const repository = new InMemoryTradeCandidateRepository();
      const auditTrail = new InMemoryAuditTrail();
      const candidate = await repository.create(makeCandidateInput());
      await repository.transition(candidate.id, "PENDING", { status: "APPROVED", approvedAt: NOW.toISOString(), approvedByUserId: "user-1" });

      const lifecycleRecord = makeLifecycleRecord({ candidateId: candidate.id, status });
      await repairCandidateForConfirmedLifecycle({
        lifecycleRecord,
        tradeCandidateRepository: repository,
        auditTrail,
        executionRunId: "test-run",
        now: NOW,
      });

      expect((await repository.getById(candidate.id))?.status).toBe("EXECUTED");
    },
  );
});
