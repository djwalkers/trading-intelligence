export type AssetClass = "equity" | "etf";

export interface Instrument {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  exchange: string;
  currency: "GBP" | "USD";
  price: number;
  changeAbsolute: number;
  changePercent: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
}
