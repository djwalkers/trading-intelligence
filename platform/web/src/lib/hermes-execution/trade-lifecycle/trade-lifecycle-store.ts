import type { TradeLifecycleRecord, TradeLifecycleStatus } from "./types";
import { countConfirmedEntriesForUtcDayFromRecords, type ConfirmedEntryCountRangeScope } from "./confirmed-entry-count";

// Milestone 6 — Trade Lifecycle & Performance Tracking. Same "clean, swappable persistence
// adapter" pattern as PaperBrokerStore (paper-broker-store.ts) and RegistryClient — the execution
// pipeline depends only on this interface, so a future real store (filesystem, database, ...)
// swaps in without touching TradeLifecycleService or anything upstream of it. Deliberately no such
// implementation exists yet in this milestone — see the mission report's Limitations section.

/** Egress-containment fix. Scopes a strategy+instrument lookup to an explicit status set — shared
 * shape for every store method below whose caller only ever needs the (by construction, at most a
 * handful of rows) active/in-flight records for ONE strategy+instrument, never the whole table. */
export interface LifecycleRecordsByStrategyInstrumentScope {
  strategyId: string;
  instrument: string;
  statuses: readonly TradeLifecycleStatus[];
}

/** Egress-containment fix. Same shape as LifecycleRecordsByStrategyInstrumentScope, plus the
 * staleness cutoff runtime/lifecycle-recovery.ts's own sweep needs — only a record last updated
 * BEFORE `updatedBefore` is stale enough to act on. */
export interface RecoverableLifecycleRecordsScope extends LifecycleRecordsByStrategyInstrumentScope {
  /** ISO 8601 — only records whose updatedAt is at or before this are returned (matches the original
   * `now - updatedAtMs >= thresholdMs` staleness check: caller computes `now - recoveryThresholdMs`
   * once and passes it here). */
  updatedBefore: string;
}

export interface ClosedTradeRealisedPnlAggregate {
  realisedPnl: number;
  realisedTradeCount: number;
}

export interface TradeLifecycleStore {
  create(record: TradeLifecycleRecord): Promise<void>;
  getById(id: string): Promise<TradeLifecycleRecord | null>;
  update(record: TradeLifecycleRecord): Promise<void>;
  /** Downloads every record this user owns — every JSONB `detail` blob included. Egress-containment
   * fix: NEVER call this from a per-cycle runtime hot path or a polled API route — see this file's
   * own confirmedEntryCount/listActive/listRecoverable/findByBrokerPositionId methods below for the
   * bounded, purpose-built alternative every such caller has been migrated to. Retained for
   * genuinely whole-table use cases only (operator tooling, tests). */
  list(): Promise<TradeLifecycleRecord[]>;
  /** Records whose position is currently live on the broker — status OPEN (fully live) or
   * CLOSE_REQUESTED (a close is in flight but not yet confirmed, so the position still exists).
   * Deliberately excludes DECISION_CREATED/RISK_REJECTED/APPROVED/EXECUTION_SUBMITTED/
   * EXECUTION_FAILED/CLOSE_FAILED/CLOSED_UNRECONCILED/EXECUTION_ABANDONED/
   * EXECUTION_RECONCILIATION_REQUIRED — none of those represent a position that currently, provenly
   * exists. */
  listOpen(): Promise<TradeLifecycleRecord[]>;
  /** Records whose trade has fully, successfully closed — status CLOSED only. Deliberately excludes
   * CLOSED_UNRECONCILED and EXECUTION_ABANDONED: neither has confirmed exit economics, so neither
   * must ever be picked up by trade-performance reporting (which requires a real entry/exit price)
   * as if it were. */
  listClosed(): Promise<TradeLifecycleRecord[]>;
  /** Missing-financial-data fix. Records whose close was submitted to the broker but never
   * confirmed reconciled — status CLOSED_UNRECONCILED only. These have NO trustworthy exit price/
   * realisedPnl (that is exactly why they're unreconciled), so realised-P/L aggregation must never
   * fold them in as if they were zero-P/L closed trades — but the count still matters, so a reader
   * can see that some closed positions are excluded from the realised-P/L total rather than
   * concluding there simply were none. */
  listUnreconciled(): Promise<TradeLifecycleRecord[]>;

  /** Egress-containment fix (production incident — Supabase egress ~800% over the Free-plan quota,
   * traced to this exact call downloading the entire table every runtime cycle). Bounded, server-side
   * count of confirmed-OPEN-today entries for one strategy — see confirmed-entry-count.ts's own doc
   * comment for the full counting semantics this must reproduce exactly. The Supabase implementation
   * performs the filtering and counting in Postgres (`count: "exact", head: true`), never downloading
   * matching rows, let alone the whole table. */
  countConfirmedEntriesForUtcDay(scope: ConfirmedEntryCountRangeScope): Promise<number>;

  /** Egress-containment fix. The bounded replacement for "download every record, then filter by
   * strategy+instrument+status client-side" — used by position-reconciliation.ts's local-active-
   * record check and duplicate-prevention.ts's in-flight check. By construction of migration 0026's
   * own active-strategy-instrument uniqueness index, at most one row can ever match. */
  listActiveLifecycleRecords(scope: LifecycleRecordsByStrategyInstrumentScope): Promise<TradeLifecycleRecord[]>;

  /** Egress-containment fix. The bounded replacement for lifecycle-recovery.ts's own "download every
   * record, then filter by strategy+instrument+status+staleness client-side" crash-window sweep. */
  listRecoverableLifecycleRecords(scope: RecoverableLifecycleRecordsScope): Promise<TradeLifecycleRecord[]>;

  /** Egress-containment fix. The bounded replacement for "download every record, then filter by
   * brokerPositionId client-side" — filters on the already-indexed broker_position_id column. */
  findLifecycleRecordsByBrokerPositionId(brokerPositionId: string): Promise<TradeLifecycleRecord[]>;

  /** Egress-containment fix. Realised P/L for GET /api/hermes/portfolio previously came from
   * downloading every CLOSED record's full row (JSONB `detail` blob included) just to sum one
   * numeric column. Selects/sums only `realised_pnl`. */
  sumRealisedPnlForClosedTrades(): Promise<ClosedTradeRealisedPnlAggregate>;

  /** Egress-containment fix. The same route previously downloaded every CLOSED_UNRECONCILED
   * record's full row just to read `.length`. Count-only. */
  countUnreconciledClosedTrades(): Promise<number>;
}

const OPEN_STATUSES = new Set(["OPEN", "CLOSE_REQUESTED"]);

/** Restart-Resilient Autonomy Phase — reconciliation hardening. Thrown by both store
 * implementations (this in-memory one, and SupabaseTradeLifecycleStore translating a Postgres
 * unique-violation) so callers — specifically position-reconciliation.ts — can detect "this create/
 * update collided with the one-active-record-per-broker-position / one-active-record-per-strategy-
 * instrument invariant" in an implementation-agnostic way, and turn it into a specific
 * reconciliation failure rather than either a generic persistence error or (worse) a silently
 * duplicated record. Mirrors supabase/migrations/0026_trade_lifecycle_records.sql's own two partial
 * unique indexes — see ACTIVE_BROKER_POSITION_STATUSES/ACTIVE_STRATEGY_INSTRUMENT_STATUSES below for
 * this store's equivalent, so dev/tests exercise the exact same invariant the database enforces in
 * production. */
export class TradeLifecycleUniqueConstraintViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TradeLifecycleUniqueConstraintViolationError";
  }
}

/** Mirrors migration 0026's trade_lifecycle_records_active_broker_position_uidx.
 * EXECUTION_RECONCILIATION_REQUIRED included defensively (it typically has no broker_position_id
 * yet — that is exactly why it's ambiguous — but if one is ever known, it must still count).
 * EXECUTION_ABANDONED deliberately excluded — terminal, releases the slot. */
const ACTIVE_BROKER_POSITION_STATUSES = new Set<TradeLifecycleStatus>([
  "OPEN",
  "CLOSE_REQUESTED",
  "CLOSE_FAILED",
  "EXECUTION_RECONCILIATION_REQUIRED",
]);
/** Mirrors migration 0026's trade_lifecycle_records_active_strategy_instrument_uidx.
 * EXECUTION_RECONCILIATION_REQUIRED must remain active — an unresolved crash-window record still
 * blocks a fresh entry for the same strategy+instrument until a later recovery sweep resolves it.
 * EXECUTION_ABANDONED deliberately excluded — terminal, releases the slot. */
const ACTIVE_STRATEGY_INSTRUMENT_STATUSES = new Set<TradeLifecycleStatus>([
  "DECISION_CREATED",
  "APPROVED",
  "EXECUTION_SUBMITTED",
  "OPEN",
  "CLOSE_REQUESTED",
  "CLOSE_FAILED",
  "EXECUTION_RECONCILIATION_REQUIRED",
]);

/** Fully isolated, no I/O — used by tests and (for now) the CLI demo, same role
 * InMemoryPaperBrokerStore/InMemoryAuditTrail already play for their own domains. Every record
 * returned is `structuredClone`d on the way in and out, so callers can never mutate this store's
 * internal state by holding a reference to a record they were handed — same discipline
 * InMemoryPaperBrokerStore already applies to PaperBrokerState. */
export class InMemoryTradeLifecycleStore implements TradeLifecycleStore {
  private readonly records = new Map<string, TradeLifecycleRecord>();

  private assertNoActiveClash(record: TradeLifecycleRecord, excludeId?: string): void {
    if (ACTIVE_BROKER_POSITION_STATUSES.has(record.status) && record.brokerPositionId !== undefined) {
      const clash = [...this.records.values()].find(
        (r) =>
          r.id !== excludeId &&
          r.brokerProvider === record.brokerProvider &&
          r.brokerPositionId === record.brokerPositionId &&
          ACTIVE_BROKER_POSITION_STATUSES.has(r.status),
      );
      if (clash) {
        throw new TradeLifecycleUniqueConstraintViolationError(
          `An active trade lifecycle record ("${clash.id}", status ${clash.status}) already exists for broker position ` +
            `"${record.brokerPositionId}" (${record.brokerProvider}).`,
        );
      }
    }
    if (ACTIVE_STRATEGY_INSTRUMENT_STATUSES.has(record.status)) {
      const clash = [...this.records.values()].find(
        (r) =>
          r.id !== excludeId &&
          r.strategyId === record.strategyId &&
          r.symbol === record.symbol &&
          ACTIVE_STRATEGY_INSTRUMENT_STATUSES.has(r.status),
      );
      if (clash) {
        throw new TradeLifecycleUniqueConstraintViolationError(
          `An active trade lifecycle record ("${clash.id}", status ${clash.status}) already exists for strategy ` +
            `"${record.strategyId}" on "${record.symbol}".`,
        );
      }
    }
  }

  async create(record: TradeLifecycleRecord): Promise<void> {
    if (this.records.has(record.id)) {
      throw new Error(`TradeLifecycleRecord "${record.id}" already exists — create() refuses to overwrite it.`);
    }
    this.assertNoActiveClash(record);
    this.records.set(record.id, structuredClone(record));
  }

  async getById(id: string): Promise<TradeLifecycleRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async update(record: TradeLifecycleRecord): Promise<void> {
    if (!this.records.has(record.id)) {
      throw new Error(`Cannot update unknown TradeLifecycleRecord "${record.id}" — call create() first.`);
    }
    this.assertNoActiveClash(record, record.id);
    this.records.set(record.id, structuredClone(record));
  }

  /** Every list-shaped method (including the new bounded ones below) reads through here rather than
   * through the public list() — so a caller/test that specifically wants to prove "this code path
   * never fetches the whole table" can spy on list() and see it genuinely uncalled, matching what a
   * bounded Supabase query call site actually achieves (it never issues the unbounded query either).
   * No egress cost of its own either way (in-process Map) — this is about keeping the two store
   * implementations' call-site-visible behaviour equivalent, not performance. */
  private snapshot(): TradeLifecycleRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async list(): Promise<TradeLifecycleRecord[]> {
    return this.snapshot();
  }

  async listOpen(): Promise<TradeLifecycleRecord[]> {
    return this.snapshot().filter((record) => OPEN_STATUSES.has(record.status));
  }

  async listClosed(): Promise<TradeLifecycleRecord[]> {
    return this.snapshot().filter((record) => record.status === "CLOSED");
  }

  async listUnreconciled(): Promise<TradeLifecycleRecord[]> {
    return this.snapshot().filter((record) => record.status === "CLOSED_UNRECONCILED");
  }

  // --- Egress-containment fix — bounded methods. No egress cost of its own (in-process Map), so
  // these simply reuse snapshot() + the same filtering a bounded Supabase query expresses server-side
  // — see supabase-trade-lifecycle-store.ts's own equivalents for the actual bounded queries these
  // exist to make production runtime code able to call identically regardless of store backend.

  async countConfirmedEntriesForUtcDay(scope: ConfirmedEntryCountRangeScope): Promise<number> {
    return countConfirmedEntriesForUtcDayFromRecords(this.snapshot(), scope);
  }

  async listActiveLifecycleRecords(scope: LifecycleRecordsByStrategyInstrumentScope): Promise<TradeLifecycleRecord[]> {
    const statuses = new Set(scope.statuses);
    return this.snapshot().filter(
      (record) => record.strategyId === scope.strategyId && record.symbol === scope.instrument && statuses.has(record.status),
    );
  }

  async listRecoverableLifecycleRecords(scope: RecoverableLifecycleRecordsScope): Promise<TradeLifecycleRecord[]> {
    const statuses = new Set(scope.statuses);
    const updatedBeforeMs = Date.parse(scope.updatedBefore);
    return this.snapshot().filter((record) => {
      if (record.strategyId !== scope.strategyId || record.symbol !== scope.instrument || !statuses.has(record.status)) return false;
      const updatedAtMs = Date.parse(record.updatedAt);
      return Number.isFinite(updatedAtMs) && updatedAtMs <= updatedBeforeMs;
    });
  }

  async findLifecycleRecordsByBrokerPositionId(brokerPositionId: string): Promise<TradeLifecycleRecord[]> {
    return this.snapshot().filter((record) => record.brokerPositionId === brokerPositionId);
  }

  async sumRealisedPnlForClosedTrades(): Promise<ClosedTradeRealisedPnlAggregate> {
    const closed = this.snapshot().filter((record) => record.status === "CLOSED" && record.realisedPnl !== undefined);
    return { realisedPnl: closed.reduce((sum, record) => sum + (record.realisedPnl ?? 0), 0), realisedTradeCount: closed.length };
  }

  async countUnreconciledClosedTrades(): Promise<number> {
    return this.snapshot().filter((record) => record.status === "CLOSED_UNRECONCILED").length;
  }
}
