import { StatCard } from "@/components/ui/StatCard";
import { Badge } from "@/components/ui/Badge";
import type { StrategyPerformanceSummary } from "@/lib/hermes-execution/analysis/types";
import { formatDuration, formatMaybeNumber, formatPercent } from "./decision-intelligence-format";

interface AnalyticsSummaryPanelProps {
  summary: StrategyPerformanceSummary;
}

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. Execution rate, average
// confidence/RSI/ATR/runtime, top traded instruments, error and fallback rate — every figure here
// is read directly from computeStrategyPerformance's own output (analysis-analytics.ts), never
// recomputed here, so the page and the repository's own getStrategyPerformance() can never
// disagree about a number.
export function AnalyticsSummaryPanel({ summary }: AnalyticsSummaryPanelProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Execution rate" value={formatPercent(summary.executionPercent)} />
        <StatCard label="Average confidence" value={formatMaybeNumber(summary.averageConfidence)} />
        <StatCard
          label="Error rate"
          value={formatPercent(summary.errorRatePercent)}
          valueClassName={summary.errorRatePercent > 0 ? "text-accent-amber" : "text-ink-100"}
        />
        <StatCard
          label="Fallback rate"
          value={formatPercent(summary.fallbackRatePercent)}
          sublabel="Always 0% — no fallback path exists in this pipeline"
        />
        <StatCard label="Average RSI14" value={formatMaybeNumber(summary.averageRsi14, 1)} />
        <StatCard label="Average ATR14" value={formatMaybeNumber(summary.averageAtr14)} />
        <StatCard label="Average runtime" value={formatDuration(summary.averageRuntimeDurationMs)} />
        <StatCard label="Total runs" value={String(summary.totalRuns)} />
      </div>

      <div className="panel flex flex-col gap-3 p-5">
        <h2 className="text-sm font-semibold text-ink-100">Top traded instruments</h2>
        {summary.topInstruments.length === 0 ? (
          <p className="text-xs text-ink-500">No analyses in the current filter.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {summary.topInstruments.map((entry) => (
              <Badge key={entry.instrument} className="border-base-600 bg-base-800 text-ink-300">
                {entry.instrument} · {entry.count}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
