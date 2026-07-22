import type { StrategyPerformanceSummary } from "@/lib/hermes-execution/analysis/types";
import { formatPercent } from "./decision-intelligence-format";

interface DecisionDistributionPanelProps {
  summary: StrategyPerformanceSummary;
}

const BARS: { label: string; key: "buyPercent" | "sellPercent" | "holdPercent"; colorClass: string }[] = [
  { label: "BUY", key: "buyPercent", colorClass: "bg-accent-teal" },
  { label: "HOLD", key: "holdPercent", colorClass: "bg-ink-500" },
  { label: "SELL", key: "sellPercent", colorClass: "bg-accent-red" },
];

// Phase 2B — Decision Intelligence: Historical Analysis Persistence.
export function DecisionDistributionPanel({ summary }: DecisionDistributionPanelProps) {
  return (
    <div className="panel flex flex-col gap-4 p-5">
      <h2 className="text-sm font-semibold text-ink-100">Decision distribution</h2>
      <div className="flex flex-col gap-3">
        {BARS.map((bar) => (
          <div key={bar.key} className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs text-ink-400">
              <span>{bar.label}</span>
              <span className="text-ink-200">{formatPercent(summary[bar.key])}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-base-800">
              <div className={`h-full ${bar.colorClass}`} style={{ width: `${Math.min(100, summary[bar.key])}%` }} />
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-ink-600">{summary.totalRuns} total analysis runs in the current filter.</p>
    </div>
  );
}
