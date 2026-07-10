import type { PaperTrade } from "@/lib/types";
import type { PaperTradeStore } from "./paper-trade-store";
import type { PersistenceStatus } from "./persistence-status";
import { AuthRequiredError } from "./auth-required-error";
import { logger } from "@/lib/logger/logger";
import { pushToastOnce } from "@/lib/notifications/toast-bus";

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
  // Build 1.13.0 — "avoid repeatedly displaying the same warning": the fallback-to-local-storage
  // toast fires at most once per store instance (i.e. once per session), even though `run()` is
  // called on every trade action.
  private readonly fallbackWarnedRef = { current: false };

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
      if (error instanceof AuthRequiredError) {
        // Not a broken connection — the backend is fine, there's just no signed-in user right
        // now. Falling back to local storage here would be wrong for a user-scoped app (it would
        // silently start saving to an unscoped store instead of surfacing that sign-in is
        // needed), so this rethrows rather than falling back. AuthGate is what actually redirects
        // the user to sign in; this just refuses to write in the meantime.
        throw error;
      }

      const reason = error instanceof Error ? error.message : "Unknown persistence error";
      logger.error("Supabase unavailable, falling back to local storage", {
        component: "persistence",
        errorCode: "PERSISTENCE_ERROR",
        reason,
      });
      pushToastOnce(
        "warning",
        "Your database is unavailable — trades are being saved to this browser only until you reload.",
        this.fallbackWarnedRef,
      );

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
