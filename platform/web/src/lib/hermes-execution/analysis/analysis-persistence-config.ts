import "server-only";
import { getServerConfig } from "@/lib/config/server-config";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. Kept as its own small config
// module, deliberately separate from ../config.ts (HermesExecutionConfig) — same "independently
// removable pipeline" reasoning that file's own top-of-file comment already gives for staying
// separate from server-config.ts. Analysis persistence is a pure, optional, bolt-on observability
// layer: if it's misconfigured or disabled, the trading runtime must behave exactly as it did
// before this phase existed (see trading-runtime.ts's own "never throws" persistence wrapper).
//
// Reuses getServerConfig()'s existing supabaseUrl/supabaseServiceRoleKey (and, transitively,
// getServiceRoleClient()) rather than re-reading those env vars here — one source of truth for
// "is the service role configured at all."

export interface AnalysisPersistenceConfig {
  enabled: boolean;
  /** The Supabase Auth user id this deployment's analysis rows are written under — required
   * because the trading-runtime process has no browser session of its own (see
   * analysis-repository.ts's own top-of-file comment). Deliberately distinct from any broker
   * account identifier; this is a Supabase Auth uuid, the same kind of id RLS's `auth.uid()`
   * compares against. */
  ownerUserId: string | undefined;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildAnalysisPersistenceConfig(
  env: { HERMES_SUPABASE_USER_ID: string | undefined } = {
    HERMES_SUPABASE_USER_ID: process.env.HERMES_SUPABASE_USER_ID,
  },
): AnalysisPersistenceConfig {
  const ownerUserId = env.HERMES_SUPABASE_USER_ID || undefined;

  // Presence/format only — never throws on a missing value (this feature is opt-in: "runtime
  // behaviour must remain identical" when it isn't configured), but a genuinely malformed value
  // that IS set is worth surfacing loudly rather than silently failing every write later.
  if (ownerUserId !== undefined && !UUID_PATTERN.test(ownerUserId)) {
    throw new Error(`HERMES_SUPABASE_USER_ID is set but is not a well-formed UUID: "${ownerUserId}".`);
  }

  const { isServiceRoleConfigured } = getServerConfig();
  const enabled = isServiceRoleConfigured && ownerUserId !== undefined;

  return { enabled, ownerUserId };
}
