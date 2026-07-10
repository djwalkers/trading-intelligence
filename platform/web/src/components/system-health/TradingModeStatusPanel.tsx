import { Badge } from "@/components/ui/Badge";

// Build 1.12.0 — replaces the old static "Services" list (Broker API / Risk Engine / Execution
// Engine, hardcoded mock data that never reflected reality). Paper trading is the platform's
// genuinely active mode today, so it's reported positively rather than framed as a missing
// feature — the previous "Execution Engine: Disabled" wording implied something was broken.
export function TradingModeStatusPanel() {
  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Paper trading</span>
          <span className="text-xs text-ink-500">
            Every trade the AI Engine or a person opens is simulated — no real money moves.
          </span>
        </div>
        <Badge className="border-accent-teal/30 bg-accent-teal/10 text-accent-teal">Enabled</Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Live trading</span>
          <span className="text-xs text-ink-500">
            Real orders cannot be placed on this platform yet.
          </span>
        </div>
        <Badge className="border-base-600 bg-base-800 text-ink-300">Not enabled</Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Broker connection</span>
          <span className="text-xs text-ink-500">See Settings for details.</span>
        </div>
        <Badge className="border-base-600 bg-base-800 text-ink-300">Coming soon</Badge>
      </div>
    </div>
  );
}
