import type { IntelligenceFactorScores } from "@/lib/types";
import { FACTOR_LABELS, FACTOR_ORDER } from "@/lib/utils/intelligence-score";

interface IntelligenceScoreBreakdownProps {
  factors: IntelligenceFactorScores;
}

// Plain, monochrome bars — no gradients, no colour-per-factor. The bar fill communicates
// magnitude; the number alongside it is the source of truth.
export function IntelligenceScoreBreakdown({ factors }: IntelligenceScoreBreakdownProps) {
  return (
    <div className="flex flex-col gap-3">
      {FACTOR_ORDER.map((key) => (
        <div key={key} className="flex items-center gap-3">
          <span className="w-28 shrink-0 text-sm text-ink-300">{FACTOR_LABELS[key]}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-base-700">
            <div
              className="h-full rounded-full bg-ink-100"
              style={{ width: `${factors[key]}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right text-sm text-ink-400">{factors[key]}</span>
        </div>
      ))}
    </div>
  );
}
