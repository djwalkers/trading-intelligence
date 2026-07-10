import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findReconcilableOutcomes } from "./outcome-analysis";
import { loadTradesForUser } from "@/lib/persistence/server-paper-trade-store";
import { loadRecordsForUser, updateOutcomesForUser } from "./server-decision-history-store";

// Mission 11's server-side reconciliation entry point — the reusable function the worker's poll
// cycle calls, and that a future mission (or a manual invocation) can call directly. Reads one
// user's trades and decision records, finds every accepted decision whose linked trade has closed
// since it was last checked, and updates them — reusing findReconcilableOutcomes(), the exact same
// function the browser's automatic on-close reconciliation uses (decision-history-context.tsx), so
// a decision reconciled by the worker and one reconciled by the browser can never disagree.
// Idempotent: calling this again immediately after a successful run finds nothing left to do,
// since every classified record's outcome is no longer "Pending" (see computeOutcomeUpdate's own
// guard) — safe to call every poll cycle, or as often as needed.
export async function reconcileOutcomesForUser(
  client: SupabaseClient,
  userId: string,
): Promise<{ updatesApplied: number }> {
  const [trades, records] = await Promise.all([
    loadTradesForUser(client, userId),
    loadRecordsForUser(client, userId),
  ]);

  const updates = findReconcilableOutcomes(trades, records);
  if (updates.length > 0) {
    await updateOutcomesForUser(client, userId, updates);
  }
  return { updatesApplied: updates.length };
}
