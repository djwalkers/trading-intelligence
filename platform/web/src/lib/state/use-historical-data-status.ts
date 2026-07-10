"use client";

import { useEffect, useState } from "react";
import { getHistoricalMarketDataProvider } from "@/lib/market-data/get-historical-market-data-provider";
import type { HistoricalDataStatus } from "@/lib/types";

// Mirrors useMarketDataStatus exactly, for the historical data provider instead of live quotes.
// The status only ever changes once something in this browser tab actually requests history —
// today, that's a Bot Runner scan (src/lib/bot/bot-runner.ts calls
// StrategyEngine.evaluateAllWithHistory(), which calls getHistoricalMarketDataProvider()) — so a
// tab that hasn't run a scan yet correctly shows the provider's initial, untouched state.
export function useHistoricalDataStatus(): HistoricalDataStatus {
  const [status, setStatus] = useState<HistoricalDataStatus>(() =>
    getHistoricalMarketDataProvider().getStatus(),
  );

  useEffect(() => {
    return getHistoricalMarketDataProvider().subscribeStatus(setStatus);
  }, []);

  return status;
}
