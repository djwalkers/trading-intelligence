import { proxyOperationsProcessesGet } from "@/lib/hermes-integration/dashboard-proxy";

// Split-deployment defect fix. The browser-facing counterpart to the VPS-only PM2 collector (GET
// /api/operations/processes) — see dashboard-proxy.ts's own doc comment for why this indirection
// exists (identical reasoning to /api/dashboard/hermes-summary and the rest of that family). The
// browser must call this route, never /api/operations/processes directly — see
// use-runtime-processes-data.ts.

export const dynamic = "force-dynamic";

export async function GET() {
  return proxyOperationsProcessesGet();
}
