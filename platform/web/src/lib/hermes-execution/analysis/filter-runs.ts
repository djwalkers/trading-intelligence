import type { AnalysisDecision, AnalysisRun } from "./types";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence.

export interface AnalysisRunClientFilter {
  search?: string;
  instrument?: string;
  decision?: AnalysisDecision | "";
  strategyId?: string;
}

function matchesSearch(run: AnalysisRun, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return (
    run.instrument.toLowerCase().includes(needle) ||
    run.strategyId.toLowerCase().includes(needle) ||
    (run.decisionReason?.toLowerCase().includes(needle) ?? false)
  );
}

/**
 * Pure client-side filter over an already-fetched batch of AnalysisRun — mirrors
 * AnalysisRepository.getRecentAnalyses' own server-side filter semantics for instrument/decision/
 * strategyId (exact match), plus free-text search across instrument/strategyId/decisionReason that
 * has no server-side equivalent. Used by the Decision Intelligence page so that changing
 * instrument/decision/strategy/search never re-queries Supabase — only the retention window does
 * (see DecisionIntelligenceView's own top-of-file comment). Never mutates `runs`.
 */
export function filterAnalysisRuns(runs: AnalysisRun[], filter: AnalysisRunClientFilter): AnalysisRun[] {
  return runs.filter((run) => {
    if (filter.instrument && run.instrument !== filter.instrument) return false;
    if (filter.decision && run.decision !== filter.decision) return false;
    if (filter.strategyId && run.strategyId !== filter.strategyId) return false;
    if (filter.search && !matchesSearch(run, filter.search)) return false;
    return true;
  });
}
