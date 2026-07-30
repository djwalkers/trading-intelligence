import { proxyHermesGet } from "@/lib/hermes-integration/dashboard-proxy";

// Main Dashboard Hermes/eToro fix. The browser-facing counterpart to GET /api/hermes/summary —
// see dashboard-proxy.ts's own doc comment for why this indirection exists. Split-deployment fix:
// the upstream host is now read from HERMES_INTEGRATION_BASE_URL (config.ts).

export const dynamic = "force-dynamic";

export async function GET() {
  return proxyHermesGet("summary");
}
