"use client";

import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { getSupabaseClient } from "@/lib/supabase/client";
import { SupabaseAnalysisRepository } from "@/lib/hermes-execution/analysis/analysis-repository";
import { runStrategyResearch } from "@/lib/hermes-execution/research/run-strategy-research";
import { compareResearchRuns } from "@/lib/hermes-execution/research/research-comparison";
import { researchStrategyRegistry } from "@/lib/hermes-execution/research/research-strategy-registry";
import type { ResearchComparisonResult } from "@/lib/hermes-execution/research/types";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { Button } from "@/components/ui/Button";
import { ComparisonEquityCurveChart } from "./ComparisonEquityCurveChart";
import { MetricComparisonTable } from "./MetricComparisonTable";
import { DecisionDifferencesTable } from "./DecisionDifferencesTable";
import { TradeDifferencesTable } from "./TradeDifferencesTable";

// Phase 5 — Strategy Research Laboratory. Reads market_analysis_runs directly from the browser
// (anon-key Supabase client + the signed-in user's session, RLS-scoped) via the existing,
// unmodified SupabaseAnalysisRepository.getRecentAnalyses — the exact same read the Decision
// Intelligence page already performs. Every strategy run, comparison, and metric below happens
// entirely in this component's own memory: nothing here writes to Supabase, calls a broker, or
// creates a TradeCandidate. See run-strategy-research.ts's own doc comment for the full guarantee.

const AVAILABLE_STRATEGIES = researchStrategyRegistry.list();

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIsoDate(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export function StrategyLabView() {
  const { isConfigured, isLoading: authLoading, user } = useAuth();
  const [strategyIdA, setStrategyIdA] = useState(AVAILABLE_STRATEGIES[0]?.id ?? "");
  const [strategyIdB, setStrategyIdB] = useState(AVAILABLE_STRATEGIES[1]?.id ?? AVAILABLE_STRATEGIES[0]?.id ?? "");
  const [instrument, setInstrument] = useState("BTC");
  const [since, setSince] = useState(daysAgoIsoDate(30));
  const [until, setUntil] = useState(todayIsoDate());
  const [comparison, setComparison] = useState<ResearchComparisonResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canRun = isConfigured && Boolean(user) && Boolean(strategyIdA) && Boolean(strategyIdB) && Boolean(instrument);

  const handleRun = async () => {
    const client = getSupabaseClient();
    if (!client || !user) return;
    setIsRunning(true);
    setError(null);
    try {
      const repository = new SupabaseAnalysisRepository(client, user.id);
      const params = { instrument, since: new Date(since).toISOString(), until: new Date(`${until}T23:59:59.999Z`).toISOString() };

      const [resultA, resultB] = await Promise.all([
        runStrategyResearch({ repository, registry: researchStrategyRegistry, params: { ...params, strategyId: strategyIdA } }),
        runStrategyResearch({ repository, registry: researchStrategyRegistry, params: { ...params, strategyId: strategyIdB } }),
      ]);

      setComparison(compareResearchRuns(resultA, resultB));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run the strategy comparison.");
      setComparison(null);
    } finally {
      setIsRunning(false);
    }
  };

  const labelA = useMemo(() => comparison?.a.strategyId ?? strategyIdA, [comparison, strategyIdA]);
  const labelB = useMemo(() => comparison?.b.strategyId ?? strategyIdB, [comparison, strategyIdB]);

  if (!isConfigured) {
    return (
      <div className="panel p-6 text-sm text-ink-400" data-testid="not-configured-placeholder">
        The Strategy Laboratory requires Supabase to be configured — it has no historical analysis data to research
        against in local prototype mode.
      </div>
    );
  }
  if (authLoading) {
    return <div className="panel p-6 text-sm text-ink-500">Checking your session…</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      <InfoNote>
        Research mode is read-only. Running a comparison never places an order, never creates a Trade Candidate,
        never writes to Supabase, and never affects live trading in any way — it only replays already-recorded
        historical analysis data through a strategy&apos;s own, unmodified decision logic, entirely in memory.
      </InfoNote>

      <div className="panel flex flex-wrap items-end gap-4 p-4">
        <label className="flex flex-col gap-1 text-xs text-ink-400">
          Strategy A
          <select
            value={strategyIdA}
            onChange={(e) => setStrategyIdA(e.target.value)}
            className="rounded-lg border border-base-600 bg-base-900 px-2 py-1.5 text-xs text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            {AVAILABLE_STRATEGIES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} v{s.version}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-400">
          Strategy B
          <select
            value={strategyIdB}
            onChange={(e) => setStrategyIdB(e.target.value)}
            className="rounded-lg border border-base-600 bg-base-900 px-2 py-1.5 text-xs text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            {AVAILABLE_STRATEGIES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} v{s.version}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-400">
          Instrument
          <input
            value={instrument}
            onChange={(e) => setInstrument(e.target.value.toUpperCase())}
            className="w-24 rounded-lg border border-base-600 bg-base-900 px-2 py-1.5 text-xs text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-400">
          From
          <input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="rounded-lg border border-base-600 bg-base-900 px-2 py-1.5 text-xs text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-400">
          To
          <input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="rounded-lg border border-base-600 bg-base-900 px-2 py-1.5 text-xs text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          />
        </label>
        <Button variant="primary" onClick={() => void handleRun()} disabled={!canRun || isRunning}>
          {isRunning ? "Running…" : "Run comparison"}
        </Button>
      </div>

      {error ? (
        <div className="panel border-accent-red/30 bg-accent-red/5 px-4 py-3 text-sm text-accent-red" role="alert">
          {error}
        </div>
      ) : null}

      {!comparison ? (
        <div className="panel p-6 text-sm text-ink-500" data-testid="no-comparison-placeholder">
          Select two strategies, an instrument, and a date range, then run a comparison.
        </div>
      ) : (
        <>
          <SectionPanel title="Equity curves" description={`${labelA} vs ${labelB}, by trade sequence`}>
            <ComparisonEquityCurveChart a={comparison.a} b={comparison.b} />
          </SectionPanel>

          <SectionPanel title="Performance differences" description="Every research metric, side by side">
            <MetricComparisonTable deltas={comparison.metricDeltas} labelA={labelA} labelB={labelB} />
          </SectionPanel>

          <SectionPanel
            title="Decision differences"
            description="Historical moments where the two strategies decided differently, given the identical market data"
          >
            <DecisionDifferencesTable differences={comparison.decisionDifferences} labelA={labelA} labelB={labelB} />
          </SectionPanel>

          <SectionPanel title="Trade differences" description="Trades one strategy took that the other didn't, or that closed differently">
            <TradeDifferencesTable summary={comparison.tradeDifferences} labelA={labelA} labelB={labelB} />
          </SectionPanel>
        </>
      )}
    </div>
  );
}
