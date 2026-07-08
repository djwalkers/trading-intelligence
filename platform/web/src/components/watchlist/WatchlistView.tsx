"use client";

import type { Instrument, StrategyScore } from "@/lib/types";
import { WatchlistTable } from "@/components/tables/WatchlistTable";
import { useMarketQuotes } from "@/lib/state/use-market-quotes";
import { useMarketDataStatus } from "@/lib/state/use-market-data-status";

interface WatchlistViewProps {
  instruments: Instrument[];
  strategyScores?: StrategyScore[];
}

// Client wrapper around WatchlistTable — the page itself stays a server component; this is the
// one seam that needs to fetch quotes and react to the live market data status.
export function WatchlistView({ instruments, strategyScores }: WatchlistViewProps) {
  const symbols = instruments.map((instrument) => instrument.symbol);
  const { quotes } = useMarketQuotes(symbols);
  const status = useMarketDataStatus();

  return (
    <WatchlistTable
      instruments={instruments}
      quotes={quotes}
      dataSource={status.source}
      strategyScores={strategyScores}
    />
  );
}
