import { computeStrategyUsage } from "@/lib/hermes-execution/analysis/analysis-analytics";
import type { AnalysisRun } from "@/lib/hermes-execution/analysis/types";
import { formatPercent } from "./decision-intelligence-format";

interface StrategyUsagePanelProps {
  runs: AnalysisRun[];
}

// Phase 2B — Decision Intelligence: Historical Analysis Persistence.
export function StrategyUsagePanel({ runs }: StrategyUsagePanelProps) {
  const usage = computeStrategyUsage(runs);

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <h2 className="text-sm font-semibold text-ink-100">Strategy usage</h2>
      </div>
      {usage.length === 0 ? (
        <p className="px-5 py-4 text-xs text-ink-500">No analyses in the current filter.</p>
      ) : (
        <div className="divide-y divide-base-700/60">
          {usage.map((entry) => {
            const executionRate = entry.count > 0 ? (entry.executedCount / entry.count) * 100 : 0;
            return (
              <div key={entry.strategyId} className="flex items-center justify-between gap-4 px-5 py-3">
                <span className="text-sm text-ink-200">{entry.strategyId}</span>
                <span className="text-xs text-ink-500">
                  {entry.count} run{entry.count === 1 ? "" : "s"} · {entry.executedCount} executed ·{" "}
                  {formatPercent(executionRate)} execution rate
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
