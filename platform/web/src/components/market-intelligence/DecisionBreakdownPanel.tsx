import { Badge } from "@/components/ui/Badge";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { StarRating } from "@/components/ui/StarRating";
import type { Opportunity } from "@/lib/types";
import { recommendationClasses } from "@/lib/utils/style";

interface DecisionBreakdownPanelProps {
  opportunity: Opportunity;
}

export function DecisionBreakdownPanel({ opportunity }: DecisionBreakdownPanelProps) {
  return (
    <SectionPanel
      title="Decision breakdown"
      description={`${opportunity.instrumentName} (${opportunity.instrumentSymbol}) · Confidence ${opportunity.confidencePercent}%`}
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        {opportunity.evidence.map((item) => (
          <div key={item.label} className="flex items-center justify-between gap-4">
            <span className="text-sm text-ink-300">{item.label}</span>
            <StarRating score={item.score} />
          </div>
        ))}

        <div className="mt-2 flex items-center justify-between border-t border-base-700/60 pt-3">
          <span className="text-sm font-medium text-ink-100">Overall rating</span>
          <Badge className={recommendationClasses(opportunity.recommendation)}>
            {opportunity.recommendation}
          </Badge>
        </div>
      </div>
    </SectionPanel>
  );
}
