import { StatCard } from "@/components/ui/StatCard";
import type { StrategyEngineSummary } from "@/lib/strategy-engine";

interface StrategyEngineSummaryCardProps {
  summary: StrategyEngineSummary;
}

export function StrategyEngineSummaryCard({ summary }: StrategyEngineSummaryCardProps) {
  const distribution = summary.agreementDistribution;

  return (
    <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Strategies evaluated" value={String(summary.strategiesEvaluated)} />
      <StatCard label="Average confidence" value={`${summary.averageConfidence}%`} />
      <StatCard
        label="Agreement distribution"
        value={`${distribution["Strong Agreement"]} · ${distribution["Moderate Agreement"]} · ${distribution["Mixed Signals"]} · ${distribution.Conflict}`}
        sublabel="Strong · Moderate · Mixed · Conflict"
      />
      <StatCard
        label="Highest confidence strategy"
        value={
          summary.highestConfidenceStrategy
            ? `${summary.highestConfidenceStrategy.strategyName} · ${summary.highestConfidenceStrategy.confidence}%`
            : "—"
        }
        sublabel={summary.highestConfidenceStrategy?.instrumentSymbol}
      />
    </div>
  );
}
