import type { NextRequest } from "next/server";
import { proxyHermesGet } from "@/lib/hermes-integration/dashboard-proxy";

// Main Dashboard Hermes/eToro fix. The browser-facing counterpart to GET /api/hermes/positions —
// see dashboard-proxy.ts's own doc comment for why this indirection exists.

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return proxyHermesGet(request, "positions");
}
