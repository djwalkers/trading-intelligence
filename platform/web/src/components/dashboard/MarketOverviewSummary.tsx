"use client";

import { Badge } from "@/components/ui/Badge";
import { useMarketDataStatus } from "@/lib/state/use-market-data-status";

// Build 1.12.0 — one line answering "can I trust these prices," condensed from the full
// Market Data settings/health views (Settings, Operations Centre) into something that fits
// naturally under the Watchlist snapshot on the Dashboard.
export function MarketOverviewSummary() {
  const status = useMarketDataStatus();

  return (
    <div className="flex flex-wrap items-center gap-2 px-5 pb-4 text-xs text-ink-500">
      <span>Prices:</span>
      <Badge
        className={
          status.source === "External"
            ? "border-accent-blue/25 bg-accent-blue/10 text-accent-blue"
            : "border-base-600 bg-base-800 text-ink-300"
        }
      >
        {status.provider}
      </Badge>
      {status.fallbackActive ? (
        <span className="text-accent-amber">Fallback active — {status.failureReason}</span>
      ) : null}
    </div>
  );
}
