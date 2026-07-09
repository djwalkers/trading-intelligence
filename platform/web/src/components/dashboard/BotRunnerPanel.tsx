"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import type { Instrument } from "@/lib/types";
import { usePaperTrades } from "@/lib/state/paper-trades-context";
import { useBotDecisionLog } from "@/lib/state/bot-decision-log-context";
import {
  useBotScheduler,
  SCHEDULE_INTERVAL_MINUTES,
  type SchedulerMode,
} from "@/lib/state/bot-scheduler-context";
import { useAuth } from "@/lib/auth/auth-context";
import { usePersistenceStatus } from "@/lib/state/use-persistence-status";
import { executeBotScan, reserveScanId } from "@/lib/bot";
import type { BotDecision, ScanTriggerType } from "@/lib/bot";
import { formatDateTime } from "@/lib/utils/format";

// How often the schedule is checked to see if it's time to run — not the schedule interval
// itself. 10s is plenty granular against a 15/30/60-minute schedule.
const TICK_INTERVAL_MS = 10_000;

const MODE_OPTIONS: { value: SchedulerMode; label: string }[] = [
  { value: "Manual", label: "Manual only" },
  { value: "Every15", label: "Every 15 minutes" },
  { value: "Every30", label: "Every 30 minutes" },
  { value: "Every60", label: "Every 60 minutes" },
];

interface BotRunnerPanelProps {
  instruments: Instrument[];
}

function candidateStatusLabel(candidate: BotDecision["candidates"][number]) {
  if (!candidate.individualPassed) return "Individual: Failed";
  if (!candidate.positionEvaluated) return "Individual: Passed";
  if (!candidate.portfolioRiskEvaluated) return `Individual: Passed · Position: ${candidate.positionAction}`;
  return `Individual: Passed · Position: ${candidate.positionAction} · Portfolio: ${
    candidate.portfolioPassed ? "Passed" : "Failed"
  }`;
}

export function BotRunnerPanel({ instruments }: BotRunnerPanelProps) {
  const { trades, addTrade } = usePaperTrades();
  const { addDecision } = useBotDecisionLog();
  const scheduler = useBotScheduler();
  const { isConfigured, isLoading, user } = useAuth();
  const persistenceStatus = usePersistenceStatus();
  const [isScanning, setIsScanning] = useState(false);
  const [lastDecision, setLastDecision] = useState<BotDecision | null>(null);

  async function runScan(triggerType: ScanTriggerType) {
    setIsScanning(true);
    try {
      const scanId = reserveScanId();
      // Goes through the shared executeBotScan() wrapper (Mission 6) rather than calling
      // runBotScan() directly, so this browser orchestration and a future background worker's
      // orchestration can never drift apart — only the BotExecutionContext (how trades are loaded
      // and persisted) differs between them. loadTrades reads the same `trades` closure runBotScan
      // used to receive as a direct parameter, so behaviour here is unchanged.
      const { decision } = await executeBotScan({
        instruments,
        scanId,
        triggerType,
        context: {
          loadTrades: async () => trades,
          persistTrade: async (trade) => addTrade(trade),
          persistDecision: async (decision) => addDecision(decision),
        },
      });
      setLastDecision(decision);
      scheduler.recordScan(decision.timestamp);
    } finally {
      setIsScanning(false);
    }
  }

  // Ref-captured, so the interval set up below (once, for the component's lifetime) always reads
  // the latest values without needing to be torn down and recreated on every render — recreating
  // it would risk a missed or doubled tick right at the boundary. Updated in an effect (not
  // directly during render) since mutating a ref's .current while rendering is not allowed.
  const latestRef = useRef({ scheduler, isConfigured, isLoading, user, persistenceStatus, isScanning, runScan });
  useEffect(() => {
    latestRef.current = { scheduler, isConfigured, isLoading, user, persistenceStatus, isScanning, runScan };
  });

  // The schedule only ever advances while this component is mounted (the Dashboard) — there is no
  // background worker. See docs/product/MISSION-4-SCHEDULED-BOT-SCANS.md for the full disclosure;
  // System Health can still show the last-known schedule state from any page, it just won't tick
  // further until the Dashboard is open again.
  useEffect(() => {
    const timer = setInterval(() => {
      const { scheduler, isConfigured, isLoading, user, persistenceStatus, isScanning, runScan } =
        latestRef.current;

      if (scheduler.status !== "Running") return;
      if (isScanning) return; // avoid overlapping runs; try again next tick

      // Safety: never run while signed out. Supabase configured + no session means the write
      // would fail anyway (AuthRequiredError) — stop rather than keep polling uselessly.
      if (isConfigured && !isLoading && !user) {
        scheduler.stop("Signed out — scheduled scans require an active session.");
        return;
      }

      // Safety: stop rather than keep silently writing to local storage after Supabase was the
      // expected store — the user should notice and decide what to do next.
      if (persistenceStatus.fallbackReason) {
        scheduler.stop(`Persistence unavailable: ${persistenceStatus.fallbackReason}`);
        return;
      }

      if (!scheduler.nextScanAt || Date.now() < new Date(scheduler.nextScanAt).getTime()) return;

      runScan("Scheduled");
    }, TICK_INTERVAL_MS);

    return () => clearInterval(timer);
  }, []);

  const rejectedCount = lastDecision
    ? lastDecision.candidates.filter((candidate) => candidate.outcome === "Rejected").length
    : 0;
  const currentIntervalMinutes = SCHEDULE_INTERVAL_MINUTES[scheduler.mode];

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-400">
          Scans every watchlist instrument through the Strategy Engine, ranks the tradeable
          opportunities, and walks down the list — evaluating individual risk, then the Position
          Manager (new position, add to position, hold, or block), then portfolio risk, for each
          candidate in turn — until one opens a paper trade or every candidate has been rejected.
          Trigger it manually, or start a schedule below.
        </p>
        <button
          type="button"
          onClick={() => runScan("Manual")}
          disabled={isScanning}
          className="whitespace-nowrap rounded-lg border border-accent-teal/30 bg-accent-teal/10 px-4 py-2 text-sm font-medium text-accent-teal transition-colors hover:bg-accent-teal/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isScanning ? "Scanning…" : "Run Bot Scan"}
        </button>
      </div>

      <div className="flex flex-col gap-2.5 rounded-xl2 border border-base-700 bg-base-850 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm font-medium text-ink-100">Scheduled scans</span>
          <Badge
            className={
              scheduler.status === "Running"
                ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
                : "border-base-600 bg-base-800 text-ink-300"
            }
          >
            {scheduler.status}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-ink-400">
            Mode
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
            onClick={() => scheduler.start()}
            disabled={scheduler.mode === "Manual" || scheduler.status === "Running"}
            className="rounded-lg border border-accent-teal/30 bg-accent-teal/10 px-3 py-1.5 text-xs font-medium text-accent-teal transition-colors hover:bg-accent-teal/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Start schedule
          </button>
          <button
            type="button"
            onClick={() => scheduler.stop()}
            disabled={scheduler.status !== "Running"}
            className="rounded-lg border border-base-600 bg-base-800 px-3 py-1.5 text-xs font-medium text-ink-300 transition-colors hover:bg-base-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Stop schedule
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

        <p className="text-xs text-ink-600">
          Browser-based scheduling only — scans run while this Dashboard tab is open; closing it or
          navigating away pauses the schedule until you return. True 24/7 scheduling needs a
          background worker, not yet built (see System Health for the current state from any page).
        </p>
      </div>

      {lastDecision ? (
        <div className="flex flex-col gap-2.5 rounded-xl2 border border-base-700 bg-base-850 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-ink-500">
              {lastDecision.scanId} · {lastDecision.triggerType} · {lastDecision.instrumentsScanned.length}{" "}
              instruments scanned at {formatDateTime(lastDecision.timestamp)}
            </span>
            <Badge
              className={
                lastDecision.tradeCreated
                  ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
                  : "border-base-600 bg-base-800 text-ink-300"
              }
            >
              {lastDecision.actionTaken}
            </Badge>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-500">
            <span>Candidates evaluated: {lastDecision.candidates.length}</span>
            <span>Rejected: {rejectedCount}</span>
            <span>Execution time: {lastDecision.executionTimeMs.toFixed(1)}ms</span>
          </div>

          {lastDecision.selectedInstrument ? (
            <p className="text-xs text-ink-400">
              Executed: <span className="text-ink-200">{lastDecision.selectedInstrument}</span>
              {lastDecision.selectedInstrumentName ? ` · ${lastDecision.selectedInstrumentName}` : ""}
            </p>
          ) : null}

          <p className="text-sm text-ink-300">{lastDecision.reason}</p>

          {lastDecision.candidates.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {lastDecision.candidates.map((candidate) => (
                <li key={candidate.instrumentSymbol} className="flex flex-col gap-0.5 text-xs">
                  <div className="flex items-start gap-2">
                    <span
                      className={
                        candidate.outcome === "Trade Opened" ? "text-accent-teal" : "text-accent-red"
                      }
                    >
                      #{candidate.rank} {candidate.outcome === "Trade Opened" ? "Executed" : "Rejected"}
                    </span>
                    <span className="text-ink-400">
                      {candidate.instrumentSymbol} ({candidate.confidence}%)
                    </span>
                    <span className="text-ink-500">{candidateStatusLabel(candidate)}</span>
                  </div>
                  {candidate.rejectionReason ? (
                    <span className="pl-1 text-ink-500">{candidate.rejectionReason}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
