import { getSupabaseClient } from "@/lib/supabase/client";
import { ClientScheduleStore } from "./client-schedule-store";

let store: ClientScheduleStore | null = null;

// Unlike getPaperTradeStore()/getDecisionHistoryStore(), there is no local-storage fallback here
// — a "server schedule" only means anything when it's actually in Supabase for the VPS worker to
// read, so this simply returns null when Supabase isn't configured, and the Server Schedule panel
// (Mission 10) shows an "unavailable" state rather than silently operating on nothing. Only the
// public anon key is ever used here — never a service role key.
export function getClientScheduleStore(): ClientScheduleStore | null {
  if (store) return store;
  const client = getSupabaseClient();
  if (!client) return null;
  store = new ClientScheduleStore(client);
  return store;
}
