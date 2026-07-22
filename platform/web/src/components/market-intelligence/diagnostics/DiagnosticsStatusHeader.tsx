"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { formatDateTime, formatRelativeTime } from "@/lib/utils/format";
import type { MarketDiagnosticsResult } from "@/lib/hermes-execution/market-diagnostics-service";
import {
  dataFreshnessLevel,
  formatDuration,
  freshnessBadgeClasses,
  providerBadgeClasses,
  providerLabel,
} from "./diagnostics-format";

interface DiagnosticsStatusHeaderProps {
  data: MarketDiagnosticsResult | null;
  error: { code: string; message: string } | null;
  isLoading: boolean;
  lastRefreshAt: string | null;
  onRefresh: () => void;
}

// Phase 2A.1 — Internal Market Diagnostics UI, section A + G. The one place this page must make it
// "extremely obvious" (this phase's own words) whether the data on screen is live, mock, stale, or
// failed — every badge here reads directly off MarketDiagnosticsResult.validation, never a
// separately-tracked UI-only guess.
export function DiagnosticsStatusHeader({ data, error, isLoading, lastRefreshAt, onRefresh }: DiagnosticsStatusHeaderProps) {
  const freshness = data ? dataFreshnessLevel(data.validation.dataAgeSeconds, data.validation.maxCandleAgeSeconds) : null;

  return (
    <div className="panel flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {data ? (
            <>
              <Badge className={providerBadgeClasses(data.provider)} data-testid="provider-badge">
                {providerLabel(data.provider)} market data
              </Badge>
              <Badge className="border-base-600 bg-base-800 text-ink-300">{data.brokerProvider}</Badge>
              <Badge className="border-base-600 bg-base-800 text-ink-300">{data.instrument}</Badge>
              <Badge className="border-base-600 bg-base-800 text-ink-300">{data.timeframe}</Badge>
              {freshness ? (
                <Badge className={freshnessBadgeClasses(freshness)} data-testid="freshness-badge">
                  {freshness === "fresh" ? "Fresh" : freshness === "aging" ? "Aging" : "Near stale threshold"}
                </Badge>
              ) : null}
              <Badge
                className={
                  data.validation.fallbackOccurred
                    ? "border-accent-red/30 bg-accent-red/10 text-accent-red"
                    : "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
                }
                data-testid="fallback-badge"
              >
                {data.validation.fallbackOccurred ? "Fallback in use" : "No fallback"}
              </Badge>
            </>
          ) : (
            <Badge className="border-base-600 bg-base-800 text-ink-300">No data yet</Badge>
          )}
        </div>

        <Button variant="secondary" onClick={onRefresh} disabled={isLoading} data-testid="refresh-button">
          {isLoading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-ink-500">
        <span data-testid="last-refresh">
          Last refresh:{" "}
          {lastRefreshAt ? (
            <span className="text-ink-300">
              {formatRelativeTime(lastRefreshAt)} ({formatDateTime(lastRefreshAt)})
            </span>
          ) : (
            "never"
          )}
        </span>
        {data ? (
          <span data-testid="data-age">
            Candle data age: <span className="text-ink-300">{formatDuration(data.validation.dataAgeSeconds)}</span>
            <span className="text-ink-600"> (threshold {formatDuration(data.validation.maxCandleAgeSeconds)})</span>
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <p role="status" className="text-xs text-ink-500" data-testid="loading-indicator">
          Fetching latest market diagnostics…
        </p>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-xl2 border border-accent-red/25 bg-accent-red/5 px-4 py-3 text-xs text-accent-red"
          data-testid="error-banner"
        >
          <p className="font-medium">
            Latest refresh failed [{error.code}]{data ? " — showing the last successful result below." : "."}
          </p>
          <p className="mt-1 text-accent-red/80">{error.message}</p>
        </div>
      ) : null}
    </div>
  );
}
