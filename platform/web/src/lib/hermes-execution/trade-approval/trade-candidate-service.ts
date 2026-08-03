import type { MarketDecision, MarketDecisionContext } from "../market-decision-engine";
import { runMarketDecisionCycleWithLifecycle, type TradeLifecycleCycleResult } from "../trade-lifecycle/trade-lifecycle-runner";
import type { TradeLifecycleService } from "../trade-lifecycle/trade-lifecycle-service";
import type { PaperBroker } from "../paper-broker";
import type { AuditTrail } from "../audit-trail";
import { PortfolioRiskEngine, type PortfolioRiskConfig } from "../portfolio-risk-engine";
import type { MarketDataSnapshot } from "../market-data/market-data-provider";
import { assertOrderSizingMode } from "../order-sizing";
import type { OrderRequest, OrderSizingMode } from "../types";
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
  /** Broker Sizing Semantic Fix. Frozen onto the candidate's own execution snapshot — see
   * TradeCandidateExecutionSnapshot's own doc comment. */
  sizingMode: OrderSizingMode;
  analysisRunId: string | undefined;
  now: Date;
  expiryMs: number;
}

/** HOLD never creates a candidate (returns undefined). This function never touches the risk engine
 * or the broker. */
export async function createTradeCandidateForDecision(
  input: CreateTradeCandidateForDecisionInput,
): Promise<TradeCandidate | undefined> {
  const { repository, auditTrail, executionRunId, decision, context, marketDataSnapshot, amount, sizingMode, analysisRunId, now, expiryMs } =
    input;

  if (decision.action === "HOLD") {
    return undefined;
  }

  const candidateInput = buildTradeCandidateInput({
    decision,
    context,
    marketDataSnapshot,
    amount,
    sizingMode,
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
  /** Restart-Resilient Autonomy Phase — audit-durability hardening. Only ever produced by
   * autoApproveTradeCandidate, when its own TRADE_CANDIDATE_AUTO_APPROVED audit write could not be
   * durably persisted and the approval was reverted to FAILED (the only valid APPROVED-state exit
   * besides EXECUTED/EXPIRED — see VALID_CANDIDATE_TRANSITIONS) — see that function's own doc
   * comment. Never produced by approveTradeCandidate/rejectTradeCandidate themselves. */
  | { outcome: "failed"; candidate: TradeCandidate; reason: string }
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

/** Sentinel `approvedByUserId` recognised by approveTradeCandidate below — never a real Supabase
 * auth user id. Declared here (rather than down in the "Automatic approval" section) purely so it
 * is defined before approveTradeCandidate's own first reference to it; autoApproveTradeCandidate
 * (below) is still its only production caller. */
export const AUTO_DEMO_APPROVER_ID = "system:auto-demo";

/**
 * PENDING -> APPROVED, guarded two ways: (1) an already-expired candidate is transitioned to
 * EXPIRED instead of approved — never lets a human approve a stale entryPrice; (2) the repository's
 * own conditional transition() only applies when the row is still PENDING, so a second, concurrent
 * approve/reject/expiry-sweep call for the same id is a safe no-op here ("already-handled"), never
 * a double approval and never a thrown error.
 *
 * AUTO_DEMO approval-persistence defect fix. `approvedByUserId` is a `uuid` column
 * (supabase/migrations/0024_trade_candidates.sql) — it must NEVER receive anything other than a
 * genuine auth.users id or null/undefined. autoApproveTradeCandidate (below) calls this same
 * function with the well-known AUTO_DEMO_APPROVER_ID sentinel; this is the one place that
 * recognises it and translates it into the correct persisted shape: `approved_by_user_id` stays
 * null and `approval_source` records 'AUTO_DEMO' instead (see
 * supabase/migrations/0027_trade_candidates_approval_source.sql and CandidateApprovalSource's own
 * doc comment). Every OTHER value of `approvedByUserId` is treated as a real human auth.users id,
 * written through unchanged — manual approval's own behaviour, input shape, and validation (the
 * database's own uuid/FK constraints) are completely unmodified by this fix.
 */
export async function approveTradeCandidate(input: ApproveTradeCandidateInput): Promise<ApprovalOutcome> {
  const { repository, auditTrail, executionRunId, candidateId, approvedByUserId, now } = input;
  const isSystemApproval = approvedByUserId === AUTO_DEMO_APPROVER_ID;
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
    approvedByUserId: isSystemApproval ? undefined : approvedByUserId,
    approvalSource: isSystemApproval ? "AUTO_DEMO" : undefined,
  });
  if (!approved) return { outcome: "already-handled" };

  await auditTrail.record({
    timestamp: now.toISOString(),
    eventType: "TRADE_CANDIDATE_APPROVED",
    executionRunId,
    strategyId: approved.strategyId,
    instrument: approved.instrument,
    // The audit trail's own `details` is a free-form JSON blob, never a uuid-typed column — the
    // sentinel string is exactly what makes an automatic approval unambiguous here, and is kept
    // verbatim regardless of what the database itself persists in approved_by_user_id.
    details: { candidateId: approved.id, approvedByUserId, approvalSource: isSystemApproval ? "AUTO_DEMO" : "HUMAN" },
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

// --- Automatic approval (AUTO_DEMO only — Restart-Resilient Autonomy Phase, Phase 5) ------------

export interface AutoApproveTradeCandidateInput {
  repository: TradeCandidateRepository;
  auditTrail: AuditTrail;
  executionRunId: string;
  candidateId: string;
  now: Date;
}

/**
 * AUTO_DEMO's own auto-approval — deliberately a thin wrapper around approveTradeCandidate()
 * above, never a second, parallel transition path: it calls the EXACT SAME function a human
 * approval uses (same PENDING -> APPROVED conditional transition, same expiry check, same
 * TRADE_CANDIDATE_APPROVED audit event), then additionally records a durable, distinctly-named
 * TRADE_CANDIDATE_AUTO_APPROVED event so an automatic approval is never indistinguishable from a
 * human one in the audit trail. The candidate itself was already persisted as PENDING by
 * createTradeCandidateForDecision before this is ever called (see trading-runtime.ts's own
 * runCycleBody) — this function never creates or executes anything itself, only approves.
 *
 * Restart-Resilient Autonomy Phase — audit-durability hardening. Unlike every other audit call in
 * this pipeline (which is best-effort — a broken audit trail must never block a trading cycle, see
 * trading-runtime.ts's own recordAudit() wrapper), THIS specific write is safety-critical enough
 * that its own durability failure must not let execution continue: the candidate is already
 * durably APPROVED in the repository by the time this write is attempted, so if the ONE audit
 * event marking that approval as AUTOMATIC (rather than human) cannot be durably recorded, this
 * function reverts the candidate to FAILED (the only valid APPROVED-state exit for this besides
 * EXECUTED/EXPIRED — see VALID_CANDIDATE_TRANSITIONS; APPROVED -> REJECTED is not a valid
 * transition) — explicit, visible, and safe (nothing further ever executes it) — rather than
 * either silently letting a capital-committing trade proceed with a gap in its own audit trail, or
 * leaving it stuck APPROVED with an incomplete one.
 *
 * AUTO_DEMO approval-persistence defect fix — requirement 6 (candidate state consistency). The
 * approveTradeCandidate() call itself can now ALSO fail (any unexpected repository/database error —
 * the specific uuid-column bug this fix closes is one instance, but this guard is deliberately
 * general, not specific to that one cause). Previously this was uncaught: it propagated straight out
 * of this function and crashed the calling cycle, and the candidate was left PENDING with no
 * explanation anywhere in the audit trail. Now: caught, recorded as a dedicated AUTO_APPROVAL_FAILED
 * event (distinct from TRADE_CANDIDATE_EXECUTION_FAILED below, which covers an approval that DID
 * persist but was reverted afterwards), and reported as "failed" — never "approved" — so the caller
 * (trading-runtime.ts) never proceeds to execute it. The candidate's own persisted status is
 * whatever it already durably was (ordinarily still PENDING, since the failed transition never
 * committed) — never fabricated as FAILED here, since this function cannot know whether the
 * underlying write truly did not apply. Nothing re-attempts auto-approval for this same candidate on
 * a later cycle (autoApproveTradeCandidate is only ever invoked once, immediately after a fresh
 * candidate's own creation — see trading-runtime.ts's own runCycleBody) — a PENDING candidate left
 * behind by this path simply blocks a fresh duplicate (checkForDuplicateEntry) until a human
 * approves/rejects it or it expires, never a repeated auto-approval attempt.
 */
export async function autoApproveTradeCandidate(input: AutoApproveTradeCandidateInput): Promise<ApprovalOutcome> {
  const { repository, auditTrail, executionRunId, candidateId, now } = input;

  let outcome: ApprovalOutcome;
  try {
    outcome = await approveTradeCandidate({
      repository,
      auditTrail,
      executionRunId,
      candidateId,
      approvedByUserId: AUTO_DEMO_APPROVER_ID,
      now,
    });
  } catch (error) {
    const reason = `AUTO_DEMO auto-approval could not be persisted: ${error instanceof Error ? error.message : String(error)}`;
    const current = await repository.getById(candidateId);
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "AUTO_APPROVAL_FAILED",
      executionRunId,
      strategyId: current?.strategyId,
      instrument: current?.instrument,
      details: { candidateId, reason },
    });
    return current ? { outcome: "failed", candidate: current, reason } : { outcome: "not-found" };
  }

  if (outcome.outcome !== "approved") return outcome;

  try {
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "TRADE_CANDIDATE_AUTO_APPROVED",
      executionRunId,
      strategyId: outcome.candidate.strategyId,
      instrument: outcome.candidate.instrument,
      details: { candidateId: outcome.candidate.id, approvedByUserId: AUTO_DEMO_APPROVER_ID },
    });
  } catch (error) {
    const reason =
      `AUTO_DEMO auto-approval audit event could not be durably recorded, so this approval is being reverted: ` +
      `${error instanceof Error ? error.message : String(error)}`;
    const failed = await repository.transition(candidateId, "APPROVED", {
      status: "FAILED",
      failureReason: reason,
    });
    if (!failed) return { outcome: "already-handled" };
    // Reuses the SAME event type executeApprovedTradeCandidate's own execution-failure path emits
    // — this candidate's fate (APPROVED -> FAILED) is identical in shape, just triggered by an
    // audit-durability failure instead of a broker/risk-engine failure.
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

  return outcome;
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
  /** Restart-Resilient Autonomy Phase. Frozen onto the resulting TradeLifecycleRecord — sourced by
   * the caller from runtime configuration, never inferred here. */
  brokerProvider: string;
}

/**
 * Approved-candidate sequencing fix. A BUY candidate executes directly from its own immutable,
 * persisted snapshot (`candidate.direction`/`entryPrice`/`stopLoss`/`takeProfit`/`execution.amount`)
 * — it never re-derives a decision via `MarketDecisionEngine.evaluate()`. It is still subject to
 * CURRENT deterministic safety/risk checks: PortfolioRiskEngine.evaluate runs against the broker's
 * live account/open-positions state and this cycle's own dailyTradeCount/brokerAvailable, exactly as
 * a fresh BUY would be — a candidate approved minutes ago can still be legitimately blocked now
 * (cash, exposure, daily-trade-count, open-position-count, broker availability), reported as FAILED
 * here, never silently downgraded or retried. The one thing that can no longer happen: a LATER
 * cycle's fresh Hermes decision moving to HOLD/SELL invalidates the approval — that later signal is
 * recorded independently (the runtime's own fresh-decision path) and never reaches or rewrites this
 * candidate. Mirrors the same audit events / lifecycle transitions
 * (createFromDecision -> [recordRiskRejected | recordApproved -> recordExecutionSubmitted ->
 * recordOpened]) `runMarketDecisionCycleWithLifecycle`'s own BUY branch already produces, so nothing
 * downstream (audit trail shape, TradeLifecycleRecord fields) changes for a BUY.
 */
async function executeApprovedBuyFromSnapshot(args: {
  broker: PaperBroker;
  lifecycleService: TradeLifecycleService;
  portfolioRisk: { config: PortfolioRiskConfig; dailyTradeCount: number; brokerAvailable: boolean };
  candidate: TradeCandidate;
  now: Date;
  brokerProvider: string;
  sizingMode: OrderSizingMode;
}): Promise<TradeLifecycleCycleResult> {
  const { broker, lifecycleService, portfolioRisk, candidate, now, brokerProvider, sizingMode } = args;
  const { marketContext } = candidate.execution;

  const decision: MarketDecision = {
    action: "BUY",
    confidence: candidate.confidence,
    reasoning: candidate.reasoning,
    validationNotes: candidate.validationNotes,
  };

  let record = await lifecycleService.createFromDecision({
    strategyId: candidate.strategyId,
    strategyVersion: candidate.strategyVersion,
    symbol: candidate.instrument,
    side: "BUY",
    quantity: candidate.execution.amount,
    sizingMode,
    candidateId: candidate.id,
    brokerProvider,
    stopLoss: candidate.stopLoss,
    takeProfit: candidate.takeProfit,
    decision,
    marketDataSnapshot: candidate.execution.marketDataSnapshot,
    intelligenceSummary: marketContext,
  });

  const proposedOrder: OrderRequest = {
    strategyId: candidate.strategyId,
    strategyVersion: candidate.strategyVersion,
    sourceType: marketContext.strategy.sourceType,
    instrument: candidate.instrument,
    side: "BUY",
    quantity: candidate.execution.amount,
    price: candidate.entryPrice,
    timestamp: now.toISOString(),
  };

  const riskDecision = PortfolioRiskEngine.evaluate({
    account: broker.getAccount(),
    openPositions: broker.getOpenPositions(),
    dailyTradeCount: portfolioRisk.dailyTradeCount,
    brokerAvailable: portfolioRisk.brokerAvailable,
    proposedOrder,
    config: portfolioRisk.config,
    sizingMode,
  });

  if (!riskDecision.permitted) {
    record = await lifecycleService.recordRiskRejected(record, riskDecision);
    return { decision, executed: false, blockedReasons: riskDecision.blockedReasons, lifecycleRecord: record };
  }

  record = await lifecycleService.recordApproved(record, riskDecision);
  record = await lifecycleService.recordExecutionSubmitted(record);

  let placed: Awaited<ReturnType<PaperBroker["placeMarketOrder"]>>;
  try {
    placed = await broker.placeMarketOrder(proposedOrder);
  } catch (error) {
    // Mirrors runMarketDecisionCycleWithLifecycle's own identical broker-call try/catch — the
    // lifecycle record must never be left stuck at EXECUTION_SUBMITTED with no terminal-ish status
    // recorded just because this path no longer routes through that wrapper.
    await lifecycleService.recordExecutionFailed(record, { message: error instanceof Error ? error.message : String(error) });
    throw error;
  }

  record = await lifecycleService.recordOpened(record, {
    entryPrice: placed.position.entryPrice,
    brokerOrderId: placed.orderId,
    brokerPositionId: placed.position.brokerPositionId,
  });

  return { decision, executed: true, position: placed.position, orderId: placed.orderId, lifecycleRecord: record };
}

/**
 * A SELL candidate still runs the EXISTING, unmodified pipeline (runMarketDecisionCycleWithLifecycle)
 * against the candidate's own frozen execution snapshot — closing an existing position is never
 * risk-gated (see market-decision-runner.ts's own SELL branch), so re-deriving the decision here
 * carries none of the "later HOLD silently blocks an already-safe BUY" risk the snapshot-driven BUY
 * path above exists to close; a SELL candidate whose re-derived decision drifted to HOLD simply fails
 * and is retried by the runtime's own next-cycle exit/close handling, same as before this fix.
 */
export async function executeApprovedTradeCandidate(input: ExecuteApprovedTradeCandidateInput): Promise<ExecutionOutcome> {
  const { repository, broker, auditTrail, executionRunId, lifecycleService, portfolioRisk, candidate, now, brokerProvider } = input;

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
    // Broker Sizing Semantic Fix. Fails closed (throws, caught below -> candidate marked FAILED
    // with a clear reason) rather than guessing UNITS or NOTIONAL for a legacy candidate persisted
    // before this field existed — see TradeCandidateExecutionSnapshot's own doc comment.
    const sizingMode = assertOrderSizingMode(candidate.execution.sizingMode, `trade candidate "${candidate.id}"`);

    const result =
      candidate.direction === "BUY"
        ? await executeApprovedBuyFromSnapshot({ broker, lifecycleService, portfolioRisk, candidate, now, brokerProvider, sizingMode })
        : await runMarketDecisionCycleWithLifecycle({
            broker,
            auditTrail,
            executionRunId,
            marketContext: candidate.execution.marketContext,
            amount: candidate.execution.amount,
            orderSizingMode: sizingMode,
            portfolioRisk,
            lifecycleService,
            marketDataSnapshot: candidate.execution.marketDataSnapshot,
            brokerProvider,
            candidateId: candidate.id,
            stopLoss: candidate.stopLoss,
            takeProfit: candidate.takeProfit,
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
