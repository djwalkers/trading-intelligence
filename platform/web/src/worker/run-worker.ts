import { getServiceRoleClient } from "@/lib/supabase/service-role-client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchDueSchedules } from "./fetch-due-schedules";
import { processSchedule } from "./process-schedule";
import { reconcileAllUsers } from "./reconcile-all-users";
import { log } from "./logger";

// The entire worker application: wake up, check schedules, execute due scans, reconcile outcomes,
// sleep. No UI, no web server, no API — this file is only ever run directly (`npm run worker`),
// never imported by the Next.js app. See docs/product/MISSION-8-VPS-WORKER.md for the full
// lifecycle and deployment notes. Reuses executeBotScan()/createServerExecutionContext() from
// Mission 6/7 for the entire risk pipeline — nothing in this file duplicates Strategy Engine,
// Position Manager, Portfolio Risk, or Decision Intelligence logic.
const WORKER_ID = `worker-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 30_000);

async function pollOnce(client: SupabaseClient): Promise<void> {
  log("poll_started");

  const due = await fetchDueSchedules(client);
  if (due.length === 0) {
    log("no_schedules_due");
  } else {
    // Sequential, not parallel — a prototype-scale worker has no reason to hammer the Strategy
    // Engine/market data provider with concurrent scans, and processing one user fully (including
    // releasing their lock) before starting the next keeps the logs straightforwardly readable in
    // order.
    for (const schedule of due) {
      await processSchedule(client, schedule, WORKER_ID);
    }
  }

  // Mission 11 — not a second permanent process, just one more step in the same cycle every poll
  // already runs. Reconciliation is independent of whether any schedule was due this cycle: a
  // trade can close (via the browser) at any time, so outcomes are worth checking every cycle, not
  // only alongside a fresh scan.
  await reconcileAllUsers(client);
}

async function main(): Promise<void> {
  log("worker_started", { workerId: WORKER_ID, pollIntervalMs: POLL_INTERVAL_MS });

  const client = getServiceRoleClient();
  if (!client) {
    log("scan_failed", {
      error:
        "SUPABASE_SERVICE_ROLE_KEY and/or NEXT_PUBLIC_SUPABASE_URL are not set — the worker has nothing to connect to. See docs/product/MISSION-8-VPS-WORKER.md, \"Environment variables\".",
    });
    process.exitCode = 1;
    return;
  }

  let running = true;
  const shutdown = (signal: string) => {
    if (!running) return;
    running = false;
    log("worker_finished", { reason: signal });
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  while (running) {
    try {
      await pollOnce(client);
    } catch (error) {
      log("poll_failed", { error: error instanceof Error ? error.message : "Unknown poll error" });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
