import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthRequiredError } from "@/lib/persistence/auth-required-error";

// Client-safe (anon key + session, never service role) counterpart to
// server-schedule-store.ts's ScheduleRow — the same `bot_schedules` row, read/written through RLS
// (`auth.uid() = user_id`, 0014_bot_schedules.sql) rather than a service-role client bypassing it.
// This is the row shape the Server Schedule panel (Mission 10) reads; `locked_at`/`locked_by` are
// deliberately not exposed here — they're a worker-internal concurrency detail (Mission 6/8) the
// browser has no reason to show or touch.
export interface ServerScheduleRow {
  id: string;
  userId: string;
  enabled: boolean;
  intervalMinutes: number;
  nextScanAt: string | null;
  lastScanAt: string | null;
  lastStatus: "Trade Opened" | "No Trade" | "Error" | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BotScheduleDbRow {
  id: string;
  user_id: string;
  enabled: boolean;
  interval_minutes: number;
  next_scan_at: string | null;
  last_scan_at: string | null;
  last_status: "Trade Opened" | "No Trade" | "Error" | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function fromDbRow(row: BotScheduleDbRow): ServerScheduleRow {
  return {
    id: row.id,
    userId: row.user_id,
    enabled: row.enabled,
    intervalMinutes: row.interval_minutes,
    nextScanAt: row.next_scan_at,
    lastScanAt: row.last_scan_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Reads and writes the signed-in user's own bot_schedules row — the browser-side half of Mission
// 10 (the other half, the worker that actually executes due schedules, already exists unchanged
// from Mission 8). Every operation requires a live session, same convention as
// SupabasePaperTradeStore/SupabaseDecisionHistoryStore; throws AuthRequiredError rather than
// silently no-op'ing so the caller can tell "not signed in" apart from a genuine Supabase failure.
export class ClientScheduleStore {
  constructor(private readonly client: SupabaseClient) {}

  private async requireUserId(): Promise<string> {
    const { data } = await this.client.auth.getSession();
    const userId = data.session?.user.id;
    if (!userId) throw new AuthRequiredError();
    return userId;
  }

  // Null when the user has never configured a server schedule yet — deliberately not an error,
  // and deliberately does not create a row just from being read (see save() below for the only
  // place a row is ever created).
  async load(): Promise<ServerScheduleRow | null> {
    const userId = await this.requireUserId();

    const { data, error } = await this.client
      .from("bot_schedules")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data ? fromDbRow(data as BotScheduleDbRow) : null;
  }

  // Creates the row if it doesn't exist yet, updates it if it does — one atomic upsert keyed on
  // bot_schedules' unique(user_id) constraint (0014_bot_schedules.sql), rather than a
  // read-then-branch that would race against a concurrent save from another tab. user_id is always
  // stamped from the live session, never taken from any caller-supplied value. next_scan_at is
  // derived here, not left to the caller: enabling (or re-saving while already enabled) sets it to
  // now + intervalMinutes so a newly (re-)enabled schedule is picked up on its own normal cadence,
  // not immediately; disabling clears it, since a disabled schedule has nothing to be "next."
  async save(enabled: boolean, intervalMinutes: number): Promise<ServerScheduleRow> {
    const userId = await this.requireUserId();
    const nowIso = new Date().toISOString();
    const nextScanAt = enabled ? new Date(Date.now() + intervalMinutes * 60_000).toISOString() : null;

    const { data, error } = await this.client
      .from("bot_schedules")
      .upsert(
        {
          user_id: userId,
          enabled,
          interval_minutes: intervalMinutes,
          next_scan_at: nextScanAt,
          updated_at: nowIso,
        },
        { onConflict: "user_id" },
      )
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    return fromDbRow(data as BotScheduleDbRow);
  }
}
