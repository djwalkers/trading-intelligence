"use client";

import { Badge } from "@/components/ui/Badge";
import { useHistoricalDataStatus } from "@/lib/state/use-historical-data-status";
import { formatDateTime } from "@/lib/utils/format";

// Live, not mocked — mirrors MarketDataStatusPanel, reading the status
// ResilientHistoricalMarketDataProvider tracks. Populated once a Bot Scan has run in this browser
// tab (Mission 9) — see use-historical-data-status.ts.
//
// Maintenance 1.11.2 — real candles now come from Alpha Vantage, but only the VPS worker can use
// it: ALPHA_VANTAGE_API_KEY is a server-only secret, never exposed to the browser (see
// get-server-historical-market-data-provider.ts), so this browser tab's own factory
// (get-historical-market-data-provider.ts) always resolves to Mock — status.source will never
// read "External" here. That's not a bug to fix; it's the same "browser can't observe worker-only
// state" limitation already disclosed for the Server Scheduler panel (Mission 10). The real Alpha
// Vantage status (source, last refresh, symbols loaded, cache age) is only observable from the
// worker process's own logs — see docs/product/MAINTENANCE-1.11.2-REAL-MARKET-DATA.md.
export function HistoricalDataStatusPanel() {
  const status = useHistoricalDataStatus();

  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Historical data</span>
          <span className="text-xs text-ink-500">
            {status.source === "External"
              ? "OHLCV candles are fetched from an external market data provider."
              : "OHLCV candles are generated deterministically from mock instrument data."}
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
            How long ago the oldest still-cached symbol was fetched (Alpha Vantage caches for 24 hours)
          </span>
        </div>
        <span className="text-sm text-ink-300">
          {status.cacheAgeMinutes === null ? "Not applicable" : `${status.cacheAgeMinutes} min`}
        </span>
      </div>

      <div className="px-5 py-4">
        <p className="text-xs leading-relaxed text-ink-600">
          Real Alpha Vantage candles require a server-side API key, so they can only be fetched by
          the VPS worker (`npm run worker`) — this browser tab&apos;s own manual Bot Scan always
          uses mock candles instead. Check the worker&apos;s own log output
          (`historical_data_status` lines) for the real Alpha Vantage source, refresh time, symbols
          loaded, cache age, and fallback reason.
        </p>
      </div>
    </div>
  );
}
