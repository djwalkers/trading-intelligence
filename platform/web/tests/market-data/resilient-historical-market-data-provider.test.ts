import { describe, expect, it } from "vitest";
import { ResilientHistoricalMarketDataProvider } from "@/lib/market-data/resilient-historical-market-data-provider";
import { MockHistoricalMarketDataProvider } from "@/lib/market-data/mock-historical-market-data-provider";
import type { HistoricalMarketDataProvider } from "@/lib/market-data/historical-market-data-provider";
import type { HistoricalFetchResult, OHLCVCandle } from "@/lib/types";

class FakeHistoricalProvider implements HistoricalMarketDataProvider {
  constructor(private behavior: "success" | "fail") {}

  async getHistoricalCandles(symbols: string[], _days: number): Promise<OHLCVCandle[]> {
    if (this.behavior === "fail") throw new Error("primary provider unavailable");
    return symbols.map((symbol) => ({
      symbol,
      timestamp: "2026-01-01T00:00:00.000Z",
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    }));
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
        provider: "Fake",
      },
    };
  }
}

describe("ResilientHistoricalMarketDataProvider.getHistoricalCandlesWithTelemetry", () => {
  it("returns a neutral, empty result for an empty symbol list without touching the active provider", async () => {
    const provider = new ResilientHistoricalMarketDataProvider(
      new FakeHistoricalProvider("success"),
      new MockHistoricalMarketDataProvider(),
      "Fake",
    );
    const result = await provider.getHistoricalCandlesWithTelemetry([], 90);
    expect(result.candles).toEqual([]);
    expect(result.telemetry.symbolsRequested).toEqual([]);
    expect(result.telemetry.usedFallback).toBe(false);
  });

  it("reports external, non-fallback telemetry when no primary was ever configured is false and the primary succeeds", async () => {
    const provider = new ResilientHistoricalMarketDataProvider(
      new FakeHistoricalProvider("success"),
      new MockHistoricalMarketDataProvider(),
      "Fake",
    );
    const result = await provider.getHistoricalCandlesWithTelemetry(["AAPL"], 90);
    expect(result.telemetry.usedFallback).toBe(false);
    expect(result.telemetry.source).toBe("External");
    expect(result.telemetry.symbolsServedExternally).toEqual(["AAPL"]);
    expect(result.candles).toHaveLength(1);
  });

  it("reports mock, non-fallback telemetry when no primary was ever configured (usingExternal = false)", async () => {
    const provider = new ResilientHistoricalMarketDataProvider(null, new MockHistoricalMarketDataProvider(), "Fake");
    const result = await provider.getHistoricalCandlesWithTelemetry(["AAPL"], 90);
    expect(result.telemetry.usedFallback).toBe(false);
    expect(result.telemetry.source).toBe("Mock");
  });

  it("reports a genuine fallback (usedFallback: true, source: Mock) the instant the primary throws", async () => {
    const provider = new ResilientHistoricalMarketDataProvider(
      new FakeHistoricalProvider("fail"),
      new MockHistoricalMarketDataProvider(),
      "Fake",
    );
    const result = await provider.getHistoricalCandlesWithTelemetry(["AAPL"], 90);
    expect(result.telemetry.usedFallback).toBe(true);
    expect(result.telemetry.source).toBe("Mock");
    expect(result.telemetry.symbolsServedFromFallback).toEqual(["AAPL"]);
  });

  it("keeps reporting usedFallback: true on every call after falling back once — this instance never retries", async () => {
    const provider = new ResilientHistoricalMarketDataProvider(
      new FakeHistoricalProvider("fail"),
      new MockHistoricalMarketDataProvider(),
      "Fake",
    );
    await provider.getHistoricalCandlesWithTelemetry(["AAPL"], 90);
    const second = await provider.getHistoricalCandlesWithTelemetry(["MSFT"], 90);
    expect(second.telemetry.usedFallback).toBe(true);
    expect(second.telemetry.source).toBe("Mock");
  });

  it("does not mutate getStatus()'s existing shape — untouched for existing consumers", async () => {
    const provider = new ResilientHistoricalMarketDataProvider(
      new FakeHistoricalProvider("success"),
      new MockHistoricalMarketDataProvider(),
      "Fake",
    );
    await provider.getHistoricalCandlesWithTelemetry(["AAPL"], 90);
    const status = provider.getStatus();
    expect(status.mode).toBe("Connected");
    expect(status.source).toBe("External");
  });
});

describe("MockHistoricalMarketDataProvider.getHistoricalCandlesWithTelemetry", () => {
  it("always reports usedFallback: false, source: Mock — a raw Mock call is intended behaviour, not a fallback", async () => {
    const provider = new MockHistoricalMarketDataProvider();
    const result = await provider.getHistoricalCandlesWithTelemetry(["AAPL"], 90);
    expect(result.telemetry.usedFallback).toBe(false);
    expect(result.telemetry.source).toBe("Mock");
    expect(result.telemetry.symbolsServedFromFallback).toEqual(["AAPL"]);
    expect(result.candles.length).toBeGreaterThan(0);
  });
});
