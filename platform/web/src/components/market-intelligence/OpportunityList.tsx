import { Badge } from "@/components/ui/Badge";
import type { Opportunity } from "@/lib/types";
import { signalToneClasses } from "@/lib/utils/style";

interface OpportunityListProps {
  opportunities: Opportunity[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function OpportunityList({ opportunities, selectedId, onSelect }: OpportunityListProps) {
  return (
    <div className="divide-y divide-base-700/60">
      {opportunities.map((opportunity, index) => {
        const isSelected = opportunity.id === selectedId;

        return (
          <button
            key={opportunity.id}
            type="button"
            onClick={() => onSelect(opportunity.id)}
            aria-pressed={isSelected}
            className={`flex w-full flex-col gap-2 px-5 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 focus-visible:ring-inset ${
              isSelected ? "bg-base-800" : "hover:bg-base-800/50"
            }`}
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
              </div>
            </div>
            <p className="text-xs text-ink-500">{opportunity.reasons.join(" · ")}</p>
          </button>
        );
      })}
    </div>
  );
}
