import { StatCard } from "@/components/ui/StatCard";
import type { IntelligenceScoreSummary } from "@/lib/utils/intelligence-score";

interface WatchlistHealthSummaryProps {
  summary: IntelligenceScoreSummary;
}

export function WatchlistHealthSummary({ summary }: WatchlistHealthSummaryProps) {
  return (
    <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Excellent opportunities"
        value={String(summary.excellentCount)}
        sublabel="Score 80+"
      />
      <StatCard
        label="Good opportunities"
        value={String(summary.goodCount)}
        sublabel="Score 65-79"
      />
      <StatCard
        label="Weak opportunities"
        value={String(summary.weakCount)}
        sublabel="Score 50-64"
      />
      <StatCard
        label="Avoid / monitor only"
        value={String(summary.avoidCount)}
        sublabel="Score below 50"
      />
    </div>
  );
}
