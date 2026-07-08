"use client";

import { StatCard } from "@/components/ui/StatCard";
import { useMarketDataStatus } from "@/lib/state/use-market-data-status";
import { formatDateTime } from "@/lib/utils/format";

export function MarketDataStatusCard() {
  const status = useMarketDataStatus();

  return (
    <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Provider" value={status.provider} />
      <StatCard label="Mode" value={status.mode} />
      <StatCard
        label="Last updated"
        value={status.lastUpdated ? formatDateTime(status.lastUpdated) : "Not yet fetched"}
      />
      <StatCard
        label="Instruments loaded"
        value={String(status.instrumentsLoaded)}
        sublabel={status.fallbackActive ? `Fallback active — ${status.failureReason}` : "Fallback active: No"}
      />
    </div>
  );
}
