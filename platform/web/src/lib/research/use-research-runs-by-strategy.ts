"use client";

import { useMemo } from "react";
import { useResearchRuns } from "./use-research-runs";
import type { ResearchRunSummary } from "./types";

export interface StrategyResearchHistory {
  strategyName: string;
  runs: ResearchRunSummary[];
}

// Built on top of useResearchRuns()'s already-fetched summary list rather than a third, separate
// query — grouping is a pure client-side reshape of data the list page already needs, and this
// prototype's expected row count doesn't warrant a dedicated grouped-by-strategy database query.
export function useResearchRunsByStrategy(): {
  strategies: StrategyResearchHistory[];
  isLoading: boolean;
  error: string | null;
} {
  const { runs, isLoading, error } = useResearchRuns();

  const strategies = useMemo(() => {
    const byStrategy = new Map<string, ResearchRunSummary[]>();
    for (const run of runs) {
      const existing = byStrategy.get(run.strategyName);
      if (existing) existing.push(run);
      else byStrategy.set(run.strategyName, [run]);
    }
    return Array.from(byStrategy.entries())
      .map(([strategyName, strategyRuns]) => ({
        strategyName,
        // Version progression, oldest first — the order a reader would want to trace a strategy's
        // history, opposite of the list page's newest-first default.
        runs: [...strategyRuns].sort(
          (a, b) => new Date(a.runCreatedAt).getTime() - new Date(b.runCreatedAt).getTime(),
        ),
      }))
      .sort((a, b) => a.strategyName.localeCompare(b.strategyName));
  }, [runs]);

  return { strategies, isLoading, error };
}
