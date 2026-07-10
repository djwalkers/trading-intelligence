import { getClientConfig } from "@/lib/config/client-config";

// Purely informational presence check — used to decide whether Supabase-backed persistence and
// auth are active, and what System Health displays. Neither variable is required to run the app.
export function isSupabaseConfigured(): boolean {
  return getClientConfig().isSupabaseConfigured;
}
