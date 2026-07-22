import type { NextRequest } from "next/server";
import { withHermesGuard } from "@/lib/hermes-integration/auth";
import { successEnvelope } from "@/lib/hermes-integration/response-envelope";
import { getBrokerSnapshot } from "@/lib/hermes-integration/broker-snapshot";
import { readHermesRuntimeAuditLog } from "@/lib/hermes-integration/audit-log-reader";
import { deriveObservedRuntimeState } from "@/lib/hermes-integration/audit-derivations";
import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import type { HealthStatus } from "@/lib/health/health-status";

// Hermes Integration API v1 — read-only. GET /api/hermes/health: a concise overall platform
// health check. Every component is either genuinely verified this request (broker: a real,
// bounded-timeout connection attempt) or explicitly marked "unknown" when this process has no
// reliable way to know (runtime: inferred from the persisted audit trail only, no live channel to
// the separate `market:runtime` process — see get-application-health.ts's own `automation: unknown`
// for the same structural limitation applied to the unrelated VPS worker).

export async function GET(request: NextRequest) {
  return withHermesGuard(request, async () => {
    const warnings: string[] = [];

    let config: ReturnType<typeof getHermesExecutionConfig> | undefined;
    let application: HealthStatus = "healthy";
    try {
      config = getHermesExecutionConfig();
    } catch (error) {
      application = "unavailable";
      warnings.push(`Configuration error: ${error instanceof Error ? error.message : "unknown"}`);
    }

    let broker: HealthStatus = "unknown";
    let marketData: HealthStatus = "unknown";
    if (config) {
      const snapshot = await getBrokerSnapshot();
      if (snapshot.ok) {
        broker = "healthy";
        marketData = "healthy";
        if (config.marketDataProvider === "mock") {
          warnings.push('Market data provider is "mock", not live.');
        }
      } else {
        broker = "unavailable";
        marketData = config.marketDataProvider === "live" ? "unavailable" : "healthy";
        warnings.push(`Broker connectivity check failed: ${snapshot.message}`);
      }
    }

    const auditLog = await readHermesRuntimeAuditLog();
    const observed = deriveObservedRuntimeState(auditLog.events);
    const runtimeState = auditLog.available ? observed.state : "unknown";
    if (!auditLog.available) {
      warnings.push("Trading runtime audit log is unavailable — runtime state could not be verified.");
    } else if (runtimeState === "unknown") {
      warnings.push("No trading runtime lifecycle events observed yet.");
    } else if (runtimeState === "STOPPED") {
      warnings.push("Trading runtime is not currently running.");
    } else if (runtimeState === "PAUSED") {
      warnings.push("Trading runtime is currently paused.");
    }

    const runtimeSeverity: HealthStatus =
      runtimeState === "RUNNING" ? "healthy" : runtimeState === "unknown" ? "unknown" : "degraded";

    const severities: HealthStatus[] = [application, broker, marketData, runtimeSeverity];
    const overall: HealthStatus = severities.includes("unavailable")
      ? "unavailable"
      : severities.includes("degraded")
        ? "degraded"
        : severities.includes("unknown")
          ? "unknown"
          : "healthy";

    return successEnvelope({
      ok: overall === "healthy",
      status: overall,
      timestamp: new Date().toISOString(),
      runtimeMode: config?.runtimeTrading.mode ?? "unknown",
      brokerProvider: config?.brokerProvider ?? "unknown",
      marketDataProvider: config?.marketDataProvider ?? "unknown",
      components: {
        application,
        broker,
        marketData,
        runtime: runtimeState,
      },
      warnings,
    });
  });
}
