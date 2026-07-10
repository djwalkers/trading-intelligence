"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { DecisionRecord } from "@/lib/decision-intelligence";
import { getDecisionHistoryStore, findReconcilableOutcomes, applyOutcomeUpdates } from "@/lib/decision-intelligence";
import { useAuth } from "@/lib/auth/auth-context";
import { usePaperTrades } from "@/lib/state/paper-trades-context";

interface DecisionHistoryContextValue {
  records: DecisionRecord[];
  addRecords: (records: DecisionRecord[]) => void;
}

const DecisionHistoryContext = createContext<DecisionHistoryContextValue | null>(null);

interface LoadedRecords {
  // Same "which identity was this loaded for" pattern as PaperTradesProvider — re-hydrates
  // whenever the signed-in user changes (sign-in, sign-out, switching accounts), rather than
  // showing a stale previous identity's history for even one render.
  key: string;
  records: DecisionRecord[];
}

export function DecisionHistoryProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState<LoadedRecords>({ key: "", records: [] });
  const { isConfigured, isLoading: isAuthLoading, user } = useAuth();
  const { trades } = usePaperTrades();

  const authKey = !isConfigured ? "local" : isAuthLoading ? "pending" : (user?.id ?? "unauthenticated");
  const isHydrated = loaded.key === authKey;
  const records = isHydrated ? loaded.records : [];

  useEffect(() => {
    if (authKey === "pending") return;

    let cancelled = false;

    async function hydrate() {
      try {
        const loadedRecords = await getDecisionHistoryStore().load();
        if (!cancelled) setLoaded({ key: authKey, records: loadedRecords });
      } catch {
        // Not authenticated (AuthRequiredError) or a genuine Supabase failure — either way, this
        // identity's decision history is empty for now; the resilient store already surfaces why.
        if (!cancelled) setLoaded({ key: authKey, records: [] });
      }
    }

    hydrate();

    return () => {
      cancelled = true;
    };
  }, [authKey]);

  // Mission 11 — whenever the trade list changes (a trade opens or closes, anywhere in the app),
  // check whether any accepted, still-Pending decision is now linked to a closed trade, and
  // classify it immediately. Reuses findReconcilableOutcomes(), the exact same function the
  // worker's reconciliation mode calls (src/lib/decision-intelligence/reconcile-outcomes.ts), so
  // "classified the moment you close a trade" and "classified later by the worker" can never
  // disagree. Self-limiting, not an infinite loop: applying an update makes that record no longer
  // Pending, so the next run of this same effect (triggered by the state change below) finds
  // nothing left to do. Never blocks or fails the trade-close action itself — closeTrade()
  // (paper-trades-context.tsx) already completed by the time this effect runs.
  useEffect(() => {
    if (!isHydrated) return;
    const updates = findReconcilableOutcomes(trades, loaded.records);
    if (updates.length === 0) return;

    // Deferred into a microtask rather than called synchronously in the effect body — same
    // reasoning as bot-decision-log-context.tsx's hydration effect: React's purity rule flags a
    // direct setState call here, and the update still lands practically immediately.
    Promise.resolve().then(() => {
      setLoaded((previous) => ({
        key: previous.key,
        records: applyOutcomeUpdates(previous.records, updates),
      }));
    });

    getDecisionHistoryStore()
      .updateOutcomes(updates)
      .catch((error) => {
        console.error("[decision-history] Failed to persist outcome update:", error);
      });
  }, [trades, loaded.records, isHydrated]);

  function addRecords(records: DecisionRecord[]) {
    if (records.length === 0) return;
    setLoaded((previous) => ({ key: previous.key, records: [...records, ...previous.records] }));
    // Same fire-and-forget handling as PaperTradesProvider.addTrade — AuthRequiredError or a
    // genuine Supabase failure already gets surfaced via the resilient store's status, not here.
    getDecisionHistoryStore()
      .addRecords(records)
      .catch(() => {});
  }

  return (
    <DecisionHistoryContext.Provider value={{ records, addRecords }}>
      {children}
    </DecisionHistoryContext.Provider>
  );
}

export function useDecisionHistory() {
  const context = useContext(DecisionHistoryContext);
  if (!context) {
    throw new Error("useDecisionHistory must be used within a DecisionHistoryProvider");
  }
  return context;
}
