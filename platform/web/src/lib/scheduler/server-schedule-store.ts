import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Server-only concurrency guard for the bot_schedules table (0014_bot_schedules.sql). Nothing in
// the running app calls this yet — no worker exists (Mission 7); this exists so Mission 7 has a
// ready-to-use, race-free locking primitive rather than starting from scratch. See
// docs/product/MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md, "Concurrency protection", for the
// full reasoning behind this pattern.
export interface ScheduleRow {
  id: string;
  user_id: string;
  enabled: boolean;
  interval_minutes: number;
  next_scan_at: string | null;
  last_scan_at: string | null;
  last_status: "Trade Opened" | "No Trade" | "Error" | null;
  last_error: string | null;
  locked_at: string | null;
  locked_by: string | null;
  created_at: string;
  updated_at: string;
}

const LOCK_TIMEOUT_MINUTES = 5;

// Claims the schedule row for one user so only one process (a worker, or in the future a worker
// racing the browser) can act on it at a time. This is a conditional UPDATE, not a read-then-write
// — the WHERE clause only matches rows that are currently unlocked or whose lock is older than
// LOCK_TIMEOUT_MINUTES, so two concurrent callers can't both "see" the row as claimable and both
// proceed: only one UPDATE can win per row, and Postgres serialises the two. Returns null if
// another process currently holds a live lock, in which case the caller should skip this scan
// cycle rather than run anyway.
export async function claimScheduleLock(
  client: SupabaseClient,
  userId: string,
  workerId: string,
): Promise<ScheduleRow | null> {
  const staleBefore = new Date(Date.now() - LOCK_TIMEOUT_MINUTES * 60 * 1000).toISOString();

  const { data, error } = await client
    .from("bot_schedules")
    .update({ locked_at: new Date().toISOString(), locked_by: workerId })
    .eq("user_id", userId)
    .or(`locked_at.is.null,locked_at.lt.${staleBefore}`)
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as ScheduleRow | null;
}

// Releases a lock and records the scan's outcome in one write. Scoped to locked_by = workerId, so
// a worker can never release a lock it doesn't actually hold (e.g. after its own lock already
// expired and something else claimed it) — that would let it clobber the other process's in-flight
// state.
export async function releaseScheduleLock(
  client: SupabaseClient,
  userId: string,
  workerId: string,
  result: { status: "Trade Opened" | "No Trade" | "Error"; error?: string; nextScanAt?: string | null },
): Promise<void> {
  const { error } = await client
    .from("bot_schedules")
    .update({
      locked_at: null,
      locked_by: null,
      last_scan_at: new Date().toISOString(),
      last_status: result.status,
      last_error: result.error ?? null,
      next_scan_at: result.nextScanAt ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("locked_by", workerId);

  if (error) throw new Error(error.message);
}
