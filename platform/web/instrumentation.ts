// Hermes Integration API v1. Next.js's standard app-startup hook (stable since Next.js 15, no
// experimental flag needed) — `register()` runs once when the server process boots, in both the
// Node.js and Edge runtime contexts if both exist in a given deployment. Guarded to the Node.js
// runtime only, since the config module below is server-only and (transitively, via auth.ts)
// eventually needs Node's `crypto` module.
//
// This is the one and only startup-time check in this file: if HERMES_INTEGRATION_TOKEN is set but
// blank or too short, crash server startup immediately with a clear error — the same fail-closed
// convention every other config module in this codebase already uses (see
// hermes-execution/config.ts, lib/config/server-config.ts), applied here at true process start
// rather than lazily on a route's first request.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getHermesIntegrationConfig } = await import("@/lib/hermes-integration/config");
    getHermesIntegrationConfig();
  }
}
