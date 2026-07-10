"use client";

import { Badge } from "@/components/ui/Badge";
import {
  useBotScheduler,
  SCHEDULE_INTERVAL_MINUTES,
  type SchedulerMode,
} from "@/lib/state/bot-scheduler-context";
import { formatDateTime } from "@/lib/utils/format";
import { useToast } from "@/lib/notifications/use-toast";

const MODE_OPTIONS: { value: SchedulerMode; label: string }[] = [
  { value: "Manual", label: "Manual only" },
  { value: "Every15", label: "Every 15 minutes" },
  { value: "Every30", label: "Every 30 minutes" },
  { value: "Every60", label: "Every 60 minutes" },
];

// Build 1.12.0 — the configuration half of what used to be BotRunnerPanel's "Browser schedule"
// section (Mission 4), moved here from the Dashboard per this build's information-architecture
// change. The execution half (the actual tick that fires a scan when due) now lives in
// AutomationRunner, mounted app-wide (src/components/automation/AutomationRunner.tsx) — this
// component only reads and writes scheduler state via useBotScheduler(), it doesn't run anything
// itself, so this panel can safely live on any page without affecting whether scans actually fire.
export function BrowserAutomationPanel() {
  const scheduler = useBotScheduler();
  const currentIntervalMinutes = SCHEDULE_INTERVAL_MINUTES[scheduler.mode];
  const { notify } = useToast();

  return (
    <div className="flex flex-col gap-2.5 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium text-ink-100">This browser</span>
        <span aria-live="polite">
          <Badge
            className={
              scheduler.status === "Running"
                ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
                : "border-base-600 bg-base-800 text-ink-300"
            }
          >
            {scheduler.status}
          </Badge>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-ink-400">
          Frequency
          <select
            value={scheduler.mode}
            onChange={(event) => scheduler.setMode(event.target.value as SchedulerMode)}
            className="rounded-lg border border-base-600 bg-base-900 px-2 py-1 text-xs text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            {MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => {
            scheduler.start();
            notify("success", "Automatic scanning enabled for this browser.");
          }}
          disabled={scheduler.mode === "Manual" || scheduler.status === "Running"}
          className="rounded-lg border border-accent-teal/30 bg-accent-teal/10 px-3 py-1.5 text-xs font-medium text-accent-teal transition-colors hover:bg-accent-teal/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Start automatic scanning
        </button>
        <button
          type="button"
          onClick={() => {
            scheduler.stop();
            notify("info", "Automatic scanning disabled for this browser.");
          }}
          disabled={scheduler.status !== "Running"}
          className="rounded-lg border border-base-600 bg-base-800 px-3 py-1.5 text-xs font-medium text-ink-300 transition-colors hover:bg-base-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Stop
        </button>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-500">
        <span>
          Current interval: {currentIntervalMinutes ? `${currentIntervalMinutes} minutes` : "None (manual only)"}
        </span>
        <span>Last scan: {scheduler.lastScanAt ? formatDateTime(scheduler.lastScanAt) : "Never"}</span>
        <span>
          Next scan:{" "}
          {scheduler.status === "Running" && scheduler.nextScanAt
            ? formatDateTime(scheduler.nextScanAt)
            : "—"}
        </span>
      </div>

      {scheduler.stopReason ? (
        <p className="text-xs text-accent-amber">Stopped automatically: {scheduler.stopReason}</p>
      ) : null}

      <p className="text-xs text-ink-500">
        <strong className="font-medium text-ink-500">This browser:</strong> keeps scanning as long
        as this browser is open in any tab — it does not need to stay on any particular page. Closing
        the browser entirely pauses it until you return. For scanning that continues even when your
        browser is closed, use the server-based automatic scanning below.
      </p>
    </div>
  );
}
