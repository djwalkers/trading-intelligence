import { randomUUID } from "node:crypto";
import type { AuditTrail } from "../audit-trail";
import type { PaperBroker } from "../paper-broker";
import { repairCandidateForConfirmedLifecycle } from "../trade-approval/candidate-lifecycle-repair";
import type { TradeCandidateRepository } from "../trade-approval/trade-candidate-repository";
import type { InternalStrategy, OrderSizingMode, PaperPosition } from "../types";
import { TradeLifecycleUniqueConstraintViolationError, type TradeLifecycleStore } from "../trade-lifecycle/trade-lifecycle-store";
import { assertValidTransition, type TradeLifecycleRecord, type TradeLifecycleStatus } from "../trade-lifecycle/types";

// Restart-Resilient Autonomy Phase — Phase 1 (Startup and cycle reconciliation), hardened by a
// later safety review's reconciliation/state-machine pass. THE one place a live broker portfolio
// read is turned into runtime truth about whether the configured instrument already has an open
// broker position. Root cause this fixes: EtoroDemoBroker.getOpenPositions() only ever reflects
// that broker INSTANCE's own in-memory `trackedPositions` map, populated solely by
// placeMarketOrder()/closePosition() calls made through that exact instance — after a PM2 restart
// (a brand-new instance), that map is empty regardless of what eToro's own account genuinely
// holds. This module never trusts that map alone; it always asks the broker's own raw portfolio
// (`getRawPortfolio()`) for the truth, every time it's called — at startup and again at the top of
// every scheduled cycle, before any entry decision is made (see trading-runtime.ts's own
// runCycleBody).
//
// Durable-identifier discipline: matching is by the broker's own numeric `positionID` (via
// PaperPosition.brokerPositionId / TradeLifecycleRecord.brokerPositionId), never by `instrument`
// alone once a durable identifier is available — `instrument` is only ever used to filter which of
// the broker's positions are even candidates to consider (a single demo account could in principle
// hold positions in other instruments this runtime doesn't manage).
//
// Hardening pass additions (all driven by a safety review of the original Phase 1 implementation):
//  - Matching by brokerPositionId now searches every record that could plausibly carry one (OPEN,
//    CLOSE_REQUESTED, CLOSE_FAILED, CLOSED, CLOSED_UNRECONCILED), not just the "currently live"
//    subset — closes a duplicate-adoption gap where a CLOSE_FAILED record (a close attempt that
//    failed, broker position possibly still live) was invisible to the old listOpen()-only lookup.
//  - CLOSE_FAILED + broker still live -> reverts the record to OPEN (a real, validated state
//    transition) so it is retried through the normal automatic-exit path, never silently ignored
//    or re-adopted as a second record.
//  - CLOSE_FAILED/OPEN/CLOSE_REQUESTED + broker genuinely absent -> resolves to CLOSED_UNRECONCILED
//    (a real terminal status — see trade-lifecycle/types.ts) rather than leaving the record stuck
//    demanding a retry that can never succeed, WITHOUT ever fabricating an exit price or P&L.
//  - More than one local record that could represent the same real position (same brokerPositionId,
//    or more than one locally-active record for the same strategy+instrument) is detected and fails
//    closed with its own audit event, rather than silently picking one.
//  - A database (or in-memory store) uniqueness-constraint violation on adoption is caught and
//    reported as a specific reconciliation failure, not a bare, generic error.

/** One entry from eToro's own `GET .../demo/portfolio` response — see etoro-client.ts's own
 * `EtoroPosition` for the confirmed-live field set this mirrors. Declared locally (not imported
 * from etoro-client.ts/EtoroDemoBroker) so this module stays duck-typed and never depends on a
 * concrete broker class — the same "depend on the narrowest shape needed" convention already
 * established by runtime-dependency-factory.ts's own SymbolResolvableBroker/RateSourceBroker and
 * hermes-integration/broker-snapshot.ts's own RawPortfolioBroker. */
export interface RawPortfolioPosition {
  positionID: number;
  orderID: number;
  instrumentID: number;
  isBuy?: boolean;
  amount?: number;
  openRate?: number;
  openDateTime?: string;
}

export interface RawPortfolioBroker {
  getRawPortfolio(): Promise<{
    clientPortfolio: {
      positions: RawPortfolioPosition[];
      credit: number;
    };
  }>;
}

export interface InstrumentResolvableBroker {
  resolveInstrument(term: string): Promise<{ instrumentId: number }>;
}

export function hasRawPortfolio(broker: unknown): broker is RawPortfolioBroker {
  return typeof (broker as Partial<RawPortfolioBroker>).getRawPortfolio === "function";
}

export function hasInstrumentResolution(broker: unknown): broker is InstrumentResolvableBroker {
  return typeof (broker as Partial<InstrumentResolvableBroker>).resolveInstrument === "function";
}

/** Registers a broker-discovered orphaned position into the broker adapter's OWN tracking (see
 * EtoroDemoBroker.adoptPosition's own doc comment) so the existing, unmodified
 * getOpenPositions()/closePosition() can find and close it later exactly like a position this
 * process opened itself. Duck-typed; only EtoroDemoBroker satisfies this today. */
export interface PositionAdoptingBroker {
  adoptPosition(
    raw: { positionID: number; orderID: number; isBuy?: boolean; amount?: number; openRate?: number; openDateTime?: string },
    internalInstrument: string,
    strategyContext: { strategyId: string; strategyVersion: number; sourceType: InternalStrategy["sourceType"] },
  ): PaperPosition;
}

export function hasPositionAdoption(broker: unknown): broker is PositionAdoptingBroker {
  return typeof (broker as Partial<PositionAdoptingBroker>).adoptPosition === "function";
}

export interface ReconcileBrokerPositionInput {
  /** Every broker satisfies the plain PaperBroker interface (getOpenPositions() is the fallback
   * source of truth below); getRawPortfolio()/resolveInstrument() are checked as ADDITIONAL,
   * optional capabilities via hasRawPortfolio/hasInstrumentResolution, never assumed. */
  broker: PaperBroker;
  instrument: string;
  strategy: InternalStrategy;
  brokerProvider: string;
  sizingMode: OrderSizingMode;
  lifecycleStore: TradeLifecycleStore;
  /** Restart-Resilient Autonomy Phase — candidate/lifecycle repair. Used only to keep a
   * TradeCandidate's own status from permanently desyncing from a lifecycle record whose own
   * existence already proves a trade executed — see candidate-lifecycle-repair.ts's own doc
   * comment. Never used to call the broker or re-run risk checks. */
  tradeCandidateRepository: TradeCandidateRepository;
  auditTrail: AuditTrail;
  executionRunId: string;
  now: Date;
}

export type ReconcileBrokerPositionResult =
  | { ok: true; positionOpen: boolean; record?: TradeLifecycleRecord }
  | { ok: false; reason: string };

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Mirrors trade-lifecycle-store.ts's own ACTIVE_BROKER_POSITION_STATUSES: statuses that mean "a
 * real broker position genuinely exists (or very recently did) for this record," PLUS
 * EXECUTION_RECONCILIATION_REQUIRED — a genuinely ambiguous crash-window record (see
 * lifecycle-recovery.ts) that is neither known-open nor known-abandoned. Deliberately excludes
 * DECISION_CREATED/APPROVED/EXECUTION_SUBMITTED — a leftover record at one of those statuses (e.g.
 * a process that crashed between submitting an order and confirming it OPEN) cannot be reliably
 * correlated with a specific broker position by strategy+instrument alone, and is a separate, known
 * limitation (see this module's own mission-report Limitations) rather than something this
 * reconciliation pass resolves.
 *
 * Deployment safety review (final hardening pass): EXECUTION_RECONCILIATION_REQUIRED was previously
 * missing from this set, which meant `findLocalActiveRecordsForStrategyInstrument` never surfaced
 * such a record as `localRecord` — reconciliation then fell through to orphan-adoption logic,
 * which DOES already treat this status as "active" (ACTIVE_STRATEGY_INSTRUMENT_STATUSES), so a
 * subsequent `lifecycleStore.create()` for the same strategy+instrument hit a raw
 * TradeLifecycleUniqueConstraintViolationError instead of the intended, clean
 * APPROVED_CANDIDATE_EXECUTION_DEFERRED path in trading-runtime.ts's approved-candidate loop. */
const LOCAL_ACTIVE_POSITION_STATUSES = new Set<TradeLifecycleStatus>([
  "OPEN",
  "CLOSE_REQUESTED",
  "CLOSE_FAILED",
  "EXECUTION_RECONCILIATION_REQUIRED",
]);

/** Statuses reverted-to-OPEN-or-CLOSED_UNRECONCILED logic is valid from — matches
 * VALID_TRANSITIONS' own CLOSE_FAILED/OPEN/CLOSE_REQUESTED -> CLOSED_UNRECONCILED edges. */
function isReconcilableToClosedUnreconciled(status: TradeLifecycleStatus): boolean {
  return status === "OPEN" || status === "CLOSE_REQUESTED" || status === "CLOSE_FAILED";
}

// Egress-containment fix (production incident: Supabase egress ~800% over the Free-plan quota).
// Both helpers previously called store.list() — a full-table `select("*")`, JSONB `detail` blob
// included — unconditionally on every instrument's every cycle, then filtered client-side. Now
// delegate to the store's own bounded, server-side-filtered methods; by construction of migration
// 0026's own active-uniqueness indexes, each can only ever match a handful of rows.

async function findLocalActiveRecordsForStrategyInstrument(
  store: TradeLifecycleStore,
  strategyId: string,
  instrument: string,
): Promise<TradeLifecycleRecord[]> {
  return store.listActiveLifecycleRecords({ strategyId, instrument, statuses: [...LOCAL_ACTIVE_POSITION_STATUSES] });
}

async function findLocalRecordsByBrokerPositionId(store: TradeLifecycleStore, brokerPositionId: string): Promise<TradeLifecycleRecord[]> {
  return store.findLifecycleRecordsByBrokerPositionId(brokerPositionId);
}

interface ReconcileMismatchInput {
  localRecord: TradeLifecycleRecord;
  strategy: InternalStrategy;
  brokerProvider: string;
  instrument: string;
  lifecycleStore: TradeLifecycleStore;
  tradeCandidateRepository: TradeCandidateRepository;
  auditTrail: AuditTrail;
  executionRunId: string;
  now: Date;
}

/**
 * Handles "a local record thinks a position is active, but a clean, successful broker read reports
 * none" — always emits BROKER_RECONCILIATION_MISMATCH first (so the mismatch itself is always
 * visible, regardless of what happens next), then either safely resolves the record to
 * CLOSED_UNRECONCILED (broker evidence is authoritative for OPEN/CLOSE_REQUESTED/CLOSE_FAILED —
 * none of those require exit economics this runtime doesn't have) or fails closed if the record is
 * in some other status this function does not recognise as safely resolvable.
 */
async function reconcileLocalActiveButBrokerAbsent(input: ReconcileMismatchInput): Promise<ReconcileBrokerPositionResult> {
  const { localRecord, strategy, brokerProvider, instrument, lifecycleStore, tradeCandidateRepository, auditTrail, executionRunId, now } = input;

  if (!isReconcilableToClosedUnreconciled(localRecord.status)) {
    const reason =
      `Local trade lifecycle record ${localRecord.id} for "${instrument}" is in status ${localRecord.status}, but the ` +
      `broker reports no matching position — this status is not one reconciliation can safely resolve automatically.`;
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "BROKER_RECONCILIATION_MISMATCH",
      executionRunId,
      strategyId: strategy.strategyId,
      instrument,
      details: { brokerProvider, lifecycleRecordId: localRecord.id, localStatus: localRecord.status, resolution: "failed-closed", reason },
    });
    return { ok: false, reason };
  }

  assertValidTransition(localRecord.status, "CLOSED_UNRECONCILED");

  // Restart-Resilient Autonomy Phase — candidate/lifecycle repair. Deliberately BEFORE the lifecycle
  // record's own transition below: the strategy+instrument uniqueness slot is released the moment
  // CLOSED_UNRECONCILED is persisted (that status is excluded from the active-uniqueness sets), so
  // the originating candidate must already be moved out of APPROVED before that happens — otherwise
  // a still-APPROVED candidate could be picked up and executed a second time the instant the slot
  // frees up (the exact double-execution risk the deployment safety review flagged).
  await repairCandidateForConfirmedLifecycle({
    lifecycleRecord: localRecord,
    tradeCandidateRepository,
    auditTrail,
    executionRunId,
    now,
  });

  const reconciled: TradeLifecycleRecord = {
    ...localRecord,
    status: "CLOSED_UNRECONCILED",
    closedAt: now.toISOString(),
    exitReason: "reconciled-broker-position-absent",
    updatedAt: now.toISOString(),
  };
  await lifecycleStore.update(reconciled);

  await auditTrail.record({
    timestamp: now.toISOString(),
    eventType: "BROKER_RECONCILIATION_MISMATCH",
    executionRunId,
    strategyId: strategy.strategyId,
    instrument,
    details: {
      brokerProvider,
      lifecycleRecordId: localRecord.id,
      localStatus: localRecord.status,
      resolution: "reconciled-closed-unreconciled",
      warning:
        "This runtime's own record showed an active position, but the broker no longer reports one. Reconciled to " +
        "CLOSED_UNRECONCILED without a confirmed exit price or P&L — never fabricated.",
    },
  });

  return { ok: true, positionOpen: false };
}

/**
 * Reconciles the broker's own live portfolio against durable runtime state for exactly one
 * instrument. Called once at startup and again at the top of every scheduled cycle (see
 * trading-runtime.ts's own runCycleBody) — deliberately not a one-time-at-startup-only check, since
 * a position could equally be discovered mid-run (e.g. this process's own earlier BUY, or a human
 * acting directly against the same demo account).
 *
 * Every branch is fail-closed: a broker read failure, an instrument-resolution failure, an
 * ambiguous broker state (more than one live position for the configured instrument), or more than
 * one local record that could plausibly represent the same real position, all return `{ ok: false
 * }` and emit an audit event — the caller must treat that as "do not evaluate a fresh entry
 * decision this cycle," never as "assume no position exists."
 */
export async function reconcileBrokerPosition(input: ReconcileBrokerPositionInput): Promise<ReconcileBrokerPositionResult> {
  const { broker, instrument, strategy, brokerProvider, sizingMode, lifecycleStore, tradeCandidateRepository, auditTrail, executionRunId, now } = input;

  // Structural safety net, independent of which broker-read path runs below: refuse to reconcile
  // at all while more than one local record already claims to be the active position for this
  // strategy+instrument — reconciliation must never have to guess which one is authoritative.
  const localActive = await findLocalActiveRecordsForStrategyInstrument(lifecycleStore, strategy.strategyId, instrument);
  if (localActive.length > 1) {
    const reason =
      `${localActive.length} local trade lifecycle records (${localActive.map((r) => `${r.id}:${r.status}`).join(", ")}) are all ` +
      `active for strategy "${strategy.strategyId}" on "${instrument}" — refusing to reconcile without knowing which is authoritative.`;
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "DUPLICATE_LIFECYCLE_RECORD_DETECTED",
      executionRunId,
      strategyId: strategy.strategyId,
      instrument,
      details: { brokerProvider, reason, detectedBy: "local-pre-check", recordIds: localActive.map((r) => r.id) },
    });
    return { ok: false, reason };
  }
  const localRecord = localActive[0];

  // Deployment safety review (final hardening pass): EXECUTION_RECONCILIATION_REQUIRED is a
  // genuinely ambiguous crash-window record — there is no known brokerPositionId to match against
  // (unlike OPEN/CLOSE_REQUESTED/CLOSE_FAILED), and it is not "was previously confirmed active, now
  // absent" the way reconcileLocalActiveButBrokerAbsent's own CLOSED_UNRECONCILED resolution is —
  // so none of the broker-matching/orphan-adoption logic below applies to it. Treat it directly as
  // an active/unresolved position (positionOpen: true) without a `record`: this lets the
  // approved-candidate loop's own `if (currentPositionOpen)` gate defer any newly-approved BUY
  // candidate via the normal APPROVED_CANDIDATE_EXECUTION_DEFERRED path, while leaving `currentRecord`
  // undefined so exit-monitor logic and candidate-repair (both gated on a truthy record) correctly
  // do not act on unproven, ambiguous state. Resolution is left entirely to the next
  // lifecycle-recovery.ts sweep once the record becomes stale enough to re-examine.
  if (localRecord?.status === "EXECUTION_RECONCILIATION_REQUIRED") {
    return { ok: true, positionOpen: true };
  }

  // Brokers with neither capability have nothing this module can additionally reconcile against —
  // out of this phase's scope (LocalPaperBroker/Trading212/Hyperliquid; this phase's own root-cause
  // investigation is eToro-demo-specific). Falls back to the SAME broker.getOpenPositions()-derived
  // check buildMarketDecisionContext already used before this phase existed — never forced to
  // `false`, which would incorrectly ignore a real, correctly-tracked position for any of those
  // brokers (or a test double built against the plain PaperBroker interface).
  if (!hasRawPortfolio(broker) || !hasInstrumentResolution(broker)) {
    const brokerHasPosition = broker.getOpenPositions().some((p) => p.instrument === instrument);
    if (!brokerHasPosition && localRecord) {
      return await reconcileLocalActiveButBrokerAbsent({
        localRecord,
        strategy,
        brokerProvider,
        instrument,
        lifecycleStore,
        tradeCandidateRepository,
        auditTrail,
        executionRunId,
        now,
      });
    }
    return { ok: true, positionOpen: brokerHasPosition };
  }

  let resolvedInstrumentId: number;
  try {
    const resolved = await broker.resolveInstrument(instrument);
    resolvedInstrumentId = resolved.instrumentId;
  } catch (error) {
    const reason = `Could not resolve instrument "${instrument}" while reconciling broker positions: ${toErrorMessage(error)}`;
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "BROKER_RECONCILIATION_FAILED",
      executionRunId,
      strategyId: strategy.strategyId,
      instrument,
      details: { reason, brokerProvider },
    });
    return { ok: false, reason };
  }

  let portfolio: Awaited<ReturnType<RawPortfolioBroker["getRawPortfolio"]>>;
  try {
    portfolio = await broker.getRawPortfolio();
  } catch (error) {
    const reason = `Could not read the broker's own portfolio while reconciling positions for "${instrument}": ${toErrorMessage(error)}`;
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "BROKER_RECONCILIATION_FAILED",
      executionRunId,
      strategyId: strategy.strategyId,
      instrument,
      details: { reason, brokerProvider },
    });
    return { ok: false, reason };
  }

  const matches = portfolio.clientPortfolio.positions.filter((p) => p.instrumentID === resolvedInstrumentId);

  if (matches.length === 0) {
    if (localRecord) {
      return await reconcileLocalActiveButBrokerAbsent({
        localRecord,
        strategy,
        brokerProvider,
        instrument,
        lifecycleStore,
        tradeCandidateRepository,
        auditTrail,
        executionRunId,
        now,
      });
    }
    return { ok: true, positionOpen: false };
  }

  if (matches.length > 1) {
    const reason =
      `Ambiguous broker state: ${matches.length} live broker positions were found for instrument "${instrument}" ` +
      `(instrumentId ${resolvedInstrumentId}) — refusing to guess which one this runtime should manage.`;
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "BROKER_RECONCILIATION_FAILED",
      executionRunId,
      strategyId: strategy.strategyId,
      instrument,
      details: { reason, brokerProvider, positionCount: matches.length },
    });
    return { ok: false, reason };
  }

  const raw = matches[0]!;
  const brokerPositionId = String(raw.positionID);

  await auditTrail.record({
    timestamp: now.toISOString(),
    eventType: "BROKER_POSITION_DISCOVERED",
    executionRunId,
    strategyId: strategy.strategyId,
    instrument,
    details: {
      brokerProvider,
      brokerPositionId,
      brokerOrderId: String(raw.orderID),
      amount: raw.amount,
      openRate: raw.openRate,
    },
  });

  // Searches every record that could plausibly already carry this exact brokerPositionId — OPEN,
  // CLOSE_REQUESTED, CLOSE_FAILED, CLOSED, CLOSED_UNRECONCILED — never just the "currently live"
  // subset (see this module's own top-of-file comment for the duplicate-adoption bug this closes).
  const matchingRecords = await findLocalRecordsByBrokerPositionId(lifecycleStore, brokerPositionId);

  if (matchingRecords.length > 1) {
    const reason =
      `${matchingRecords.length} local trade lifecycle records (${matchingRecords.map((r) => `${r.id}:${r.status}`).join(", ")}) all ` +
      `reference broker position "${brokerPositionId}" (${brokerProvider}) — refusing to reconcile without knowing which is authoritative.`;
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "DUPLICATE_LIFECYCLE_RECORD_DETECTED",
      executionRunId,
      strategyId: strategy.strategyId,
      instrument,
      details: { brokerProvider, brokerPositionId, reason, detectedBy: "local-pre-check", recordIds: matchingRecords.map((r) => r.id) },
    });
    return { ok: false, reason };
  }

  const existing = matchingRecords[0];
  if (existing) {
    if (existing.status === "OPEN" || existing.status === "CLOSE_REQUESTED") {
      await auditTrail.record({
        timestamp: now.toISOString(),
        eventType: "BROKER_POSITION_RECONCILED",
        executionRunId,
        strategyId: strategy.strategyId,
        instrument,
        details: { brokerProvider, brokerPositionId, lifecycleRecordId: existing.id, candidateId: existing.candidateId },
      });
      return { ok: true, positionOpen: true, record: existing };
    }

    if (existing.status === "CLOSE_FAILED") {
      // The prior close attempt failed, but the broker confirms the position is still genuinely
      // live — safe to retry: revert to OPEN (a real, validated transition) so the normal
      // automatic-exit path re-evaluates and re-attempts the close next, rather than either
      // re-adopting it as a second record or leaving it permanently stuck.
      assertValidTransition("CLOSE_FAILED", "OPEN");
      const reverted: TradeLifecycleRecord = { ...existing, status: "OPEN", updatedAt: now.toISOString() };
      await lifecycleStore.update(reverted);
      await auditTrail.record({
        timestamp: now.toISOString(),
        eventType: "TRADE_LIFECYCLE_REOPENED_FOR_RETRY",
        executionRunId,
        strategyId: strategy.strategyId,
        instrument,
        details: { brokerProvider, brokerPositionId, lifecycleRecordId: existing.id },
      });
      return { ok: true, positionOpen: true, record: reverted };
    }

    // CLOSED/CLOSED_UNRECONCILED (this exact brokerPositionId already recorded as resolved
    // locally, yet the broker reports it live) or a structurally-unexpected status
    // (DECISION_CREATED/APPROVED/EXECUTION_SUBMITTED/EXECUTION_FAILED never carry a
    // brokerPositionId in practice) — genuinely anomalous either way; fail closed rather than
    // guess which side (broker or local record) is stale or wrong.
    const reason =
      `Broker reports position "${brokerPositionId}" (${brokerProvider}) for "${instrument}" as live, but local record ` +
      `${existing.id} already has it recorded as ${existing.status} — refusing to guess which is correct.`;
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "BROKER_RECONCILIATION_FAILED",
      executionRunId,
      strategyId: strategy.strategyId,
      instrument,
      details: { reason, brokerProvider, brokerPositionId, lifecycleRecordId: existing.id, localStatus: existing.status },
    });
    return { ok: false, reason };
  }

  // Orphaned — a genuinely real broker position with no durable record referencing it (the exact
  // "PM2 restarted and lost context" / "position exists at eToro but no lifecycle record exists
  // locally" scenario). Adopt it using ONLY fields the broker itself actually reported —
  // stopLoss/takeProfit stay undefined (genuinely unknown, never guessed), and
  // marketDataSnapshot/intelligenceSummary stay undefined for the same reason (no decision cycle
  // ever produced them for this position).
  if (raw.amount === undefined || raw.openRate === undefined) {
    const reason =
      `Broker position ${brokerPositionId} for "${instrument}" is missing its own reported amount/openRate — ` +
      `refusing to adopt an orphaned position without genuine entry data.`;
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "BROKER_RECONCILIATION_FAILED",
      executionRunId,
      strategyId: strategy.strategyId,
      instrument,
      details: { reason, brokerProvider, brokerPositionId },
    });
    return { ok: false, reason };
  }

  if (hasPositionAdoption(broker)) {
    broker.adoptPosition(raw, instrument, {
      strategyId: strategy.strategyId,
      strategyVersion: strategy.version,
      sourceType: strategy.sourceType,
    });
  }

  const adopted: TradeLifecycleRecord = {
    id: randomUUID(),
    candidateId: undefined,
    brokerProvider,
    strategyId: strategy.strategyId,
    strategyVersion: strategy.version,
    symbol: instrument,
    side: raw.isBuy === false ? "SELL" : "BUY",
    quantity: raw.amount,
    sizingMode,
    stopLoss: undefined,
    takeProfit: undefined,
    decision: "BUY",
    confidence: 0,
    decisionReasons: [
      "Adopted from an orphaned broker position discovered during reconciliation — no originating decision is known.",
    ],
    marketDataSnapshot: undefined,
    intelligenceSummary: undefined,
    status: "OPEN",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    openedAt: raw.openDateTime ?? now.toISOString(),
    entryPrice: raw.openRate,
    brokerOrderId: String(raw.orderID),
    brokerPositionId,
  };

  try {
    await lifecycleStore.create(adopted);
  } catch (error) {
    if (error instanceof TradeLifecycleUniqueConstraintViolationError) {
      // A race this process's own pre-checks above missed (e.g. a genuinely concurrent second
      // process) — the store's own uniqueness invariant (mirrored in-memory, enforced for real by
      // migration 0026's partial unique indexes in Supabase) caught it instead. Reported as a
      // specific reconciliation failure, never a generic TRADING_CYCLE_FAILED and never silently
      // swallowed into "adoption succeeded."
      const reason = `Refusing to adopt broker position "${brokerPositionId}" (${brokerProvider}) as a duplicate: ${error.message}`;
      await auditTrail.record({
        timestamp: now.toISOString(),
        eventType: "DUPLICATE_LIFECYCLE_RECORD_DETECTED",
        executionRunId,
        strategyId: strategy.strategyId,
        instrument,
        details: { brokerProvider, brokerPositionId, reason, detectedBy: "database-constraint" },
      });
      return { ok: false, reason };
    }
    throw error;
  }

  await auditTrail.record({
    timestamp: now.toISOString(),
    eventType: "BROKER_POSITION_ORPHANED",
    executionRunId,
    strategyId: strategy.strategyId,
    instrument,
    details: {
      brokerProvider,
      brokerPositionId,
      adoptedLifecycleRecordId: adopted.id,
      warning:
        "This position was found open at the broker with no local record — it has been adopted so it can be " +
        "monitored/closed going forward, but its stop-loss/take-profit levels are unknown (no originating candidate).",
    },
  });

  return { ok: true, positionOpen: true, record: adopted };
}
