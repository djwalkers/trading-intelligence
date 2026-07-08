import { Badge } from "@/components/ui/Badge";
import { SectionPanel } from "@/components/ui/SectionPanel";
import type { StrategyScore } from "@/lib/types";
import { computeContributionPercent } from "@/lib/strategy-engine";
import { signalToneClasses } from "@/lib/utils/style";

interface StrategyBreakdownPanelProps {
  score: StrategyScore;
}

// The detailed counterpart to GeneratedByPanel's compact vote list — full evidence per strategy,
// plus each one's share of the combined confidence ("contribution").
export function StrategyBreakdownPanel({ score }: StrategyBreakdownPanelProps) {
  return (
    <SectionPanel
      title="Strategy breakdown"
      description="Every strategy's signal, confidence, evidence, and share of the combined call"
    >
      <div className="flex flex-col divide-y divide-base-700/60">
        {score.results.map((result) => {
          const contribution = computeContributionPercent(result, score.results);
          const agrees = result.signal === score.overallSignal;

          return (
            <div key={result.strategyId} className="flex flex-col gap-2.5 px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="text-sm font-medium text-ink-100">{result.strategyName}</span>
                  <Badge className={signalToneClasses(result.signal)}>{result.signal}</Badge>
                  {!agrees ? (
                    <span className="text-xs text-accent-amber">Dissents from overall call</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-4 text-sm text-ink-300">
                  <span>{result.confidence}% confidence</span>
                  <span>{contribution}% contribution</span>
                </div>
              </div>

              <ul className="flex flex-col gap-1.5">
                {result.evidence.map((item, index) => (
                  <li key={index} className="flex items-start gap-2 text-xs text-ink-400">
                    <span
                      className="mt-1 h-1 w-1 shrink-0 rounded-full bg-ink-500"
                      aria-hidden="true"
                    />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </SectionPanel>
  );
}
