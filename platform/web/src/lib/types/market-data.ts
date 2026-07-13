export type MarketDataSource = "Mock" | "External";

export interface MarketQuote {
  symbol: string;
  price: number;
  changeAbsolute: number;
  changePercent: number;
  lastUpdated: string;
}

// "Connected" — an external provider is configured and the last fetch succeeded.
// "Mocked" — no external provider is configured; mock data is being served by design.
// "Fallback" — an external provider is configured but failed, so mock data is standing in.
export type MarketDataMode = "Connected" | "Mocked" | "Fallback";

export interface MarketDataStatus {
  provider: string;
  source: MarketDataSource;
  mode: MarketDataMode;
  lastUpdated: string | null;
  instrumentsLoaded: number;
  fallbackActive: boolean;
  failureReason: string | null;
}

// Mission 9 — one daily candle for one instrument. The unit the historical market data layer
// deals in, batched the same way MarketQuote is: a flat array, each candle self-identifying via
// `symbol`, not a map — consistent with getQuotes()'s existing "batched, not per-symbol" contract.
export interface OHLCVCandle {
  symbol: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Deliberately the same shape as MarketDataSource/MarketDataMode/MarketDataStatus above — the
// historical layer is a sibling of the live-quote layer, not a different architecture, so its
// status reads the same way in System Health.
export type HistoricalDataSource = "Mock" | "External";
export type HistoricalDataMode = "Connected" | "Mocked" | "Fallback";

export interface HistoricalDataStatus {
  provider: string;
  source: HistoricalDataSource;
  mode: HistoricalDataMode;
  lastUpdated: string | null;
  instrumentsLoaded: number;
  fallbackActive: boolean;
  failureReason: string | null;
  // Maintenance 1.11.2 — minutes since the active provider's oldest cached symbol was fetched, or
  // null when the active provider doesn't cache (Mock) or nothing has been fetched yet.
  cacheAgeMinutes: number | null;
}

// Sprint 290 — a genuinely fresh, per-invocation result returned directly by one specific
// getHistoricalCandlesWithTelemetry() call, never a field read afterward from a provider's shared,
// mutable, process-lifetime HistoricalDataStatus. This is what lets provenance be computed from
// what actually happened during THIS scan's fetch, not from a sticky flag that stays set from an
// earlier, unrelated call. `source`/`usedFallback` describe this call as a whole; the four symbol
// lists exist for a future provider that can report genuinely mixed per-symbol outcomes within one
// call — today's concrete providers (AlphaVantage, Resilient) always report fully-external or
// fully-fallback for a given call, never split, since a single symbol failure aborts the whole
// sequential fetch (see AlphaVantageHistoricalMarketDataProvider.getHistoricalCandles).
export interface HistoricalFetchTelemetry {
  symbolsRequested: string[];
  symbolsServedExternally: string[];
  symbolsServedFromFallback: string[];
  symbolsFailed: string[];
  usedFallback: boolean;
  source: HistoricalDataSource;
  provider: string;
}

export interface HistoricalFetchResult {
  candles: OHLCVCandle[];
  telemetry: HistoricalFetchTelemetry;
}

// The live-quote sibling of HistoricalFetchTelemetry/HistoricalFetchResult above — same rationale,
// returned directly by getQuotesWithTelemetry().
export interface QuoteFetchTelemetry {
  symbolsRequested: string[];
  symbolsServedExternally: string[];
  symbolsServedFromFallback: string[];
  symbolsFailed: string[];
  usedFallback: boolean;
  source: MarketDataSource;
  provider: string;
}

export interface QuoteFetchResult {
  quotes: MarketQuote[];
  telemetry: QuoteFetchTelemetry;
}
