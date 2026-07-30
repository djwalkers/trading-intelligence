"use client";

import { useState } from "react";
import { instruments } from "@/lib/mock";
import { useBotScanRunner } from "@/lib/state/use-bot-scan-runner";

// Legacy-worker UI cleanup. This manual trigger previously lived on the primary Dashboard as "Run
// scan now" — removed from there (see QuickActionsPanel.tsx and
// docs/audit/LEGACY_WORKER_IMPACT_ASSESSMENT.md) so the Dashboard no longer suggests this legacy
// simulator is part of the live Hermes Agent/eToro pipeline. The trigger itself is preserved here,
// clearly scoped to the legacy simulator, rather than deleted — it calls the exact same
// useBotScanRunner() hook, unchanged, so its behaviour is identical to before.
export function LegacyScanTriggerControl() {
  const { runScan, isScanning } = useBotScanRunner(instruments);
  const [announcement, setAnnouncement] = useState("");

  async function handleScan() {
    setAnnouncement("Legacy scan started.");
    const decision = await runScan("Manual");
    if (!decision) {
      setAnnouncement("Legacy scan failed. See the notification for details.");
      return;
    }
    setAnnouncement(
      decision.tradeCreated
        ? `Legacy scan complete. Simulated trade opened for ${decision.selectedInstrument ?? "an instrument"}.`
        : `Legacy scan complete. ${decision.actionTaken}.`,
    );
  }

  return (
    <div className="flex flex-col gap-2 px-5 py-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-ink-100">Manual scan</span>
        <span className="text-xs text-ink-500">
          Runs the legacy simulator once, immediately, in this browser only — never places a real
          order and never involves Hermes Agent or eToro.
        </span>
      </div>
      <button
        type="button"
        onClick={handleScan}
        disabled={isScanning}
        className="w-full rounded-lg border border-base-600 bg-base-800 px-4 py-2.5 text-sm font-medium text-ink-200 transition-colors hover:bg-base-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
      >
        {isScanning ? "Scanning…" : "Run legacy scan now"}
      </button>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
