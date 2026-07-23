import type { StrategyPerformanceSummary } from "@/lib/hermes-execution/trade-performance/trade-performance-analytics";

const WIDTH = 800;
const ROW_HEIGHT = 28;

/** Horizontal bars, one per strategy — net P/L, single hue split by sign (teal >= 0, red < 0), a
 * fixed row order (strategyId, already sorted by the analytics layer) rather than sorted by value
 * (a filter/re-sort would otherwise repaint bars, violating "colour follows the entity, never its
 * rank"). */
export function StrategyComparisonChart({ summaries }: { summaries: StrategyPerformanceSummary[] }) {
  if (summaries.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">No closed trades yet.</p>;
  }

  const maxAbs = Math.max(...summaries.map((s) => Math.abs(s.expectancy * s.tradeCount)), 1);
  const height = summaries.length * ROW_HEIGHT;
  const halfWidth = WIDTH / 2;
  const scaleX = (halfWidth - 12) / maxAbs;

  return (
    <div className="px-4 py-3">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full" role="img" aria-label="Net profit and loss by strategy">
        <line x1={halfWidth} y1={0} x2={halfWidth} y2={height} stroke="currentColor" className="text-base-700" strokeWidth={1} />
        {summaries.map((summary, index) => {
          const netPnl = summary.expectancy * summary.tradeCount;
          const barWidth = Math.abs(netPnl) * scaleX;
          const y = index * ROW_HEIGHT + 4;
          const x = netPnl >= 0 ? halfWidth : halfWidth - barWidth;
          const colorClass = netPnl >= 0 ? "fill-accent-teal" : "fill-accent-red";
          return (
            <g key={summary.strategyId}>
              <rect x={x} y={y} width={Math.max(1, barWidth)} height={ROW_HEIGHT - 8} className={colorClass} rx={1}>
                <title>
                  {summary.strategyId}: {netPnl >= 0 ? "+" : ""}
                  {netPnl.toFixed(2)} across {summary.tradeCount} trades
                </title>
              </rect>
              <text x={4} y={y + (ROW_HEIGHT - 8) / 2} dominantBaseline="middle" className="fill-ink-400 text-[10px]">
                {summary.strategyId}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
