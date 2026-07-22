import type { NextRequest } from "next/server";
import { withHermesGuard } from "@/lib/hermes-integration/auth";
import { successEnvelope, errorEnvelope } from "@/lib/hermes-integration/response-envelope";
import { getBrokerSnapshot } from "@/lib/hermes-integration/broker-snapshot";
import { readHermesRuntimeAuditLog } from "@/lib/hermes-integration/audit-log-reader";
import { sumRealisedPnlSinceLastStart } from "@/lib/hermes-integration/audit-derivations";

// Hermes Integration API v1 — read-only. GET /api/hermes/portfolio: a demo/paper portfolio
// summary. `cash` and open-position data are live (see broker-snapshot.ts). `realisedPnl` is
// summed from the persisted audit trail's TRADE_CLOSED events since the runtime's last start —
// scoped to "since last runtime restart" because the audit log itself is truncated fresh on every
// process start (JsonFileAuditTrail.createFresh() — see docs/hermes-integration-api.md's Known
// Limitations). `unrealisedPnl`/`equity` are always `null`: computing them would need a live rate
// per open position, which the existing broker abstraction doesn't cheaply expose — never
// fabricated here.

export async function GET(request: NextRequest) {
  return withHermesGuard(request, async () => {
    const snapshot = await getBrokerSnapshot();
    if (!snapshot.ok) {
      return errorEnvelope("BROKER_UNAVAILABLE", snapshot.message, 503);
    }

    const auditLog = await readHermesRuntimeAuditLog();
    const realisedPnl = auditLog.available ? sumRealisedPnlSinceLastStart(auditLog.events) : null;
    const investedValue = snapshot.positions.reduce((sum, position) => sum + (position.quantity ?? 0), 0);

    return successEnvelope({
      accountMode: snapshot.accountMode,
      provider: snapshot.provider,
      cash: snapshot.cash,
      investedValue,
      realisedPnl,
      realisedPnlScope: "since last runtime start (audit log is not durable across restarts)",
      unrealisedPnl: null,
      equity: null,
      openPositionCount: snapshot.positions.length,
      timestamp: new Date().toISOString(),
      positionsAreLiveGroundTruth: snapshot.positionsAreLiveGroundTruth,
    });
  });
}
