import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;
let attempted = false;

// One client, shared by persistence and auth, so both see the same session — Supabase Auth
// tokens are attached to every request this client makes, which is what lets Row Level Security
// scope paper_trades reads/writes to the signed-in user. Only the public anon key is ever used
// here; access control is delegated to RLS (see supabase/migrations/0007...).
export function getSupabaseClient(): SupabaseClient | null {
  if (attempted) return client;
  attempted = true;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  client = createClient(url, anonKey);
  return client;
}
