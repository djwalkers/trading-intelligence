import { proxyHermesGet } from "@/lib/hermes-integration/dashboard-proxy";

// Main Dashboard Hermes/eToro fix. The browser-facing counterpart to GET /api/hermes/portfolio —
// see dashboard-proxy.ts's own doc comment for why this indirection exists (that route requires a
// bearer token meant for an external AI agent, never exposable to browser JS). Split-deployment
// fix: the upstream host is now read from HERMES_INTEGRATION_BASE_URL (config.ts), never derived
// from this request's own origin — see dashboard-proxy.ts's own doc comment.

export const dynamic = "force-dynamic";

export async function GET() {
  return proxyHermesGet("portfolio");
}
