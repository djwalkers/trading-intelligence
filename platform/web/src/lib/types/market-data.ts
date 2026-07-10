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
}
