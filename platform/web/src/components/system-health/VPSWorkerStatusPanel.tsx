"use client";

import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/lib/auth/auth-context";
import { useServerSchedule } from "@/lib/state/server-schedule-context";
import { formatDateTime } from "@/lib/utils/format";

// Build 1.12.0 — renamed from ServerSchedulerStatusPanel. Reads the same always-on scanning
// schedule Settings' ServerAutomationPanel reads and writes, via ServerScheduleProvider's periodic
// poll, so this reflects updates from the background service without requiring a manual reload.
export function VPSWorkerStatusPanel() {
  const { isConfigured } = useAuth();
  const { schedule, isAvailable } = useServerSchedule();
  const isEnabled = schedule?.enabled ?? false;

  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Always-on scanning</span>
          <span className="text-xs text-ink-500">
            {!isConfigured
              ? "Requires a connected database."
              : !isAvailable
                ? "Sign in to view or manage always-on scanning."
                : "Configured here; runs on a dedicated background service, not this browser."}
          </span>
        </div>
        <Badge
          className={
            isEnabled
              ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
              : "border-base-600 bg-base-800 text-ink-300"
          }
        >
          {isAvailable ? (isEnabled ? "Enabled" : "Disabled") : "Unavailable"}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Next scan</span>
          <span className="text-xs text-ink-500">Only set while always-on scanning is enabled</span>
        </div>
        <span className="text-sm text-ink-300">
          {isEnabled && schedule?.nextScanAt ? formatDateTime(schedule.nextScanAt) : "—"}
        </span>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Last scan</span>
          <span className="text-xs text-ink-500">
            {schedule?.lastStatus ? `Last result: ${schedule.lastStatus}` : "No scan recorded yet"}
          </span>
        </div>
        <span className="text-sm text-ink-300">
          {schedule?.lastScanAt ? formatDateTime(schedule.lastScanAt) : "Never run"}
        </span>
      </div>

      {schedule?.lastError ? (
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-ink-100">Last error</span>
            <span className="max-w-md text-xs text-accent-amber">{schedule.lastError}</span>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Background service</span>
          <span className="max-w-md text-xs text-ink-500">
            Enabling always-on scanning configures when a scan should run — it doesn&apos;t
            guarantee the background service itself is running, which this browser has no direct
            way to detect. &ldquo;Last scan&rdquo; above is the clearest evidence it is.
          </span>
        </div>
        <Badge className="border-base-600 bg-base-800 text-ink-300">Not directly detectable</Badge>
      </div>
    </div>
  );
}
