import type { NextRequest } from "next/server";
import { withHermesGuard } from "@/lib/hermes-integration/auth";
import { successEnvelope } from "@/lib/hermes-integration/response-envelope";
import { getBrokerSnapshot } from "@/lib/hermes-integration/broker-snapshot";
import { readHermesRuntimeAuditLog } from "@/lib/hermes-integration/audit-log-reader";
import {
  deriveObservedRuntimeState,
  latestFailureOrWarning,
  listDecisions,
  sumRealisedPnlSinceLastStart,
} from "@/lib/hermes-integration/audit-derivations";
import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import type { HealthStatus } from "@/lib/health/health-status";

// Hermes Integration API v1 — read-only. GET /api/hermes/summary: a single compact, deterministic
// operational snapshot for an AI agent to read in one call — combining health, runtime status,
// portfolio, latest decision, and recent failures. Purely a combination of the other five
// endpoints' own logic (each subsystem reuses the exact same derivation/broker-snapshot functions
// they do) — no new computation, no LLM involved anywhere in building this response.
//
// Every subsystem is fetched independently and defensively: a broker/config/audit-log failure in
// one never prevents the others from being reported, and never makes this endpoint itself fail —
// see the individual try/catches below. The response is always `ok: true` (the request itself
// succeeded); degradation is visible only in `warnings` and in individual fields being `null`.

export async function GET(request: NextRequest) {
  return withHermesGuard(request, async () => {
    const warnings: string[] = [];

    let config: ReturnType<typeof getHermesExecutionConfig> | undefined;
    try {
      config = getHermesExecutionConfig();
    } catch (error) {
      warnings.push(`Configuration error: ${error instanceof Error ? error.message : "unknown"}`);
    }

    let portfolio: {
      accountMode: string;
      provider: string;
      cash: number;
      investedValue: number;
      realisedPnl: number | null;
      openPositionCount: number;
    } | null = null;
    let openPositionCount: number | null = null;
    let brokerStatus: HealthStatus = "unknown";

    try {
      const snapshot = await getBrokerSnapshot();
      if (snapshot.ok) {
        brokerStatus = "healthy";
        openPositionCount = snapshot.positions.length;
        portfolio = {
          accountMode: snapshot.accountMode,
          provider: snapshot.provider,
          cash: snapshot.cash,
          investedValue: snapshot.positions.reduce((sum, position) => sum + (position.quantity ?? 0), 0),
          realisedPnl: null, // filled in below, once the audit log has been read
          openPositionCount: snapshot.positions.length,
        };
      } else {
        brokerStatus = "unavailable";
        warnings.push(`Broker/portfolio unavailable: ${snapshot.message}`);
      }
    } catch (error) {
      brokerStatus = "unavailable";
      warnings.push(`Broker/portfolio check failed unexpectedly: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    let runtimeSummary: {
      state: string;
      lastRunAt: string | null;
      successfulRunCount: number;
      failedRunCount: number;
    } | null = null;
    let latestDecision: ReturnType<typeof listDecisions>[number] | null = null;
    let recentFailure: ReturnType<typeof latestFailureOrWarning> = null;

    try {
      const auditLog = await readHermesRuntimeAuditLog();
      if (auditLog.available) {
        const observed = deriveObservedRuntimeState(auditLog.events);
        runtimeSummary = {
          state: observed.state,
          lastRunAt: observed.lastRunAt,
          successfulRunCount: observed.successfulRunCount,
          failedRunCount: observed.failedRunCount,
        };
        if (observed.state === "STOPPED") warnings.push("Trading runtime is not currently running.");
        if (observed.state === "PAUSED") warnings.push("Trading runtime is currently paused.");

        if (portfolio) {
          portfolio.realisedPnl = sumRealisedPnlSinceLastStart(auditLog.events);
        }

        const decisions = listDecisions(auditLog.events, { limit: 1 });
        latestDecision = decisions[0] ?? null;

        recentFailure = latestFailureOrWarning(auditLog.events);
        if (recentFailure) {
          warnings.push(`Most recent failure (${recentFailure.eventType} at ${recentFailure.timestamp}): ${recentFailure.message}`);
        }
      } else {
        warnings.push("Trading runtime audit log is unavailable — runtime/decision history could not be read.");
      }
    } catch (error) {
      warnings.push(`Runtime/decision history check failed unexpectedly: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    const healthSeverities: HealthStatus[] = [config ? "healthy" : "unavailable", brokerStatus];
    const overallHealth: HealthStatus = healthSeverities.includes("unavailable")
      ? "unavailable"
      : healthSeverities.includes("degraded")
        ? "degraded"
        : healthSeverities.includes("unknown")
          ? "unknown"
          : "healthy";

    return successEnvelope({
      timestamp: new Date().toISOString(),
      health: {
        status: overallHealth,
        runtimeMode: config?.runtimeTrading.mode ?? "unknown",
        brokerProvider: config?.brokerProvider ?? "unknown",
      },
      runtime: runtimeSummary,
      portfolio,
      openPositionCount,
      latestDecision,
      recentFailure,
      warnings,
    });
  });
}
