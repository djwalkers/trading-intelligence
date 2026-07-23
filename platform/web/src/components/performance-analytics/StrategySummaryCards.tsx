import type { StrategyPerformanceSummary } from "@/lib/hermes-execution/trade-performance/trade-performance-analytics";

function metric(label: string, value: string, toneClass = "text-ink-200") {
  return (
    <div key={label} className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-ink-500">{label}</span>
      <span className={`text-sm font-medium ${toneClass}`}>{value}</span>
    </div>
  );
}

export function StrategySummaryCards({ summaries }: { summaries: StrategyPerformanceSummary[] }) {
  if (summaries.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">No closed trades yet — per-strategy analytics will appear once one closes.</p>;
  }

  return (
    <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
      {summaries.map((summary) => (
        <div key={summary.strategyId} className="panel flex flex-col gap-3 p-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-ink-100">{summary.strategyId}</h3>
            <span className="text-xs text-ink-500">{summary.tradeCount} trades</span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {metric("Win rate", `${(summary.winRate * 100).toFixed(0)}%`, "text-accent-teal")}
            {metric("Loss rate", `${(summary.lossRate * 100).toFixed(0)}%`, "text-accent-red")}
            {metric("Avg winner", summary.averageWinner.toFixed(2), "text-accent-teal")}
            {metric("Avg loser", summary.averageLoser.toFixed(2), "text-accent-red")}
            {metric("Profit factor", summary.profitFactor !== undefined ? summary.profitFactor.toFixed(2) : "—")}
            {metric("Expectancy", summary.expectancy.toFixed(2), summary.expectancy >= 0 ? "text-accent-teal" : "text-accent-red")}
            {metric("Avg hold time", `${(summary.averageHoldingTimeMs / 3_600_000).toFixed(1)}h`)}
            {metric("Max drawdown", summary.maximumDrawdown.toFixed(2))}
            {metric("Avg R multiple", summary.averageRiskMultiple !== undefined ? summary.averageRiskMultiple.toFixed(2) : "—")}
            {metric("Best trade", summary.bestTrade ? `+${summary.bestTrade.netPnl.toFixed(2)}` : "—", "text-accent-teal")}
            {metric("Worst trade", summary.worstTrade ? summary.worstTrade.netPnl.toFixed(2) : "—", "text-accent-red")}
            {metric("Longest win streak", `${summary.largestConsecutiveWins}`)}
            {metric("Longest loss streak", `${summary.largestConsecutiveLosses}`)}
          </div>
        </div>
      ))}
    </div>
  );
}
