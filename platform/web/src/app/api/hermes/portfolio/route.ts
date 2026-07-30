import type { NextRequest } from "next/server";
import { withHermesGuard } from "@/lib/hermes-integration/auth";
import { successEnvelope, errorEnvelope } from "@/lib/hermes-integration/response-envelope";
import { getBrokerSnapshot } from "@/lib/hermes-integration/broker-snapshot";
import { getServiceRoleClient } from "@/lib/supabase/service-role-client";
import { buildAnalysisPersistenceConfig } from "@/lib/hermes-execution/analysis/analysis-persistence-config";
import { SupabaseTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/supabase-trade-lifecycle-store";

// Hermes Integration API v1. GET /api/hermes/portfolio: cash + positions read live from the
// connected broker (getBrokerSnapshot — see broker-snapshot.ts), realised P/L aggregated from the
// durable trade lifecycle store (Supabase-backed, survives runtime restarts — see
// TradeLifecycleStore's own doc comment), unrealised P/L and equity derived here from those two,
// never fabricated.
//
// Missing-financial-data fix. Previously realisedPnl was summed from the trading runtime's
// JsonFileAuditTrail "since last runtime start" — misleadingly scoped (that text predates the
// Restart-Resilient Autonomy Phase's trade lifecycle persistence hardening; production's
// market-runtime.ts has used JsonFileAuditTrail.loadExisting(), not createFresh(), for a while,
// and the runtime's TradeLifecycleStore is REQUIRED and Supabase-backed regardless) and
// unrealisedPnl/equity were simply always null. Realised P/L now aggregates the durable
// trade_lifecycle_records table directly (the same store the trading runtime itself writes to),
// which is authoritative for confirmed-closed trades independent of process restarts; unrealised
// P/L and equity are computed from broker-ground-truth open positions + live prices (see
// broker-snapshot.ts's own priceOpenPositions()).

const REALISED_PNL_SCOPE_DURABLE =
  "Since trade lifecycle tracking began — aggregated from durable, Supabase-backed trade lifecycle records " +
  "(survives trading-runtime restarts; not scoped to the current process's own uptime).";

interface RealisedPnlSummary {
  realisedPnl: number | null;
  realisedPnlScope: string;
  realisedTradeCount: number;
  unreconciledClosedTradeCount: number;
}

async function computeRealisedPnlSummary(): Promise<RealisedPnlSummary> {
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
    const [closed, unreconciled] = await Promise.all([store.listClosed(), store.listUnreconciled()]);

    // listClosed() already excludes CLOSED_UNRECONCILED/EXECUTION_ABANDONED server-side (status ===
    // "CLOSED" only) — this filter only guards against a CLOSED record that, unexpectedly, never
    // got a confirmed realisedPnl written; such a record is excluded from the sum/count rather than
    // treated as a $0 trade.
    const confirmedClosed = closed.filter((record) => record.realisedPnl !== undefined);
    const realisedPnl = confirmedClosed.reduce((sum, record) => sum + (record.realisedPnl ?? 0), 0);

    return {
      realisedPnl,
      realisedPnlScope: REALISED_PNL_SCOPE_DURABLE,
      realisedTradeCount: confirmedClosed.length,
      unreconciledClosedTradeCount: unreconciled.length,
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

export async function GET(request: NextRequest) {
  return withHermesGuard(request, async () => {
    const snapshot = await getBrokerSnapshot();
    if (!snapshot.ok) {
      return errorEnvelope("BROKER_UNAVAILABLE", snapshot.message, 503);
    }

    // Missing-financial-data fix. `investedValue` sums eToro's own `amount` per position — the
    // margin/notional committed at entry, NOT a continuously mark-to-market figure (eToro's API
    // never re-reports it as prices move) — i.e. a cost basis, not current market value. This is
    // exactly why the equity formula below still needs `unrealisedPnl` added on top: for a
    // margined/CFD position, currentMarketValue ≈ investedValue (margin) + unrealisedPnl, so
    // cash + investedValue + unrealisedPnl is the correct total-equity formula, not double-counting.
    const investedValue = snapshot.positions.reduce((sum, position) => sum + (position.quantity ?? 0), 0);

    const unrealisedPnl = snapshot.unrealisedPnlComplete
      ? snapshot.positions.reduce((sum, position) => sum + (position.unrealisedPnl ?? 0), 0)
      : null;

    const equity = unrealisedPnl !== null ? snapshot.cash + investedValue + unrealisedPnl : null;
    const equitySource: "BROKER" | "CALCULATED" | "UNAVAILABLE" = equity !== null ? "CALCULATED" : "UNAVAILABLE";

    const realisedPnlSummary = await computeRealisedPnlSummary();

    return successEnvelope({
      accountMode: snapshot.accountMode,
      provider: snapshot.provider,
      cash: snapshot.cash,
      investedValue,
      realisedPnl: realisedPnlSummary.realisedPnl,
      realisedPnlScope: realisedPnlSummary.realisedPnlScope,
      realisedTradeCount: realisedPnlSummary.realisedTradeCount,
      unreconciledClosedTradeCount: realisedPnlSummary.unreconciledClosedTradeCount,
      unrealisedPnl,
      unrealisedPnlComplete: snapshot.unrealisedPnlComplete,
      unrealisedPnlUnavailableReason: snapshot.unrealisedPnlUnavailableReason,
      equity,
      equitySource,
      openPositionCount: snapshot.positions.length,
      currency: "USD",
      positionsAreLiveGroundTruth: snapshot.positionsAreLiveGroundTruth,
      timestamp: new Date().toISOString(),
    });
  });
}
