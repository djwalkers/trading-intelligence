"use client";

import { useState } from "react";
import type { Instrument } from "@/lib/types";
import { usePaperTrades } from "@/lib/state/paper-trades-context";
import { useBotDecisionLog } from "@/lib/state/bot-decision-log-context";
import { useDecisionHistory } from "@/lib/state/decision-history-context";
import { useBotScheduler } from "@/lib/state/bot-scheduler-context";
import { executeBotScan, reserveScanId } from "@/lib/bot";
import type { BotDecision, ScanTriggerType } from "@/lib/bot";
import { useToast } from "@/lib/notifications/use-toast";
import { logger } from "@/lib/logger/logger";
import { toAppError } from "@/lib/errors/app-error";

// Build 1.12.0 — extracted from BotRunnerPanel.tsx verbatim (no behaviour change) so the same scan
// logic can be triggered from more than one place: a manual "Run scan now" action (Dashboard) and
// the always-mounted AutomationRunner (automatic-scanning-runner.tsx), which used to be the only
// caller, tied to whichever page happened to render BotRunnerPanel. Still goes through the shared
// executeBotScan() wrapper (Mission 6), so this browser orchestration and the VPS worker's
// orchestration can never drift apart.
export function useBotScanRunner(instruments: Instrument[]) {
  const { trades, addTrade } = usePaperTrades();
  const { addDecision } = useBotDecisionLog();
  const { addRecords } = useDecisionHistory();
  const scheduler = useBotScheduler();
  const [isScanning, setIsScanning] = useState(false);
  const { notify } = useToast();

  // Build 1.13.0 — previously this could throw uncaught: AutomationRunner's scheduled tick calls
  // `runScan("Scheduled")` without awaiting or catching it at all, so any failure inside
  // `executeBotScan` (a strategy error, a Supabase write failure, anything) surfaced as an
  // unhandled promise rejection instead of a recoverable, visible failure. Every path now resolves
  // (never rejects) — callers that do care about the outcome check for `null`.
  async function runScan(triggerType: ScanTriggerType): Promise<BotDecision | null> {
    setIsScanning(true);
    notify("info", "Scan started.");
    try {
      const scanId = reserveScanId();
      const { decision } = await executeBotScan({
        instruments,
        scanId,
        triggerType,
        context: {
          loadTrades: async () => trades,
          persistTrade: async (trade) => addTrade(trade),
          persistDecision: async (decision) => addDecision(decision),
          persistDecisionRecords: async (records) => addRecords(records),
        },
      });
      scheduler.recordScan(decision.timestamp);
      // A trade being opened already gets its own "Trade opened" toast from
      // paper-trades-context.tsx's addTrade — avoid a duplicate/competing toast here. When no
      // trade was opened, this is the one place that outcome (accepted-but-blocked or no
      // candidates at all) gets surfaced.
      if (!decision.tradeCreated) {
        notify("info", `Scan complete — no trade opened: ${decision.reason}`);
      }
      return decision;
    } catch (error) {
      const appError = toAppError(error, "TRADE_EXECUTION_ERROR", {
        userMessage: "The scan couldn't complete. No trade was placed.",
      });
      logger.error("Scan failed", {
        component: "bot-scan-runner",
        errorCode: appError.code,
        triggerType,
        reason: appError.diagnosticMessage,
      });
      notify("error", appError.userMessage);
      return null;
    } finally {
      setIsScanning(false);
    }
  }

  return { runScan, isScanning };
}
