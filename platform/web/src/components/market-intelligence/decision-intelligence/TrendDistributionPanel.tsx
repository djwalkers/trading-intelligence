import type { StrategyPerformanceSummary } from "@/lib/hermes-execution/analysis/types";
import type { TrendClassification } from "@/lib/hermes-execution/technical-indicators";
import { formatPercent } from "./decision-intelligence-format";

interface TrendDistributionPanelProps {
  summary: StrategyPerformanceSummary;
}

const BARS: { trend: TrendClassification; colorClass: string }[] = [
  { trend: "Bullish", colorClass: "bg-accent-teal" },
  { trend: "Bearish", colorClass: "bg-accent-red" },
  { trend: "Sideways", colorClass: "bg-ink-500" },
];

// Phase 2B — Decision Intelligence: Historical Analysis Persistence.
export function TrendDistributionPanel({ summary }: TrendDistributionPanelProps) {
  const total = summary.totalRuns;
  return (
    <div className="panel flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink-100">Trend distribution</h2>
        <span className="text-xs text-ink-500">
          Most common: <span className="text-ink-200">{summary.mostCommonTrend ?? "—"}</span>
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {BARS.map((bar) => {
          const count = summary.trendDistribution[bar.trend];
          const percent = total > 0 ? (count / total) * 100 : 0;
          return (
            <div key={bar.trend} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs text-ink-400">
                <span>{bar.trend}</span>
                <span className="text-ink-200">
                  {formatPercent(percent)} ({count})
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-base-800">
                <div className={`h-full ${bar.colorClass}`} style={{ width: `${Math.min(100, percent)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
