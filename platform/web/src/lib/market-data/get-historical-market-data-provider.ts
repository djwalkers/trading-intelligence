import { isExternalMarketDataConfigured } from "./config";
import { ExternalHistoricalMarketDataProvider } from "./external-historical-market-data-provider";
import { MockHistoricalMarketDataProvider } from "./mock-historical-market-data-provider";
import type { HistoricalMarketDataProvider } from "./historical-market-data-provider";
import { ResilientHistoricalMarketDataProvider } from "./resilient-historical-market-data-provider";

let provider: ResilientHistoricalMarketDataProvider | null = null;

function createExternalProvider(): HistoricalMarketDataProvider | null {
  const providerName = process.env.NEXT_PUBLIC_MARKET_DATA_PROVIDER;
  const apiKey = process.env.NEXT_PUBLIC_MARKET_DATA_API_KEY;
  if (!providerName || !apiKey) return null;

  return new ExternalHistoricalMarketDataProvider(providerName, apiKey);
}

// Same configuration and selection rule as getMarketDataProvider() — external is used when
// configured (the same NEXT_PUBLIC_MARKET_DATA_PROVIDER/NEXT_PUBLIC_MARKET_DATA_API_KEY pair, one
// vendor account, a different endpoint), mock is the default and the fallback. Cached at module
// scope so every caller in the same JS runtime (a browser tab, or a worker process) shares one
// instance, one status, one in-flight connection.
export function getHistoricalMarketDataProvider(): ResilientHistoricalMarketDataProvider {
  if (!provider) {
    const providerName = process.env.NEXT_PUBLIC_MARKET_DATA_PROVIDER ?? "External";
    const primary = isExternalMarketDataConfigured() ? createExternalProvider() : null;
    provider = new ResilientHistoricalMarketDataProvider(
      primary,
      new MockHistoricalMarketDataProvider(),
      providerName,
    );
  }
  return provider;
}
