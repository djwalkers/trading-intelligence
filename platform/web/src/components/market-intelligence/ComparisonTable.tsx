import { Badge } from "@/components/ui/Badge";
import type { Opportunity } from "@/lib/types";
import { calculateOverallIntelligenceScore } from "@/lib/utils/intelligence-score";
import { recommendationClasses, signalToneClasses } from "@/lib/utils/style";

interface ComparisonTableProps {
  opportunities: Opportunity[];
  emptyMessage?: string;
}

export function ComparisonTable({
  opportunities,
  emptyMessage = "Select at least 2 opportunities using the checkboxes in the list to compare them.",
}: ComparisonTableProps) {
  if (opportunities.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">{emptyMessage}</p>;
  }

  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full min-w-[820px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-base-700 text-left text-xs uppercase tracking-wide text-ink-500">
            <th className="px-5 py-2.5 font-medium">Instrument</th>
            <th className="px-5 py-2.5 font-medium">Signal</th>
            <th className="px-5 py-2.5 font-medium">Overall</th>
            <th className="px-5 py-2.5 font-medium">Trend</th>
            <th className="px-5 py-2.5 font-medium">Momentum</th>
            <th className="px-5 py-2.5 font-medium">Volume</th>
            <th className="px-5 py-2.5 font-medium">Volatility</th>
            <th className="px-5 py-2.5 font-medium">Risk</th>
            <th className="px-5 py-2.5 font-medium">Reward</th>
            <th className="px-5 py-2.5 font-medium">Recommendation</th>
          </tr>
        </thead>
        <tbody>
          {opportunities.map((opportunity) => {
            const overall = calculateOverallIntelligenceScore(opportunity.intelligenceFactors);

            return (
              <tr key={opportunity.id} className="border-b border-base-700/60 last:border-0">
                <td className="px-5 py-2.5">
                  <div className="flex flex-col">
                    <span className="font-medium text-ink-100">
                      {opportunity.instrumentSymbol}
                    </span>
                    <span className="text-xs text-ink-500">{opportunity.instrumentName}</span>
                  </div>
                </td>
                <td className="px-5 py-2.5">
                  <Badge className={signalToneClasses(opportunity.signalType)}>
                    {opportunity.signalType}
                  </Badge>
                </td>
                <td className="px-5 py-2.5 font-semibold text-ink-100">{overall}</td>
                <td className="px-5 py-2.5 text-ink-300">{opportunity.intelligenceFactors.trend}</td>
                <td className="px-5 py-2.5 text-ink-300">
                  {opportunity.intelligenceFactors.momentum}
                </td>
                <td className="px-5 py-2.5 text-ink-300">{opportunity.intelligenceFactors.volume}</td>
                <td className="px-5 py-2.5 text-ink-300">
                  {opportunity.intelligenceFactors.volatility}
                </td>
                <td className="px-5 py-2.5 text-ink-300">{opportunity.intelligenceFactors.risk}</td>
                <td className="px-5 py-2.5 text-ink-300">{opportunity.intelligenceFactors.reward}</td>
                <td className="px-5 py-2.5">
                  <Badge className={recommendationClasses(opportunity.recommendation)}>
                    {opportunity.recommendation}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
