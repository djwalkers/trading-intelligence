import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScheduleRow } from "@/lib/scheduler/server-schedule-store";

// Enabled schedules whose next_scan_at has already passed. This is a plain read, not itself the
// concurrency guard — two workers can both read the same due row here without any race risk; the
// actual mutual exclusion happens next, in claimScheduleLock's conditional UPDATE (see
// process-schedule.ts). Ordered oldest-due-first so a worker that fell behind catches up on the
// most overdue users first.
export async function fetchDueSchedules(client: SupabaseClient): Promise<ScheduleRow[]> {
  const nowIso = new Date().toISOString();

  // next_scan_at is nullable (a schedule enabled but never yet scanned) — null counts as due, the
  // same "run it now rather than wait forever for a time that was never set" behaviour the
  // browser's scheduler already has for a fresh, never-run schedule.
  const { data, error } = await client
    .from("bot_schedules")
    .select("*")
    .eq("enabled", true)
    .or(`next_scan_at.is.null,next_scan_at.lte.${nowIso}`)
    .order("next_scan_at", { ascending: true, nullsFirst: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as ScheduleRow[];
}
