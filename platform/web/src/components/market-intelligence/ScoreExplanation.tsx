import { SectionPanel } from "@/components/ui/SectionPanel";
import type { IntelligenceFactorScores } from "@/lib/types";
import { explainIntelligenceScore } from "@/lib/utils/intelligence-score";

interface ScoreExplanationProps {
  factors: IntelligenceFactorScores;
  overall: number;
}

// Rule-based explanation of why the score is what it is — plain English, generated from
// thresholds, not a model. Mirrors the existing "Why?" / "What could change?" panels in tone.
export function ScoreExplanation({ factors, overall }: ScoreExplanationProps) {
  const explanation = explainIntelligenceScore(factors, overall);

  return (
    <SectionPanel title="Explain score" description="Why this score, in plain terms">
      <div className="flex flex-col gap-4 px-5 py-4">
        <p className="text-sm leading-relaxed text-ink-300">{explanation.summary}</p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">
              Increased confidence
            </p>
            {explanation.strengths.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {explanation.strengths.map((label) => (
                  <li key={label} className="flex items-start gap-2 text-sm text-ink-300">
                    <span
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-500"
                      aria-hidden="true"
                    />
                    {label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-500">No single factor stands out strongly.</p>
            )}
          </div>

          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">
              Reduced confidence
            </p>
            {explanation.weaknesses.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {explanation.weaknesses.map((label) => (
                  <li key={label} className="flex items-start gap-2 text-sm text-ink-300">
                    <span
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-amber"
                      aria-hidden="true"
                    />
                    {label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-500">No factor is meaningfully working against it.</p>
            )}
          </div>
        </div>
      </div>
    </SectionPanel>
  );
}
