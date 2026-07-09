import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { instruments } from "@/lib/mock";
import { executeBotScan } from "@/lib/bot";
import { createServerExecutionContext } from "@/lib/bot/server-execution-context";
import {
  claimScheduleLock,
  releaseScheduleLock,
  type ScheduleRow,
} from "@/lib/scheduler/server-schedule-store";
import { reserveWorkerScanId } from "./reserve-worker-scan-id";
import { log } from "./logger";

// Runs (at most) one scan for one due schedule, start to finish: claim the advisory lock, run the
// exact same executeBotScan() pipeline the browser uses (Strategy Engine → Position Manager →
// Portfolio Risk → Decision Intelligence → paper trade/trade events — see
// docs/product/MISSION-8-VPS-WORKER.md, "Shared execution"), then release the lock with the
// outcome and the next scan time. Every step is logged so a VPS operator can see exactly what
// happened from the process's stdout alone.
export async function processSchedule(
  client: SupabaseClient,
  schedule: ScheduleRow,
  workerId: string,
): Promise<void> {
  log("schedule_found", { userId: schedule.user_id, scheduleId: schedule.id });

  const claimed = await claimScheduleLock(client, schedule.user_id, workerId);
  if (!claimed) {
    log("lock_skipped", {
      userId: schedule.user_id,
      reason: "Another process already holds this user's schedule lock — skipping this cycle.",
    });
    return;
  }
  log("lock_acquired", { userId: schedule.user_id, workerId });

  const nextScanAt = new Date(Date.now() + claimed.interval_minutes * 60_000).toISOString();

  try {
    const context = createServerExecutionContext(client, schedule.user_id);
    const scanId = reserveWorkerScanId();

    const result = await executeBotScan({
      instruments,
      scanId,
      triggerType: "Scheduled",
      context,
    });

    log("scan_executed", {
      userId: schedule.user_id,
      scanId,
      actionTaken: result.decision.actionTaken,
      candidatesEvaluated: result.decision.candidates.length,
    });

    if (result.trade) {
      log("trade_opened", {
        userId: schedule.user_id,
        tradeId: result.trade.id,
        symbol: result.trade.instrumentSymbol,
        side: result.trade.side,
      });
    }

    log("decision_records_stored", {
      userId: schedule.user_id,
      scanId,
      count: result.decision.candidates.length,
    });

    await releaseScheduleLock(client, schedule.user_id, workerId, {
      status: result.decision.actionTaken === "Trade Opened" ? "Trade Opened" : "No Trade",
      nextScanAt,
    });
    log("lock_released", { userId: schedule.user_id, workerId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker scan error";
    log("scan_failed", { userId: schedule.user_id, error: message });

    // Still release the lock and advance next_scan_at even on failure — a schedule that keeps
    // failing should be visible (last_status: "Error", last_error populated) and retried on its
    // normal interval, not stuck holding a lock or retried in a tight failure loop.
    await releaseScheduleLock(client, schedule.user_id, workerId, {
      status: "Error",
      error: message,
      nextScanAt,
    });
    log("lock_released", { userId: schedule.user_id, workerId });
  }
}
