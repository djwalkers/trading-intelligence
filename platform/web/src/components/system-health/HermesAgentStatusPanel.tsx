"use client";

import { Badge } from "@/components/ui/Badge";
import { useHermesDashboardData } from "@/lib/hermes-dashboard/use-hermes-dashboard-data";
import { formatDateTime } from "@/lib/utils/format";

// Legacy-worker UI cleanup. Operations Centre previously had no panel reporting the REAL Hermes
// Agent/eToro pipeline's own health at all — every other panel on this page described either the
// legacy Strategy Simulator or generic infrastructure (Database/Auth).
//
// Review fix: Hermes Agent, trading runtime, and eToro broker are three DISTINCT concepts, never
// merged into one badge. A running trading runtime (the scheduled orchestration process being
// alive) proves nothing about whether the official Nous Hermes Agent CLI call is actually
// succeeding — GET /api/hermes/summary has no direct "is the Agent healthy" field, so "Hermes
// Agent" below is deliberately evidence-based (has it recently produced a decision, is there a
// recorded failure) rather than a fabricated on/off derived from the runtime's own process state.
// "Trading runtime" is the one row allowed to read `runtime.state` directly — it is honestly
// scoped to "is the orchestration loop alive," nothing more.
type ObservedAgentState = "producing-decisions" | "degraded" | "no-decision-yet" | "unavailable";
type ObservedRuntimeState = "running" | "paused" | "stopped" | "unavailable";
type ObservedBrokerState = "connected" | "degraded" | "unavailable";

interface Summary {
  health: { status: string; runtimeMode: string; brokerProvider: string };
  runtime: { state: string; lastRunAt: string | null } | null;
  openPositionCount: number | null;
  latestDecision: { timestamp: string; symbol: string; outcome: string } | null;
  recentFailure: { message: string } | null;
}

type FetchStatus = "loading" | "ready" | "error" | "unauthorized";

function classifyAgentState(fetchStatus: FetchStatus, summary: Summary | null): ObservedAgentState {
  if (fetchStatus !== "ready" || !summary) return "unavailable";
  if (summary.recentFailure) return "degraded";
  if (summary.latestDecision) return "producing-decisions";
  return "no-decision-yet";
}

function classifyRuntimeState(fetchStatus: FetchStatus, summary: Summary | null): ObservedRuntimeState {
  if (fetchStatus !== "ready" || !summary) return "unavailable";
  if (summary.health.status === "unavailable") return "unavailable";
  const state = summary.runtime?.state;
  if (state === "RUNNING") return "running";
  if (state === "PAUSED") return "paused";
  if (state === "STOPPED") return "stopped";
  return "unavailable";
}

function classifyBrokerConnectivity(fetchStatus: FetchStatus, summary: Summary | null): ObservedBrokerState {
  if (fetchStatus !== "ready" || !summary) return "unavailable";
  if (summary.health.status === "healthy") return "connected";
  if (summary.health.status === "degraded") return "degraded";
  return "unavailable";
}

const AGENT_BADGE_CLASSES: Record<ObservedAgentState, string> = {
  "producing-decisions": "border-accent-teal/30 bg-accent-teal/10 text-accent-teal",
  degraded: "border-accent-amber/30 bg-accent-amber/10 text-accent-amber",
  "no-decision-yet": "border-base-600 bg-base-800 text-ink-300",
  unavailable: "border-base-600 bg-base-800 text-ink-400",
};

const AGENT_LABEL: Record<ObservedAgentState, string> = {
  "producing-decisions": "Producing decisions",
  degraded: "Degraded",
  "no-decision-yet": "No decision yet",
  unavailable: "Unavailable",
};

const RUNTIME_BADGE_CLASSES: Record<ObservedRuntimeState, string> = {
  running: "border-accent-teal/30 bg-accent-teal/10 text-accent-teal",
  paused: "border-accent-amber/30 bg-accent-amber/10 text-accent-amber",
  stopped: "border-accent-red/30 bg-accent-red/10 text-accent-red",
  unavailable: "border-base-600 bg-base-800 text-ink-400",
};

const RUNTIME_LABEL: Record<ObservedRuntimeState, string> = {
  running: "Running",
  paused: "Paused",
  stopped: "Stopped",
  unavailable: "Unavailable",
};

const BROKER_BADGE_CLASSES: Record<ObservedBrokerState, string> = {
  connected: "border-accent-teal/30 bg-accent-teal/10 text-accent-teal",
  degraded: "border-accent-amber/30 bg-accent-amber/10 text-accent-amber",
  unavailable: "border-accent-red/30 bg-accent-red/10 text-accent-red",
};

const BROKER_LABEL: Record<ObservedBrokerState, string> = {
  connected: "Connected",
  degraded: "Degraded",
  unavailable: "Unavailable",
};

export function HermesAgentStatusPanel() {
  const { state, summary } = useHermesDashboardData();
  const fetchStatus = state.status;
  const agentState = classifyAgentState(fetchStatus, summary);
  const runtimeState = classifyRuntimeState(fetchStatus, summary);
  const brokerState = classifyBrokerConnectivity(fetchStatus, summary);

  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Hermes Agent</span>
          <span className="text-xs text-ink-500">
            {fetchStatus === "loading"
              ? "Loading…"
              : agentState === "unavailable"
                ? "Agent activity could not be read right now."
                : summary?.latestDecision
                  ? `Last decision: ${summary.latestDecision.symbol} ${summary.latestDecision.outcome} at ${formatDateTime(summary.latestDecision.timestamp)}`
                  : "No decision recorded yet. Reflects whether the configured strategy has produced a decision — not the runtime process itself; see Trading runtime below for that."}
          </span>
        </div>
        <Badge className={AGENT_BADGE_CLASSES[agentState]} data-testid="hermes-agent-observed-state">
          {AGENT_LABEL[agentState]}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Trading runtime</span>
          <span className="text-xs text-ink-500">
            {fetchStatus === "loading"
              ? "Loading…"
              : runtimeState === "unavailable"
                ? "Runtime status could not be read right now."
                : summary?.runtime?.lastRunAt
                  ? `Last run ${formatDateTime(summary.runtime.lastRunAt)} — a running process alone does not confirm Hermes Agent itself is healthy.`
                  : "No run recorded yet."}
          </span>
        </div>
        <Badge className={RUNTIME_BADGE_CLASSES[runtimeState]} data-testid="trading-runtime-observed-state">
          {RUNTIME_LABEL[runtimeState]}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">eToro broker connection</span>
          <span className="text-xs text-ink-500">
            {fetchStatus === "loading"
              ? "Loading…"
              : summary
                ? `Provider: ${summary.health.brokerProvider} (${summary.health.runtimeMode})`
                : "Broker connectivity could not be read right now."}
          </span>
        </div>
        <Badge className={BROKER_BADGE_CLASSES[brokerState]} data-testid="etoro-broker-observed-state">
          {BROKER_LABEL[brokerState]}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Open broker positions</span>
          <span className="text-xs text-ink-500">Broker-ground-truth open position count</span>
        </div>
        <span className="text-sm text-ink-300">
          {fetchStatus === "ready" && summary?.openPositionCount !== null && summary?.openPositionCount !== undefined
            ? summary.openPositionCount
            : "—"}
        </span>
      </div>

      {summary?.recentFailure ? (
        <div className="px-5 py-4">
          <span className="text-xs text-accent-red">Recent failure: {summary.recentFailure.message}</span>
        </div>
      ) : null}
    </div>
  );
}
