"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/lib/auth/auth-context";
import { useServerSchedule } from "@/lib/state/server-schedule-context";
import { formatDateTime } from "@/lib/utils/format";

const INTERVAL_OPTIONS = [15, 30, 60] as const;
const DEFAULT_INTERVAL_MINUTES = 30;

// Build 1.12.0 — renamed and relocated from the Dashboard's "Server schedule" panel (Mission 10)
// to Settings, alongside its browser-based counterpart. Unchanged behaviour: this is the
// browser-side control surface for a database-stored automatic-scanning schedule, executed by the
// always-on VPS worker, independently of this or any browser tab.
export function ServerAutomationPanel() {
  const { isConfigured, isLoading: isAuthLoading, user } = useAuth();
  const { schedule, isAvailable, isHydrated, error, save } = useServerSchedule();
  // Only set once the user actively changes the selector — otherwise the displayed interval is
  // derived straight from the loaded row (see intervalMinutes below), no effect/sync needed.
  const [intervalOverride, setIntervalOverride] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const intervalMinutes = intervalOverride ?? schedule?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;

  async function handleSave(nextEnabled: boolean, nextIntervalMinutes: number) {
    setIsSaving(true);
    setActionError(null);
    try {
      await save(nextEnabled, nextIntervalMinutes);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save automatic scanning settings.");
    } finally {
      setIsSaving(false);
    }
  }

  if (!isConfigured) {
    return (
      <div className="flex flex-col gap-2 px-5 py-4">
        <span className="text-sm font-medium text-ink-100">Server (always-on)</span>
        <p className="text-xs text-ink-500">
          Always-on automatic scanning requires a connected database (see Operations Centre) — in
          local mode, only the browser-based scanning above is available.
        </p>
      </div>
    );
  }

  if (isAuthLoading || !isHydrated) {
    return (
      <div className="flex flex-col gap-2 px-5 py-4">
        <span className="text-sm font-medium text-ink-100">Server (always-on)</span>
        <p className="text-xs text-ink-500">Loading…</p>
      </div>
    );
  }

  if (!user || !isAvailable) {
    return (
      <div className="flex flex-col gap-2 px-5 py-4">
        <span className="text-sm font-medium text-ink-100">Server (always-on)</span>
        <p className="text-xs text-ink-500">Sign in to create and manage always-on automatic scanning.</p>
      </div>
    );
  }

  const isEnabled = schedule?.enabled ?? false;

  return (
    <div className="flex flex-col gap-2.5 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium text-ink-100">Server (always-on)</span>
        <span aria-live="polite">
          <Badge
            className={
              isEnabled
                ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
                : "border-base-600 bg-base-800 text-ink-300"
            }
          >
            {isEnabled ? "Enabled" : "Disabled"}
          </Badge>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-ink-400">
          Interval
          <select
            value={intervalMinutes}
            onChange={(event) => {
              const next = Number(event.target.value);
              setIntervalOverride(next);
              // Changing the interval while already enabled takes effect immediately (recomputes
              // the next scan time from now), rather than silently waiting for the old cadence to
              // elapse — the same "acting on a value takes effect right away" behaviour Enable/
              // Disable has below.
              if (isEnabled) void handleSave(true, next);
            }}
            disabled={isSaving}
            className="rounded-lg border border-base-600 bg-base-900 px-2 py-1 text-xs text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {INTERVAL_OPTIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                Every {minutes} minutes
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => handleSave(true, intervalMinutes)}
          disabled={isSaving || isEnabled}
          className="rounded-lg border border-accent-teal/30 bg-accent-teal/10 px-3 py-1.5 text-xs font-medium text-accent-teal transition-colors hover:bg-accent-teal/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Enable
        </button>
        <button
          type="button"
          onClick={() => handleSave(false, intervalMinutes)}
          disabled={isSaving || !isEnabled}
          className="rounded-lg border border-base-600 bg-base-800 px-3 py-1.5 text-xs font-medium text-ink-300 transition-colors hover:bg-base-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Disable
        </button>
        {isSaving ? (
          <span role="status" className="text-xs text-ink-500">
            Saving…
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-500">
        <span>Last scan: {schedule?.lastScanAt ? formatDateTime(schedule.lastScanAt) : "Never"}</span>
        <span>
          Next scan: {isEnabled && schedule?.nextScanAt ? formatDateTime(schedule.nextScanAt) : "—"}
        </span>
        <span>Last status: {schedule?.lastStatus ?? "—"}</span>
      </div>

      {schedule?.lastError ? (
        <p className="text-xs text-accent-amber">Last automation error: {schedule.lastError}</p>
      ) : null}

      {actionError || error ? (
        <p role="alert" className="text-xs text-accent-red">
          {actionError ?? error}
        </p>
      ) : null}

      <p className="text-xs text-ink-500">
        <strong className="font-medium text-ink-500">Server (always-on):</strong> runs on a
        dedicated background service, independently of this or any browser tab — it keeps scanning
        even when no one has the app open. Enabling it here only configures <em>when</em> a scan
        should run; see the Operations Centre for the last-known result, which is the clearest
        evidence that the background service is actively running.
      </p>
    </div>
  );
}
