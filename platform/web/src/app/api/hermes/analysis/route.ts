import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { withHermesGuard } from "@/lib/hermes-integration/auth";
import { getServiceRoleClient } from "@/lib/supabase/service-role-client";
import { buildAnalysisPersistenceConfig } from "@/lib/hermes-execution/analysis/analysis-persistence-config";
import { SupabaseAnalysisRepository } from "@/lib/hermes-execution/analysis/analysis-repository";
import type { AnalysisDecision, AnalysisFilter, AnalysisRetentionWindow } from "@/lib/hermes-execution/analysis/types";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. GET /api/hermes/analysis: a
// read-only, bearer-token-gated (withHermesGuard — same guard every other /api/hermes/* route
// uses) view of persisted market_analysis_runs. Uses the service-role client + the same
// HERMES_SUPABASE_USER_ID the trading-runtime writes under (see analysis-persistence-config.ts) —
// this route has no browser session of its own, exactly like every other /api/hermes/* route.
// Read-only: never calls saveAnalysis/saveEvents/markTradeExecuted, only getRecentAnalyses/
// getStrategyPerformance. Never cached: force-dynamic plus explicit no-store headers.

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

const VALID_DECISIONS: readonly AnalysisDecision[] = ["BUY", "SELL", "HOLD", "ERROR"];
const VALID_RETENTION: readonly AnalysisRetentionWindow[] = ["30d", "90d", "365d", "all"];
const MAX_LIMIT = 1000;

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status, headers: NO_STORE_HEADERS });
}

function parseFilter(searchParams: URLSearchParams): AnalysisFilter | { error: string } {
  const filter: AnalysisFilter = {};

  const instrument = searchParams.get("instrument");
  if (instrument) filter.instrument = instrument;

  const strategyId = searchParams.get("strategy");
  if (strategyId) filter.strategyId = strategyId;

  const decision = searchParams.get("decision");
  if (decision) {
    if (!VALID_DECISIONS.includes(decision as AnalysisDecision)) {
      return { error: `"decision" must be one of ${VALID_DECISIONS.join(", ")} — received "${decision}".` };
    }
    filter.decision = decision as AnalysisDecision;
  }

  // "date" — a single convenience param: analyses at or after this date/timestamp. Callers needing
  // an explicit end can still pass "until" directly.
  const date = searchParams.get("date");
  if (date) filter.since = date;
  const since = searchParams.get("since");
  if (since) filter.since = since;
  const until = searchParams.get("until");
  if (until) filter.until = until;

  const retention = searchParams.get("retention");
  if (retention) {
    if (!VALID_RETENTION.includes(retention as AnalysisRetentionWindow)) {
      return { error: `"retention" must be one of ${VALID_RETENTION.join(", ")} — received "${retention}".` };
    }
    filter.retention = retention as AnalysisRetentionWindow;
  }

  const limitRaw = searchParams.get("limit");
  if (limitRaw) {
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit <= 0) {
      return { error: `"limit" must be a positive integer — received "${limitRaw}".` };
    }
    filter.limit = Math.min(limit, MAX_LIMIT);
  }

  return filter;
}

export async function GET(request: NextRequest) {
  return withHermesGuard(request, async () => {
    const persistenceConfig = buildAnalysisPersistenceConfig();
    if (!persistenceConfig.enabled || !persistenceConfig.ownerUserId) {
      return errorResponse(
        "ANALYSIS_PERSISTENCE_NOT_CONFIGURED",
        "Market analysis persistence is not configured (HERMES_SUPABASE_USER_ID / Supabase service role).",
        503,
      );
    }

    const client = getServiceRoleClient();
    if (!client) {
      return errorResponse("ANALYSIS_PERSISTENCE_NOT_CONFIGURED", "The Supabase service role client is not configured.", 503);
    }

    const filter = parseFilter(request.nextUrl.searchParams);
    if ("error" in filter) {
      return errorResponse("INVALID_FILTER", filter.error, 400);
    }

    try {
      const repository = new SupabaseAnalysisRepository(client, persistenceConfig.ownerUserId);
      const analyses = await repository.getRecentAnalyses(filter);
      return NextResponse.json({ ok: true, analyses, count: analyses.length }, { status: 200, headers: NO_STORE_HEADERS });
    } catch (error) {
      const message = error instanceof Error ? error.message : "An unexpected error occurred.";
      return errorResponse("ANALYSIS_FETCH_FAILED", message, 502);
    }
  });
}
