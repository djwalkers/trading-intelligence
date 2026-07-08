"use client";

import { useState } from "react";
import { getMarketDataProvider } from "@/lib/market-data/get-market-data-provider";
import type { EntryPriceInfo } from "@/lib/types";

// Shared "request a live entry price, then let the user confirm" flow for both Signals and
// Market Intelligence paper trades — mirrors useCloseTradeFlow's async pattern (Build 1.0.0),
// but for entry rather than exit. Generic over the source object (Signal or Opportunity) so both
// call sites can keep it available synchronously (for instrument/side/confidence display) while
// only the price itself is asynchronous.
export function usePaperTradeEntryFlow<TSource>() {
  const [pendingSource, setPendingSource] = useState<TSource | null>(null);
  const [entryPriceInfo, setEntryPriceInfo] = useState<EntryPriceInfo | null>(null);
  const [isPriceLoading, setIsPriceLoading] = useState(false);

  async function requestTrade(symbol: string, source: TSource) {
    setPendingSource(source);
    setEntryPriceInfo(null);
    setIsPriceLoading(true);
    try {
      const quotes = await getMarketDataProvider().getQuotes([symbol]);
      const quote = quotes[0];
      const status = getMarketDataProvider().getStatus();
      setEntryPriceInfo({
        price: quote?.price ?? 0,
        source: status.source,
        provider: status.provider,
        timestamp: quote?.lastUpdated ?? new Date().toISOString(),
        mode: status.mode,
      });
    } catch {
      // Leave entryPriceInfo null — the modal keeps Confirm disabled until a price resolves.
    } finally {
      setIsPriceLoading(false);
    }
  }

  function cancelTrade() {
    setPendingSource(null);
    setEntryPriceInfo(null);
  }

  return { pendingSource, entryPriceInfo, isPriceLoading, requestTrade, cancelTrade };
}
