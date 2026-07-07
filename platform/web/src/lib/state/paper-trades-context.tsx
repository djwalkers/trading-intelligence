"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { PaperTrade } from "@/lib/types";
import { getPaperTradeStore } from "@/lib/persistence/get-paper-trade-store";

interface PaperTradesContextValue {
  trades: PaperTrade[];
  addTrade: (trade: PaperTrade) => void;
  updateTrade: (updatedTrade: PaperTrade) => void;
  hasTradeForSignal: (signalId: string) => boolean;
  hasTradeForOpportunity: (opportunityId: string) => boolean;
}

const PaperTradesContext = createContext<PaperTradesContextValue | null>(null);

export function PaperTradesProvider({ children }: { children: ReactNode }) {
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      try {
        const loaded = await getPaperTradeStore().load();
        if (cancelled) return;
        // One-time hydration from storage after mount, so the client's first render matches
        // the server (empty state) and avoids a hydration mismatch.
        setTrades(loaded);
      } catch {
        // Corrupt or inaccessible storage — start from an empty trade log.
      } finally {
        if (!cancelled) setIsHydrated(true);
      }
    }

    hydrate();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    getPaperTradeStore().save(trades);
  }, [trades, isHydrated]);

  function addTrade(trade: PaperTrade) {
    setTrades((previous) => [trade, ...previous]);
  }

  function updateTrade(updatedTrade: PaperTrade) {
    setTrades((previous) =>
      previous.map((trade) => (trade.id === updatedTrade.id ? updatedTrade : trade)),
    );
  }

  function hasTradeForSignal(signalId: string) {
    return trades.some((trade) => trade.sourceSignalId === signalId);
  }

  function hasTradeForOpportunity(opportunityId: string) {
    return trades.some((trade) => trade.sourceOpportunityId === opportunityId);
  }

  return (
    <PaperTradesContext.Provider
      value={{ trades, addTrade, updateTrade, hasTradeForSignal, hasTradeForOpportunity }}
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
