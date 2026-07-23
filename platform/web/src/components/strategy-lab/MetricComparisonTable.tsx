import type { MetricDelta, ResearchMetrics } from "@/lib/hermes-execution/research/types";

const METRIC_LABELS: Record<keyof ResearchMetrics, string> = {
  opportunityCount: "Opportunities",
  skippedCount: "Skipped (HOLD)",
  tradeCount: "Trades",
  tradeFrequency: "Trade frequency",
  opportunityFrequencyPerDay: "Opportunities / day",
  winRate: "Win rate",
  lossRate: "Loss rate",
  expectancy: "Expectancy",
  profitFactor: "Profit factor",
  averageRiskMultiple: "Average R",
  sharpeRatio: "Sharpe ratio (approx.)",
  maximumDrawdown: "Maximum drawdown",
  averageHoldingTimeMs: "Avg holding time",
};

const PERCENT_METRICS = new Set<keyof ResearchMetrics>(["tradeFrequency", "winRate", "lossRate"]);
const MS_METRICS = new Set<keyof ResearchMetrics>(["averageHoldingTimeMs"]);

function formatMetricValue(metric: keyof ResearchMetrics, value: number | undefined): string {
  if (value === undefined) return "—";
  if (PERCENT_METRICS.has(metric)) return `${(value * 100).toFixed(1)}%`;
  if (MS_METRICS.has(metric)) return `${(value / 3_600_000).toFixed(1)}h`;
  if (metric === "opportunityFrequencyPerDay") return `${value.toFixed(2)}/day`;
  return value.toFixed(2);
}

export function MetricComparisonTable({ deltas, labelA, labelB }: { deltas: MetricDelta[]; labelA: string; labelB: string }) {
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-base-700/60 text-ink-500">
            <th scope="col" className="px-4 py-2 font-medium">
              Metric
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              {labelA}
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              {labelB}
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Difference (B − A)
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-base-700/60">
          {deltas.map((row) => (
            <tr key={row.metric} className="text-ink-300">
              <td className="px-4 py-2 text-ink-100">{METRIC_LABELS[row.metric]}</td>
              <td className="px-4 py-2">{formatMetricValue(row.metric, row.a)}</td>
              <td className="px-4 py-2">{formatMetricValue(row.metric, row.b)}</td>
              <td className={`px-4 py-2 ${row.delta !== undefined && row.delta > 0 ? "text-accent-teal" : row.delta !== undefined && row.delta < 0 ? "text-accent-red" : "text-ink-500"}`}>
                {row.delta !== undefined ? `${row.delta > 0 ? "+" : ""}${formatMetricValue(row.metric, row.delta)}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
