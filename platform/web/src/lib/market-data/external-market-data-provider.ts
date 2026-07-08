import type { MarketQuote } from "@/lib/types";
import type { MarketDataProvider } from "./market-data-provider";

interface FinnhubQuoteResponse {
  c: number; // current price
  d: number | null; // change
  dp: number | null; // percent change
  t: number; // unix seconds
}

// A real HTTP implementation, not a stub — calls Finnhub's quote endpoint
// (https://finnhub.io/docs/api/quote), chosen as the first concrete adapter because it has a
// genuinely free tier and the simplest possible contract of the major quote APIs. Swapping
// vendors later means adding a branch in get-market-data-provider.ts and a sibling class here,
// not touching the interface or any UI. Never instantiated unless both
// NEXT_PUBLIC_MARKET_DATA_PROVIDER and NEXT_PUBLIC_MARKET_DATA_API_KEY are set.
export class ExternalMarketDataProvider implements MarketDataProvider {
  constructor(
    public readonly providerName: string,
    private readonly apiKey: string,
  ) {}

  async getQuotes(symbols: string[]): Promise<MarketQuote[]> {
    return Promise.all(symbols.map((symbol) => this.getQuote(symbol)));
  }

  private async getQuote(symbol: string): Promise<MarketQuote> {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(this.apiKey)}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Market data request failed for ${symbol}: HTTP ${response.status}`);
    }

    const data = (await response.json()) as FinnhubQuoteResponse;
    if (!data || typeof data.c !== "number" || data.c === 0) {
      throw new Error(`Market data provider returned no quote for ${symbol}`);
    }

    return {
      symbol,
      price: data.c,
      changeAbsolute: data.d ?? 0,
      changePercent: data.dp ?? 0,
      lastUpdated: new Date(data.t * 1000).toISOString(),
    };
  }
}
