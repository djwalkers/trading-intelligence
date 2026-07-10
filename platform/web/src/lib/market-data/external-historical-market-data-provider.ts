import type { OHLCVCandle } from "@/lib/types";
import type { HistoricalMarketDataProvider } from "./historical-market-data-provider";

interface FinnhubCandleResponse {
  s: string; // "ok" | "no_data"
  c: number[];
  o: number[];
  h: number[];
  l: number[];
  v: number[];
  t: number[]; // unix seconds
}

const SECONDS_PER_DAY = 24 * 60 * 60;

// The historical sibling of ExternalMarketDataProvider — calls Finnhub's daily candle endpoint
// (https://finnhub.io/docs/api/stock-candles), reusing the same NEXT_PUBLIC_MARKET_DATA_PROVIDER/
// NEXT_PUBLIC_MARKET_DATA_API_KEY configuration as live quotes (same vendor account, a different
// endpoint) rather than introducing a second pair of env vars. Never instantiated unless both are
// set; if the endpoint fails or isn't available on the configured plan,
// ResilientHistoricalMarketDataProvider falls back to mock candles the same way its live-quote
// counterpart already does.
export class ExternalHistoricalMarketDataProvider implements HistoricalMarketDataProvider {
  constructor(
    public readonly providerName: string,
    private readonly apiKey: string,
  ) {}

  async getHistoricalCandles(symbols: string[], days: number): Promise<OHLCVCandle[]> {
    const results = await Promise.all(symbols.map((symbol) => this.getCandles(symbol, days)));
    return results.flat();
  }

  private async getCandles(symbol: string, days: number): Promise<OHLCVCandle[]> {
    const to = Math.floor(Date.now() / 1000);
    const from = to - days * SECONDS_PER_DAY;
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(this.apiKey)}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Historical market data request failed for ${symbol}: HTTP ${response.status}`);
    }

    const data = (await response.json()) as FinnhubCandleResponse;
    if (!data || data.s !== "ok" || !Array.isArray(data.c) || data.c.length === 0) {
      throw new Error(`Historical market data provider returned no candles for ${symbol}`);
    }

    const candles: OHLCVCandle[] = [];
    for (let i = 0; i < data.c.length; i++) {
      const close = data.c[i];
      const open = data.o[i];
      const high = data.h[i];
      const low = data.l[i];
      const volume = data.v[i];
      const unixSeconds = data.t[i];

      // Every one of these arrays should be the same length per Finnhub's contract — handled
      // explicitly rather than asserted, consistent with this codebase's "structurally
      // unreachable but still checked" convention (see bot-runner.ts).
      if (
        close === undefined ||
        open === undefined ||
        high === undefined ||
        low === undefined ||
        volume === undefined ||
        unixSeconds === undefined
      ) {
        continue;
      }

      candles.push({
        symbol,
        timestamp: new Date(unixSeconds * 1000).toISOString(),
        open,
        high,
        low,
        close,
        volume,
      });
    }

    return candles;
  }
}
