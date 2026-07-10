"use client";

import { StatCard } from "@/components/ui/StatCard";
import { usePersistenceStatus } from "@/lib/state/use-persistence-status";
import { useMarketDataStatus } from "@/lib/state/use-market-data-status";
import { useHistoricalDataStatus } from "@/lib/state/use-historical-data-status";
import { useDecisionHistoryStatus } from "@/lib/state/use-decision-history-status";
import { useServerSchedule } from "@/lib/state/server-schedule-context";
import { marketStatus } from "@/lib/mock";
import { summarizePlatformHealth, type PlatformHealthCheck } from "@/lib/utils/platform-health";

// Build 1.12.0 — the top-of-page verdict: is the platform healthy, right now? Combines every
// status flag this app already tracks (see platform-health.ts) into one percentage, plus three
// KPI cards for the questions an operator asks most often. This is a presentation rollup only —
// it doesn't gate or change any trading behaviour.
export function PlatformHealthOverview() {
  const persistence = usePersistenceStatus();
  const marketData = useMarketDataStatus();
  const historicalData = useHistoricalDataStatus();
  const decisionHistory = useDecisionHistoryStatus();
  const { schedule, isAvailable } = useServerSchedule();

  const checks: PlatformHealthCheck[] = [
    { label: "Database", healthy: !persistence.fallbackReason, detail: persistence.fallbackReason },
    { label: "Live prices", healthy: !marketData.failureReason, detail: marketData.failureReason },
    {
      label: "Historical market data",
      healthy: !historicalData.failureReason,
      detail: historicalData.failureReason,
    },
    {
      label: "AI Decision History",
      healthy: !decisionHistory.fallbackReason,
      detail: decisionHistory.fallbackReason,
    },
    {
      label: "Always-on scanning",
      healthy: !schedule?.lastError,
      detail: schedule?.lastError ?? null,
    },
  ];
  const health = summarizePlatformHealth(checks);

  const workerStatus = !isAvailable ? "Unavailable" : schedule?.enabled ? "Enabled" : "Disabled";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Platform health"
          value={`${health.healthPercent}%`}
          valueClassName={
            health.healthPercent === 100
              ? "text-accent-teal"
              : health.healthPercent >= 60
                ? "text-accent-amber"
                : "text-accent-red"
          }
          sublabel={
            health.issues.length === 0
              ? "All systems normal"
              : `${health.issues.length} issue${health.issues.length === 1 ? "" : "s"} to review`
          }
        />
        <StatCard label="Market status" value={marketStatus.isOpen ? "Open" : "Closed"} sublabel={marketStatus.nextEvent} />
        <StatCard
          label="Database"
          value={persistence.connected ? "Connected" : "Disconnected"}
          valueClassName={persistence.connected ? "text-accent-teal" : "text-accent-red"}
        />
        <StatCard
          label="Always-on scanning"
          value={workerStatus}
          valueClassName={workerStatus === "Enabled" ? "text-accent-teal" : "text-ink-100"}
        />
      </div>

      {health.issues.length > 0 ? (
        <div className="rounded-xl2 border border-accent-amber/25 bg-accent-amber/5 px-4 py-3">
          <p className="mb-1.5 text-xs font-medium text-accent-amber">Needs attention</p>
          <ul className="flex flex-col gap-1">
            {health.issues.map((issue) => (
              <li key={issue.label} className="text-xs text-ink-400">
                <span className="text-ink-200">{issue.label}:</span> {issue.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
