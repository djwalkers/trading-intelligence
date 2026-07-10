import type { OHLCVCandle } from "@/lib/types";

// The historical sibling of MarketDataProvider (live quotes) — batched, not per-symbol, same
// contract shape: one call for the whole watchlist, each returned candle self-identifying via
// `symbol` rather than the caller getting back a map. `days` is how far back to request, not a
// guarantee of how many candles come back (a real provider may return fewer near a listing date,
// weekends, etc.) — callers that need a minimum amount of history check the result length
// themselves (see buildStrategyContextFromHistory).
export interface HistoricalMarketDataProvider {
  getHistoricalCandles(symbols: string[], days: number): Promise<OHLCVCandle[]>;
}
