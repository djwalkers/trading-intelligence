export type PersistenceMode = "Supabase" | "Local Browser Storage";

export interface PersistenceStatus {
  mode: PersistenceMode;
  connected: boolean;
  lastSyncedAt: string | null;
  // Set once, the first time Supabase fails and we fall back to local storage. Cleared never —
  // it's a session-level fact ("this is why you're on local storage right now"), not a
  // per-request error.
  fallbackReason: string | null;
}
