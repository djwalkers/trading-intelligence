import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileOutcomesForUser } from "@/lib/decision-intelligence/reconcile-outcomes";
import { log } from "./logger";

// Runs Mission 11's outcome reconciliation for every user the worker knows about, once per poll
// cycle (see run-worker.ts) — not a second permanent process, just one more step in the existing
// loop. `bot_schedules` is the only enumeration of "users this worker has ever acted for" available
// to it; a user who has never created a server schedule gets their outcomes reconciled by the
// browser's own automatic on-close reconciliation instead (decision-history-context.tsx), which
// runs independently of whether a worker exists at all. This is a deliberate, disclosed scope
// boundary, not an oversight — see docs/product/MISSION-11-OUTCOME-ANALYSIS.md.
export async function reconcileAllUsers(client: SupabaseClient): Promise<void> {
  const { data, error } = await client.from("bot_schedules").select("user_id");
  if (error) throw new Error(error.message);

  const userIds = Array.from(new Set((data ?? []).map((row) => row.user_id as string)));

  for (const userId of userIds) {
    try {
      const { updatesApplied } = await reconcileOutcomesForUser(client, userId);
      if (updatesApplied > 0) {
        log("outcomes_reconciled", { userId, updatesApplied });
      }
    } catch (reconcileError) {
      log("reconcile_failed", {
        userId,
        error: reconcileError instanceof Error ? reconcileError.message : "Unknown reconcile error",
      });
    }
  }
}
