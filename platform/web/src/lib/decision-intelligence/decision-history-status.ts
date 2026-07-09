export type DecisionHistoryMode = "Supabase" | "Local Browser Storage";

export interface DecisionHistoryStatus {
  mode: DecisionHistoryMode;
  connected: boolean;
  recordsStored: number;
  lastRecordedAt: string | null;
  // Set once, the first time Supabase fails and this falls back to local storage — mirrors
  // PersistenceStatus.fallbackReason (src/lib/persistence/persistence-status.ts).
  fallbackReason: string | null;
}
