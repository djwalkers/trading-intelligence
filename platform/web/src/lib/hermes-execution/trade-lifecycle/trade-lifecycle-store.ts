import type { TradeLifecycleRecord } from "./types";

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
   * EXECUTION_FAILED/CLOSE_FAILED — none of those represent a position that currently exists. */
  listOpen(): Promise<TradeLifecycleRecord[]>;
  /** Records whose trade has fully, successfully closed — status CLOSED only. */
  listClosed(): Promise<TradeLifecycleRecord[]>;
}

const OPEN_STATUSES = new Set(["OPEN", "CLOSE_REQUESTED"]);

/** Fully isolated, no I/O — used by tests and (for now) the CLI demo, same role
 * InMemoryPaperBrokerStore/InMemoryAuditTrail already play for their own domains. Every record
 * returned is `structuredClone`d on the way in and out, so callers can never mutate this store's
 * internal state by holding a reference to a record they were handed — same discipline
 * InMemoryPaperBrokerStore already applies to PaperBrokerState. */
export class InMemoryTradeLifecycleStore implements TradeLifecycleStore {
  private readonly records = new Map<string, TradeLifecycleRecord>();

  async create(record: TradeLifecycleRecord): Promise<void> {
    if (this.records.has(record.id)) {
      throw new Error(`TradeLifecycleRecord "${record.id}" already exists — create() refuses to overwrite it.`);
    }
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
}
