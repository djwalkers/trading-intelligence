"use client";

import { useState } from "react";
import type { PaperTrade } from "@/lib/types";
import { usePaperTrades } from "@/lib/state/paper-trades-context";
import { buildClosedTrade } from "@/lib/utils/paper-trade";

// Shared close-trade state so the Paper Portfolio page and Trade Journal don't each
// reimplement the same "pending close -> confirm -> update trade" wiring.
export function useCloseTradeFlow() {
  const { updateTrade } = usePaperTrades();
  const [closingTrade, setClosingTrade] = useState<PaperTrade | null>(null);

  function requestClose(trade: PaperTrade) {
    setClosingTrade(trade);
  }

  function confirmClose() {
    if (closingTrade) {
      updateTrade(buildClosedTrade(closingTrade));
    }
    setClosingTrade(null);
  }

  function cancelClose() {
    setClosingTrade(null);
  }

  return { closingTrade, requestClose, confirmClose, cancelClose };
}
