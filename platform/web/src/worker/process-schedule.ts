import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { executeBotScan } from "@/lib/bot";
import { createServerExecutionContext } from "@/lib/bot/server-execution-context";
import { getServerHistoricalMarketDataProvider } from "@/lib/market-data/get-server-historical-market-data-provider";
import { getServerConfig } from "@/lib/config/server-config";
import { getMarketUniverseSummary } from "@/lib/market-universe/get-market-universe-summary";
import { resolveMarketScreeningShortlist } from "@/lib/market-screening/resolve-market-screening-shortlist";
import { log as logMarketScreening } from "@/lib/market-screening/logger";
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
    const historicalMarketDataProvider = getServerHistoricalMarketDataProvider();

    // Phase 2A — Market Universe. The worker's actual traded instrument list stays the accepted
    // static 5-symbol list, unconditionally — the existing Strategy Engine/historical-data pipeline
    // was never built to safely evaluate thousands of instruments per scan, and Phase 2A is scoped
    // to building and verifying the universe only, not consuming it. MARKET_UNIVERSE_WORKER_ENABLED
    // (default off) only controls an optional, best-effort observability log below; it can never
    // change `instruments`. See docs/product/PHASE-2A-MARKET-UNIVERSE.md.
    if (getServerConfig().isMarketUniverseWorkerObservabilityEnabled) {
      try {
        const summary = await getMarketUniverseSummary(client);
        log("market_universe_summary", {
          eligibleCount: summary.eligibleCount,
          eligibleWithCompleteMarketDataCount: summary.eligibleWithCompleteMarketDataCount,
        });
      } catch (summaryError) {
        log("market_universe_summary_failed", {
          error: summaryError instanceof Error ? summaryError.message : "Unknown error",
        });
      }
    }

    // Sprint 295 — market-screening integration seam (Sprint 294 §1). With
    // marketScreeningRolloutStage fixed to "off" (the default; no liquidity provider is approved
    // yet — Sprint 293), this always resolves to the exact same static instrument list
    // `instruments` used to be, via the same default resolve-market-screening-shortlist.ts itself
    // falls back to — the worker's traded instrument list is unconditionally unchanged by this
    // sprint, exactly as Phase 2A's Market Universe integration was before it.
    const marketScreeningRolloutStage = getServerConfig().marketScreeningRolloutStage;
    const shortlistResult = await resolveMarketScreeningShortlist(marketScreeningRolloutStage);
    if (shortlistResult.source === "fallback-static-list") {
      logMarketScreening(
        marketScreeningRolloutStage === "off"
          ? "market_screening_disabled"
          : "market_screening_provider_unavailable",
        {
          reason: shortlistResult.reason,
          instrumentCount: shortlistResult.instruments.length,
        },
      );
    }

    const result = await executeBotScan({
      instruments: shortlistResult.instruments,
      scanId,
      triggerType: "Scheduled",
      context,
      historicalMarketDataProvider,
    });

    log("scan_executed", {
      userId: schedule.user_id,
      scanId,
      actionTaken: result.decision.actionTaken,
      candidatesEvaluated: result.decision.candidates.length,
    });

    // Maintenance 1.11.2 — one plain-English line per scan reporting where the candles this scan's
    // indicators were computed from actually came from. Reads the same status the System Health
    // "Historical data" panel would show, but for the real Alpha-Vantage-capable provider only the
    // worker process ever constructs; this is the honest way to observe it, since the browser has
    // no live channel into a separate worker process (same disclosed limitation as "Server
    // Scheduler" status, Mission 10).
    const historicalStatus = historicalMarketDataProvider.getStatus();
    log("historical_data_status", {
      source: historicalStatus.source,
      provider: historicalStatus.provider,
      symbolsLoaded: historicalStatus.instrumentsLoaded,
      lastRefresh: historicalStatus.lastUpdated,
      cacheAgeMinutes: historicalStatus.cacheAgeMinutes,
      fallbackReason: historicalStatus.failureReason,
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
