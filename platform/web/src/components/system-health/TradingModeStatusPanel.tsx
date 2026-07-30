import { Badge } from "@/components/ui/Badge";

// Legacy-worker UI cleanup. This panel previously claimed "Broker connection: Not available yet"
// and framed "Paper trading" as the platform's only active mode — both stale, predating the real
// Hermes Agent/eToro integration and directly contradicted by it (see
// docs/audit/LEGACY_WORKER_IMPACT_ASSESSMENT.md). The real broker connection now has its own
// panel (HermesAgentStatusPanel, above on this page) — this panel is scoped to the legacy
// simulator only, and no longer makes any claim about broker connectivity.
export function TradingModeStatusPanel() {
  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Legacy paper-trading simulator</span>
          <span className="text-xs text-ink-500">
            Every trade the legacy simulator or a person opens here is simulated — no real money
            moves, and it is not connected to Hermes Agent or eToro.
          </span>
        </div>
        <Badge className="border-accent-teal/30 bg-accent-teal/10 text-accent-teal">Enabled</Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Live trading (real money)</span>
          <span className="text-xs text-ink-500">
            Real orders cannot be placed on this platform — the Hermes Agent/eToro pipeline
            currently trades on a demo account only.
          </span>
        </div>
        <Badge className="border-base-600 bg-base-800 text-ink-300">Not enabled</Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">eToro broker connection</span>
          <span className="text-xs text-ink-500">See the Hermes Agent panel above for live status.</span>
        </div>
      </div>
    </div>
  );
}
