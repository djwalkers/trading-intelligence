import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { withHermesGuard } from "@/lib/hermes-integration/auth";
import { getMarketDiagnostics, MarketDiagnosticsError } from "@/lib/hermes-execution/market-diagnostics-service";

// Phase 2A.1 — Internal Market Diagnostics UI. GET /api/hermes/market-diagnostics: a read-only,
// bearer-token-gated (withHermesGuard — same guard every other /api/hermes/* route uses) snapshot
// of market-data quality and indicator calculations. Wraps market-diagnostics-service.ts's own
// getMarketDiagnostics() directly — never a second implementation of provider selection, broker
// construction, or indicator computation. Never calls placeMarketOrder/closePosition or any other
// execution method; the underlying service is read-only by construction (see its own doc comment).
//
// This route's response shape ({ ok, diagnostics } / { ok, error }) is deliberately its own,
// simpler contract rather than the shared successEnvelope/errorEnvelope's {ok,data,meta}/
// {ok,error,meta} — a distinct, explicitly-specified shape for this phase's own UI consumer.
// withHermesGuard's own catch-all (the standard {ok,error,meta} shape) only ever fires for a
// genuinely unexpected throw this route's own try/catch below didn't already handle.
//
// Never cached: force-dynamic plus explicit no-store headers, since every response must reflect
// the market data at the moment of the request, never a stale cached one.

export const dynamic = "force-dynamic";

function statusForCode(code: string): number {
  switch (code) {
    case "UNSUPPORTED_BROKER":
    case "BROKER_NOT_CONFIGURED":
      return 503; // misconfiguration — the service isn't set up to serve live data at all
    case "BROKER_CONNECTION_FAILED":
    case "INSTRUMENT_RESOLUTION_FAILED":
    case "CANDLE_FETCH_FAILED":
    case "CANDLE_VALIDATION_FAILED":
      return 502; // an upstream (eToro) call failed or returned unusable data
    default:
      return 500;
  }
}

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

export async function GET(request: NextRequest) {
  return withHermesGuard(request, async () => {
    try {
      const diagnostics = await getMarketDiagnostics();
      return NextResponse.json({ ok: true, diagnostics }, { status: 200, headers: NO_STORE_HEADERS });
    } catch (error) {
      const code = error instanceof MarketDiagnosticsError ? error.code : "DIAGNOSTICS_FAILED";
      // Every MarketDiagnosticsError message is already a safe, hand-written or upstream-error
      // string (EtoroApiError/EtoroTimeoutError never include credentials in .message — see
      // etoro-client.test.ts's own coverage) — never a raw stack trace or the caught error itself.
      const message = error instanceof Error ? error.message : "An unexpected error occurred.";
      return NextResponse.json(
        { ok: false, error: { code, message } },
        { status: statusForCode(code), headers: NO_STORE_HEADERS },
      );
    }
  });
}
