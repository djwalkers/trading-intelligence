import type { PaperTrade } from "@/lib/types";
import type { PaperTradeStore } from "./paper-trade-store";
import type { PersistenceStatus } from "./persistence-status";

type StatusListener = (status: PersistenceStatus) => void;

// Wraps a primary store (Supabase, when configured) with a local storage fallback. If the
// primary store ever throws — network down, RLS misconfigured, project paused, whatever — this
// falls back to local storage for that call AND every call after it in the session. It does not
// keep retrying the primary store once it has failed once ("do not fetch repeatedly"): a broken
// connection is broken until the next full page load, so there is nothing to gain from retrying
// it, only latency to lose.
export class ResilientPaperTradeStore implements PaperTradeStore {
  private active: PaperTradeStore;
  private readonly fallback: PaperTradeStore;
  private readonly usingSupabase: boolean;
  private fallenBack = false;
  private readonly listeners = new Set<StatusListener>();
  private status: PersistenceStatus;

  constructor(primary: PaperTradeStore | null, fallback: PaperTradeStore) {
    this.fallback = fallback;
    this.usingSupabase = primary !== null;
    this.active = primary ?? fallback;
    this.status = {
      mode: this.usingSupabase ? "Supabase" : "Local Browser Storage",
      connected: !this.usingSupabase,
      lastSyncedAt: null,
      fallbackReason: null,
    };
  }

  getStatus(): PersistenceStatus {
    return this.status;
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setStatus(patch: Partial<PersistenceStatus>) {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((listener) => listener(this.status));
  }

  private async run<T>(operation: (store: PaperTradeStore) => Promise<T>): Promise<T> {
    if (this.fallenBack || !this.usingSupabase) {
      const result = await operation(this.active);
      this.setStatus({ connected: true, lastSyncedAt: new Date().toISOString() });
      return result;
    }

    try {
      const result = await operation(this.active);
      this.setStatus({ connected: true, lastSyncedAt: new Date().toISOString() });
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown persistence error";
      console.error("[persistence] Supabase unavailable, falling back to local storage:", error);

      this.fallenBack = true;
      this.active = this.fallback;
      this.setStatus({
        mode: "Local Browser Storage",
        connected: true,
        fallbackReason: reason,
        lastSyncedAt: new Date().toISOString(),
      });

      return operation(this.fallback);
    }
  }

  load(): Promise<PaperTrade[]> {
    return this.run((store) => store.load());
  }

  addTrade(trade: PaperTrade): Promise<void> {
    return this.run((store) => store.addTrade(trade));
  }

  closeTrade(trade: PaperTrade): Promise<void> {
    return this.run((store) => store.closeTrade(trade));
  }
}
