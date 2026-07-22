import type { NextRequest } from "next/server";
import { withHermesGuard } from "@/lib/hermes-integration/auth";
import { successEnvelope, errorEnvelope } from "@/lib/hermes-integration/response-envelope";
import { getBrokerSnapshot } from "@/lib/hermes-integration/broker-snapshot";

// Hermes Integration API v1 — read-only. GET /api/hermes/positions: current demo/paper positions,
// read live from the configured broker (see broker-snapshot.ts — this is a genuine, bounded-
// timeout network call to eToro's demo API for Prototype V1's fixed broker, not a replay of
// anything cached).

export async function GET(request: NextRequest) {
  return withHermesGuard(request, async () => {
    const snapshot = await getBrokerSnapshot();
    if (!snapshot.ok) {
      return errorEnvelope("BROKER_UNAVAILABLE", snapshot.message, 503);
    }

    return successEnvelope({
      positions: snapshot.positions,
      count: snapshot.positions.length,
      provider: snapshot.provider,
      accountMode: snapshot.accountMode,
      positionsAreLiveGroundTruth: snapshot.positionsAreLiveGroundTruth,
    });
  });
}
