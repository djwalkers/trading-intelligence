import { Badge } from "@/components/ui/Badge";

interface StrategyEngineStatusPanelProps {
  strategiesLoaded: number;
  instrumentsEvaluated: number;
  evaluationTimeMs: number;
}

// Server-rendered, not a client hook like the Auth/Persistence/Market Data panels — the Strategy
// Engine is a pure, synchronous, in-memory computation with no configuration and no failure mode,
// so there is nothing async to subscribe to. The numbers below are measured fresh on every
// request that renders this page.
export function StrategyEngineStatusPanel({
  strategiesLoaded,
  instrumentsEvaluated,
  evaluationTimeMs,
}: StrategyEngineStatusPanelProps) {
  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Strategy calculations</span>
          <span className="text-xs text-ink-500">
            Always available — a deterministic, in-memory calculation with no external dependency
            to fail.
          </span>
        </div>
        <Badge className="border-accent-teal/30 bg-accent-teal/10 text-accent-teal">Active</Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Strategies active</span>
          <span className="text-xs text-ink-500">
            Moving Average Crossover, RSI Reversal, Momentum
          </span>
        </div>
        <span className="text-sm text-ink-300">{strategiesLoaded}</span>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Evaluation speed</span>
          <span className="text-xs text-ink-500">
            {instrumentsEvaluated} instrument{instrumentsEvaluated === 1 ? "" : "s"} evaluated on
            this request
          </span>
        </div>
        <span className="text-sm text-ink-300">{evaluationTimeMs.toFixed(2)}ms</span>
      </div>
    </div>
  );
}
