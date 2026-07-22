import { describe, expect, it, vi } from "vitest";
import { LiveMarketDataProvider, type RateSource } from "@/lib/hermes-execution/market-data/live-market-data-provider";
import { MarketDataProviderError } from "@/lib/hermes-execution/market-data/market-data-provider";
import { logger } from "@/lib/logger/logger";

function stubRateSource(rate: { bid: number; ask: number }): RateSource {
  return { getRate: async () => rate };
}

function failingRateSource(error: unknown): RateSource {
  return {
    getRate: async () => {
      throw error;
    },
  };
}

describe("LiveMarketDataProvider — successful initialisation", () => {
  it("returns a snapshot built from the rate source's real bid/ask", async () => {
    const provider = new LiveMarketDataProvider(stubRateSource({ bid: 99.5, ask: 100.5 }));
    const snapshot = await provider.getMarketData("BTC");

    expect(snapshot.instrument).toBe("BTC");
    expect(snapshot.bid).toBe(99.5);
    expect(snapshot.ask).toBe(100.5);
    expect(snapshot.spread).toBeCloseTo(1, 10);
    expect(snapshot.latestPrice).toBeCloseTo(100, 10);
  });

  it("anchors the generated candle history's final close near the live mid-price", async () => {
    const provider = new LiveMarketDataProvider(stubRateSource({ bid: 199, ask: 201 }), { candleCount: 10 });
    const snapshot = await provider.getMarketData("ETH");

    expect(snapshot.candles).toHaveLength(10);
    expect(snapshot.candles[0]!.open).toBeCloseTo(200, 6);
    expect(snapshot.volume).toBe(snapshot.candles[snapshot.candles.length - 1]!.volume);
  });

  it("produces a fresh snapshot with a new timestamp on every call, not a cached one", async () => {
    const provider = new LiveMarketDataProvider(stubRateSource({ bid: 100, ask: 100.1 }));
    const first = await provider.getMarketData("BTC");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await provider.getMarketData("BTC");
    expect(second.timestamp).not.toBe(first.timestamp);
  });
});

describe("LiveMarketDataProvider — provider failure", () => {
  it("wraps a rate-source rejection in a MarketDataProviderError with reason 'fetch-failed'", async () => {
    const provider = new LiveMarketDataProvider(failingRateSource(new Error("connection reset")));

    await expect(provider.getMarketData("BTC")).rejects.toMatchObject({
      name: "MarketDataProviderError",
      reason: "fetch-failed",
    });
  });

  it("preserves the original error as `cause`", async () => {
    const original = new Error("timeout");
    const provider = new LiveMarketDataProvider(failingRateSource(original));

    try {
      await provider.getMarketData("BTC");
      expect.unreachable("expected getMarketData to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(MarketDataProviderError);
      expect((error as MarketDataProviderError).cause).toBe(original);
    }
  });
});

describe("LiveMarketDataProvider — malformed data handling", () => {
  it("rejects a non-finite bid", async () => {
    const provider = new LiveMarketDataProvider(stubRateSource({ bid: Number.NaN, ask: 100 }));
    await expect(provider.getMarketData("BTC")).rejects.toMatchObject({ reason: "malformed-data" });
  });

  it("rejects a zero or negative ask", async () => {
    const provider = new LiveMarketDataProvider(stubRateSource({ bid: 10, ask: 0 }));
    await expect(provider.getMarketData("BTC")).rejects.toMatchObject({ reason: "malformed-data" });
  });

  it("rejects an inverted rate (ask below bid)", async () => {
    const provider = new LiveMarketDataProvider(stubRateSource({ bid: 105, ask: 100 }));
    await expect(provider.getMarketData("BTC")).rejects.toThrow(/inverted rate/);
  });
});

describe("LiveMarketDataProvider — structured quote-fetch logging", () => {
  it("logs provider, instrument, quote timestamp, latest price, and candle count on a successful fetch", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const provider = new LiveMarketDataProvider(stubRateSource({ bid: 99, ask: 101 }), { candleCount: 12 });
      const snapshot = await provider.getMarketData("BTC");

      expect(infoSpy).toHaveBeenCalledWith(
        "Live market data quote fetched",
        expect.objectContaining({
          component: "market-data",
          provider: "live",
          instrument: "BTC",
          quoteTimestamp: snapshot.timestamp,
          latestPrice: snapshot.latestPrice,
          candleCount: 12,
          fallbackOccurred: false,
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("never logs the raw bid/ask rate object, credentials, or headers", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const provider = new LiveMarketDataProvider(stubRateSource({ bid: 99, ask: 101 }));
      await provider.getMarketData("BTC");

      const [, context] = infoSpy.mock.calls[0]!;
      expect(context).not.toHaveProperty("apiKey");
      expect(context).not.toHaveProperty("userKey");
      expect(context).not.toHaveProperty("headers");
      expect(context).not.toHaveProperty("rate");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("logs an error with fallbackOccurred:false when the fetch fails, and still throws — never substitutes a value", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      const provider = new LiveMarketDataProvider(failingRateSource(new Error("connection reset")));
      await expect(provider.getMarketData("BTC")).rejects.toThrow(MarketDataProviderError);

      expect(errorSpy).toHaveBeenCalledWith(
        "Live market data quote fetch failed — no fallback attempted",
        expect.objectContaining({
          component: "market-data",
          provider: "live",
          instrument: "BTC",
          fallbackOccurred: false,
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
