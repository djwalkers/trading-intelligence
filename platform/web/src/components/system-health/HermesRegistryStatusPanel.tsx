import { Badge } from "@/components/ui/Badge";
import { getHermesExecutionStatus } from "@/lib/hermes-execution/status";

// Hermes Execution MVP Phase 1 — read-only status for the isolated Hermes Strategy Registry ->
// paper trading pipeline (src/lib/hermes-execution/). Deliberately reuses the Operations Centre
// rather than a new page, per that phase's "reuse existing pages" mandate. Every value here is
// read live from configuration and the pipeline's own persisted state; nothing is hardcoded.
export async function HermesRegistryStatusPanel() {
  const status = await getHermesExecutionStatus();

  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Execution mode</span>
          <span className="text-xs text-ink-500">Only paper trading is supported in this phase.</span>
        </div>
        <Badge className="border-accent-teal/30 bg-accent-teal/10 text-accent-teal">
          {status.executionMode}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Strategy Registry connection</span>
          <span className="text-xs text-ink-500">
            {status.registryConfigured
              ? status.registryPath
              : "HERMES_STRATEGY_REGISTRY_PATH is not configured."}
          </span>
        </div>
        <Badge
          className={
            status.registryConnected
              ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
              : "border-base-600 bg-base-800 text-ink-300"
          }
        >
          {status.registryConfigured ? (status.registryConnected ? "Connected" : "Unreachable") : "Not configured"}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Hermes-approved strategies</span>
          <span className="text-xs text-ink-500">
            Strategies with promotionStatus.decision === &quot;ELIGIBLE&quot; in the registry.
          </span>
        </div>
        <Badge className="border-base-600 bg-base-800 text-ink-300">{status.hermesApprovedCount}</Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Demo execution mode</span>
          <span className="text-xs text-ink-500">
            {status.demoStrategyActive
              ? "The DEMO_ONLY strategy is loaded — deterministic fixture data only, never evidence-backed."
              : "Disabled — the DEMO_ONLY strategy does not exist in this process."}
          </span>
        </div>
        <Badge
          className={
            status.demoExecutionModeEnabled
              ? "border-accent-amber/30 bg-accent-amber/10 text-accent-amber"
              : "border-base-600 bg-base-800 text-ink-300"
          }
        >
          {status.demoExecutionModeEnabled ? "Enabled" : "Disabled"}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Open paper positions</span>
          <span className="text-xs text-ink-500">From the last `npm run execution:demo` replay.</span>
        </div>
        <Badge className="border-base-600 bg-base-800 text-ink-300">{status.openPositions.length}</Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Completed paper trades</span>
          <span className="text-xs text-ink-500">Realised P/L: {status.realisedPnl.toFixed(2)}</span>
        </div>
        <Badge className="border-base-600 bg-base-800 text-ink-300">{status.completedTrades.length}</Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Latest execution event</span>
          <span className="text-xs text-ink-500">
            {status.latestEvent
              ? `${status.latestEvent.eventType} — ${status.latestEvent.timestamp}`
              : "No execution run recorded yet."}
          </span>
        </div>
      </div>

      {status.error ? (
        <div className="px-5 py-4">
          <span className="text-xs text-accent-red">Status unavailable: {status.error}</span>
        </div>
      ) : null}
    </div>
  );
}
