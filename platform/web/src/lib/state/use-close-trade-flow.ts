"use client";

import { useState } from "react";
import type { PaperTrade } from "@/lib/types";
import { usePaperTrades } from "@/lib/state/paper-trades-context";
import { getMarketDataProvider } from "@/lib/market-data/get-market-data-provider";
import { buildClosedTrade } from "@/lib/utils/paper-trade";

// Shared close-trade state so the Paper Portfolio page and Trade Journal don't each
// reimplement the same "pending close -> confirm -> update trade" wiring.
export function useCloseTradeFlow() {
  const { closeTrade } = usePaperTrades();
  const [closingTrade, setClosingTrade] = useState<PaperTrade | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [isPriceLoading, setIsPriceLoading] = useState(false);

  async function requestClose(trade: PaperTrade) {
    setClosingTrade(trade);
    setCurrentPrice(null);
    setIsPriceLoading(true);
    try {
      const quotes = await getMarketDataProvider().getQuotes([trade.instrumentSymbol]);
      setCurrentPrice(quotes[0]?.price ?? trade.entryPrice);
    } finally {
      setIsPriceLoading(false);
    }
  }

  function confirmClose() {
    if (closingTrade && currentPrice !== null) {
      closeTrade(buildClosedTrade(closingTrade, currentPrice));
    }
    setClosingTrade(null);
    setCurrentPrice(null);
  }

  function cancelClose() {
    setClosingTrade(null);
    setCurrentPrice(null);
  }

  return { closingTrade, currentPrice, isPriceLoading, requestClose, confirmClose, cancelClose };
}
