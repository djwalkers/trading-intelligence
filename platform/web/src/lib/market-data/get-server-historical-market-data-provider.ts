import "server-only";
import { getServerConfig } from "@/lib/config/server-config";
import { AlphaVantageHistoricalMarketDataProvider } from "./alpha-vantage-historical-market-data-provider";
import { MockHistoricalMarketDataProvider } from "./mock-historical-market-data-provider";
import type { HistoricalMarketDataProvider } from "./historical-market-data-provider";
import { ResilientHistoricalMarketDataProvider } from "./resilient-historical-market-data-provider";

let provider: ResilientHistoricalMarketDataProvider | null = null;

// Purely informational — mirrors isExternalMarketDataConfigured()'s "presence check, not a
// guarantee it works" convention.
export function isAlphaVantageConfigured(): boolean {
  return getServerConfig().isAlphaVantageConfigured;
}

function createAlphaVantageProvider(): HistoricalMarketDataProvider | null {
  const { alphaVantageApiKey } = getServerConfig();
  if (!alphaVantageApiKey) return null;
  return new AlphaVantageHistoricalMarketDataProvider(alphaVantageApiKey);
}

// Maintenance 1.11.2 — the server-only counterpart to get-historical-market-data-provider.ts
// (the client-safe factory the browser uses, Mock-only as of this maintenance). This one is
// never imported by anything the browser bundle can reach: the only caller is
// src/worker/process-schedule.ts, itself only ever run via `npm run worker` (tsx), never bundled
// by Next.js. ALPHA_VANTAGE_API_KEY is deliberately NOT prefixed with NEXT_PUBLIC_, so even if this
// module were somehow reachable client-side, Next.js would never inline the key into browser code
// — but the "server-only" import above turns that scenario into a build-time error instead of
// relying on that alone. Cached at module scope like every other provider singleton in this app —
// one instance, one cache, shared by every scan the worker process runs until it restarts.
export function getServerHistoricalMarketDataProvider(): ResilientHistoricalMarketDataProvider {
  if (!provider) {
    const primary = isAlphaVantageConfigured() ? createAlphaVantageProvider() : null;
    provider = new ResilientHistoricalMarketDataProvider(
      primary,
      new MockHistoricalMarketDataProvider(),
      "Alpha Vantage",
    );
  }
  return provider;
}
