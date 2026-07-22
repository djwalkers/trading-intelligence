import type { NextRequest } from "next/server";
import { withHermesGuard } from "@/lib/hermes-integration/auth";
import { successEnvelope, errorEnvelope } from "@/lib/hermes-integration/response-envelope";
import { readHermesRuntimeAuditLog } from "@/lib/hermes-integration/audit-log-reader";
import { deriveObservedRuntimeState } from "@/lib/hermes-integration/audit-derivations";
import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";

// Hermes Integration API v1 — read-only. GET /api/hermes/runtime: the scheduler/runtime's current
// state. "Configured" fields (intervalMs, runtime mode) are read directly from
// HermesExecutionConfig — always available, authoritative. "Observed" fields (state, counts,
// lastRunAt, lastError) are derived from the persisted audit trail only; `nextRunAt` is always
// `null` — there is no live channel to the separate `market:runtime` process from this Next.js
// server to know that with any confidence, and this API never invents a value for it (see
// docs/hermes-integration-api.md).

export async function GET(request: NextRequest) {
  return withHermesGuard(request, async () => {
    let config;
    try {
      config = getHermesExecutionConfig();
    } catch (error) {
      return errorEnvelope(
        "CONFIGURATION_ERROR",
        error instanceof Error ? error.message : "Configuration error.",
        500,
      );
    }

    const auditLog = await readHermesRuntimeAuditLog();
    const observed = deriveObservedRuntimeState(auditLog.events);

    return successEnvelope({
      state: auditLog.available ? observed.state : "unknown",
      startedAt: auditLog.available ? observed.startedAt : null,
      lastRunAt: auditLog.available ? observed.lastRunAt : null,
      nextRunAt: null,
      successfulRunCount: auditLog.available ? observed.successfulRunCount : 0,
      failedRunCount: auditLog.available ? observed.failedRunCount : 0,
      skippedOverlapCount: auditLog.available ? observed.skippedOverlapCount : 0,
      lastError: auditLog.available ? observed.lastError : null,
      configuredIntervalMs: config.scheduler.intervalMs,
      runtimeMode: config.runtimeTrading.mode,
      observedFromAuditLog: auditLog.available,
    });
  });
}
