"use server";

import { getMarketDiagnostics, MarketDiagnosticsError, type MarketDiagnosticsResult } from "@/lib/hermes-execution/market-diagnostics-service";

// Phase 2A.1 — Internal Market Diagnostics UI. A Next.js Server Action, not a client-callable REST
// endpoint: the page's own "Refresh" button and 60s auto-refresh both call this directly from the
// client component, but the function itself only ever runs on the server. This is deliberately
// NOT wired through GET /api/hermes/market-diagnostics (that route's bearer-token auth is meant for
// an external caller — the Hermes Agent, a curl check from the VPS — and the HERMES_INTEGRATION_
// TOKEN it requires must never reach the browser). This action calls the exact same
// getMarketDiagnostics() service that route also calls, so there is still only one implementation
// of provider selection / broker construction / indicator computation — just two different,
// independently-authenticated ways to reach it (the app's own session auth, already enforced by
// AuthGate around every page including this one, is this action's only gate; it needs no
// additional token of its own).

export type MarketDiagnosticsFetchResult =
  | { ok: true; diagnostics: MarketDiagnosticsResult }
  | { ok: false; error: { code: string; message: string } };

export async function fetchMarketDiagnostics(): Promise<MarketDiagnosticsFetchResult> {
  try {
    const diagnostics = await getMarketDiagnostics();
    return { ok: true, diagnostics };
  } catch (error) {
    if (error instanceof MarketDiagnosticsError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    return {
      ok: false,
      error: { code: "UNKNOWN_ERROR", message: error instanceof Error ? error.message : "An unexpected error occurred." },
    };
  }
}
