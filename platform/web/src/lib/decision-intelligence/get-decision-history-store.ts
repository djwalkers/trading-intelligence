import { getSupabaseClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { LocalStorageDecisionHistoryStore } from "./local-storage-decision-history-store";
import { ResilientDecisionHistoryStore } from "./resilient-decision-history-store";
import { SupabaseDecisionHistoryStore } from "./supabase-decision-history-store";
import type { DecisionHistoryStore } from "./decision-history-store";

let store: ResilientDecisionHistoryStore | null = null;

function createSupabaseStore(): DecisionHistoryStore | null {
  const client = getSupabaseClient();
  if (!client) return null;

  // Only the public anon key is ever used here — never a service role key. Row Level Security
  // (0016_decision_history.sql) is what actually gates access, not secrecy of this key — same
  // convention as get-paper-trade-store.ts.
  return new SupabaseDecisionHistoryStore(client);
}

// Supabase is used when configured; local browser storage is the fallback, and becomes the only
// store for the rest of the session if Supabase is unavailable (see ResilientDecisionHistoryStore).
// Cached at module scope so every caller shares one store, one persistence status — same pattern
// as getPaperTradeStore().
export function getDecisionHistoryStore(): ResilientDecisionHistoryStore {
  if (!store) {
    const primary = isSupabaseConfigured() ? createSupabaseStore() : null;
    store = new ResilientDecisionHistoryStore(primary, new LocalStorageDecisionHistoryStore());
  }
  return store;
}
