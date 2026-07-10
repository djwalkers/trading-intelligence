"use client";

import { useState } from "react";
import type { Instrument } from "@/lib/types";
import { usePaperTrades } from "@/lib/state/paper-trades-context";
import { useBotDecisionLog } from "@/lib/state/bot-decision-log-context";
import { useDecisionHistory } from "@/lib/state/decision-history-context";
import { useBotScheduler } from "@/lib/state/bot-scheduler-context";
import { executeBotScan, reserveScanId } from "@/lib/bot";
import type { BotDecision, ScanTriggerType } from "@/lib/bot";

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

  async function runScan(triggerType: ScanTriggerType): Promise<BotDecision> {
    setIsScanning(true);
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
      return decision;
    } finally {
      setIsScanning(false);
    }
  }

  return { runScan, isScanning };
}
