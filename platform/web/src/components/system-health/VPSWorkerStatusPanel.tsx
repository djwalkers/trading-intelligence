"use client";

import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/lib/auth/auth-context";
import { useServerSchedule } from "@/lib/state/server-schedule-context";
import { formatDateTime } from "@/lib/utils/format";

// Legacy-worker UI cleanup. This panel previously conflated "the schedule is enabled" with "the
// background service is healthy" — an "Enabled" badge with an aging, un-flagged "Last scan"
// timestamp looked identical whether the worker was running normally or had stopped entirely (see
// docs/audit/LEGACY_WORKER_IMPACT_ASSESSMENT.md, §7 and its safety verdict). This panel is
// developer/legacy-scoped — see its SectionPanel's own "(Developer)" title on the Operations
// Centre page — and never represents Hermes Agent/eToro status (see HermesAgentStatusPanel for
// that, elsewhere on this same page).
type ObservedWorkerState = "running" | "stopped" | "stale" | "unavailable";

// A schedule counts as "stale" once it is overdue by more than double its own configured interval
// (minimum 10 minutes' grace) — enough margin to absorb a single slow/delayed poll cycle without
// flapping, while still catching a genuinely stopped background service within one missed cycle
// or two, never silently presenting it as healthy activity.
function classifyWorkerState(
  isConfigured: boolean,
  isAvailable: boolean,
  isEnabled: boolean,
  nextScanAt: string | null | undefined,
  intervalMinutes: number | null | undefined,
): ObservedWorkerState {
  if (!isConfigured || !isAvailable) return "unavailable";
  if (!isEnabled) return "stopped";
  if (!nextScanAt) return "running";
  const overdueMs = Date.now() - new Date(nextScanAt).getTime();
  const graceMs = Math.max(intervalMinutes ?? 30, 5) * 60_000 * 2;
  return overdueMs > graceMs ? "stale" : "running";
}

const WORKER_STATE_BADGE_CLASSES: Record<ObservedWorkerState, string> = {
  running: "border-accent-teal/30 bg-accent-teal/10 text-accent-teal",
  stopped: "border-base-600 bg-base-800 text-ink-300",
  stale: "border-accent-amber/30 bg-accent-amber/10 text-accent-amber",
  unavailable: "border-base-600 bg-base-800 text-ink-400",
};

const WORKER_STATE_LABEL: Record<ObservedWorkerState, string> = {
  running: "Running",
  stopped: "Stopped",
  stale: "Stale",
  unavailable: "Unavailable",
};

const WORKER_STATE_DETAIL: Record<ObservedWorkerState, string> = {
  running: "Configured here; runs on a dedicated background service, not this browser.",
  stopped: "Always-on scanning is disabled — no schedule is configured to run.",
  stale:
    "Configured to run, but no recent activity was recorded — the background service may not be running. This never affects real trading.",
  unavailable: "Requires a connected database and sign-in to check.",
};

// Build 1.12.0 — renamed from ServerSchedulerStatusPanel. Reads the same always-on scanning
// schedule Settings' ServerAutomationPanel reads and writes, via ServerScheduleProvider's periodic
// poll, so this reflects updates from the background service without requiring a manual reload.
export function VPSWorkerStatusPanel() {
  const { isConfigured } = useAuth();
  const { schedule, isAvailable } = useServerSchedule();
  const isEnabled = schedule?.enabled ?? false;
  const observedState = classifyWorkerState(
    isConfigured,
    isAvailable,
    isEnabled,
    schedule?.nextScanAt,
    schedule?.intervalMinutes,
  );

  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Always-on scanning (legacy simulator)</span>
          <span className="text-xs text-ink-500">{WORKER_STATE_DETAIL[observedState]}</span>
        </div>
        <Badge className={WORKER_STATE_BADGE_CLASSES[observedState]} data-testid="legacy-worker-observed-state">
          {WORKER_STATE_LABEL[observedState]}
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
            This browser cannot directly confirm the background service process is alive — the
            state above is inferred from whether a scan ran recently enough to match the configured
            interval, never presented as healthy activity once it falls too far behind.
          </span>
        </div>
      </div>
    </div>
  );
}
