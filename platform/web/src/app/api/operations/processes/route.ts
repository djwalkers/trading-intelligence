import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ChildProcessPm2Runner } from "@/lib/operations/pm2-runner";
import { mapPm2ProcessesToOperationsView } from "@/lib/operations/map-pm2-processes";
import { requireHermesAuth } from "@/lib/hermes-integration/auth";
import { logger } from "@/lib/logger/logger";

// Runtime Processes panel — Operations Centre. GET /api/operations/processes: read-only PM2
// process health for the two allow-listed processes (see map-pm2-processes.ts's own
// MONITORED_PROCESSES) — this route runs the FIXED "pm2 jlist" command (never parameterized by
// anything in `request` — no query parameter, header, or body is ever read here) and returns a
// narrow, explicitly-modelled DTO.
//
// Split-deployment defect fix. This route only ever produces a real result on the VPS (the only
// host PM2 actually runs on) — it must never be called directly by the browser, which may be
// talking to an entirely different host (Vercel) where this route correctly, but uselessly, fails
// with "the PM2 executable could not be started". The browser instead calls
// GET /api/dashboard/operations-processes, which server-side-proxies here across hosts with a
// bearer token attached — see dashboard-proxy.ts's own proxyOperationsProcessesGet. This route is
// consequently no longer purely same-origin-dashboard-facing; it now has a legitimate
// server-to-server caller, and is gated by requireHermesAuth — the exact same
// HERMES_INTEGRATION_TOKEN bearer-token check every /api/hermes/* route already uses (not a new,
// one-off auth mechanism). The response stays just as narrow as before regardless (§
// map-pm2-processes.ts: no pm2_env, no environment variables, no paths, no command lines) — the
// token check is a real access-control layer now, not merely a compensating control.

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

export async function GET(request: NextRequest) {
  const auth = requireHermesAuth(request);
  if (!auth.ok) {
    return errorResponse(auth.code, auth.message, auth.status);
  }

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
