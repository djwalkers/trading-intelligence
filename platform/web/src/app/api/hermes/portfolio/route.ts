import type { NextRequest } from "next/server";
import { withHermesGuard } from "@/lib/hermes-integration/auth";
import { successEnvelope, errorEnvelope } from "@/lib/hermes-integration/response-envelope";
import { getBrokerSnapshot } from "@/lib/hermes-integration/broker-snapshot";
import { getDurableRealisedPnlSummary } from "@/lib/hermes-integration/durable-realised-pnl";

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
//
// Realised-P/L restart-consistency fix. computeRealisedPnlSummary() used to live here as this
// route's own private helper — now getDurableRealisedPnlSummary() (durable-realised-pnl.ts),
// shared with GET /api/hermes/summary so both routes report the exact same durable figure from the
// exact same bounded Supabase queries, never two independently-computed (and previously
// inconsistent) realised-P/L numbers for the same account.

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

    const realisedPnlSummary = await getDurableRealisedPnlSummary();

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
