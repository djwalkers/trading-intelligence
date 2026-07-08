"use client";

import { useEffect, useState } from "react";
import { getMarketDataProvider } from "@/lib/market-data/get-market-data-provider";
import type { MarketDataStatus } from "@/lib/types";

// Mirrors usePersistenceStatus — the initial status (provider/mode from env presence) is
// identical on server and client, so there is no hydration-mismatch risk reading it eagerly.
export function useMarketDataStatus(): MarketDataStatus {
  const [status, setStatus] = useState<MarketDataStatus>(() => getMarketDataProvider().getStatus());

  useEffect(() => {
    return getMarketDataProvider().subscribeStatus(setStatus);
  }, []);

  return status;
}
