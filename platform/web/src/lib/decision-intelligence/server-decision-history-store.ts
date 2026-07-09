import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DecisionRecord } from "./types";
import { toDbDecisionRecord } from "./supabase-decision-history-store";

// Server-only mirror of SupabaseDecisionHistoryStore.addRecords, for a future worker acting on
// behalf of a user without a browser session (see
// docs/product/MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md and
// docs/product/MISSION-7-DECISION-INTELLIGENCE.md). Reuses the exact same row mapping
// (toDbDecisionRecord) as the browser store so the two can never drift into writing subtly
// different shapes — the only differences are how the client is authenticated (service role +
// explicit userId here, vs. anon key + session there). Nothing in the running app calls this yet —
// no worker exists (Mission 7 doesn't deploy one).
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
