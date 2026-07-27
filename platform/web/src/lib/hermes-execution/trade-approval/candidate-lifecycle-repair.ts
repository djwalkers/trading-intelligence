import type { AuditTrail } from "../audit-trail";
import type { TradeLifecycleRecord, TradeLifecycleStatus } from "../trade-lifecycle/types";
import type { TradeCandidateRepository } from "./trade-candidate-repository";

// Restart-Resilient Autonomy Phase — candidate/lifecycle repair (deployment safety review). A crash
// immediately after a TradeLifecycleRecord reaches OPEN but before executeApprovedTradeCandidate's
// own candidate.transition(..., { status: "EXECUTED" }) leaves the candidate permanently stuck
// APPROVED even though the trade genuinely executed — VALID_CANDIDATE_TRANSITIONS.APPROVED never
// leads back to EXECUTED any other way (trade-approval/types.ts). Left alone, this both loses
// trade-performance bookkeeping for a real trade AND (once the position eventually reaches
// CLOSED_UNRECONCILED, freeing the strategy+instrument slot) risks the SAME approved candidate being
// executed a second time. This module repairs that gap wherever a lifecycle record's own existence
// already proves the trade happened — it never calls the broker and never re-runs risk checks; the
// broker call already happened, and the lifecycle record IS the proof.

export interface RepairCandidateForLifecycleInput {
  /** Must be a record whose own existence proves a real trade executed — OPEN (reconciliation just
   * matched/reopened it), CLOSE_REQUESTED/CLOSE_FAILED (position-reconciliation.ts's own
   * repair-before-close call, made just before the record is persisted to CLOSED_UNRECONCILED),
   * CLOSED, or CLOSED_UNRECONCILED (the position DID open; only its later close is unresolved) —
   * see assertProvesOpenedPosition below, which enforces this at call time. */
  lifecycleRecord: TradeLifecycleRecord;
  tradeCandidateRepository: TradeCandidateRepository;
  auditTrail: AuditTrail;
  executionRunId: string;
  now: Date;
}

/** Deployment safety review (final hardening pass): a clear, dedicated domain error thrown when a
 * caller passes a lifecycleRecord that does not itself prove a real broker position ever opened —
 * a caller-contract violation, since this module never calls the broker to verify anything itself
 * (see this file's own top-of-file comment). Both of this function's real call sites
 * (trading-runtime.ts, position-reconciliation.ts) are designed to never trigger this; it exists as
 * a fail-closed backstop against a future/incorrect caller, e.g. one passing an
 * EXECUTION_RECONCILIATION_REQUIRED record (genuinely ambiguous — reconciliation deliberately never
 * attaches such a record here; see position-reconciliation.ts's own early-return). */
export class InvalidLifecycleRepairInputError extends Error {
  constructor(lifecycleRecordId: string, reason: string) {
    super(`Cannot repair a candidate against lifecycle record "${lifecycleRecordId}": ${reason}`);
    this.name = "InvalidLifecycleRepairInputError";
  }
}

/** Statuses whose own existence — per migration 0026's own
 * `trade_lifecycle_records_open_status_requires_broker_fields` constraint — durably requires
 * broker_position_id/entry_price/opened_at to already be populated from a genuine, confirmed
 * broker read. This is the only "broker evidence" this module ever consults; it never calls the
 * broker itself. */
const STATUSES_PROVING_OPENED_POSITION = new Set<TradeLifecycleStatus>([
  "OPEN",
  "CLOSE_REQUESTED",
  "CLOSE_FAILED",
  "CLOSED",
  "CLOSED_UNRECONCILED",
]);

function assertProvesOpenedPosition(record: TradeLifecycleRecord): void {
  if (!STATUSES_PROVING_OPENED_POSITION.has(record.status)) {
    throw new InvalidLifecycleRepairInputError(
      record.id,
      `status "${record.status}" does not prove a broker position was ever opened — repair only applies to a ` +
        `record whose status is one of OPEN/CLOSE_REQUESTED/CLOSE_FAILED/CLOSED/CLOSED_UNRECONCILED.`,
    );
  }
  if (record.brokerPositionId === undefined || record.entryPrice === undefined || record.openedAt === undefined) {
    throw new InvalidLifecycleRepairInputError(
      record.id,
      "is missing brokerPositionId/entryPrice/openedAt — these must already be durably recorded as evidence of a " +
        "confirmed broker position; this function never calls the broker itself to verify them.",
    );
  }
}

/**
 * Idempotent: `tradeCandidateRepository.transition(id, "APPROVED", ...)` only applies when the
 * candidate's CURRENT status is still exactly APPROVED (the same conditional-transition guard
 * every other candidate-status change already relies on — trade-candidate-repository.ts) — calling
 * this again once the candidate is already EXECUTED is a safe no-op, not a second event or a
 * duplicate transition attempt.
 *
 * A no-op when `lifecycleRecord.candidateId` is undefined (an orphan-adopted position has no
 * originating candidate to repair) or when the candidate is in any status other than APPROVED/
 * FAILED (already EXECUTED, or REJECTED/EXPIRED/PENDING — none of which this repair concerns
 * itself with).
 */
export async function repairCandidateForConfirmedLifecycle(input: RepairCandidateForLifecycleInput): Promise<void> {
  const { lifecycleRecord, tradeCandidateRepository, auditTrail, executionRunId, now } = input;

  assertProvesOpenedPosition(lifecycleRecord);

  if (!lifecycleRecord.candidateId) return;
  const candidate = await tradeCandidateRepository.getById(lifecycleRecord.candidateId);
  if (!candidate) return; // defensive; the DB's own composite FK should make this unreachable

  if (candidate.status === "APPROVED") {
    const executed = await tradeCandidateRepository.transition(candidate.id, "APPROVED", {
      status: "EXECUTED",
      executedAt: now.toISOString(),
      lifecycleRecordId: lifecycleRecord.id,
      brokerOrderId: lifecycleRecord.brokerOrderId,
    });
    if (!executed) return; // lost a race to some other repair/execution path — already handled
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "CANDIDATE_EXECUTION_RECONCILED",
      executionRunId,
      strategyId: executed.strategyId,
      instrument: executed.instrument,
      details: {
        candidateId: executed.id,
        lifecycleRecordId: lifecycleRecord.id,
        lifecycleStatus: lifecycleRecord.status,
        brokerOrderId: lifecycleRecord.brokerOrderId,
      },
    });
    return;
  }

  if (candidate.status === "FAILED") {
    // Do NOT silently rewrite FAILED to EXECUTED: VALID_CANDIDATE_TRANSITIONS has no such edge, and
    // erasing "the execution flow itself reported failure" would destroy a real, historically
    // accurate signal. A durable, distinct audit event is the documented repair transition instead
    // — visible and actionable, never a silent state change.
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "CANDIDATE_FAILED_WITH_CONFIRMED_BROKER_POSITION",
      executionRunId,
      strategyId: candidate.strategyId,
      instrument: candidate.instrument,
      details: { candidateId: candidate.id, lifecycleRecordId: lifecycleRecord.id, lifecycleStatus: lifecycleRecord.status },
    });
  }
}
