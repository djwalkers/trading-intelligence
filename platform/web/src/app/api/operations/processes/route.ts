import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ChildProcessPm2Runner } from "@/lib/operations/pm2-runner";
import { mapPm2ProcessesToOperationsView } from "@/lib/operations/map-pm2-processes";
import { logger } from "@/lib/logger/logger";

// Runtime Processes panel — Operations Centre. GET /api/operations/processes: read-only PM2
// process health for the two allow-listed processes (see map-pm2-processes.ts's own
// MONITORED_PROCESSES) — this route runs the FIXED "pm2 jlist" command (never parameterized by
// anything in `request` — no query parameter, header, or body is ever read here) and returns a
// narrow, explicitly-modelled DTO.
//
// Auth. This app has no server-side session-validation mechanism at all today — no
// `src/middleware.ts`, no `@supabase/ssr`/cookie-based session reader anywhere in the codebase
// (confirmed by repository-wide search before writing this route). `AuthGate` (the mechanism that
// gates PAGES behind sign-in) is a client-side-only React redirect; it cannot, and does not,
// protect any API route. Every existing dashboard-facing data route in this app
// (/api/dashboard/hermes-*, see dashboard-proxy.ts's own doc comment: "no token needed — this app
// has no other multi-tenant concern at this layer") is consequently already same-origin-callable
// with no bearer token, by explicit, established design — not an oversight this route introduces.
// This route follows that exact same convention for this iteration, rather than inventing a new,
// one-off authentication mechanism for a single endpoint. The response is kept narrow enough
// (§ map-pm2-processes.ts: no pm2_env, no environment variables, no paths, no command lines) that
// the impact of it being technically reachable without a session is low — but this IS a known,
// pre-existing platform limitation, not a solved problem, and is not yet tracked in any backlog
// document. If a real server-side session-validation mechanism is added to this app in the future,
// this route (and every other same-origin dashboard route referenced above) should adopt it.

export const dynamic = "force-dynamic";

const TIMEOUT_MS = 5_000;
// pm2 jlist's own output scales with the number of PM2-managed processes on the VPS and each
// process's own pm2_env size (exec paths, args, env) — generous but still bounded, so a runaway or
// misbehaving PM2 output can never make this route buffer unboundedly.
const MAX_STDOUT_BYTES = 512 * 1024;

interface ErrorBody {
  ok: false;
  error: { code: string; message: string };
}

function errorResponse(code: string, message: string, status: number): NextResponse<ErrorBody> {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(_request: NextRequest) {
  const runner = new ChildProcessPm2Runner();
  const result = await runner.jlist({ timeoutMs: TIMEOUT_MS, maxStdoutBytes: MAX_STDOUT_BYTES });

  if (!result.ok) {
    // The raw stderr/spawn-error message is logged server-side only (for operator diagnostics) —
    // never forwarded to the browser, which only ever sees a safe, generic reason.
    logger.warn("PM2 process health check failed", {
      component: "api-operations-processes",
      reason: result.reason,
      detail: result.reason === "spawn-error" ? result.message : "stderrExcerpt" in result ? result.stderrExcerpt : undefined,
    });
    const message =
      result.reason === "timeout"
        ? "PM2 did not respond in time."
        : result.reason === "spawn-error"
          ? "The PM2 executable could not be started on this server."
          : result.reason === "oversized-stdout"
            ? "PM2 returned an unexpectedly large response."
            : "PM2 exited with a non-zero status.";
    return errorResponse("PM2_UNAVAILABLE", message, 503);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    logger.warn("PM2 process health check returned non-JSON output", { component: "api-operations-processes" });
    return errorResponse("PM2_MALFORMED_OUTPUT", "PM2 returned output that could not be parsed as JSON.", 502);
  }

  const now = new Date();
  const mapped = mapPm2ProcessesToOperationsView(parsed, now);
  if (!mapped.ok) {
    logger.warn("PM2 process health check returned an unexpected shape", { component: "api-operations-processes", reason: mapped.reason });
    return errorResponse("PM2_MALFORMED_OUTPUT", mapped.reason, 502);
  }

  return NextResponse.json({ ok: true, data: { processes: mapped.processes, timestamp: now.toISOString() } });
}
