import type { MarketQuote, QuoteFetchResult } from "@/lib/types";

// The one seam every price in the app is meant to go through — components never read a price
// directly off mock instrument data or hardcode one. Batched, not per-symbol, so a real HTTP
// provider can fetch the whole watchlist in one round trip instead of one request per instrument.
export interface MarketDataProvider {
  getQuotes(symbols: string[]): Promise<MarketQuote[]>;

  // Sprint 290 — the live-quote sibling of HistoricalMarketDataProvider.
  // getHistoricalCandlesWithTelemetry: a telemetry object constructed fresh, directly in this
  // specific call's own return statement, never a value read back afterward from any shared,
  // mutable, process-lifetime status.
  getQuotesWithTelemetry(symbols: string[]): Promise<QuoteFetchResult>;
}
