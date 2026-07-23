import type { MarketDecision, MarketDecisionContext } from "../market-decision-engine";
import { runMarketDecisionCycleWithLifecycle } from "../trade-lifecycle/trade-lifecycle-runner";
import type { TradeLifecycleService } from "../trade-lifecycle/trade-lifecycle-service";
import type { PaperBroker } from "../paper-broker";
import type { AuditTrail } from "../audit-trail";
import type { PortfolioRiskConfig } from "../portfolio-risk-engine";
import type { MarketDataSnapshot } from "../market-data/market-data-provider";
import { buildTradeCandidateInput } from "./build-trade-candidate";
import type { TradeCandidate } from "./types";
import type { TradeCandidateRepository } from "./trade-candidate-repository";

// Phase 3.5 — Trade Review & Approval. The one place the new flow (Analyse -> Decision -> Trade
// Candidate -> Persist -> Review UI -> Approved? -> Broker) is orchestrated. Every function here
// calls an existing, unmodified piece of the pipeline (MarketDecisionEngine.evaluate,
// runMarketDecisionCycleWithLifecycle) or the new, additive TradeCandidateRepository — nothing here
// reimplements a decision, a risk check, or a broker call.

function isExpired(candidate: Pick<TradeCandidate, "expiresAt">, now: Date): boolean {
  return new Date(candidate.expiresAt).getTime() <= now.getTime();
}

// --- Candidate creation (the automatic, per-cycle path) -----------------------------------------

export interface CreateTradeCandidateForDecisionInput {
  repository: TradeCandidateRepository;
  auditTrail: AuditTrail;
  executionRunId: string;
  /** Already evaluated by the caller (MarketDecisionEngine.evaluate(context), unmodified) — this
   * function never calls the engine itself. The caller evaluates once, upfront, so it can also use
   * the same decision to persist a Phase 2B analysis record and pass that row's id in as
   * `analysisRunId` before this function ever runs (see trading-runtime.ts's own runCycleBody). */
  decision: MarketDecision;
  context: MarketDecisionContext;
  marketDataSnapshot: MarketDataSnapshot;
  amount: number;
  analysisRunId: string | undefined;
  now: Date;
  expiryMs: number;
}

/** HOLD never creates a candidate (returns undefined). This function never touches the risk engine
 * or the broker. */
export async function createTradeCandidateForDecision(
  input: CreateTradeCandidateForDecisionInput,
): Promise<TradeCandidate | undefined> {
  const { repository, auditTrail, executionRunId, decision, context, marketDataSnapshot, amount, analysisRunId, now, expiryMs } = input;

  if (decision.action === "HOLD") {
    return undefined;
  }

  const candidateInput = buildTradeCandidateInput({
    decision,
    context,
    marketDataSnapshot,
    amount,
    analysisRunId,
    now,
    expiryMs,
  });
  const candidate = await repository.create(candidateInput);

  await auditTrail.record({
    timestamp: now.toISOString(),
    eventType: "TRADE_CANDIDATE_CREATED",
    executionRunId,
    strategyId: candidate.strategyId,
    strategyVersion: candidate.strategyVersion,
    instrument: candidate.instrument,
    details: {
      candidateId: candidate.id,
      direction: candidate.direction,
      confidence: candidate.confidence,
      entryPrice: candidate.entryPrice,
      stopLoss: candidate.stopLoss,
      takeProfit: candidate.takeProfit,
      expiresAt: candidate.expiresAt,
      analysisRunId: candidate.analysisRunId,
    },
  });

  return candidate;
}

// --- Human approval / rejection (the Review UI path) ---------------------------------------------

export type ApprovalOutcome =
  | { outcome: "approved"; candidate: TradeCandidate }
  | { outcome: "expired"; candidate: TradeCandidate }
  | { outcome: "already-handled" }
  | { outcome: "not-found" };

export interface ApproveTradeCandidateInput {
  repository: TradeCandidateRepository;
  auditTrail: AuditTrail;
  executionRunId: string;
  candidateId: string;
  approvedByUserId: string;
  now: Date;
}

/**
 * PENDING -> APPROVED, guarded two ways: (1) an already-expired candidate is transitioned to
 * EXPIRED instead of approved — never lets a human approve a stale entryPrice; (2) the repository's
 * own conditional transition() only applies when the row is still PENDING, so a second, concurrent
 * approve/reject/expiry-sweep call for the same id is a safe no-op here ("already-handled"), never
 * a double approval and never a thrown error.
 */
export async function approveTradeCandidate(input: ApproveTradeCandidateInput): Promise<ApprovalOutcome> {
  const { repository, auditTrail, executionRunId, candidateId, approvedByUserId, now } = input;
  const candidate = await repository.getById(candidateId);
  if (!candidate) return { outcome: "not-found" };
  if (candidate.status !== "PENDING") return { outcome: "already-handled" };

  if (isExpired(candidate, now)) {
    const expired = await repository.transition(candidateId, "PENDING", { status: "EXPIRED" });
    if (!expired) return { outcome: "already-handled" };
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "TRADE_CANDIDATE_EXPIRED",
      executionRunId,
      strategyId: expired.strategyId,
      instrument: expired.instrument,
      details: { candidateId: expired.id, reason: "expired-at-approval-attempt" },
    });
    return { outcome: "expired", candidate: expired };
  }

  const approved = await repository.transition(candidateId, "PENDING", {
    status: "APPROVED",
    approvedAt: now.toISOString(),
    approvedByUserId,
  });
  if (!approved) return { outcome: "already-handled" };

  await auditTrail.record({
    timestamp: now.toISOString(),
    eventType: "TRADE_CANDIDATE_APPROVED",
    executionRunId,
    strategyId: approved.strategyId,
    instrument: approved.instrument,
    details: { candidateId: approved.id, approvedByUserId },
  });

  return { outcome: "approved", candidate: approved };
}

export type RejectionOutcome =
  | { outcome: "rejected"; candidate: TradeCandidate }
  | { outcome: "already-handled" }
  | { outcome: "not-found" };

export interface RejectTradeCandidateInput {
  repository: TradeCandidateRepository;
  auditTrail: AuditTrail;
  executionRunId: string;
  candidateId: string;
  rejectedByUserId: string;
  reason?: string;
  now: Date;
}

/** PENDING -> REJECTED. A candidate that has already expired can still be explicitly rejected
 * (rejecting is always safe, unlike approving a stale price) — only an already-APPROVED/EXECUTED/
 * REJECTED/FAILED candidate is refused, via the same conditional-transition guard
 * approveTradeCandidate uses. */
export async function rejectTradeCandidate(input: RejectTradeCandidateInput): Promise<RejectionOutcome> {
  const { repository, auditTrail, executionRunId, candidateId, rejectedByUserId, reason, now } = input;
  const candidate = await repository.getById(candidateId);
  if (!candidate) return { outcome: "not-found" };
  if (candidate.status !== "PENDING") return { outcome: "already-handled" };

  const rejected = await repository.transition(candidateId, "PENDING", {
    status: "REJECTED",
    rejectedAt: now.toISOString(),
    rejectedByUserId,
    rejectionReason: reason,
  });
  if (!rejected) return { outcome: "already-handled" };

  await auditTrail.record({
    timestamp: now.toISOString(),
    eventType: "TRADE_CANDIDATE_REJECTED",
    executionRunId,
    strategyId: rejected.strategyId,
    instrument: rejected.instrument,
    details: { candidateId: rejected.id, rejectedByUserId, reason },
  });

  return { outcome: "rejected", candidate: rejected };
}

// --- Execution of an approved candidate (still only ever run by the standalone trading-runtime
// process, which owns the live broker/lifecycle-service instances — see trading-runtime.ts) --------

export type ExecutionOutcome =
  | { outcome: "executed"; candidate: TradeCandidate }
  | { outcome: "failed"; candidate: TradeCandidate; reason: string }
  | { outcome: "expired"; candidate: TradeCandidate }
  | { outcome: "already-handled" };

export interface ExecuteApprovedTradeCandidateInput {
  repository: TradeCandidateRepository;
  broker: PaperBroker;
  auditTrail: AuditTrail;
  executionRunId: string;
  lifecycleService: TradeLifecycleService;
  portfolioRisk: { config: PortfolioRiskConfig; dailyTradeCount: number; brokerAvailable: boolean };
  candidate: TradeCandidate;
  now: Date;
}

/**
 * Runs the EXACT existing, unmodified pipeline (runMarketDecisionCycleWithLifecycle — the same
 * function TradingRuntime called automatically before this phase existed) against the candidate's
 * own frozen execution snapshot (never re-fetched market data, never a re-decided action — the
 * human approved exactly what was reviewed). That function re-evaluates MarketDecisionEngine
 * (deterministic, same context -> same decision) and, for BUY, re-runs PortfolioRiskEngine — state
 * (cash, open positions) may have changed since the candidate was created, so a BUY approved
 * minutes ago can still be legitimately blocked now; that is reported as FAILED here, not silently
 * downgraded or retried.
 */
export async function executeApprovedTradeCandidate(input: ExecuteApprovedTradeCandidateInput): Promise<ExecutionOutcome> {
  const { repository, broker, auditTrail, executionRunId, lifecycleService, portfolioRisk, candidate, now } = input;

  if (candidate.status !== "APPROVED") return { outcome: "already-handled" };

  if (isExpired(candidate, now)) {
    const expired = await repository.transition(candidate.id, "APPROVED", { status: "EXPIRED" });
    if (!expired) return { outcome: "already-handled" };
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "TRADE_CANDIDATE_EXPIRED",
      executionRunId,
      strategyId: expired.strategyId,
      instrument: expired.instrument,
      details: { candidateId: expired.id, reason: "expired-before-execution" },
    });
    return { outcome: "expired", candidate: expired };
  }

  try {
    const result = await runMarketDecisionCycleWithLifecycle({
      broker,
      auditTrail,
      executionRunId,
      marketContext: candidate.execution.marketContext,
      amount: candidate.execution.amount,
      portfolioRisk,
      lifecycleService,
      marketDataSnapshot: candidate.execution.marketDataSnapshot,
    });

    if (!result.executed) {
      const reason = result.blockedReasons?.join("; ") ?? "Execution did not occur (unexpected: decision was no longer executable).";
      const failed = await repository.transition(candidate.id, "APPROVED", { status: "FAILED", failureReason: reason });
      if (!failed) return { outcome: "already-handled" };
      await auditTrail.record({
        timestamp: now.toISOString(),
        eventType: "TRADE_CANDIDATE_EXECUTION_FAILED",
        executionRunId,
        strategyId: failed.strategyId,
        instrument: failed.instrument,
        details: { candidateId: failed.id, reason },
      });
      return { outcome: "failed", candidate: failed, reason };
    }

    const executed = await repository.transition(candidate.id, "APPROVED", {
      status: "EXECUTED",
      executedAt: now.toISOString(),
      lifecycleRecordId: result.lifecycleRecord?.id,
      brokerOrderId: result.orderId,
    });
    if (!executed) return { outcome: "already-handled" };

    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "TRADE_CANDIDATE_EXECUTED",
      executionRunId,
      strategyId: executed.strategyId,
      instrument: executed.instrument,
      details: { candidateId: executed.id, brokerOrderId: executed.brokerOrderId, lifecycleRecordId: executed.lifecycleRecordId },
    });
    return { outcome: "executed", candidate: executed };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failed = await repository.transition(candidate.id, "APPROVED", { status: "FAILED", failureReason: reason });
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "TRADE_CANDIDATE_EXECUTION_FAILED",
      executionRunId,
      strategyId: candidate.strategyId,
      instrument: candidate.instrument,
      details: { candidateId: candidate.id, reason },
    });
    return failed ? { outcome: "failed", candidate: failed, reason } : { outcome: "already-handled" };
  }
}

// --- Expiry sweep (runs once per runtime cycle, before that cycle looks for new APPROVED work) ---

export interface SweepExpiredCandidatesInput {
  repository: TradeCandidateRepository;
  auditTrail: AuditTrail;
  executionRunId: string;
  strategyId: string;
  instrument: string;
  now: Date;
}

/** Marks every PENDING or APPROVED candidate for this strategy+instrument whose expiresAt has
 * passed as EXPIRED. Idempotent and safe to call every cycle — an already-EXPIRED (or since-
 * approved/rejected/executed) candidate is simply skipped, never double-processed, via the same
 * conditional transition() every other state change here uses. */
export async function sweepExpiredCandidates(input: SweepExpiredCandidatesInput): Promise<TradeCandidate[]> {
  const { repository, auditTrail, executionRunId, strategyId, instrument, now } = input;
  const expired: TradeCandidate[] = [];

  for (const status of ["PENDING", "APPROVED"] as const) {
    const candidates = await repository.list({ status, strategyId, instrument });
    for (const candidate of candidates) {
      if (!isExpired(candidate, now)) continue;
      const result = await repository.transition(candidate.id, status, { status: "EXPIRED" });
      if (!result) continue;
      expired.push(result);
      await auditTrail.record({
        timestamp: now.toISOString(),
        eventType: "TRADE_CANDIDATE_EXPIRED",
        executionRunId,
        strategyId: result.strategyId,
        instrument: result.instrument,
        details: { candidateId: result.id, reason: "expiry-sweep" },
      });
    }
  }

  return expired;
}
