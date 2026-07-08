import { isExternalMarketDataConfigured } from "./config";
import { ExternalMarketDataProvider } from "./external-market-data-provider";
import { MockMarketDataProvider } from "./mock-market-data-provider";
import type { MarketDataProvider } from "./market-data-provider";
import { ResilientMarketDataProvider } from "./resilient-market-data-provider";

let provider: ResilientMarketDataProvider | null = null;

function createExternalProvider(): MarketDataProvider | null {
  const providerName = process.env.NEXT_PUBLIC_MARKET_DATA_PROVIDER;
  const apiKey = process.env.NEXT_PUBLIC_MARKET_DATA_API_KEY;
  if (!providerName || !apiKey) return null;

  return new ExternalMarketDataProvider(providerName, apiKey);
}

// External is used when configured; mock is the fallback, and becomes the only source for the
// rest of the session if the external provider fails (see ResilientMarketDataProvider). Cached at
// module scope so every hook/component shares one instance, one status, and one in-flight
// connection rather than each caller creating its own.
export function getMarketDataProvider(): ResilientMarketDataProvider {
  if (!provider) {
    const providerName = process.env.NEXT_PUBLIC_MARKET_DATA_PROVIDER ?? "External";
    const primary = isExternalMarketDataConfigured() ? createExternalProvider() : null;
    provider = new ResilientMarketDataProvider(primary, new MockMarketDataProvider(), providerName);
  }
  return provider;
}
