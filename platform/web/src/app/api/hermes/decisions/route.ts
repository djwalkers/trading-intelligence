import type { NextRequest } from "next/server";
import { withHermesGuard } from "@/lib/hermes-integration/auth";
import { successEnvelope, errorEnvelope } from "@/lib/hermes-integration/response-envelope";
import { readHermesRuntimeAuditLog } from "@/lib/hermes-integration/audit-log-reader";
import { listDecisions } from "@/lib/hermes-integration/audit-derivations";
import { parseLimitParam, parseOutcomeParam, parseSinceParam, parseSymbolParam } from "@/lib/hermes-integration/query-validation";

// Hermes Integration API v1 — read-only. GET /api/hermes/decisions: recent trading decisions,
// sourced entirely from the existing MARKET_DECISION_RECEIVED audit events already recorded by
// market-decision-runner.ts — nothing here re-runs or re-derives a decision, only reads and
// reshapes what was already recorded. See audit-derivations.ts's listDecisions() for the full
// field mapping.

export async function GET(request: NextRequest) {
  return withHermesGuard(request, async () => {
    const { searchParams } = request.nextUrl;

    const limitResult = parseLimitParam(searchParams.get("limit"));
    if (!limitResult.ok) return errorEnvelope("INVALID_QUERY_PARAMETER", limitResult.message, 400);

    const outcomeResult = parseOutcomeParam(searchParams.get("outcome"));
    if (!outcomeResult.ok) return errorEnvelope("INVALID_QUERY_PARAMETER", outcomeResult.message, 400);

    const sinceResult = parseSinceParam(searchParams.get("since"));
    if (!sinceResult.ok) return errorEnvelope("INVALID_QUERY_PARAMETER", sinceResult.message, 400);

    const symbol = parseSymbolParam(searchParams.get("symbol"));

    const auditLog = await readHermesRuntimeAuditLog();
    const decisions = listDecisions(auditLog.events, {
      limit: limitResult.value,
      symbol,
      outcome: outcomeResult.value,
      since: sinceResult.value,
    });

    return successEnvelope({
      decisions,
      count: decisions.length,
      filters: {
        limit: limitResult.value,
        symbol: symbol ?? null,
        outcome: outcomeResult.value ?? null,
        since: sinceResult.value ?? null,
      },
      observedFromAuditLog: auditLog.available,
    });
  });
}
