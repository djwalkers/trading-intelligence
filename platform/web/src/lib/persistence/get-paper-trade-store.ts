import { LocalStoragePaperTradeStore } from "./local-storage-paper-trade-store";
import type { PaperTradeStore } from "./paper-trade-store";

let store: PaperTradeStore | null = null;

// Build 0.6.0 always uses local browser storage, regardless of whether Supabase environment
// variables are present (see config.ts's isSupabaseConfigured, which is informational only and
// only drives the System Health display). SupabasePaperTradeStore is a placeholder with no real
// queries yet, so switching to it here would silently break persistence for anyone who sets the
// env vars before that store is actually implemented. A future build should make this factory
// check isSupabaseConfigured() and return SupabasePaperTradeStore once it is real.
export function getPaperTradeStore(): PaperTradeStore {
  if (!store) {
    store = new LocalStoragePaperTradeStore();
  }
  return store;
}
