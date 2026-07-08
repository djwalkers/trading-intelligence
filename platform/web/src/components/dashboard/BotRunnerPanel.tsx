"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import type { Instrument } from "@/lib/types";
import { usePaperTrades } from "@/lib/state/paper-trades-context";
import { useBotDecisionLog } from "@/lib/state/bot-decision-log-context";
import { runBotScan, reserveScanId } from "@/lib/bot";
import type { BotDecision } from "@/lib/bot";
import { formatDateTime } from "@/lib/utils/format";

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
  const [isScanning, setIsScanning] = useState(false);
  const [lastDecision, setLastDecision] = useState<BotDecision | null>(null);

  async function handleRunScan() {
    setIsScanning(true);
    try {
      const scanId = reserveScanId();
      const { decision, trade } = await runBotScan(instruments, trades, scanId);
      if (trade) addTrade(trade);
      addDecision(decision);
      setLastDecision(decision);
    } finally {
      setIsScanning(false);
    }
  }

  const rejectedCount = lastDecision
    ? lastDecision.candidates.filter((candidate) => candidate.outcome === "Rejected").length
    : 0;

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-400">
          Scans every watchlist instrument through the Strategy Engine, ranks the tradeable
          opportunities, and walks down the list — evaluating individual risk, then the Position
          Manager (new position, add to position, hold, or block), then portfolio risk, for each
          candidate in turn — until one opens a paper trade or every candidate has been rejected.
          Triggered manually; nothing runs on a schedule.
        </p>
        <button
          type="button"
          onClick={handleRunScan}
          disabled={isScanning}
          className="whitespace-nowrap rounded-lg border border-accent-teal/30 bg-accent-teal/10 px-4 py-2 text-sm font-medium text-accent-teal transition-colors hover:bg-accent-teal/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isScanning ? "Scanning…" : "Run Bot Scan"}
        </button>
      </div>

      {lastDecision ? (
        <div className="flex flex-col gap-2.5 rounded-xl2 border border-base-700 bg-base-850 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-ink-500">
              {lastDecision.scanId} · {lastDecision.instrumentsScanned.length} instruments scanned at{" "}
              {formatDateTime(lastDecision.timestamp)}
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
