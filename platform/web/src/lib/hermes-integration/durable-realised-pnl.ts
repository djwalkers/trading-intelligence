import "server-only";
import { getServiceRoleClient } from "@/lib/supabase/service-role-client";
import { buildAnalysisPersistenceConfig } from "@/lib/hermes-execution/analysis/analysis-persistence-config";
import { SupabaseTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/supabase-trade-lifecycle-store";

// Realised-P/L restart-consistency fix. Extracted from GET /api/hermes/portfolio's own former
// computeRealisedPnlSummary() (unchanged logic, just made shared) so GET /api/hermes/summary can
// report the SAME durable, Supabase-backed figure instead of its own former
// sumRealisedPnlSinceLastStart(auditLog.events) — a process-session-scoped scan of the runtime's
// own audit log that returns null the instant the runtime restarts and no position has closed yet
// THIS process run, even though durably-persisted history (surviving the restart) says otherwise.
// Both routes now call this ONE function, so both see one coherent figure from one coherent source
// — never two independently-drifting realised-P/L numbers for the same account.
//
// Egress-containment fix (see supabase-trade-lifecycle-store.ts's own doc comment): both underlying
// store calls are bounded, server-side-aggregated queries — sumRealisedPnlForClosedTrades() selects
// only the realised_pnl column (never the JSONB `detail` blob a `select("*")` would also pull in),
// and countUnreconciledClosedTrades() is a count-only (`head: true`) query. Never list()/listClosed()/
// listUnreconciled()/select("*") — this module must never reintroduce the full-table-scan egress
// source that prompted that fix.

export const DURABLE_REALISED_PNL_SCOPE =
  "Since trade lifecycle tracking began — aggregated from durable, Supabase-backed trade lifecycle records " +
  "(survives trading-runtime restarts; not scoped to the current process's own uptime).";

export interface DurableRealisedPnlSummary {
  realisedPnl: number | null;
  realisedPnlScope: string;
  realisedTradeCount: number;
  unreconciledClosedTradeCount: number;
}

/** Never throws — every failure path (persistence not configured, service-role client missing, the
 * store query itself failing) returns `realisedPnl: null` with a `realisedPnlScope` string
 * explaining why, so a caller can degrade safely (`ok: true`, this one field null) rather than
 * failing the whole request. */
export async function getDurableRealisedPnlSummary(): Promise<DurableRealisedPnlSummary> {
  const persistenceConfig = buildAnalysisPersistenceConfig();
  if (!persistenceConfig.enabled || !persistenceConfig.ownerUserId) {
    return {
      realisedPnl: null,
      realisedPnlScope:
        "Unavailable — durable trade lifecycle persistence is not configured on this deployment " +
        "(HERMES_SUPABASE_USER_ID / Supabase service role).",
      realisedTradeCount: 0,
      unreconciledClosedTradeCount: 0,
    };
  }

  const client = getServiceRoleClient();
  if (!client) {
    return {
      realisedPnl: null,
      realisedPnlScope: "Unavailable — the Supabase service role client is not configured.",
      realisedTradeCount: 0,
      unreconciledClosedTradeCount: 0,
    };
  }

  try {
    const store = new SupabaseTradeLifecycleStore(client, persistenceConfig.ownerUserId);
    const [{ realisedPnl, realisedTradeCount }, unreconciledClosedTradeCount] = await Promise.all([
      store.sumRealisedPnlForClosedTrades(),
      store.countUnreconciledClosedTrades(),
    ]);

    return {
      realisedPnl,
      realisedPnlScope: DURABLE_REALISED_PNL_SCOPE,
      realisedTradeCount,
      unreconciledClosedTradeCount,
    };
  } catch (error) {
    return {
      realisedPnl: null,
      realisedPnlScope: `Unavailable — could not read trade lifecycle records: ${error instanceof Error ? error.message : "unknown error"}.`,
      realisedTradeCount: 0,
      unreconciledClosedTradeCount: 0,
    };
  }
}
