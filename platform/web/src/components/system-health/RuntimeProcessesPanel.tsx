"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useRuntimeProcessesData } from "@/lib/operations/use-runtime-processes-data";
import { formatCpuPercent, formatMemoryBytes, formatUptime } from "@/lib/operations/format";
import { formatRelativeTime } from "@/lib/utils/format";
import type { RuntimeProcessStatus, RuntimeProcessView } from "@/lib/operations/types";
import type { HermesSummaryData } from "@/lib/hermes-dashboard/types";

// Runtime Processes panel — Operations Centre. Two DELIBERATELY separate signals shown per PM2
// process card, never conflated into one badge:
//   - PM2 process status (top-right badge on every card): "is the operating-system process
//     alive?" — sourced ONLY from /api/operations/processes (map-pm2-processes.ts).
//   - Hermes operational details (the Hermes Market Runtime card's own lower section, sourced from
//     GET /api/dashboard/hermes-summary — the SAME existing source HermesAgentStatusPanel already
//     uses, just above this panel on the same page): "is the trading runtime actually completing
//     cycles?" A green "Online" PM2 badge here says nothing about whether Hermes itself is
//     healthy — see the Hermes Agent & eToro Broker section above for that dedicated verdict; this
//     panel never re-derives or duplicates that classification, it only surfaces the raw
//     operational facts (mode/broker/kill-switch/scheduler/last cycle/open positions/latest
//     issue) a reader can judge for themselves.

const STATUS_LABEL: Record<RuntimeProcessStatus, string> = {
  online: "Online",
  stopped: "Stopped",
  errored: "Errored",
  launching: "Launching",
  unknown: "Unknown",
};

const STATUS_BADGE_CLASSES: Record<RuntimeProcessStatus, string> = {
  online: "border-accent-teal/30 bg-accent-teal/10 text-accent-teal",
  launching: "border-accent-amber/30 bg-accent-amber/10 text-accent-amber",
  stopped: "border-base-600 bg-base-800 text-ink-300",
  errored: "border-accent-red/30 bg-accent-red/10 text-accent-red",
  unknown: "border-base-600 bg-base-800 text-ink-400",
};

function ProcessMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-ink-500">{label}</span>
      <span className="text-sm text-ink-100">{value}</span>
    </div>
  );
}

/** Open positions is otherwise-identical to ProcessMetric, but actionable: a non-zero count links
 * to the existing Hermes portfolio view (the root dashboard's own HermesPortfolioSection, the real
 * broker-ground-truth positions list this exact count is sourced from — never the legacy paper
 * simulator's /portfolio). A zero count stays plain, non-interactive text — there is nothing to
 * navigate to. `next/link`'s `<a>` is used, not a styled `<button>`, so keyboard/screen-reader
 * behaviour (Tab focus, Enter activation, link semantics) comes for free. */
function OpenPositionsMetric({ count }: { count: number | null }) {
  const displayValue = count !== null ? String(count) : "—";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-ink-500">Open positions</span>
      {count !== null && count > 0 ? (
        <Link
          href="/"
          aria-label={`View ${count} open position${count === 1 ? "" : "s"}`}
          className="text-sm text-ink-100 underline decoration-dotted underline-offset-2 hover:text-accent-teal"
        >
          {displayValue}
        </Link>
      ) : (
        <span className="text-sm text-ink-100">{displayValue}</span>
      )}
    </div>
  );
}

/** Demo is the calm, expected state (the only state this deployment runs in today). Anything else
 * — including a future "live" value the current RuntimeMode type doesn't even define yet — gets a
 * visually prominent, unmistakably different treatment, so a genuinely live runtime mode can never
 * be mistaken for the safe default at a glance. */
function RuntimeModeIndicator({ mode }: { mode: string }) {
  const isDemo = mode === "demo";
  const label = mode.charAt(0).toUpperCase() + mode.slice(1);
  return (
    <Badge
      data-testid="runtime-mode-indicator"
      className={isDemo ? "border-base-600 bg-base-800 text-ink-300" : "border-accent-red/40 bg-accent-red/15 font-semibold text-accent-red"}
    >
      {label}
    </Badge>
  );
}

/** In Demo mode, Disabled is the genuinely safe, healthy state (reuses the same accent-teal token
 * every other "healthy" badge in this design system already uses) and Enabled is an active safety
 * mechanism worth noticing at a glance (accent-amber, matching this file's own PM2 "launching"
 * treatment). In Live mode, real money is at stake regardless of the switch's own position, so the
 * calm green treatment never applies there — both states keep the same prominent, cautionary
 * accent-amber treatment Enabled already used, consistent with RuntimeModeIndicator's own
 * non-demo-is-never-calm convention just above. */
function KillSwitchIndicator({ enabled, isLiveMode }: { enabled: boolean | null; isLiveMode: boolean }) {
  if (enabled === null) {
    return (
      <Badge data-testid="kill-switch-indicator" className="border-base-600 bg-base-800 text-ink-400">
        Unknown
      </Badge>
    );
  }
  const isCalmAndSafe = !isLiveMode && !enabled;
  return (
    <Badge
      data-testid="kill-switch-indicator"
      className={isCalmAndSafe ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal" : "border-accent-amber/40 bg-accent-amber/15 font-semibold text-accent-amber"}
    >
      {enabled ? "Enabled" : "Disabled"}
    </Badge>
  );
}

function HermesOperationalDetails({ summary }: { summary: HermesSummaryData | null }) {
  if (!summary) {
    return (
      <div className="flex flex-col gap-1 border-t border-base-700/60 pt-3">
        <span className="text-[11px] uppercase tracking-wide text-ink-500">Trading engine</span>
        <p className="text-xs text-ink-500">Hermes operational data is currently unavailable.</p>
      </div>
    );
  }

  const { health, runtime, openPositionCount, latestDecision, recentFailure } = summary;
  const schedulerValue =
    health.schedulerEnabled === null
      ? "—"
      : health.schedulerEnabled
        ? `On · ${Math.round((health.schedulerIntervalMs ?? 0) / 1000)}s`
        : "Off";

  return (
    <div className="flex flex-col gap-3 border-t border-base-700/60 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-ink-500">Trading engine</span>
        <RuntimeModeIndicator mode={health.runtimeMode} />
        <span className="text-xs text-ink-500">Broker: {health.brokerProvider}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] uppercase tracking-wide text-ink-500">Kill switch</span>
          <KillSwitchIndicator enabled={health.killSwitchEnabled} isLiveMode={health.runtimeMode !== "demo"} />
        </div>
        <ProcessMetric label="Scheduler" value={schedulerValue} />
        <OpenPositionsMetric count={openPositionCount} />
        <ProcessMetric label="Last cycle" value={runtime?.lastRunAt ? formatRelativeTime(runtime.lastRunAt) : "—"} />
        <ProcessMetric label="Last decision" value={latestDecision ? `${latestDecision.symbol} ${latestDecision.outcome}` : "—"} />
      </div>

      {recentFailure ? <p className="text-xs text-accent-red">Latest issue: {recentFailure.message}</p> : null}
    </div>
  );
}

function ProcessCard({ process, testId, children }: { process: RuntimeProcessView; testId: string; children?: ReactNode }) {
  return (
    <div className="panel flex flex-col gap-4 p-5" data-testid={`runtime-process-card-${testId}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold text-ink-100">{process.name}</span>
          <span className="text-xs text-ink-500">
            PM2: {process.pm2Name}
            {process.pm2Id !== null ? ` (#${process.pm2Id})` : ""}
          </span>
        </div>
        <Badge className={STATUS_BADGE_CLASSES[process.status]}>{STATUS_LABEL[process.status]}</Badge>
      </div>

      {!process.available ? (
        <p className="text-xs text-accent-amber">Not found in PM2 — this process may not be running on this server.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <ProcessMetric label="Uptime" value={process.uptimeMs !== null ? formatUptime(process.uptimeMs) : "—"} />
          <ProcessMetric label="Restarts" value={process.restartCount !== null ? String(process.restartCount) : "—"} />
          <ProcessMetric label="CPU" value={process.cpuPercent !== null ? formatCpuPercent(process.cpuPercent) : "—"} />
          <ProcessMetric label="Memory" value={process.memoryBytes !== null ? formatMemoryBytes(process.memoryBytes) : "—"} />
        </div>
      )}

      {children}
    </div>
  );
}

export function RuntimeProcessesPanel() {
  const { state, processes, hermesSummary, lastRefreshedAt, isStale, refresh } = useRuntimeProcessesData();

  const summaryCounts = processes
    ? {
        total: processes.processes.length,
        online: processes.processes.filter((p) => p.status === "online").length,
        stopped: processes.processes.filter((p) => p.status === "stopped").length,
        errored: processes.processes.filter((p) => p.status === "errored").length,
      }
    : null;

  const web = processes?.processes.find((p) => p.key === "web");
  const hermesRuntime = processes?.processes.find((p) => p.key === "hermes-runtime");

  return (
    <div className="flex flex-col gap-4 px-5 pt-4">
      {summaryCounts ? (
        <div className="flex flex-wrap items-center justify-between gap-3" data-testid="runtime-processes-summary-strip">
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
            <span>{summaryCounts.total} monitored</span>
            <span>&middot;</span>
            <span className="text-accent-teal">{summaryCounts.online} online</span>
            <span>&middot;</span>
            <span>{summaryCounts.stopped} stopped</span>
            <span>&middot;</span>
            <span className={summaryCounts.errored > 0 ? "text-accent-red" : undefined}>{summaryCounts.errored} errored</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-ink-500">
            <span>Last refreshed {lastRefreshedAt ? formatRelativeTime(lastRefreshedAt) : "—"}</span>
            <Button variant="secondary" onClick={refresh} data-testid="runtime-processes-refresh-button">
              Refresh
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button variant="secondary" onClick={refresh} data-testid="runtime-processes-refresh-button">
            Refresh
          </Button>
        </div>
      )}

      {isStale && state.status === "ready" ? (
        <div className="rounded-lg border border-accent-amber/30 bg-accent-amber/10 px-4 py-2 text-xs text-accent-amber" data-testid="runtime-processes-stale-warning">
          This data may be out of date — the last successful refresh was {lastRefreshedAt ? formatRelativeTime(lastRefreshedAt) : "a while ago"}.
        </div>
      ) : null}

      {state.status === "degraded" ? (
        <div className="rounded-lg border border-accent-red/30 bg-accent-red/10 px-4 py-3 text-sm text-accent-red" data-testid="runtime-processes-degraded">
          Could not reach PM2 process health: {state.message}
        </div>
      ) : null}

      {state.status === "loading" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-busy="true" data-testid="runtime-processes-loading">
          {[0, 1].map((index) => (
            <div key={index} className="panel h-32 animate-pulse bg-base-800/60" />
          ))}
        </div>
      ) : null}

      {processes ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {web ? <ProcessCard process={web} testId="web" /> : null}
          {hermesRuntime ? (
            <ProcessCard process={hermesRuntime} testId="hermes-runtime">
              <HermesOperationalDetails summary={hermesSummary} />
            </ProcessCard>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
