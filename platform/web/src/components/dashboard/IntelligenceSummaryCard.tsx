import { StatCard } from "@/components/ui/StatCard";
import type { IntelligenceScoreSummary } from "@/lib/utils/intelligence-score";

interface IntelligenceSummaryCardProps {
  summary: IntelligenceScoreSummary;
}

export function IntelligenceSummaryCard({ summary }: IntelligenceSummaryCardProps) {
  return (
    <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Highest scoring opportunity"
        value={summary.highest ? `${summary.highest.instrumentSymbol} · ${summary.highest.overall}` : "—"}
        sublabel={summary.highest?.instrumentName}
      />
      <StatCard label="Average intelligence score" value={String(summary.averageScore)} />
      <StatCard label="Excellent opportunities" value={String(summary.excellentCount)} />
      <StatCard label="Monitor-only opportunities" value={String(summary.avoidCount)} />
    </div>
  );
}
