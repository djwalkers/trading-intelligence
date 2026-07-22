import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger/logger";
import { getHermesIntegrationConfig } from "./config";
import { errorEnvelope, type HermesErrorEnvelope } from "./response-envelope";

// Hermes Integration API v1 — the shared authentication guard every /api/hermes/* route calls.
//
// Implemented as a plain exported function (requireHermesAuth) plus one wrapper every route calls
// first (withHermesGuard), NOT Next.js `middleware.ts`. Two reasons: (1) `crypto.timingSafeEqual`
// requires the Node.js runtime, and while Next.js middleware can opt into `runtime: "nodejs"`,
// route handlers under `src/app/api/**/route.ts` already run in the Node.js runtime by default —
// no extra runtime configuration to get right or verify; (2) testability — a plain function is
// directly unit-testable with this project's existing Vitest setup with no special middleware test
// harness, which is what this mission's test list (missing header/invalid token/valid token/
// malformed header) needs. Every route below calls withHermesGuard() as its very first line, so
// there is no route that can accidentally skip it.

function timingSafeStringsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still perform a same-shape comparison so a length mismatch doesn't return measurably faster
    // than a same-length value mismatch — this result is always discarded; only `false` is ever
    // returned for a length mismatch.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// Local-only enforcement, layer #2 — observability, NOT a gate. Network binding to 127.0.0.1
// (see the deployment doc) is layer #1 and the only layer that is actually authoritative; mandatory
// token auth (below) is layer #3 and the only *application-level* control.
//
// This was originally written to reject any request carrying x-forwarded-for/x-real-ip/forwarded,
// on the assumption that a genuine direct loopback connection would never produce one. Live testing
// against this exact server (both `next dev` and `next start`, no reverse proxy) disproved that
// assumption: Next.js's own request handling sets `x-forwarded-for` (and x-forwarded-host/-port/
// -proto) on every request, using the real socket peer address (e.g. `::ffff:127.0.0.1` for a
// genuine loopback call) whenever the client itself didn't already set that header — which means
// the header's mere PRESENCE is meaningless here; it is present on every request, including
// legitimate ones. Worse: when a client DOES set `x-forwarded-for` itself (confirmed live with
// `curl -H "X-Forwarded-For: 8.8.8.8"`), Next.js passes that client-supplied value straight through
// unchanged — so the header's VALUE is fully attacker-controlled too, by any client that can reach
// the port at all (a value of "127.0.0.1" here proves nothing; an attacker could trivially send
// that exact string). Neither presence nor value can therefore ever be used as an allow or a deny
// decision without being either wrong (this rejected 100% of legitimate traffic when live-tested)
// or misleading (a "looks local" check trivially bypassable by anyone who can already reach the
// port). This function is kept as pure observability — logging only, never blocking — per this
// API's own requirement to document rather than fake a check that can't be made reliable at this
// layer. See docs/hermes-integration-api.md's "Local-only enforcement" section for the full
// write-up, including the live test that disproved the original approach.
function logIfForwardedFromNonLoopback(request: NextRequest): void {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (!forwardedFor) return;
  const firstHop = forwardedFor.split(",")[0]?.trim();
  const looksLoopback = firstHop === "127.0.0.1" || firstHop === "::1" || firstHop === "::ffff:127.0.0.1";
  if (!looksLoopback) {
    logger.warn("Hermes Integration API saw a non-loopback x-forwarded-for value — informational only, not enforced", {
      component: "hermes-integration-auth",
    });
  }
}

export interface HermesAuthFailure {
  status: number;
  code: string;
  message: string;
}

export type HermesAuthResult = { ok: true } | ({ ok: false } & HermesAuthFailure);

const UNAUTHORIZED: HermesAuthFailure = { status: 401, code: "UNAUTHORIZED", message: "Missing or invalid credentials." };

const BEARER_PATTERN = /^Bearer (.+)$/i;

export function requireHermesAuth(request: NextRequest): HermesAuthResult {
  // Observability only — see logIfForwardedFromNonLoopback's own doc comment for why this can never
  // gate access. Token authentication below is the only real application-level control.
  logIfForwardedFromNonLoopback(request);

  let config;
  try {
    config = getHermesIntegrationConfig();
  } catch (error) {
    // A configured-but-invalid token is meant to fail the whole process at startup (see
    // instrumentation.ts). If we still somehow get here (e.g. instrumentation didn't run in this
    // environment), fail closed on every request rather than ever throwing a raw 500 that might
    // include the ConfigError's own text (it never includes the token value itself, but the
    // response should stay generic regardless).
    logger.error("Hermes Integration API: HERMES_INTEGRATION_TOKEN is configured but invalid", {
      component: "hermes-integration-auth",
      reason: error instanceof Error ? error.message : "Unknown configuration error.",
    });
    return { ok: false, ...UNAUTHORIZED };
  }

  if (!config) return { ok: false, ...UNAUTHORIZED };

  const header = request.headers.get("authorization");
  if (!header) return { ok: false, ...UNAUTHORIZED };

  const match = BEARER_PATTERN.exec(header);
  if (!match) return { ok: false, ...UNAUTHORIZED };

  const presented = match[1] ?? "";
  if (presented.length === 0) return { ok: false, ...UNAUTHORIZED };

  if (!timingSafeStringsEqual(presented, config.token)) return { ok: false, ...UNAUTHORIZED };

  return { ok: true };
}

/**
 * Every `/api/hermes/*` route's first line. Runs the shared guard, then the route's own handler
 * inside a catch-all that converts any unexpected throw into the standard error envelope (never a
 * raw Next.js error page / stack trace) — the same "never crash, never leak internals" contract
 * every route promises. Route-specific error handling (e.g. a validation 400, a broker-unavailable
 * 503) still happens inside `handler` itself; this catch is only the last-resort safety net.
 */
export async function withHermesGuard(
  request: NextRequest,
  handler: () => Promise<NextResponse>,
): Promise<NextResponse | NextResponse<HermesErrorEnvelope>> {
  const auth = requireHermesAuth(request);
  if (!auth.ok) return errorEnvelope(auth.code, auth.message, auth.status);

  try {
    return await handler();
  } catch (error) {
    logger.error("Hermes Integration API request failed unexpectedly", {
      component: "hermes-integration-api",
      reason: error instanceof Error ? error.message : String(error),
    });
    return errorEnvelope("UNKNOWN_ERROR", "An unexpected error occurred.", 500);
  }
}
