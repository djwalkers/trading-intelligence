import { Badge } from "@/components/ui/Badge";
import { getScoreBand } from "@/lib/utils/intelligence-score";
import { scoreBandClasses, scoreBandLabel } from "@/lib/utils/style";

interface IntelligenceScoreDisplayProps {
  overall: number;
  compact?: boolean;
}

// Reusable "headline" score element — a plain number in compact mode (for dense lists, where
// it sits alongside other plain numbers like confidence%), or the number plus a restrained band
// badge in full mode (for the selected opportunity's detail view).
export function IntelligenceScoreDisplay({ overall, compact = false }: IntelligenceScoreDisplayProps) {
  if (compact) {
    return <span className="text-sm font-semibold text-ink-100">{overall}</span>;
  }

  const band = getScoreBand(overall);

  return (
    <div className="flex items-center gap-2.5">
      <span className="text-2xl font-semibold tracking-tight text-ink-100">{overall}</span>
      <Badge className={scoreBandClasses(band)}>{scoreBandLabel(band)}</Badge>
    </div>
  );
}
