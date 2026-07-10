import { getClientConfig } from "@/lib/config/client-config";
import { ExternalMarketDataProvider } from "./external-market-data-provider";
import { MockMarketDataProvider } from "./mock-market-data-provider";
import type { MarketDataProvider } from "./market-data-provider";
import { ResilientMarketDataProvider } from "./resilient-market-data-provider";

let provider: ResilientMarketDataProvider | null = null;

function createExternalProvider(): MarketDataProvider | null {
  const { marketDataProviderName, marketDataApiKey } = getClientConfig();
  if (!marketDataProviderName || !marketDataApiKey) return null;

  return new ExternalMarketDataProvider(marketDataProviderName, marketDataApiKey);
}

// External is used when configured; mock is the fallback, and becomes the only source for the
// rest of the session if the external provider fails (see ResilientMarketDataProvider). Cached at
// module scope so every hook/component shares one instance, one status, and one in-flight
// connection rather than each caller creating its own.
export function getMarketDataProvider(): ResilientMarketDataProvider {
  if (!provider) {
    const config = getClientConfig();
    const providerName = config.marketDataProviderName ?? "External";
    const primary = config.isExternalMarketDataConfigured ? createExternalProvider() : null;
    provider = new ResilientMarketDataProvider(primary, new MockMarketDataProvider(), providerName);
  }
  return provider;
}
