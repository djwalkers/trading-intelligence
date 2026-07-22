"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMarketDiagnostics, type MarketDiagnosticsFetchResult } from "@/app/market-intelligence/diagnostics/actions";
import type { MarketDiagnosticsResult } from "@/lib/hermes-execution/market-diagnostics-service";
import { InfoNote } from "@/components/ui/InfoNote";
import { DiagnosticsStatusHeader } from "./DiagnosticsStatusHeader";
import { CurrentQuotePanel } from "./CurrentQuotePanel";
import { CandlestickChart } from "./CandlestickChart";
import { IndicatorCards } from "./IndicatorCards";
import { RsiChart } from "./RsiChart";
import { DataQualityPanel } from "./DataQualityPanel";

interface MarketDiagnosticsViewProps {
  initial: MarketDiagnosticsFetchResult;
}

// Phase 2A.1 — Internal Market Diagnostics UI. Never polls more than once per minute (this phase's
// own requirement) — manual refresh via the button in DiagnosticsStatusHeader remains available at
// any time. A failed refresh only ever updates `error`; `data` (the last successful result) is
// never cleared by a failure, so the dashboard below keeps showing the last known-good snapshot
// with a visible error banner above it, never a blank/broken page.
const REFRESH_INTERVAL_MS = 60_000;

export function MarketDiagnosticsView({ initial }: MarketDiagnosticsViewProps) {
  const [data, setData] = useState<MarketDiagnosticsResult | null>(initial.ok ? initial.diagnostics : null);
  const [error, setError] = useState<{ code: string; message: string } | null>(initial.ok ? null : initial.error);
  const [isLoading, setIsLoading] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(initial.ok ? initial.diagnostics.fetchedAt : null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await fetchMarketDiagnostics();
      if (!isMounted.current) return;
      if (result.ok) {
        setData(result.diagnostics);
        setError(null);
        setLastRefreshAt(result.diagnostics.fetchedAt);
      } else {
        // Deliberately does not touch `data` — never silently switches to mock/synthetic data and
        // never clears the last valid result on a failed refresh (this phase's own requirement).
        setError(result.error);
      }
    } finally {
      if (isMounted.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="flex flex-col gap-6">
      <DiagnosticsStatusHeader data={data} error={error} isLoading={isLoading} lastRefreshAt={lastRefreshAt} onRefresh={refresh} />

      {data ? (
        <>
          <CurrentQuotePanel data={data} />
          <CandlestickChart data={data} />
          <IndicatorCards data={data} />
          <RsiChart data={data} />
          <DataQualityPanel data={data} />
        </>
      ) : (
        <div className="panel p-6 text-sm text-ink-400" data-testid="no-data-placeholder">
          {error ? "Market diagnostics are unavailable — see the error above." : "Loading market diagnostics…"}
        </div>
      )}

      <InfoNote>
        This page is read-only. It never places an order, closes a position, changes strategy configuration, restarts the
        runtime, or modifies environment variables — it only reads market data and displays it.
      </InfoNote>
    </div>
  );
}
