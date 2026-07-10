"use client";

import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/lib/auth/auth-context";
import { useServerSchedule } from "@/lib/state/server-schedule-context";
import { formatDateTime } from "@/lib/utils/format";

// Live, not mocked — reads the same `bot_schedules` row the Dashboard's Server Schedule panel
// (Mission 10) reads and writes, via ServerScheduleProvider's periodic poll, so this reflects
// worker-driven updates (last_scan_at/last_status/last_error) without requiring a manual reload.
export function ServerSchedulerStatusPanel() {
  const { isConfigured } = useAuth();
  const { schedule, isAvailable } = useServerSchedule();
  const isEnabled = schedule?.enabled ?? false;

  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Server Scheduler</span>
          <span className="text-xs text-ink-500">
            {!isConfigured
              ? "Requires Supabase to be configured."
              : !isAvailable
                ? "Sign in to view or manage a server-side schedule."
                : "Configuration stored in Supabase; executed by the VPS worker, not this browser."}
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
          <span className="text-sm font-medium text-ink-100">Next server scan</span>
          <span className="text-xs text-ink-500">Only set while the server schedule is enabled</span>
        </div>
        <span className="text-sm text-ink-300">
          {isEnabled && schedule?.nextScanAt ? formatDateTime(schedule.nextScanAt) : "—"}
        </span>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Last server scan</span>
          <span className="text-xs text-ink-500">
            {schedule?.lastStatus ? `Last status: ${schedule.lastStatus}` : "No server-triggered scan recorded yet"}
          </span>
        </div>
        <span className="text-sm text-ink-300">
          {schedule?.lastScanAt ? formatDateTime(schedule.lastScanAt) : "Never run"}
        </span>
      </div>

      {schedule?.lastError ? (
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-ink-100">Last worker error</span>
            <span className="max-w-md text-xs text-accent-amber">{schedule.lastError}</span>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Worker requirement</span>
          <span className="max-w-md text-xs text-ink-500">
            A server schedule being enabled does not mean a worker is running — this browser has no
            way to detect that directly. Start it separately with{" "}
            <code className="rounded bg-base-800 px-1 py-0.5 text-[11px]">npm run worker</code> (see
            docs/product/MISSION-8-VPS-WORKER.md). &ldquo;Last server scan&rdquo; above is the only
            indirect evidence a worker has actually been running.
          </span>
        </div>
        <Badge className="border-base-600 bg-base-800 text-ink-300">Not detectable</Badge>
      </div>
    </div>
  );
}
