"use client";

import { StatCard } from "@/components/ui/StatCard";
import { useBotDecisionLog } from "@/lib/state/bot-decision-log-context";
import { useBotScheduler } from "@/lib/state/bot-scheduler-context";
import { useServerSchedule } from "@/lib/state/server-schedule-context";
import { formatDateTime } from "@/lib/utils/format";

function isToday(isoTimestamp: string): boolean {
  return new Date(isoTimestamp).toDateString() === new Date().toDateString();
}

// Build 1.12.0 — "What is my AI doing right now?" in four numbers. Automatic scanning combines
// both independent scheduling systems (browser-based and always-on server-based, Settings) into
// one plain yes/no; "Last scan" and "Next scan" reflect this browser's own view (manual runs and
// browser-based scheduled runs) — always-on server scans are only visible via Settings/Operations
// Centre, since this browser has no live channel into that separate process.
export function AIActivityKpis() {
  const { decisions } = useBotDecisionLog();
  const scheduler = useBotScheduler();
  const { schedule } = useServerSchedule();

  const decisionsToday = decisions.filter((decision) => isToday(decision.timestamp)).length;
  const lastScan = decisions[0] ?? null;

  const browserRunning = scheduler.status === "Running";
  const serverEnabled = schedule?.enabled ?? false;
  const automationOn = browserRunning || serverEnabled;
  const automationDetail = [
    browserRunning ? "this browser" : null,
    serverEnabled ? "server" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Automatic scanning"
        value={automationOn ? "On" : "Off"}
        valueClassName={automationOn ? "text-accent-teal" : "text-ink-100"}
        sublabel={automationOn ? automationDetail : "Manual only — see Settings"}
      />
      <StatCard label="AI decisions today" value={String(decisionsToday)} />
      <StatCard
        label="Last scan (this browser)"
        value={lastScan ? formatDateTime(lastScan.timestamp) : "Never"}
        sublabel={lastScan ? lastScan.triggerType : undefined}
      />
      <StatCard
        label="Next scan (this browser)"
        value={browserRunning && scheduler.nextScanAt ? formatDateTime(scheduler.nextScanAt) : "—"}
        sublabel={browserRunning ? undefined : "Start in Settings"}
      />
    </div>
  );
}
