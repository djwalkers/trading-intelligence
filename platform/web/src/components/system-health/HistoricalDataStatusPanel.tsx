"use client";

import { Badge } from "@/components/ui/Badge";
import { useHistoricalDataStatus } from "@/lib/state/use-historical-data-status";
import { formatDateTime } from "@/lib/utils/format";

// Live, not mocked — mirrors MarketDataStatusPanel, reading the status
// ResilientHistoricalMarketDataProvider tracks. Populated once a scan has run in this browser tab.
//
// Real candles come from a connected market data provider, but only the always-on server-based
// scanning (Settings) can reach it — that provider's key is never exposed to the browser, so this
// browser tab always uses sample history for its own manual scans. That's expected, not a fault;
// see the disclosure at the bottom of this panel.
export function HistoricalDataStatusPanel() {
  const status = useHistoricalDataStatus();

  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Historical market data</span>
          <span className="text-xs text-ink-500">
            {status.source === "External"
              ? "Price history is fetched from a connected market data provider."
              : "Price history is generated from sample instrument data."}
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
          <span className="text-sm font-medium text-ink-100">Instruments loaded</span>
          <span className="text-xs text-ink-500">Symbols with enough history for real indicators</span>
        </div>
        <span className="text-sm text-ink-300">{status.instrumentsLoaded}</span>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Last refresh</span>
          <span className="text-xs text-ink-500">Most recent successful candle fetch</span>
        </div>
        <span className="text-sm text-ink-300">
          {status.lastUpdated ? formatDateTime(status.lastUpdated) : "Not yet fetched"}
        </span>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Cache age</span>
          <span className="text-xs text-ink-500">
            How long ago the oldest still-cached symbol was fetched (refreshed once every 24 hours)
          </span>
        </div>
        <span className="text-sm text-ink-300">
          {status.cacheAgeMinutes === null ? "Not applicable" : `${status.cacheAgeMinutes} min`}
        </span>
      </div>

      <div className="px-5 py-4">
        <p className="text-xs leading-relaxed text-ink-600">
          Real historical data requires a server-side connection, so it is only available to the
          always-on server-based scanning described in Settings — this browser tab&apos;s own
          manual scans always use sample history instead.
        </p>
      </div>
    </div>
  );
}
