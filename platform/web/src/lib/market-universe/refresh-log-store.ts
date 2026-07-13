import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RefreshRunStats } from "./types";

const TABLE = "market_universe_refresh_log";

export async function startRefreshRun(client: SupabaseClient, dataSource: string): Promise<string> {
  const { data, error } = await client
    .from(TABLE)
    .insert({ data_source: dataSource, status: "running" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

export async function completeRefreshRun(
  client: SupabaseClient,
  runId: string,
  stats: RefreshRunStats,
): Promise<void> {
  const { error } = await client
    .from(TABLE)
    .update({
      completed_at: new Date().toISOString(),
      duration_ms: stats.durationMs,
      total_downloaded: stats.totalDownloaded,
      new_listings_count: stats.newListingsCount,
      delistings_count: stats.delistingsCount,
      metadata_changes_count: stats.metadataChangesCount,
      price_checks_performed: stats.priceChecksPerformed,
      price_check_failures: stats.priceCheckFailures,
      eligible_count: stats.eligibleCount,
      excluded_count: stats.excludedCount,
      exclusion_reason_breakdown: stats.exclusionReasonBreakdown,
      awaiting_price_check_count: stats.awaitingPriceCheckCount,
      status: "completed",
    })
    .eq("id", runId);
  if (error) throw new Error(error.message);
}

export async function failRefreshRun(client: SupabaseClient, runId: string, message: string): Promise<void> {
  const { error } = await client
    .from(TABLE)
    .update({ completed_at: new Date().toISOString(), status: "failed", error: message })
    .eq("id", runId);
  if (error) throw new Error(error.message);
}

// The fail-safe check get-market-universe-summary.ts relies on — "never refreshed at all" (throw)
// is distinct from "refreshed, but currently zero eligible symbols" (a legitimate, different state).
export async function hasCompletedRefreshRun(client: SupabaseClient): Promise<boolean> {
  const { data, error } = await client
    .from(TABLE)
    .select("id")
    .eq("status", "completed")
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}
