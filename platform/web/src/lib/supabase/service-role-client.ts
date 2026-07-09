import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Server-only (see the "server-only" import above — Next.js fails the build if any client
// component ever imports this module, even transitively). SUPABASE_SERVICE_ROLE_KEY is
// deliberately NOT prefixed with NEXT_PUBLIC_, so Next.js never inlines it into the browser
// bundle. This client bypasses Row Level Security entirely — that's what the service role is for
// — so every query issued through it MUST filter/stamp user_id explicitly in application code
// (see src/lib/persistence/server-paper-trade-store.ts and
// docs/product/MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md, "Service-role safety"). Nothing in
// the running app calls this yet — no worker exists (Mission 7); this is prepared, unused
// infrastructure, and returns null until SUPABASE_SERVICE_ROLE_KEY is actually configured.
let client: SupabaseClient | null = null;
let attempted = false;

export function getServiceRoleClient(): SupabaseClient | null {
  if (attempted) return client;
  attempted = true;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;

  client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  return client;
}
