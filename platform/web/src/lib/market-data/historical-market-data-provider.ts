import type { HistoricalFetchResult, OHLCVCandle } from "@/lib/types";

// The historical sibling of MarketDataProvider (live quotes) — batched, not per-symbol, same
// contract shape: one call for the whole watchlist, each returned candle self-identifying via
// `symbol` rather than the caller getting back a map. `days` is how far back to request, not a
// guarantee of how many candles come back (a real provider may return fewer near a listing date,
// weekends, etc.) — callers that need a minimum amount of history check the result length
// themselves (see buildStrategyContextFromHistory).
export interface HistoricalMarketDataProvider {
  getHistoricalCandles(symbols: string[], days: number): Promise<OHLCVCandle[]>;

  // Sprint 290 — the same fetch as getHistoricalCandles, but returning a telemetry object
  // constructed fresh, directly in this specific call's own return statement — never a value read
  // back afterward from any shared, mutable, process-lifetime status. This is what lets a caller
  // (runBotScan) determine data provenance from what genuinely happened during THIS invocation,
  // regardless of which concrete provider it was given and regardless of that provider's history
  // in earlier, unrelated calls. Every implementation (Mock/AlphaVantage/Resilient) must return a
  // freshly-built result here, never a reference to an existing status field.
  getHistoricalCandlesWithTelemetry(symbols: string[], days: number): Promise<HistoricalFetchResult>;

  // Optional — only a provider that actually caches (Maintenance 1.11.2's Alpha Vantage provider)
  // implements this. Minutes since its oldest still-cached symbol was fetched, or null if nothing
  // is cached yet. ResilientHistoricalMarketDataProvider reads it when present; a provider that
  // doesn't implement it (Mock) simply never contributes a cache age to the reported status.
  getCacheAgeMinutes?(): number | null;
}
