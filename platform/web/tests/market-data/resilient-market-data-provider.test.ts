import { describe, expect, it } from "vitest";
import { ResilientMarketDataProvider } from "@/lib/market-data/resilient-market-data-provider";
import { MockMarketDataProvider } from "@/lib/market-data/mock-market-data-provider";
import type { MarketDataProvider } from "@/lib/market-data/market-data-provider";
import type { MarketQuote, QuoteFetchResult } from "@/lib/types";

class FakeQuoteProvider implements MarketDataProvider {
  constructor(private behavior: "success" | "fail") {}

  async getQuotes(symbols: string[]): Promise<MarketQuote[]> {
    if (this.behavior === "fail") throw new Error("primary provider unavailable");
    return symbols.map((symbol) => ({
      symbol,
      price: 100,
      changeAbsolute: 1,
      changePercent: 1,
      lastUpdated: "2026-01-01T00:00:00.000Z",
    }));
  }

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
        source: "External",
        provider: "Fake",
      },
    };
  }
}

describe("ResilientMarketDataProvider.getQuotesWithTelemetry", () => {
  it("returns a neutral, empty result for an empty symbol list", async () => {
    const provider = new ResilientMarketDataProvider(new FakeQuoteProvider("success"), new MockMarketDataProvider(), "Fake");
    const result = await provider.getQuotesWithTelemetry([]);
    expect(result.quotes).toEqual([]);
    expect(result.telemetry.symbolsRequested).toEqual([]);
  });

  it("reports external, non-fallback telemetry when the primary succeeds", async () => {
    const provider = new ResilientMarketDataProvider(new FakeQuoteProvider("success"), new MockMarketDataProvider(), "Fake");
    const result = await provider.getQuotesWithTelemetry(["AAPL"]);
    expect(result.telemetry.usedFallback).toBe(false);
    expect(result.telemetry.source).toBe("External");
    expect(result.quotes).toHaveLength(1);
  });

  it("reports mock, non-fallback telemetry when no primary was ever configured", async () => {
    const provider = new ResilientMarketDataProvider(null, new MockMarketDataProvider(), "Fake");
    const result = await provider.getQuotesWithTelemetry(["AAPL"]);
    expect(result.telemetry.usedFallback).toBe(false);
    expect(result.telemetry.source).toBe("Mock");
  });

  it("reports a genuine fallback the instant the primary throws, and stays fallen back on later calls", async () => {
    const provider = new ResilientMarketDataProvider(new FakeQuoteProvider("fail"), new MockMarketDataProvider(), "Fake");
    const first = await provider.getQuotesWithTelemetry(["AAPL"]);
    expect(first.telemetry.usedFallback).toBe(true);
    expect(first.telemetry.source).toBe("Mock");

    const second = await provider.getQuotesWithTelemetry(["MSFT"]);
    expect(second.telemetry.usedFallback).toBe(true);
    expect(second.telemetry.source).toBe("Mock");
  });
});

describe("MockMarketDataProvider.getQuotesWithTelemetry", () => {
  it("always reports usedFallback: false, source: Mock", async () => {
    const provider = new MockMarketDataProvider();
    const result = await provider.getQuotesWithTelemetry(["AAPL"]);
    expect(result.telemetry.usedFallback).toBe(false);
    expect(result.telemetry.source).toBe("Mock");
    expect(result.quotes.length).toBeGreaterThan(0);
  });
});
