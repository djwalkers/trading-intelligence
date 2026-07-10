import { NextResponse } from "next/server";
import { getApplicationHealth } from "@/lib/health/get-application-health";
import { logger } from "@/lib/logger/logger";

// Build 1.13.0 — a production-safe health endpoint for deployment monitoring (a load balancer,
// uptime check, or PM2/systemd readiness probe). Deliberately does no network calls, no database
// writes, and no trading actions — see get-application-health.ts for exactly what it does check.
// Safe to poll repeatedly: every field is either a constant, a config-presence check, or the
// current timestamp.
export async function GET() {
  try {
    const health = getApplicationHealth();
    const httpStatus = health.status === "unavailable" ? 503 : 200;
    return NextResponse.json(health, { status: httpStatus });
  } catch (error) {
    // Belt-and-braces: getApplicationHealth() is designed not to throw, but if it somehow does,
    // this must still return a stable, safe JSON shape rather than a raw Next.js error page with
    // a stack trace.
    logger.error("Health endpoint failed unexpectedly", {
      component: "api-health",
      errorCode: "UNKNOWN_ERROR",
      reason: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      {
        status: "unavailable",
        version: "unknown",
        timestamp: new Date().toISOString(),
        services: { application: "unavailable" },
      },
      { status: 503 },
    );
  }
}
