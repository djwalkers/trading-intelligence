"use client";

import { Badge } from "@/components/ui/Badge";
import { useMarketDataStatus } from "@/lib/state/use-market-data-status";

// Build 1.12.0 — configuration-facing view of market data sourcing, distinct from the live health
// view on the Operations Centre. This describes *what's configured*, not moment-to-moment
// connection health (that belongs on the Operations Centre's Market Data group).
export function MarketDataSettingsPanel() {
  const liveQuotes = useMarketDataStatus();

  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Live prices</span>
          <span className="text-xs text-ink-500">
            {liveQuotes.source === "External"
              ? "Current instrument prices are fetched from a connected market data provider."
              : "Current instrument prices use built-in sample data — no live provider is configured."}
          </span>
        </div>
        <Badge
          className={
            liveQuotes.source === "External"
              ? "border-accent-blue/25 bg-accent-blue/10 text-accent-blue"
              : "border-base-600 bg-base-800 text-ink-300"
          }
        >
          {liveQuotes.provider}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Historical market data</span>
          <span className="text-xs text-ink-500">
            Powers the AI Engine&apos;s indicators (moving averages, RSI, momentum). Configured for
            always-on server-based scanning; this browser always uses sample history.
          </span>
        </div>
        <Badge className="border-base-600 bg-base-800 text-ink-300">Configured on server</Badge>
      </div>

      <div className="px-5 py-4">
        <p className="text-xs leading-relaxed text-ink-500">
          Provider connections are set up once by whoever manages this platform&apos;s deployment,
          not from this page. Contact your administrator to change which market data providers are
          connected.
        </p>
      </div>
    </div>
  );
}
