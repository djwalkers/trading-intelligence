"use client";

import { Badge } from "@/components/ui/Badge";
import { useMarketDataStatus } from "@/lib/state/use-market-data-status";
import { formatDateTime } from "@/lib/utils/format";

// Live, not mocked — mirrors PersistenceStatusPanel, reading the same status object the
// ResilientMarketDataProvider itself tracks.
export function MarketDataStatusPanel() {
  const status = useMarketDataStatus();

  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Live prices</span>
          <span className="text-xs text-ink-500">
            {status.source === "External"
              ? "Prices are fetched from a connected market data provider."
              : "Prices are served from sample instrument data."}
          </span>
        </div>
        <Badge
          className={
            status.source === "External"
              ? "border-accent-blue/25 bg-accent-blue/10 text-accent-blue"
              : "border-base-600 bg-base-800 text-ink-300"
          }
        >
          {status.provider}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Connection</span>
          {status.failureReason ? (
            <span className="text-xs text-accent-amber">{status.failureReason}</span>
          ) : (
            <span className="text-xs text-ink-500">
              {status.mode === "Connected" ? "Live connection to provider" : "No live connection needed"}
            </span>
          )}
        </div>
        <Badge
          className={
            status.mode === "Connected"
              ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
              : status.mode === "Fallback"
                ? "border-accent-amber/30 bg-accent-amber/10 text-accent-amber"
                : "border-base-600 bg-base-800 text-ink-300"
          }
        >
          {status.mode}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Last successful refresh</span>
          <span className="text-xs text-ink-500">Most recent successful quote fetch</span>
        </div>
        <span className="text-sm text-ink-300">
          {status.lastUpdated ? formatDateTime(status.lastUpdated) : "Not yet fetched"}
        </span>
      </div>
    </div>
  );
}
