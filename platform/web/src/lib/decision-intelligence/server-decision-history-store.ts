import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DecisionRecord } from "./types";
import type { OutcomeUpdate } from "./outcome-analysis";
import {
  toDbDecisionRecord,
  fromDbDecisionRecord,
  type DecisionHistoryRow,
} from "./supabase-decision-history-store";

// Server-only mirror of SupabaseDecisionHistoryStore.addRecords, for a future worker acting on
// behalf of a user without a browser session (see
// docs/product/MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md and
// docs/product/MISSION-7-DECISION-INTELLIGENCE.md). Reuses the exact same row mapping
// (toDbDecisionRecord) as the browser store so the two can never drift into writing subtly
// different shapes — the only differences are how the client is authenticated (service role +
// explicit userId here, vs. anon key + session there). Called by the worker's per-schedule scan
// (Mission 8) to log a scheduled scan's decisions.
export async function addRecordsForUser(
  client: SupabaseClient,
  userId: string,
  records: DecisionRecord[],
): Promise<void> {
  if (records.length === 0) return;

  const rows = records.map((record) => ({ ...toDbDecisionRecord(record), user_id: userId }));
  const { error } = await client.from("decision_history").insert(rows);
  if (error) throw new Error(error.message);
}

// Server-only mirror of SupabaseDecisionHistoryStore.load — reads every decision record for one
// user (Mission 11's reconciliation needs the full set, not just Pending ones, so
// findReconcilableOutcomes can apply its own filtering identically to the browser path).
export async function loadRecordsForUser(client: SupabaseClient, userId: string): Promise<DecisionRecord[]> {
  const { data, error } = await client
    .from("decision_history")
    .select("*")
    .eq("user_id", userId)
    .order("decided_at", { ascending: false });

  if (error) throw new Error(error.message);
  return ((data ?? []) as DecisionHistoryRow[]).map(fromDbDecisionRecord);
}

// Server-only mirror of SupabaseDecisionHistoryStore.updateOutcomes (Mission 11) — the worker's
// half of outcome reconciliation, using the service role client + an explicit userId instead of a
// browser session.
export async function updateOutcomesForUser(
  client: SupabaseClient,
  userId: string,
  updates: OutcomeUpdate[],
): Promise<void> {
  if (updates.length === 0) return;

  for (const update of updates) {
    const { error } = await client
      .from("decision_history")
      .update({
        outcome: update.outcome,
        realised_pnl: update.realisedPnl,
        realised_pnl_percent: update.realisedPnlPercent,
        holding_duration_minutes: update.holdingDurationMinutes,
        closed_at: update.closedAt,
        outcome_recorded_at: update.outcomeRecordedAt,
      })
      .eq("client_record_id", update.recordId)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
  }
}
