// Purely informational — this only controls what System Health displays. It does NOT switch
// persistence to Supabase; see get-paper-trade-store.ts for why local storage remains the only
// active store in this build.
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
