import type { OHLCVCandle } from "@/lib/types";

// The historical sibling of MarketDataProvider (live quotes) — batched, not per-symbol, same
// contract shape: one call for the whole watchlist, each returned candle self-identifying via
// `symbol` rather than the caller getting back a map. `days` is how far back to request, not a
// guarantee of how many candles come back (a real provider may return fewer near a listing date,
// weekends, etc.) — callers that need a minimum amount of history check the result length
// themselves (see buildStrategyContextFromHistory).
export interface HistoricalMarketDataProvider {
  getHistoricalCandles(symbols: string[], days: number): Promise<OHLCVCandle[]>;

  // Optional — only a provider that actually caches (Maintenance 1.11.2's Alpha Vantage provider)
  // implements this. Minutes since its oldest still-cached symbol was fetched, or null if nothing
  // is cached yet. ResilientHistoricalMarketDataProvider reads it when present; a provider that
  // doesn't implement it (Mock) simply never contributes a cache age to the reported status.
  getCacheAgeMinutes?(): number | null;
}
