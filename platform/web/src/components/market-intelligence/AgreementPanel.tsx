import { Badge } from "@/components/ui/Badge";
import { SectionPanel } from "@/components/ui/SectionPanel";
import type { StrategyScore } from "@/lib/types";
import { agreementLevelClasses } from "@/lib/utils/style";

interface AgreementPanelProps {
  score: StrategyScore;
}

export function AgreementPanel({ score }: AgreementPanelProps) {
  return (
    <SectionPanel title="Agreement">
      <div className="flex flex-col gap-3 px-5 py-4">
        <Badge className={`w-fit text-sm ${agreementLevelClasses(score.agreement)}`}>
          {score.agreement}
        </Badge>
        <p className="text-sm leading-relaxed text-ink-300">{score.agreementExplanation}</p>
      </div>
    </SectionPanel>
  );
}
