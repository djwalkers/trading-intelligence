"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth/auth-context";
import { SupabaseAnalysisRepository } from "@/lib/hermes-execution/analysis/analysis-repository";
import { computeStrategyPerformance } from "@/lib/hermes-execution/analysis/analysis-analytics";
import { analysisRunsToCsv } from "@/lib/hermes-execution/analysis/csv-export";
import { filterAnalysisRuns } from "@/lib/hermes-execution/analysis/filter-runs";
import type { AnalysisRun } from "@/lib/hermes-execution/analysis/types";
import { InfoNote } from "@/components/ui/InfoNote";
import { AnalysisFilterPanel, type AnalysisFilterState } from "./AnalysisFilterPanel";
import { AnalysisTimelineChart } from "./AnalysisTimelineChart";
import { DecisionDistributionPanel } from "./DecisionDistributionPanel";
import { TrendDistributionPanel } from "./TrendDistributionPanel";
import { StrategyUsagePanel } from "./StrategyUsagePanel";
import { AnalyticsSummaryPanel } from "./AnalyticsSummaryPanel";
import { RecentAnalysesTable } from "./RecentAnalysesTable";

const DEFAULT_FILTER: AnalysisFilterState = {
  search: "",
  retention: "30d",
  instrument: "",
  decision: "",
  strategyId: "",
};

const FETCH_LIMIT = 1000;

function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. Entirely read-only: this
// component never writes to market_analysis_runs/market_analysis_events, never calls a broker
// method, and never touches strategy/runtime configuration — it only queries (via
// SupabaseAnalysisRepository.getRecentAnalyses, RLS-scoped to the signed-in user) and displays.
// The retention window (30d/90d/365d/All Time) drives the database query itself; every other
// filter (instrument/decision/strategy/search) is applied client-side over that already-fetched
// batch, so switching them never re-queries Supabase.
export function DecisionIntelligenceView() {
  const { user, isConfigured } = useAuth();
  const [filter, setFilter] = useState<AnalysisFilterState>(DEFAULT_FILTER);
  const [runs, setRuns] = useState<AnalysisRun[]>([]);
  // Starts false, not true: when there's no client/session this effect returns immediately without
  // ever entering a loading state (see below) — matches paper-trades-context.tsx's own "just
  // return, no setState" convention for its equivalent not-ready branch, which is also what avoids
  // a synchronous setState call directly in the effect body (react-hooks/set-state-in-effect).
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mirrors paper-trades-context.tsx's own "define the async loader inline inside the effect,
  // guard every setState with a `cancelled` flag" pattern — retention is the only filter that
  // re-triggers a Supabase query (see this component's own top-of-file comment); every other
  // filter is applied client-side over the already-fetched `runs` below, never re-fetching.
  useEffect(() => {
    const client = getSupabaseClient();
    if (!client || !user) return;

    let cancelled = false;

    async function loadRuns() {
      setIsLoading(true);
      setError(null);
      try {
        // Non-null: TS can't trace the closure narrowing across the nested function boundary, but
        // the `if (!client || !user) return;` check above already guarantees both are non-null for
        // the lifetime of this effect run (neither is reassigned within it).
        const repository = new SupabaseAnalysisRepository(client!, user!.id);
        const fetched = await repository.getRecentAnalyses({ retention: filter.retention, limit: FETCH_LIMIT });
        if (!cancelled) setRuns(fetched);
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "Failed to load market analysis history.");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadRuns();

    return () => {
      cancelled = true;
    };
  }, [user, filter.retention]);

  const availableInstruments = useMemo(() => [...new Set(runs.map((r) => r.instrument))].sort(), [runs]);
  const availableStrategies = useMemo(() => [...new Set(runs.map((r) => r.strategyId))].sort(), [runs]);

  const filteredRuns = useMemo(() => filterAnalysisRuns(runs, filter), [runs, filter]);

  const summary = useMemo(() => computeStrategyPerformance(filteredRuns), [filteredRuns]);

  function handleExportCsv() {
    const csv = analysisRunsToCsv(filteredRuns);
    downloadCsv(csv, `market-analysis-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  if (isConfigured && !user) {
    return <div className="panel p-6 text-sm text-ink-400">Sign in to view your decision intelligence history.</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      <AnalysisFilterPanel
        filter={filter}
        onChange={setFilter}
        availableInstruments={availableInstruments}
        availableStrategies={availableStrategies}
        onExportCsv={handleExportCsv}
        exportDisabled={filteredRuns.length === 0}
      />

      {error ? (
        <div role="alert" className="rounded-xl2 border border-accent-red/25 bg-accent-red/5 px-4 py-3 text-xs text-accent-red">
          {error}
        </div>
      ) : null}

      {isLoading ? (
        <div className="panel p-6 text-sm text-ink-400" data-testid="loading-indicator">
          Loading market analysis history…
        </div>
      ) : (
        <>
          <AnalysisTimelineChart runs={filteredRuns} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <DecisionDistributionPanel summary={summary} />
            <TrendDistributionPanel summary={summary} />
          </div>

          <AnalyticsSummaryPanel summary={summary} />
          <StrategyUsagePanel runs={filteredRuns} />
          <RecentAnalysesTable runs={filteredRuns.slice(0, 100)} />
        </>
      )}

      <InfoNote>
        This page is read-only. It only displays historical market analysis already recorded by the trading runtime — it
        never places an order, closes a position, changes strategy configuration, or modifies the runtime.
      </InfoNote>
    </div>
  );
}
