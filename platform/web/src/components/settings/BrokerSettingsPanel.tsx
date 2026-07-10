import { Badge } from "@/components/ui/Badge";

// Build 1.12.0 — an honest placeholder, not a fake toggle: this platform has no broker connection
// today, and nothing here pretends otherwise. When a broker integration is added, its connection
// and account settings will live in this same panel.
export function BrokerSettingsPanel() {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-ink-100">Broker connection</span>
        <span className="text-xs text-ink-500">
          This platform currently supports paper trading only — no broker account is connected and
          no real orders can be placed.
        </span>
      </div>
      <Badge className="border-base-600 bg-base-800 text-ink-300">Coming soon</Badge>
    </div>
  );
}
