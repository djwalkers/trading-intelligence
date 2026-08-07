import type { NextRequest } from "next/server";
import { withHermesGuard } from "@/lib/hermes-integration/auth";
import { successEnvelope } from "@/lib/hermes-integration/response-envelope";
import { getBrokerSnapshot } from "@/lib/hermes-integration/broker-snapshot";
import { readHermesRuntimeAuditLog } from "@/lib/hermes-integration/audit-log-reader";
import {
  deriveObservedRuntimeState,
  findLastRuntimeStartIndex,
  latestFailureOrWarning,
  listDecisions,
  listUnreconciledClosures,
} from "@/lib/hermes-integration/audit-derivations";
import { getDurableRealisedPnlSummary } from "@/lib/hermes-integration/durable-realised-pnl";
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
//
// Realised-P/L restart-consistency fix. `portfolio.realisedPnl` used to be
// sumRealisedPnlSinceLastStart(auditLog.events) — scoped to the CURRENT process's own uptime, so it
// silently returned null the instant the runtime restarted and no position had closed yet this
// process run, even though GET /api/hermes/portfolio (durable, Supabase-backed) reported the real,
// unchanged figure the whole time. Now sourced from the exact same getDurableRealisedPnlSummary()
// that route calls — one shared helper, one durable source, both endpoints always agree. No longer
// derived from the audit log at all; the audit log here is used only for runtime state, decision/
// failure history, and unreconciled-closure DETAIL records (see listUnreconciledClosures below —
// the durable store has no per-closure detail equivalent, only a count).

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
          realisedPnl: null, // filled in below, once the durable trade lifecycle store has been read
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

    // Realised-P/L restart-consistency fix. Independent of both the broker-snapshot fetch above and
    // the audit-log read below — this is the same durable, Supabase-backed source GET
    // /api/hermes/portfolio uses, via the same shared helper (one call here — never repeated —
    // covers both realisedPnl and unreconciledClosedTradeCount in one round trip, avoiding two
    // identical Supabase queries within this one request).
    let durableRealisedPnl: Awaited<ReturnType<typeof getDurableRealisedPnlSummary>> | null = null;
    try {
      durableRealisedPnl = await getDurableRealisedPnlSummary();
      if (durableRealisedPnl.realisedPnl === null) {
        warnings.push(`Durable realised P/L unavailable: ${durableRealisedPnl.realisedPnlScope}`);
      }
    } catch (error) {
      warnings.push(`Durable realised P/L check failed unexpectedly: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (portfolio) {
      portfolio.realisedPnl = durableRealisedPnl?.realisedPnl ?? null;
    }

    let runtimeSummary: {
      state: string;
      lastRunAt: string | null;
      successfulRunCount: number;
      failedRunCount: number;
    } | null = null;
    let latestDecision: ReturnType<typeof listDecisions>[number] | null = null;
    let recentFailure: ReturnType<typeof latestFailureOrWarning> = null;
    let unreconciledClosures: ReturnType<typeof listUnreconciledClosures> = [];

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

        const decisions = listDecisions(auditLog.events, { limit: 1 });
        latestDecision = decisions[0] ?? null;

        // Deployment safety review — recentFailure scope fix. Scoped to the current run only, so a
        // stale failure from BEFORE the most recent TRADING_RUNTIME_STARTED event (e.g. an old
        // candle-validation error left over from a previous process) never resurfaces as "recent"
        // after a restart. listUnreconciledClosures below is deliberately NOT scoped this way — see
        // its own doc comment on why an unreconciled closure must remain visible across a restart.
        const lastStartIndex = findLastRuntimeStartIndex(auditLog.events);
        recentFailure = latestFailureOrWarning(auditLog.events, { sinceIndex: Math.max(lastStartIndex, 0) });
        if (recentFailure) {
          warnings.push(`Most recent failure (${recentFailure.eventType} at ${recentFailure.timestamp}): ${recentFailure.message}`);
        }

        // Restart-Resilient Autonomy Phase — CLOSED_UNRECONCILED operator visibility (deployment
        // safety review). A position that closed with no confirmed exit price/P&L is exactly the
        // kind of thing this summary must never omit — never folded into `recentFailure` (that field
        // is scoped to a single most-recent event; every unreconciled closure stays visible here).
        unreconciledClosures = listUnreconciledClosures(auditLog.events);
        if (unreconciledClosures.length > 0) {
          warnings.push(
            `${unreconciledClosures.length} position(s) closed with unknown exit price/P&L (CLOSED_UNRECONCILED) — ` +
              `see unreconciledClosures for details.`,
          );
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
        // Runtime Processes panel (Operations Centre). Additive only — both already exist on the
        // same `config` object this route already reads above for runtimeMode/brokerProvider; no
        // new business logic, no new Supabase call. `null` (never a guessed default) whenever
        // config itself failed to load, matching this object's own existing "unknown"/null
        // convention for every other config-derived field here.
        killSwitchEnabled: config?.killSwitchEnabled ?? null,
        schedulerEnabled: config?.scheduler?.enabled ?? null,
        schedulerIntervalMs: config?.scheduler?.intervalMs ?? null,
      },
      runtime: runtimeSummary,
      portfolio,
      openPositionCount,
      latestDecision,
      recentFailure,
      unreconciledClosures,
      warnings,
    });
  });
}
