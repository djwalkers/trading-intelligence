"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { getSupabaseClient } from "@/lib/supabase/client";
import { SupabaseTradePerformanceRepository } from "@/lib/hermes-execution/trade-performance/trade-performance-repository";
import { SupabaseTradeCandidateRepository } from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import {
  buildEquityCurve,
  buildMonthlySummary,
  computeAllStrategyPerformance,
} from "@/lib/hermes-execution/trade-performance/trade-performance-analytics";
import type { TradePerformanceRecord } from "@/lib/hermes-execution/trade-performance/types";
import type { TradeCandidate } from "@/lib/hermes-execution/trade-approval/types";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { Button } from "@/components/ui/Button";
import { EquityCurveChart } from "./EquityCurveChart";
import { PnlOverTimeChart } from "./PnlOverTimeChart";
import { WinLossPie } from "./WinLossPie";
import { StrategyComparisonChart } from "./StrategyComparisonChart";
import { TradeDurationChart } from "./TradeDurationChart";
import { MonthlySummaryTable } from "./MonthlySummaryTable";
import { OpenPositionsTable } from "./OpenPositionsTable";
import { ClosedPositionsTable } from "./ClosedPositionsTable";
import { RecentPerformanceList } from "./RecentPerformanceList";
import { StrategySummaryCards } from "./StrategySummaryCards";

// Phase 4 — Trade Performance Engine. Reads trade_performance and trade_candidates directly from
// the browser (anon-key Supabase client + the signed-in user's own id), the same pattern
// TradeApprovalView.tsx already established — RLS is the actual permission boundary, no bespoke
// server action exists here either. This page never writes to either table (purely observational,
// matching this whole phase's own "measure, don't improve" objective) and never touches the trade
// approval workflow's own mutation paths.

const REFRESH_INTERVAL_MS = 60_000;

/** Open positions are approximated from trade_candidates (durable, cross-process) rather than read
 * from the true, live TradeLifecycleStore (in-memory, per-process, unreachable from this app — see
 * this module's own doc comment and docs/trade-performance-engine-phase-4.md's limitations
 * section): an EXECUTED BUY candidate for a strategy+instrument counts as "open" unless a later
 * trade_performance row exists for that same strategy+instrument. */
function approximateOpenPositions(executedCandidates: TradeCandidate[], performanceRecords: TradePerformanceRecord[]): TradeCandidate[] {
  const latestCloseByKey = new Map<string, string>();
  for (const record of performanceRecords) {
    const key = `${record.strategyId}::${record.instrument}`;
    const existing = latestCloseByKey.get(key);
    if (!existing || record.exitTime > existing) latestCloseByKey.set(key, record.exitTime);
  }

  return executedCandidates.filter((candidate) => {
    if (candidate.direction !== "BUY" || !candidate.executedAt) return false;
    const key = `${candidate.strategyId}::${candidate.instrument}`;
    const latestClose = latestCloseByKey.get(key);
    return !latestClose || candidate.executedAt > latestClose;
  });
}

export function PerformanceAnalyticsView() {
  const { isConfigured, isLoading: authLoading, user } = useAuth();
  const [performanceRecords, setPerformanceRecords] = useState<TradePerformanceRecord[]>([]);
  const [executedCandidates, setExecutedCandidates] = useState<TradeCandidate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const client = getSupabaseClient();
    if (!client || !user) return;
    setIsLoading(true);
    try {
      const performanceRepository = new SupabaseTradePerformanceRepository(client, user.id);
      const candidateRepository = new SupabaseTradeCandidateRepository(client, user.id);
      const [performance, executed] = await Promise.all([
        performanceRepository.list({ limit: 2000 }),
        candidateRepository.list({ status: "EXECUTED", limit: 500 }),
      ]);
      if (!isMounted.current) return;
      setPerformanceRecords(performance);
      setExecutedCandidates(executed);
      setError(null);
    } catch (err) {
      if (!isMounted.current) return;
      setError(err instanceof Error ? err.message : "Failed to load trade performance.");
    } finally {
      if (isMounted.current) setIsLoading(false);
    }
  }, [user]);

  // Mirrors TradeApprovalView.tsx's own "inline async loader inside the effect" fix for
  // react-hooks/set-state-in-effect — see that file's doc comment for why.
  useEffect(() => {
    const client = getSupabaseClient();
    if (!client || !user) return;

    let cancelled = false;
    async function load() {
      setIsLoading(true);
      try {
        const performanceRepository = new SupabaseTradePerformanceRepository(client!, user!.id);
        const candidateRepository = new SupabaseTradeCandidateRepository(client!, user!.id);
        const [performance, executed] = await Promise.all([
          performanceRepository.list({ limit: 2000 }),
          candidateRepository.list({ status: "EXECUTED", limit: 500 }),
        ]);
        if (cancelled) return;
        setPerformanceRecords(performance);
        setExecutedCandidates(executed);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load trade performance.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    const interval = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  if (!isConfigured) {
    return (
      <div className="panel p-6 text-sm text-ink-400" data-testid="not-configured-placeholder">
        Performance analytics requires Supabase to be configured — it has nowhere durable to read trade performance
        from in local prototype mode.
      </div>
    );
  }
  if (authLoading) {
    return <div className="panel p-6 text-sm text-ink-500">Checking your session…</div>;
  }

  const equityCurve = buildEquityCurve(performanceRecords);
  const monthlySummary = buildMonthlySummary(performanceRecords);
  const strategySummaries = computeAllStrategyPerformance(performanceRecords);
  const openPositions = approximateOpenPositions(executedCandidates, performanceRecords);
  const candidatesById = new Map(executedCandidates.map((candidate) => [candidate.id, candidate]));

  return (
    <div className="flex flex-col gap-6">
      <div className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <span className="text-xs text-ink-500">
          <span className="font-medium text-ink-200">{performanceRecords.length}</span> closed trade
          {performanceRecords.length === 1 ? "" : "s"} measured
        </span>
        <Button variant="secondary" onClick={() => void refresh()} disabled={isLoading}>
          {isLoading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {error ? (
        <div className="panel border-accent-red/30 bg-accent-red/5 px-4 py-3 text-sm text-accent-red" role="alert">
          {error}
        </div>
      ) : null}

      <SectionPanel title="Equity curve" description="Cumulative net profit and loss across every closed trade">
        <EquityCurveChart points={equityCurve} />
      </SectionPanel>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionPanel title="P/L over time" description="Net profit/loss per closed trade, in order">
          <PnlOverTimeChart records={performanceRecords} />
        </SectionPanel>
        <SectionPanel title="Win / loss" description="Outcome mix across every closed trade">
          <WinLossPie records={performanceRecords} />
        </SectionPanel>
        <SectionPanel title="Strategy comparison" description="Net profit/loss by strategy">
          <StrategyComparisonChart summaries={strategySummaries} />
        </SectionPanel>
        <SectionPanel title="Trade duration" description="How long trades were held before closing">
          <TradeDurationChart records={performanceRecords} />
        </SectionPanel>
      </div>

      <SectionPanel title="Monthly summary" description="Trades, win rate, and net P/L by month closed">
        <MonthlySummaryTable months={monthlySummary} />
      </SectionPanel>

      <SectionPanel title="Strategy analytics" description="Win rate, expectancy, drawdown, and streaks per strategy">
        <StrategySummaryCards summaries={strategySummaries} />
      </SectionPanel>

      <SectionPanel title="Recent performance" description="The 10 most recently closed trades">
        <RecentPerformanceList records={performanceRecords} />
      </SectionPanel>

      <SectionPanel
        title="Open positions"
        description="Approximated from executed BUY candidates with no recorded close — see this page's own limitations note below"
      >
        <OpenPositionsTable candidates={openPositions} />
      </SectionPanel>

      <SectionPanel title="Closed positions" description="Every measured trade — click a row for its full analysis-to-performance chain">
        <ClosedPositionsTable records={performanceRecords} candidatesById={candidatesById} />
      </SectionPanel>

      <InfoNote>
        This page is read-only. It never places an order, approves or rejects a trade candidate, changes strategy
        configuration, or influences a future decision — it only measures trades that have already closed.
        &quot;Open positions&quot; is an approximation (executed BUY candidates with no later recorded close), not a
        live broker read: the trading runtime&apos;s own live position state exists only in that process&apos;s
        memory and is not reachable from this app. Risk multiple (R) uses the stop-loss recorded on the candidate
        that originally opened a position — trades opened before this engine existed, or whose opening candidate
        could not be resolved, show R as &quot;—&quot; rather than a fabricated value.
      </InfoNote>
    </div>
  );
}
