import "server-only";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getHermesIntegrationConfig } from "./config";
import type { HermesErrorEnvelope } from "./response-envelope";

// Main Dashboard Hermes/eToro fix. Every /api/hermes/* route requires a bearer token
// (HERMES_INTEGRATION_TOKEN — see auth.ts's own doc comment: "there is no supported 'on, but
// unauthenticated' state for this API"), because it exists for an external AI agent to call, never
// for this app's own browser client. That token must never reach browser JS (it would be visible
// in the network tab to anyone with access to the page, defeating its purpose as a private
// credential) — so the dashboard's own browser code can never call GET /api/hermes/* directly.
//
// This module is the one place that bridges the two: a genuine, real network call to the exact
// /api/hermes/* path requested (never a re-implementation of that route's own logic — no
// duplicated business logic, no risk of the two diverging), with the bearer token attached
// server-side, from a route handler under /api/dashboard/* that the browser CAN call directly
// (same-origin, no token needed — this app has no other multi-tenant concern at this layer; see
// docs/hermes-integration-api.md's own "local-only" deployment model). The upstream response's own
// envelope/status is forwarded through unchanged, so a genuine 401 (e.g. HERMES_INTEGRATION_TOKEN
// missing or misconfigured) is visible to the dashboard as a real "unauthorised" state, never
// silently swallowed or misreported as a generic error.

/**
 * Proxies one GET /api/hermes/<path> call for a same-origin dashboard route handler. `path` must
 * be a plain path segment (e.g. "portfolio") — never accepts caller-supplied input, so there is no
 * injection surface here; every call site passes a hard-coded literal.
 */
export async function proxyHermesGet(request: NextRequest, path: string): Promise<NextResponse> {
  let config;
  try {
    config = getHermesIntegrationConfig();
  } catch (error) {
    return NextResponse.json<HermesErrorEnvelope>(
      {
        ok: false,
        error: { code: "CONFIG_ERROR", message: error instanceof Error ? error.message : "Hermes Integration API configuration error." },
        meta: { timestamp: new Date().toISOString() },
      },
      { status: 500 },
    );
  }

  if (!config) {
    return NextResponse.json<HermesErrorEnvelope>(
      {
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Hermes Integration API is not configured (HERMES_INTEGRATION_TOKEN is not set)." },
        meta: { timestamp: new Date().toISOString() },
      },
      { status: 401 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(new URL(`/api/hermes/${path}`, request.nextUrl.origin), {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: "no-store",
    });
  } catch (error) {
    return NextResponse.json<HermesErrorEnvelope>(
      {
        ok: false,
        error: { code: "UPSTREAM_UNREACHABLE", message: error instanceof Error ? error.message : "Could not reach the Hermes Integration API." },
        meta: { timestamp: new Date().toISOString() },
      },
      { status: 502 },
    );
  }

  const body = await upstream.json();
  return NextResponse.json(body, { status: upstream.status });
}
