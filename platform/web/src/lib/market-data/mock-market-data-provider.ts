import { getInstrumentBySymbol } from "@/lib/mock/instruments";
import type { MarketQuote, QuoteFetchResult } from "@/lib/types";
import type { MarketDataProvider } from "./market-data-provider";

// Fixed per-instrument drift, carried over from the Build 0.5.0 paper-trade P/L mock (previously
// duplicated as MOCK_PRICE_DRIFT_PERCENT in lib/utils/paper-trade.ts). Promoted here so Watchlist,
// Portfolio valuation, and paper trade P/L all read the same "current" mock price instead of each
// page computing its own — deliberately not a live feed, just a believable non-zero mock move.
const MOCK_PRICE_DRIFT_PERCENT: Record<string, number> = {
  AAPL: 0.6,
  MSFT: 1.1,
  TSLA: -2.4,
  NVDA: 2.8,
  SPY: 0.3,
};

export class MockMarketDataProvider implements MarketDataProvider {
  async getQuotes(symbols: string[]): Promise<MarketQuote[]> {
    const lastUpdated = new Date().toISOString();

    return symbols.flatMap((symbol) => {
      const instrument = getInstrumentBySymbol(symbol);
      if (!instrument) return [];

      const driftPercent = MOCK_PRICE_DRIFT_PERCENT[symbol] ?? 0;
      const price = Math.round(instrument.price * (1 + driftPercent / 100) * 100) / 100;

      // Re-derive change vs. an implied previous close, so displayed price/change/percent always
      // agree with each other even though `price` includes the mock drift on top of the
      // instrument's originally authored daily change.
      const previousClose = instrument.price - instrument.changeAbsolute;
      const changeAbsolute = Math.round((price - previousClose) * 100) / 100;
      const changePercent =
        previousClose === 0 ? 0 : Math.round((changeAbsolute / previousClose) * 10000) / 100;

      const quote: MarketQuote = { symbol, price, changeAbsolute, changePercent, lastUpdated };
      return [quote];
    });
  }

  // A raw Mock provider called directly (never wrapped by Resilient) has no concept of "standing
  // in for a failure" — that concept belongs only to the Resilient wrapper, which is the only
  // caller that ever falls back to this provider.
  async getQuotesWithTelemetry(symbols: string[]): Promise<QuoteFetchResult> {
    const quotes = await this.getQuotes(symbols);
    return {
      quotes,
      telemetry: {
        symbolsRequested: symbols,
        symbolsServedExternally: [],
        symbolsServedFromFallback: symbols,
        symbolsFailed: [],
        usedFallback: false,
        source: "Mock",
        provider: "Sample data",
      },
    };
  }
}
