import type { Strategy } from "@/lib/types";
import { Badge } from "@/components/ui/Badge";
import { strategyStatusClasses, strategyStatusLabel } from "@/lib/utils/style";

interface StrategyListProps {
  strategies: Strategy[];
}

export function StrategyList({ strategies }: StrategyListProps) {
  return (
    <div className="divide-y divide-base-700/60">
      {strategies.map((strategy) => (
        <div key={strategy.id} className="flex flex-col gap-2 px-5 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-ink-100">{strategy.name}</span>
            <Badge className={strategyStatusClasses(strategy.status)}>
              {strategyStatusLabel(strategy.status)}
            </Badge>
          </div>
          <p className="text-sm text-ink-400">{strategy.description}</p>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-500">
            <span>Covers {strategy.instrumentsCovered.join(", ")}</span>
            <span>{strategy.signalsGenerated30d} signals / 30d</span>
            {strategy.status !== "backtesting" ? (
              <span>{strategy.winRatePercent}% historical win rate</span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
