import type { AuditTrail } from "../audit-trail";
import type { PaperBroker } from "../paper-broker";
import type { TradeCandidateRepository } from "../trade-approval/trade-candidate-repository";
import type { TradeLifecycleStore } from "../trade-lifecycle/trade-lifecycle-store";
import { assertValidTransition, type TradeLifecycleRecord, type TradeLifecycleStatus } from "../trade-lifecycle/types";
import type { InternalStrategy } from "../types";
import { hasInstrumentResolution, hasPositionAdoption, hasRawPortfolio } from "./position-reconciliation";

// Restart-Resilient Autonomy Phase — crash-window recovery (deployment safety review). The final
// safety review found that a crash while a lifecycle record sat at DECISION_CREATED/APPROVED/
// EXECUTION_SUBMITTED (i.e. before a broker_position_id exists) permanently wedges that
// strategy+instrument: this session's own earlier hardening added a uniqueness invariant that
// correctly rejects a second record for the same identity, but nothing ever cleaned up the FIRST,
// abandoned one — every retry, and every future orphan-adoption attempt, collides with it forever.
// This module is that missing cleanup: a durable sweep, run at the top of every cycle (which also
// covers "at startup", since the very first cycle after a restart runs it too) before
// reconciliation and before any entry execution.
//
// Deliberately NOT one-size-fits-all — the two families of pre-OPEN status carry fundamentally
// different evidence:
//   - DECISION_CREATED / APPROVED: no broker call could structurally have happened yet (see
//     trade-lifecycle-runner.ts's own BUY branch — recordExecutionSubmitted always precedes the
//     one and only broker-touching call). Recoverable with a lightweight defensive check.
//   - EXECUTION_SUBMITTED (and EXECUTION_RECONCILIATION_REQUIRED, its own unresolved leftover): the
//     broker may have accepted the order before the crash — genuinely ambiguous, and resolved only
//     by an authoritative broker read. Never guesses "it failed" merely because no position id was
//     ever persisted locally.
//
// Every state-changing action here records its own audit event BEFORE writing the store update —
// deliberately the reverse of this codebase's usual "store first, audit second" order (see e.g.
// TradeLifecycleService's own transition()/audit() split) — because releasing the
// strategy+instrument uniqueness slot (EXECUTION_ABANDONED) or attaching a real broker position
// (OPEN) are themselves safety-critical enough that a durability failure recording WHY must block
// the change, not silently succeed with an incomplete trail. Neither call here is wrapped in a
// try/catch: an audit-write failure propagates out of recoverStaleLifecycleRecords() uncaught,
// failing this cycle via TRADING_CYCLE_FAILED — the same "fail loud rather than continue on an
// unaudited safety-critical change" discipline autoApproveTradeCandidate's own audit-durability
// handling already established.

export interface RecoverStaleLifecycleRecordsInput {
  /** Every broker satisfies the plain PaperBroker interface; getRawPortfolio()/resolveInstrument()
   * are checked as ADDITIONAL, optional capabilities via hasRawPortfolio/hasInstrumentResolution
   * (imported from position-reconciliation.ts, never redeclared) — this module stays exactly as
   * duck-typed as reconciliation itself. */
  broker: PaperBroker;
  instrument: string;
  strategy: InternalStrategy;
  brokerProvider: string;
  lifecycleStore: TradeLifecycleStore;
  tradeCandidateRepository: TradeCandidateRepository;
  auditTrail: AuditTrail;
  executionRunId: string;
  now: Date;
  /** How long (ms), measured from a record's own updatedAt, it may sit at DECISION_CREATED/
   * APPROVED/EXECUTION_SUBMITTED/EXECUTION_RECONCILIATION_REQUIRED before this sweep acts on it —
   * see config.ts's own HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS. A record younger than this is still
   * plausibly mid-execution in a legitimately slow cycle and is left alone. */
  recoveryThresholdMs: number;
}

const PRE_OPEN_RECOVERABLE_STATUSES = new Set<TradeLifecycleStatus>([
  "DECISION_CREATED",
  "APPROVED",
  "EXECUTION_SUBMITTED",
  "EXECUTION_RECONCILIATION_REQUIRED",
]);

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStale(record: TradeLifecycleRecord, now: Date, thresholdMs: number): boolean {
  const updatedAtMs = Date.parse(record.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return false; // never act on a record with an unparseable timestamp
  return now.getTime() - updatedAtMs >= thresholdMs;
}

/**
 * Scans every DECISION_CREATED/APPROVED/EXECUTION_SUBMITTED/EXECUTION_RECONCILIATION_REQUIRED
 * lifecycle record for this exact strategy+instrument older than `recoveryThresholdMs`, and
 * resolves each one. At most one such record can exist at a time — the active-uniqueness invariant
 * (trade-lifecycle-store.ts's own ACTIVE_STRATEGY_INSTRUMENT_STATUSES, mirrored by migration 0026)
 * guarantees it — but this still loops defensively rather than assuming exactly one.
 */
export async function recoverStaleLifecycleRecords(input: RecoverStaleLifecycleRecordsInput): Promise<void> {
  const { broker, instrument, strategy, brokerProvider, lifecycleStore, tradeCandidateRepository, auditTrail, executionRunId, now, recoveryThresholdMs } =
    input;

  const all = await lifecycleStore.list();
  const stale = all.filter(
    (record) =>
      record.strategyId === strategy.strategyId &&
      record.symbol === instrument &&
      PRE_OPEN_RECOVERABLE_STATUSES.has(record.status) &&
      isStale(record, now, recoveryThresholdMs),
  );

  for (const record of stale) {
    // Defensive, shared guard: a candidate already EXECUTED contradicts ANY pre-OPEN lifecycle
    // status — no code path can produce this combination (EXECUTED is only ever set immediately
    // after a confirmed OPEN, in the same synchronous call chain — see executeApprovedTradeCandidate),
    // so encountering it means something is genuinely wrong. Never force an abandonment or
    // correlation that would contradict already-durable, more-authoritative candidate state.
    if (record.candidateId) {
      const candidate = await tradeCandidateRepository.getById(record.candidateId);
      if (candidate?.status === "EXECUTED") {
        await markAmbiguous(
          record,
          `Associated candidate ${record.candidateId} is already EXECUTED, which contradicts this record's own ` +
            `${record.status} status — refusing to guess which is correct.`,
          { broker, auditTrail, executionRunId, strategy, instrument, brokerProvider, now, lifecycleStore },
        );
        continue;
      }
    }

    if (record.status === "DECISION_CREATED" || record.status === "APPROVED") {
      await recoverPreSubmissionRecord(record, { broker, instrument, strategy, brokerProvider, lifecycleStore, auditTrail, executionRunId, now });
    } else {
      await recoverAmbiguousSubmission(record, { broker, instrument, strategy, brokerProvider, lifecycleStore, auditTrail, executionRunId, now });
    }
  }
}

interface RecoveryContext {
  broker: PaperBroker;
  instrument: string;
  strategy: InternalStrategy;
  brokerProvider: string;
  lifecycleStore: TradeLifecycleStore;
  auditTrail: AuditTrail;
  executionRunId: string;
  now: Date;
}

/**
 * DECISION_CREATED / APPROVED: no broker call could structurally have happened yet. Verified with a
 * lightweight, universally-available check (broker.getOpenPositions() — every PaperBroker
 * implements this, unlike getRawPortfolio()) rather than the full raw-portfolio correlation
 * EXECUTION_SUBMITTED needs below: the structural guarantee already carries most of the weight
 * here, so this check only needs to catch something genuinely unexpected, not resolve real
 * ambiguity. A broker order lookup is also attempted if the broker exposes one AND this record
 * happens to carry a brokerOrderId — today that never holds this early (brokerOrderId is only ever
 * set once a position reaches OPEN), so this is a defensive, currently-vacuous check, not a
 * fabricated one; it future-proofs correctly if that ever changes.
 */
async function recoverPreSubmissionRecord(record: TradeLifecycleRecord, ctx: RecoveryContext): Promise<void> {
  const { broker, instrument } = ctx;

  let unexpectedPositions: unknown[];
  try {
    unexpectedPositions = broker.getOpenPositions().filter((p) => p.instrument === instrument);
  } catch (error) {
    await markAmbiguous(
      record,
      `Broker's own open-positions check failed while recovering a stale ${record.status} record: ${toErrorMessage(error)}.`,
      ctx,
    );
    return;
  }

  if (unexpectedPositions.length > 0) {
    await markAmbiguous(
      record,
      `Broker's own open-positions list unexpectedly shows ${unexpectedPositions.length} position(s) for "${instrument}" — ` +
        `this record's status (${record.status}) means no broker call should ever have happened yet.`,
      ctx,
    );
    return;
  }

  if (hasOrderLookup(broker) && record.brokerOrderId !== undefined) {
    try {
      const found = await broker.getOrderStatus(record.brokerOrderId);
      if (found) {
        await markAmbiguous(
          record,
          `Broker reports an order matching ${record.brokerOrderId}, which should never exist for a record still at ${record.status}.`,
          ctx,
        );
        return;
      }
    } catch (error) {
      await markAmbiguous(record, `Broker order lookup failed while recovering a stale ${record.status} record: ${toErrorMessage(error)}.`, ctx);
      return;
    }
  }

  await abandon(
    record,
    `No broker call could have occurred from status ${record.status} (verified: recordExecutionSubmitted always precedes any ` +
      `broker-touching call), and the broker's own open-positions read confirms nothing unexpected exists for "${instrument}".`,
    ctx,
  );
}

/** Duck-typed, optional broker order-lookup capability — matching position-reconciliation.ts's own
 * "depend on the narrowest shape needed" convention. Only Trading212DemoBroker satisfies this today
 * (getOrderStatus), and Trading212 is excluded from Prototype V1 entirely (see
 * runtime-config/compatibility.ts's own checkPrototypeV1BrokerSupport) — this capability check is
 * therefore currently always false in practice, kept for forward compatibility rather than removed. */
export interface OrderLookupBroker {
  getOrderStatus(orderId: string): Promise<unknown>;
}
export function hasOrderLookup(broker: unknown): broker is OrderLookupBroker {
  return typeof (broker as Partial<OrderLookupBroker>).getOrderStatus === "function";
}

/**
 * EXECUTION_SUBMITTED (and EXECUTION_RECONCILIATION_REQUIRED, its own unresolved leftover from a
 * previous sweep): genuinely ambiguous — the broker may have accepted the order before this
 * process crashed. Resolved only by an authoritative broker read (the same raw-portfolio capability
 * position-reconciliation.ts's own orphan-adoption path requires); a broker that cannot supply one
 * can never definitively prove absence, so this never concludes EXECUTION_ABANDONED for such a
 * broker — only EXECUTION_RECONCILIATION_REQUIRED, honestly reflecting "still unknown."
 */
async function recoverAmbiguousSubmission(record: TradeLifecycleRecord, ctx: RecoveryContext): Promise<void> {
  const { broker, instrument, strategy, brokerProvider, lifecycleStore, auditTrail, executionRunId, now } = ctx;

  if (!hasRawPortfolio(broker) || !hasInstrumentResolution(broker)) {
    await markAmbiguous(
      record,
      `Broker "${brokerProvider}" cannot supply an authoritative portfolio read — this runtime cannot prove whether the ` +
        `order behind lifecycle record ${record.id} was ever placed. Never guessing "it failed" from a missing broker_position_id alone.`,
      ctx,
    );
    return;
  }

  let resolvedInstrumentId: number;
  let matches: Array<{ positionID: number; orderID: number; instrumentID: number; isBuy?: boolean; amount?: number; openRate?: number; openDateTime?: string }>;
  try {
    resolvedInstrumentId = (await broker.resolveInstrument(instrument)).instrumentId;
    const portfolio = await broker.getRawPortfolio();
    matches = portfolio.clientPortfolio.positions.filter((p) => p.instrumentID === resolvedInstrumentId);
  } catch (error) {
    await markAmbiguous(record, `Broker portfolio read failed while recovering lifecycle record ${record.id}: ${toErrorMessage(error)}.`, ctx);
    return;
  }

  if (matches.length > 1) {
    await markAmbiguous(
      record,
      `${matches.length} live broker positions found for "${instrument}" — cannot determine which, if any, corresponds to ` +
        `lifecycle record ${record.id}.`,
      ctx,
    );
    return;
  }

  if (matches.length === 0) {
    await abandon(
      record,
      `Broker's own portfolio read confirms no matching position exists for "${instrument}" — the order behind lifecycle ` +
        `record ${record.id} was never placed, or has since closed leaving no local trace.`,
      ctx,
    );
    return;
  }

  const raw = matches[0]!;
  const brokerPositionId = String(raw.positionID);

  // Already tracked by a DIFFERENT local record? Then this stale record's own attempt did not
  // produce it — some other flow already resolved it — so THIS record is abandoned, never
  // double-attached to a position another record already owns.
  const allRecords = await lifecycleStore.list();
  const alreadyClaimedBy = allRecords.find((r) => r.id !== record.id && r.brokerPositionId === brokerPositionId);
  if (alreadyClaimedBy) {
    await abandon(
      record,
      `Broker position "${brokerPositionId}" is already tracked by a different lifecycle record (${alreadyClaimedBy.id}) — ` +
        `this record's own execution attempt did not produce it.`,
      ctx,
    );
    return;
  }

  if (raw.amount === undefined || raw.openRate === undefined) {
    await markAmbiguous(
      record,
      `Broker position "${brokerPositionId}" for "${instrument}" is missing its own reported amount/openRate — refusing to ` +
        `correlate lifecycle record ${record.id} to it without genuine entry data.`,
      ctx,
    );
    return;
  }

  if (hasPositionAdoption(broker)) {
    broker.adoptPosition(raw, instrument, {
      strategyId: strategy.strategyId,
      strategyVersion: strategy.version,
      sourceType: strategy.sourceType,
    });
  }

  assertValidTransition(record.status, "OPEN");
  await auditTrail.record({
    timestamp: now.toISOString(),
    eventType: "LIFECYCLE_RECOVERY_CORRELATED",
    executionRunId,
    strategyId: strategy.strategyId,
    instrument,
    details: { brokerProvider, brokerPositionId, lifecycleRecordId: record.id, previousStatus: record.status },
  });
  const correlated: TradeLifecycleRecord = {
    ...record,
    status: "OPEN",
    openedAt: raw.openDateTime ?? now.toISOString(),
    entryPrice: raw.openRate,
    brokerOrderId: String(raw.orderID),
    brokerPositionId,
    updatedAt: now.toISOString(),
  };
  await lifecycleStore.update(correlated);
}

/** Terminal — proves no real broker order/position exists (or no longer exists) for `record`.
 * Audits BEFORE writing the store transition; see this module's own top-of-file comment for why. */
async function abandon(record: TradeLifecycleRecord, reason: string, ctx: RecoveryContext): Promise<void> {
  const { auditTrail, executionRunId, strategy, instrument, brokerProvider, now, lifecycleStore } = ctx;
  assertValidTransition(record.status, "EXECUTION_ABANDONED");

  await auditTrail.record({
    timestamp: now.toISOString(),
    eventType: "LIFECYCLE_RECOVERY_ABANDONED",
    executionRunId,
    strategyId: strategy.strategyId,
    instrument,
    details: { brokerProvider, lifecycleRecordId: record.id, previousStatus: record.status, reason },
  });

  const abandoned: TradeLifecycleRecord = {
    ...record,
    status: "EXECUTION_ABANDONED",
    closedAt: now.toISOString(),
    exitReason: reason,
    updatedAt: now.toISOString(),
  };
  await lifecycleStore.update(abandoned);
}

/** Fails closed: transitions (or keeps) `record` at EXECUTION_RECONCILIATION_REQUIRED, remaining
 * active and blocking a fresh entry for this strategy+instrument until a later sweep resolves it.
 * Audits BEFORE writing the store transition; see this module's own top-of-file comment for why. */
async function markAmbiguous(record: TradeLifecycleRecord, reason: string, ctx: RecoveryContext): Promise<void> {
  const { auditTrail, executionRunId, strategy, instrument, brokerProvider, now, lifecycleStore } = ctx;

  await auditTrail.record({
    timestamp: now.toISOString(),
    eventType: "LIFECYCLE_RECOVERY_AMBIGUOUS",
    executionRunId,
    strategyId: strategy.strategyId,
    instrument,
    details: { brokerProvider, lifecycleRecordId: record.id, previousStatus: record.status, reason },
  });

  // Already there — nothing further to persist (a self-transition isn't in VALID_TRANSITIONS, and
  // there is nothing new to write); the audit event above still re-fires for visibility, matching
  // this codebase's own established "re-emit every cycle a failure condition persists" convention
  // (e.g. BROKER_RECONCILIATION_FAILED).
  if (record.status === "EXECUTION_RECONCILIATION_REQUIRED") return;

  assertValidTransition(record.status, "EXECUTION_RECONCILIATION_REQUIRED");
  const flagged: TradeLifecycleRecord = {
    ...record,
    status: "EXECUTION_RECONCILIATION_REQUIRED",
    error: { message: reason, occurredAt: now.toISOString() },
    updatedAt: now.toISOString(),
  };
  await lifecycleStore.update(flagged);
}
