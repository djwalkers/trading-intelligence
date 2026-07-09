"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { DecisionRecord } from "@/lib/decision-intelligence";
import { getDecisionHistoryStore } from "@/lib/decision-intelligence";
import { useAuth } from "@/lib/auth/auth-context";

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
