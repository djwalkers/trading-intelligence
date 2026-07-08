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
