import { Badge } from "@/components/ui/Badge";
import { SectionPanel } from "@/components/ui/SectionPanel";
import type { Opportunity } from "@/lib/types";
import { recommendationClasses } from "@/lib/utils/style";

interface RecommendationPanelProps {
  opportunity: Opportunity;
  tradeable: boolean;
  alreadyTraded: boolean;
  onPaperTrade: () => void;
}

export function RecommendationPanel({
  opportunity,
  tradeable,
  alreadyTraded,
  onPaperTrade,
}: RecommendationPanelProps) {
  return (
    <SectionPanel title="Recommendation">
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Badge className={`text-sm ${recommendationClasses(opportunity.recommendation)}`}>
            {opportunity.recommendation}
          </Badge>

          {tradeable ? (
            alreadyTraded ? (
              <Badge className="border-base-600 bg-base-800 text-ink-400">Trade placed</Badge>
            ) : (
              <button
                type="button"
                onClick={onPaperTrade}
                className="whitespace-nowrap rounded-lg border border-accent-teal/30 bg-accent-teal/10 px-3 py-1.5 text-xs font-medium text-accent-teal transition-colors hover:bg-accent-teal/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
              >
                Paper Trade
              </button>
            )
          ) : (
            <span className="text-xs text-ink-500">Not tradeable — for monitoring only</span>
          )}
        </div>

        <p className="text-sm leading-relaxed text-ink-300">{opportunity.narrative}</p>
      </div>
    </SectionPanel>
  );
}
