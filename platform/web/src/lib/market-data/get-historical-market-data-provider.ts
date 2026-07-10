import { MockHistoricalMarketDataProvider } from "./mock-historical-market-data-provider";
import { ResilientHistoricalMarketDataProvider } from "./resilient-historical-market-data-provider";

let provider: ResilientHistoricalMarketDataProvider | null = null;

// Client-safe factory — used by the browser (Bot Runner's manual scan, the System Health status
// hook). Always Mock: as of Maintenance 1.11.2, Finnhub's historical candle endpoint is no longer
// selected here (real history now comes from Alpha Vantage, a server-only key that must never
// reach the browser — see get-server-historical-market-data-provider.ts, used only by the VPS
// worker). This is why "primary" is always null here rather than reading any env var — there is
// no historical provider this factory could safely construct client-side. Cached at module scope
// so every caller in the same JS runtime (a browser tab) shares one instance, one status.
export function getHistoricalMarketDataProvider(): ResilientHistoricalMarketDataProvider {
  if (!provider) {
    provider = new ResilientHistoricalMarketDataProvider(null, new MockHistoricalMarketDataProvider(), "Mock");
  }
  return provider;
}
