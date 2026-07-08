"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { PaperTrade } from "@/lib/types";
import { getPaperTradeStore } from "@/lib/persistence/get-paper-trade-store";
import { LocalStoragePaperTradeStore } from "@/lib/persistence/local-storage-paper-trade-store";
import { useAuth } from "@/lib/auth/auth-context";

const IMPORT_PROMPT_RESOLVED_KEY = "trading-intelligence.import-prompt-resolved.v1";

interface PaperTradesContextValue {
  trades: PaperTrade[];
  addTrade: (trade: PaperTrade) => void;
  closeTrade: (closedTrade: PaperTrade) => void;
  hasTradeForSignal: (signalId: string) => boolean;
  hasTradeForOpportunity: (opportunityId: string) => boolean;
  // First-run import: non-null when there's local trade history to offer importing into
  // Supabase. See the hydration effect below for exactly when this is (and isn't) set.
  importCandidate: PaperTrade[] | null;
  confirmImport: () => void;
  skipImport: () => void;
}

const PaperTradesContext = createContext<PaperTradesContextValue | null>(null);

function markImportPromptResolved() {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(IMPORT_PROMPT_RESOLVED_KEY, "true");
}

function hasResolvedImportPrompt(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(IMPORT_PROMPT_RESOLVED_KEY) === "true";
}

interface LoadedTrades {
  // Which authKey these trades were loaded for — see below. Compared against the current
  // authKey to derive isHydrated, rather than tracking it as separate state that would need
  // resetting synchronously inside the effect.
  key: string;
  trades: PaperTrade[];
}

export function PaperTradesProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState<LoadedTrades>({ key: "", trades: [] });
  const [importCandidate, setImportCandidate] = useState<PaperTrade[] | null>(null);
  const { isConfigured, isLoading: isAuthLoading, user } = useAuth();

  // Identifies "whose trades should currently be loaded." Local prototype mode never changes
  // (single shared key); Supabase mode changes whenever the signed-in user changes — including
  // signing in, signing out, or switching accounts on the same browser tab — which is exactly
  // when trades need to be re-hydrated from scratch rather than left showing the previous
  // identity's data (or nothing, if the very first hydration attempt ran before auth resolved).
  const authKey = !isConfigured ? "local" : isAuthLoading ? "pending" : (user?.id ?? "unauthenticated");

  // Neither becomes true/populated until a hydration attempt for THIS authKey has completed —
  // so switching identity (sign-in, sign-out, account switch) never shows a stale previous
  // identity's trades, even for a single render.
  const isHydrated = loaded.key === authKey;
  const trades = isHydrated ? loaded.trades : [];

  useEffect(() => {
    if (authKey === "pending") return;

    let cancelled = false;

    async function hydrate() {
      try {
        const loadedTrades = await getPaperTradeStore().load();
        if (cancelled) return;
        // One-time hydration from storage per identity, so the client's first render matches
        // the server (empty state) and avoids a hydration mismatch.
        setLoaded({ key: authKey, trades: loadedTrades });

        // First-run import offer: only when Supabase is actually the active store (not merely
        // configured — if it's unreachable we've already fallen back, and offering to "import
        // into Supabase" would be misleading), its own data is empty, the prompt hasn't already
        // been resolved once before, and there's existing local history worth offering.
        const status = getPaperTradeStore().getStatus();
        if (
          status.mode === "Supabase" &&
          loadedTrades.length === 0 &&
          !hasResolvedImportPrompt()
        ) {
          const localTrades = await new LocalStoragePaperTradeStore().load();
          if (!cancelled && localTrades.length > 0) {
            setImportCandidate(localTrades);
          }
        }
      } catch {
        // Not authenticated (AuthRequiredError) or a genuine Supabase failure — either way,
        // this identity's trade list is empty for now; the resilient store and AuthGate already
        // surface why.
        if (!cancelled) setLoaded({ key: authKey, trades: [] });
      }
    }

    hydrate();

    return () => {
      cancelled = true;
    };
  }, [authKey]);

  function addTrade(trade: PaperTrade) {
    setLoaded((previous) => ({ key: previous.key, trades: [trade, ...previous.trades] }));
    // AuthRequiredError (no session) or a genuine Supabase failure already gets its own handling
    // — AuthGate redirects to sign-in, or the persistence fallback banner appears — so there is
    // nothing further to do with the rejection here beyond not letting it go unhandled.
    getPaperTradeStore().addTrade(trade).catch(() => {});
  }

  function closeTrade(closedTrade: PaperTrade) {
    setLoaded((previous) => ({
      key: previous.key,
      trades: previous.trades.map((trade) => (trade.id === closedTrade.id ? closedTrade : trade)),
    }));
    getPaperTradeStore().closeTrade(closedTrade).catch(() => {});
  }

  function hasTradeForSignal(signalId: string) {
    return trades.some((trade) => trade.sourceSignalId === signalId);
  }

  function hasTradeForOpportunity(opportunityId: string) {
    return trades.some((trade) => trade.sourceOpportunityId === opportunityId);
  }

  function confirmImport() {
    if (!importCandidate) return;
    const store = getPaperTradeStore();

    async function runImport() {
      for (const trade of importCandidate ?? []) {
        await store.addTrade(trade);
      }
      const refreshed = await store.load();
      setLoaded({ key: authKey, trades: refreshed });
    }

    runImport()
      .catch(() => {})
      .finally(() => {
        markImportPromptResolved();
        setImportCandidate(null);
      });
  }

  function skipImport() {
    markImportPromptResolved();
    setImportCandidate(null);
  }

  return (
    <PaperTradesContext.Provider
      value={{
        trades,
        addTrade,
        closeTrade,
        hasTradeForSignal,
        hasTradeForOpportunity,
        importCandidate: isHydrated ? importCandidate : null,
        confirmImport,
        skipImport,
      }}
    >
      {children}
    </PaperTradesContext.Provider>
  );
}

export function usePaperTrades() {
  const context = useContext(PaperTradesContext);
  if (!context) {
    throw new Error("usePaperTrades must be used within a PaperTradesProvider");
  }
  return context;
}
