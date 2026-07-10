"use client";

import { useState } from "react";
import Link from "next/link";
import type { Instrument } from "@/lib/types";
import { useBotScanRunner } from "@/lib/state/use-bot-scan-runner";

interface QuickActionsPanelProps {
  instruments: Instrument[];
}

const LINK_ACTIONS = [
  { href: "/settings", label: "Configure automatic scanning" },
  { href: "/portfolio", label: "View paper portfolio" },
  { href: "/trade-journal", label: "View trade journal" },
  { href: "/system-health", label: "Open Operations Centre" },
];

// Build 1.12.0 — the one place on the redesigned Dashboard where you can act, not just observe:
// trigger a scan immediately, or jump to the page that handles everything else. Calls the same
// useBotScanRunner() hook AutomationRunner uses for scheduled scans, so a manual run here and an
// automatic one behave identically.
export function QuickActionsPanel({ instruments }: QuickActionsPanelProps) {
  const { runScan, isScanning } = useBotScanRunner(instruments);
  // Build 1.12.2 — a visually-hidden status announcement for screen-reader users: the visible
  // result of a scan only shows up in other Dashboard widgets (Recent AI Decisions, AI Activity
  // KPIs), which a screen reader wouldn't otherwise notice changed after this button is pressed.
  const [announcement, setAnnouncement] = useState("");

  async function handleScan() {
    setAnnouncement("Scan started.");
    const decision = await runScan("Manual");
    if (!decision) {
      // A failure toast has already been shown by useBotScanRunner — this just keeps the
      // sr-only announcement in sync rather than leaving "Scan started." as the last thing read.
      setAnnouncement("Scan failed. See the notification for details.");
      return;
    }
    setAnnouncement(
      decision.tradeCreated
        ? `Scan complete. Trade opened for ${decision.selectedInstrument ?? "an instrument"}.`
        : `Scan complete. ${decision.actionTaken}.`,
    );
  }

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <button
        type="button"
        onClick={handleScan}
        disabled={isScanning}
        className="w-full rounded-lg border border-accent-teal/30 bg-accent-teal/10 px-4 py-2.5 text-sm font-medium text-accent-teal transition-colors hover:bg-accent-teal/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
      >
        {isScanning ? "Scanning…" : "Run scan now"}
      </button>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

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
