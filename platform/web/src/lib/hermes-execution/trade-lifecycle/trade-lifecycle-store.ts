import type { TradeLifecycleRecord, TradeLifecycleStatus } from "./types";

// Milestone 6 — Trade Lifecycle & Performance Tracking. Same "clean, swappable persistence
// adapter" pattern as PaperBrokerStore (paper-broker-store.ts) and RegistryClient — the execution
// pipeline depends only on this interface, so a future real store (filesystem, database, ...)
// swaps in without touching TradeLifecycleService or anything upstream of it. Deliberately no such
// implementation exists yet in this milestone — see the mission report's Limitations section.

export interface TradeLifecycleStore {
  create(record: TradeLifecycleRecord): Promise<void>;
  getById(id: string): Promise<TradeLifecycleRecord | null>;
  update(record: TradeLifecycleRecord): Promise<void>;
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

  async list(): Promise<TradeLifecycleRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async listOpen(): Promise<TradeLifecycleRecord[]> {
    return (await this.list()).filter((record) => OPEN_STATUSES.has(record.status));
  }

  async listClosed(): Promise<TradeLifecycleRecord[]> {
    return (await this.list()).filter((record) => record.status === "CLOSED");
  }

  async listUnreconciled(): Promise<TradeLifecycleRecord[]> {
    return (await this.list()).filter((record) => record.status === "CLOSED_UNRECONCILED");
  }
}
