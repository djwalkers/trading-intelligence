import { Badge } from "@/components/ui/Badge";
import { IntelligenceScoreDisplay } from "@/components/market-intelligence/IntelligenceScoreDisplay";
import type { Opportunity } from "@/lib/types";
import { calculateOverallIntelligenceScore } from "@/lib/utils/intelligence-score";
import { signalToneClasses } from "@/lib/utils/style";

interface OpportunityListProps {
  opportunities: Opportunity[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  compareIds: string[];
  onToggleCompare: (id: string) => void;
  maxCompare: number;
}

export function OpportunityList({
  opportunities,
  selectedId,
  onSelect,
  compareIds,
  onToggleCompare,
  maxCompare,
}: OpportunityListProps) {
  return (
    <div className="divide-y divide-base-700/60">
      {opportunities.map((opportunity, index) => {
        const isSelected = opportunity.id === selectedId;
        const isComparing = compareIds.includes(opportunity.id);
        const compareDisabled = !isComparing && compareIds.length >= maxCompare;
        const overall = calculateOverallIntelligenceScore(opportunity.intelligenceFactors);

        return (
          <div
            key={opportunity.id}
            className={`flex items-start gap-3 px-5 py-3.5 transition-colors ${
              isSelected ? "bg-base-800" : "hover:bg-base-800/50"
            }`}
          >
            <label
              className="mt-1 flex shrink-0 cursor-pointer items-center"
              onClick={(event) => event.stopPropagation()}
              title={compareDisabled ? `You can compare up to ${maxCompare} at a time` : "Compare"}
            >
              <input
                type="checkbox"
                checked={isComparing}
                disabled={compareDisabled}
                onChange={() => onToggleCompare(opportunity.id)}
                className="h-3.5 w-3.5 accent-accent-teal disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={`Compare ${opportunity.instrumentName}`}
              />
            </label>

            <button
              type="button"
              onClick={() => onSelect(opportunity.id)}
              aria-pressed={isSelected}
              className="flex w-full flex-col gap-2 text-left focus-visible:outline-none"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="text-xs text-ink-600">#{index + 1}</span>
                  <div className="flex flex-col">
                    <span className="font-medium text-ink-100">{opportunity.instrumentName}</span>
                    <span className="text-xs text-ink-500">{opportunity.instrumentSymbol}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge className={signalToneClasses(opportunity.signalType)}>
                    {opportunity.signalType}
                  </Badge>
                  <span className="text-sm font-semibold text-ink-100">
                    {opportunity.confidencePercent}%
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="text-[10px] uppercase tracking-wide text-ink-600">Score</span>
                    <IntelligenceScoreDisplay overall={overall} compact />
                  </span>
                </div>
              </div>
              <p className="text-xs text-ink-500">{opportunity.reasons.join(" · ")}</p>
            </button>
          </div>
        );
      })}
    </div>
  );
}
