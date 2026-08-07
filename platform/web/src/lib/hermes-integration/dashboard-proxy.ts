import "server-only";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getHermesIntegrationConfig } from "./config";
import type { HermesErrorEnvelope } from "./response-envelope";
import { logger } from "@/lib/logger/logger";

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
//
// Split-deployment fix. The frontend (this Next.js app) and the Hermes runtime (which owns
// /api/hermes/*) can now run on entirely different hosts — frontend on Vercel, Hermes on a VPS —
// so this can no longer assume /api/hermes/* lives at the SAME origin as the incoming request
// (request.nextUrl.origin, the previous behaviour). The upstream URL is now built from
// HERMES_INTEGRATION_BASE_URL (config.baseUrl — see config.ts's own validation: required together
// with the token, HTTPS-enforced for anything remote, trailing-slash-normalised) instead — `request`
// itself is no longer needed to determine where to call.
//
// Runtime Processes split-deployment defect fix. The VPS-only PM2 collector (GET
// /api/operations/processes — see its own route.ts) hit the exact same split-deployment problem
// /api/hermes/* already had: the browser was calling it directly, so on Vercel it executed against
// Vercel's own copy of that route, where no PM2 process exists ("The PM2 executable could not be
// started on this server"). proxyOperationsProcessesGet below reuses this module's own bridge
// unchanged — same HERMES_INTEGRATION_BASE_URL/HERMES_INTEGRATION_TOKEN pair, same error handling —
// rather than inventing a second networking model; the two exported functions share one internal
// `proxyGet` that only the upstream path differs between them.

interface ProxyErrorLogContext {
  upstreamPath: string;
}

function configErrorResponse(message: string): NextResponse<HermesErrorEnvelope> {
  return NextResponse.json<HermesErrorEnvelope>(
    { ok: false, error: { code: "CONFIG_ERROR", message }, meta: { timestamp: new Date().toISOString() } },
    { status: 500 },
  );
}

/**
 * Proxies one GET `<upstreamPath>` call for a same-origin dashboard route handler, attaching the
 * HERMES_INTEGRATION_TOKEN bearer token server-side. `upstreamPath` must always be a hard-coded
 * literal at the call site (never derived from a request/caller) — see the two thin wrappers below.
 */
async function proxyGet(upstreamPath: string): Promise<NextResponse> {
  let config;
  try {
    config = getHermesIntegrationConfig();
  } catch (error) {
    return configErrorResponse(error instanceof Error ? error.message : "Hermes Integration API configuration error.");
  }

  if (!config) {
    return NextResponse.json<HermesErrorEnvelope>(
      {
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Hermes Integration API is not configured (HERMES_INTEGRATION_TOKEN / HERMES_INTEGRATION_BASE_URL are not set).",
        },
        meta: { timestamp: new Date().toISOString() },
      },
      { status: 401 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(new URL(upstreamPath, config.baseUrl), {
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

  logUpstreamAuthFailure(upstream.status, { upstreamPath });

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return NextResponse.json<HermesErrorEnvelope>(
      {
        ok: false,
        error: {
          code: "UPSTREAM_MALFORMED_RESPONSE",
          message: `The Hermes Integration API returned a response that could not be parsed as JSON (HTTP ${upstream.status}).`,
        },
        meta: { timestamp: new Date().toISOString() },
      },
      { status: 502 },
    );
  }

  return NextResponse.json(body, { status: upstream.status });
}

// A 401/403 from the upstream almost always means the two sides' HERMES_INTEGRATION_TOKEN values
// disagree (or one side lacks it entirely) — a configuration problem, not a real caller-facing
// event. Logged server-side only, by status code and upstream path alone, so an operator can
// diagnose it; the token itself is never logged, matching this API's own auth.ts convention (see
// its own doc comment: unexpected-error logging never includes the credential, only a safe reason).
function logUpstreamAuthFailure(status: number, context: ProxyErrorLogContext): void {
  if (status !== 401 && status !== 403) return;
  logger.warn("Dashboard proxy: upstream Hermes Integration API rejected the server-to-server request as unauthorized", {
    component: "dashboard-proxy",
    ...context,
    upstreamStatus: status,
  });
}

/**
 * Proxies one GET /api/hermes/<path> call for a same-origin dashboard route handler. `path` must
 * be a plain path segment (e.g. "portfolio") — never accepts caller-supplied input, so there is no
 * injection surface here; every call site passes a hard-coded literal.
 */
export async function proxyHermesGet(path: string): Promise<NextResponse> {
  return proxyGet(`/api/hermes/${path}`);
}

/**
 * Proxies GET /api/operations/processes (the VPS-only PM2 process-health collector) for the
 * browser-facing GET /api/dashboard/operations-processes route. No arguments — there is exactly one
 * upstream path this ever calls, never parameterized by a caller.
 */
export async function proxyOperationsProcessesGet(): Promise<NextResponse> {
  return proxyGet("/api/operations/processes");
}
