import Link from "next/link";

const LINK_ACTIONS = [
  { href: "/settings", label: "Legacy scan settings" },
  { href: "/portfolio", label: "View paper portfolio" },
  { href: "/trade-journal", label: "View trade journal" },
  { href: "/system-health", label: "Open Operations Centre" },
];

// Legacy-worker UI cleanup. This panel previously included a "Run scan now" button that invoked
// the legacy Strategy Simulator (useBotScanRunner) directly from the primary Dashboard, with no
// label distinguishing it from anything Hermes-related — see
// docs/audit/LEGACY_WORKER_IMPACT_ASSESSMENT.md. That action has been removed from the primary
// Dashboard rather than replaced with a Hermes-labelled substitute (there is no equivalent
// on-demand action for the real Hermes Agent — it runs on its own schedule). A manual trigger for
// the legacy simulator remains available, clearly labelled, in Settings' "Legacy paper-trading
// simulator" section (LegacyScanTriggerControl) — this panel only links there now.
export function QuickActionsPanel() {
  return (
    <div className="flex flex-col gap-2 px-5 py-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {LINK_ACTIONS.map((action) => (
          <Link
            key={action.href}
            href={action.href}
            className="rounded-lg border border-base-700 bg-base-850 px-4 py-2.5 text-sm text-ink-300 transition-colors hover:border-base-600 hover:bg-base-800 hover:text-ink-100"
          >
            {action.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
