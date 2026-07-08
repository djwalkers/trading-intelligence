"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { PaperTrade } from "@/lib/types";
import { getPaperTradeStore } from "@/lib/persistence/get-paper-trade-store";
import { LocalStoragePaperTradeStore } from "@/lib/persistence/local-storage-paper-trade-store";

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

export function PaperTradesProvider({ children }: { children: ReactNode }) {
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const [importCandidate, setImportCandidate] = useState<PaperTrade[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      try {
        const loaded = await getPaperTradeStore().load();
        if (cancelled) return;
        // One-time hydration from storage after mount, so the client's first render matches
        // the server (empty state) and avoids a hydration mismatch.
        setTrades(loaded);

        // First-run import offer: only when Supabase is actually the active store (not merely
        // configured — if it's unreachable we've already fallen back, and offering to "import
        // into Supabase" would be misleading), its own data is empty, the prompt hasn't already
        // been resolved once before, and there's existing local history worth offering.
        const status = getPaperTradeStore().getStatus();
        if (
          status.mode === "Supabase" &&
          loaded.length === 0 &&
          !hasResolvedImportPrompt()
        ) {
          const localTrades = await new LocalStoragePaperTradeStore().load();
          if (!cancelled && localTrades.length > 0) {
            setImportCandidate(localTrades);
          }
        }
      } catch {
        // The resilient store already handles and surfaces persistence failures; nothing
        // further to do here beyond leaving the trade list empty.
      } finally {
        if (!cancelled) setIsHydrated(true);
      }
    }

    hydrate();

    return () => {
      cancelled = true;
    };
  }, []);

  function addTrade(trade: PaperTrade) {
    setTrades((previous) => [trade, ...previous]);
    getPaperTradeStore().addTrade(trade);
  }

  function closeTrade(closedTrade: PaperTrade) {
    setTrades((previous) =>
      previous.map((trade) => (trade.id === closedTrade.id ? closedTrade : trade)),
    );
    getPaperTradeStore().closeTrade(closedTrade);
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
      setTrades(refreshed);
    }

    runImport().finally(() => {
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
