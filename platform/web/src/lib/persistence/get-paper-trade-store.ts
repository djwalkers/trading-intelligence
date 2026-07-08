import { getSupabaseClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { LocalStoragePaperTradeStore } from "./local-storage-paper-trade-store";
import { ResilientPaperTradeStore } from "./resilient-paper-trade-store";
import { SupabasePaperTradeStore } from "./supabase-paper-trade-store";
import type { PaperTradeStore } from "./paper-trade-store";

let store: ResilientPaperTradeStore | null = null;

function createSupabaseStore(): PaperTradeStore | null {
  const client = getSupabaseClient();
  if (!client) return null;

  // Only the public anon key is ever used here — never a service role key. Row Level Security
  // (0005_row_level_security.sql, replaced by 0007_user_scoped_row_level_security.sql) is what
  // actually gates access, not secrecy of this key.
  return new SupabasePaperTradeStore(client);
}

// Supabase is used when configured; local browser storage is the fallback, and becomes the
// only store for the rest of the session if Supabase is unavailable (see
// ResilientPaperTradeStore). The instance is cached at module scope so every caller shares one
// store — and, with it, one in-flight connection and one persistence status — rather than each
// hook/component creating its own.
export function getPaperTradeStore(): ResilientPaperTradeStore {
  if (!store) {
    const primary = isSupabaseConfigured() ? createSupabaseStore() : null;
    store = new ResilientPaperTradeStore(primary, new LocalStoragePaperTradeStore());
  }
  return store;
}
