import { describe, expect, it, vi } from "vitest";
import { getInstrumentBySymbol } from "@/lib/mock/instruments";
import { MockHistoricalMarketDataProvider } from "@/lib/market-data/mock-historical-market-data-provider";
import { ResilientHistoricalMarketDataProvider } from "@/lib/market-data/resilient-historical-market-data-provider";
import type { HistoricalMarketDataProvider } from "@/lib/market-data/historical-market-data-provider";
import type {
  HistoricalFetchResult,
  MarketDataStatus,
  MarketQuote,
  OHLCVCandle,
  PaperTrade,
  QuoteFetchResult,
} from "@/lib/types";

// Sprint 290 — objective 9's own verification wording: "scheduled worker scans are marked
// verified_external_data" and "fallback scans are marked fallback_sample_data." These integration
// tests exercise runBotScan itself (not just combineDataSourceResults in isolation) to prove the
// wiring genuinely reaches BotDecision.dataProvenance end to end.

const FAKE_QUOTE_STATUS: MarketDataStatus = {
  provider: "Fake External Quotes",
  source: "External",
  mode: "Connected",
  lastUpdated: null,
  instrumentsLoaded: 0,
  fallbackActive: false,
  failureReason: null,
};

vi.mock("@/lib/market-data/get-market-data-provider", () => {
  const fakeMarketDataProvider = {
    async getQuotes(symbols: string[]): Promise<MarketQuote[]> {
      return symbols.map((symbol) => ({
        symbol,
        price: 100,
        changeAbsolute: 1,
        changePercent: 1,
        lastUpdated: "2026-01-01T00:00:00.000Z",
      }));
    },
    async getQuotesWithTelemetry(symbols: string[]): Promise<QuoteFetchResult> {
      const quotes = await this.getQuotes(symbols);
      return {
        quotes,
        telemetry: {
          symbolsRequested: symbols,
          symbolsServedExternally: symbols,
          symbolsServedFromFallback: [],
          symbolsFailed: [],
          usedFallback: false,
          source: "External" as const,
          provider: "Fake External Quotes",
        },
      };
    },
    getStatus: () => FAKE_QUOTE_STATUS,
  };
  return { getMarketDataProvider: () => fakeMarketDataProvider };
});

class AllExternalHistoricalProvider implements HistoricalMarketDataProvider {
  async getHistoricalCandles(symbols: string[], days: number): Promise<OHLCVCandle[]> {
    return new MockHistoricalMarketDataProvider().getHistoricalCandles(symbols, days);
  }

  async getHistoricalCandlesWithTelemetry(symbols: string[], days: number): Promise<HistoricalFetchResult> {
    const candles = await this.getHistoricalCandles(symbols, days);
    return {
      candles,
      telemetry: {
        symbolsRequested: symbols,
        symbolsServedExternally: symbols,
        symbolsServedFromFallback: [],
        symbolsFailed: [],
        usedFallback: false,
        source: "External",
        provider: "Fake External Historical",
      },
    };
  }
}

class AlwaysFailingHistoricalProvider implements HistoricalMarketDataProvider {
  async getHistoricalCandles(_symbols: string[], _days: number): Promise<OHLCVCandle[]> {
    throw new Error("Alpha Vantage unavailable");
  }

  async getHistoricalCandlesWithTelemetry(_symbols: string[], _days: number): Promise<HistoricalFetchResult> {
    throw new Error("Alpha Vantage unavailable");
  }
}

const instruments = ["AAPL", "MSFT", "TSLA", "NVDA", "SPY"].map((symbol) => {
  const instrument = getInstrumentBySymbol(symbol);
  if (!instrument) throw new Error(`Missing fixture instrument: ${symbol}`);
  return instrument;
});

describe("runBotScan — dataProvenance end to end", () => {
  it("marks a scan verified_external_data when every data touchpoint was external", async () => {
    const { runBotScan } = await import("@/lib/bot/bot-runner");
    const trades: PaperTrade[] = [];
    const result = await runBotScan(
      instruments,
      trades,
      "SCAN-TEST-001",
      "Scheduled",
      new AllExternalHistoricalProvider(),
    );
    expect(result.decision.dataProvenance).toBe("verified_external_data");
  });

  it("marks a scan fallback_sample_data when the historical provider falls back to sample data", async () => {
    const { runBotScan } = await import("@/lib/bot/bot-runner");
    const trades: PaperTrade[] = [];
    const fallbackProvider = new ResilientHistoricalMarketDataProvider(
      new AlwaysFailingHistoricalProvider(),
      new MockHistoricalMarketDataProvider(),
      "Alpha Vantage",
    );
    const result = await runBotScan(instruments, trades, "SCAN-TEST-002", "Scheduled", fallbackProvider);
    expect(result.decision.dataProvenance).toBe("fallback_sample_data");
  });
});
