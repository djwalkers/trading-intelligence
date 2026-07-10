import type { DecisionHistoryStore } from "./decision-history-store";
import type { DecisionHistoryStatus } from "./decision-history-status";
import type { DecisionRecord } from "./types";
import type { OutcomeUpdate } from "./outcome-analysis";
import { AuthRequiredError } from "@/lib/persistence/auth-required-error";

type StatusListener = (status: DecisionHistoryStatus) => void;

// Wraps a primary store (Supabase, when configured) with a local storage fallback — the same
// fallback-once, don't-keep-retrying shape as ResilientPaperTradeStore
// (src/lib/persistence/resilient-paper-trade-store.ts), extended with the two counters System
// Health's Decision Intelligence panel needs (recordsStored, lastRecordedAt), which paper trades
// don't track this way since Trade Journal already shows the full list directly.
export class ResilientDecisionHistoryStore implements DecisionHistoryStore {
  private active: DecisionHistoryStore;
  private readonly fallback: DecisionHistoryStore;
  private readonly usingSupabase: boolean;
  private fallenBack = false;
  private readonly listeners = new Set<StatusListener>();
  private status: DecisionHistoryStatus;

  constructor(primary: DecisionHistoryStore | null, fallback: DecisionHistoryStore) {
    this.fallback = fallback;
    this.usingSupabase = primary !== null;
    this.active = primary ?? fallback;
    this.status = {
      mode: this.usingSupabase ? "Supabase" : "Local Browser Storage",
      connected: !this.usingSupabase,
      recordsStored: 0,
      lastRecordedAt: null,
      fallbackReason: null,
    };
  }

  getStatus(): DecisionHistoryStatus {
    return this.status;
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setStatus(patch: Partial<DecisionHistoryStatus>) {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((listener) => listener(this.status));
  }

  private async run<T>(operation: (store: DecisionHistoryStore) => Promise<T>): Promise<T> {
    if (this.fallenBack || !this.usingSupabase) {
      const result = await operation(this.active);
      this.setStatus({ connected: true });
      return result;
    }

    try {
      const result = await operation(this.active);
      this.setStatus({ connected: true });
      return result;
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        // Not a broken connection — no signed-in user right now. Falling back to local storage
        // here would silently start saving decision history to an unscoped store, wrong for a
        // user-scoped app — same reasoning as ResilientPaperTradeStore.
        throw error;
      }

      const reason = error instanceof Error ? error.message : "Unknown persistence error";
      console.error("[decision-history] Supabase unavailable, falling back to local storage:", error);

      this.fallenBack = true;
      this.active = this.fallback;
      this.setStatus({
        mode: "Local Browser Storage",
        connected: true,
        fallbackReason: reason,
      });

      return operation(this.fallback);
    }
  }

  async load(): Promise<DecisionRecord[]> {
    const records = await this.run((store) => store.load());
    this.setStatus({
      recordsStored: records.length,
      lastRecordedAt: records[0]?.timestamp ?? null,
    });
    return records;
  }

  async addRecords(records: DecisionRecord[]): Promise<void> {
    await this.run((store) => store.addRecords(records));
    const [first, ...rest] = records;
    if (!first) return;
    let mostRecent = first.timestamp;
    for (const record of rest) {
      if (record.timestamp > mostRecent) mostRecent = record.timestamp;
    }
    this.setStatus({
      recordsStored: this.status.recordsStored + records.length,
      lastRecordedAt: mostRecent,
    });
  }

  // Not reflected in recordsStored/lastRecordedAt — those track new records being inserted, not
  // existing ones being reclassified. An update touches no new rows and needs no status change.
  async updateOutcomes(updates: OutcomeUpdate[]): Promise<void> {
    await this.run((store) => store.updateOutcomes(updates));
  }
}
