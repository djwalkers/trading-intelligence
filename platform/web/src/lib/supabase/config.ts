// Purely informational presence check — used to decide whether Supabase-backed persistence and
// auth are active, and what System Health displays. Neither variable is required to run the app.
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
