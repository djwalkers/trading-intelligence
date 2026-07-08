"use client";

import { useEffect, useState } from "react";
import { getMarketDataProvider } from "@/lib/market-data/get-market-data-provider";
import type { MarketQuote } from "@/lib/types";

interface UseMarketQuotesResult {
  quotes: Record<string, MarketQuote>;
  prices: Record<string, number>;
  isLoading: boolean;
}

interface LoadedQuotes {
  key: string;
  quotes: Record<string, MarketQuote>;
}

// Loads quotes once per distinct symbol set and caches them in component state — no polling, no
// refetch on every render. The dependency is the sorted, joined symbol string rather than the
// array itself, so a caller passing a fresh array literal with the same contents on every render
// does not trigger a refetch ("load once, cache, refresh only when required"). `isLoading` is
// derived by comparing the resolved key against the current one, rather than a separate setState
// call in the effect body, so quotes only ever change from inside the async callback.
export function useMarketQuotes(symbols: string[]): UseMarketQuotesResult {
  const key = symbols.slice().sort().join(",");
  const [loaded, setLoaded] = useState<LoadedQuotes>({ key: "", quotes: {} });

  useEffect(() => {
    let cancelled = false;

    getMarketDataProvider()
      .getQuotes(key ? key.split(",") : [])
      .then((result) => {
        if (cancelled) return;
        const map: Record<string, MarketQuote> = {};
        result.forEach((quote) => {
          map[quote.symbol] = quote;
        });
        setLoaded({ key, quotes: map });
      });

    return () => {
      cancelled = true;
    };
  }, [key]);

  const isLoading = loaded.key !== key;
  const quotes = isLoading ? {} : loaded.quotes;

  const prices: Record<string, number> = {};
  Object.values(quotes).forEach((quote) => {
    prices[quote.symbol] = quote.price;
  });

  return { quotes, prices, isLoading };
}
