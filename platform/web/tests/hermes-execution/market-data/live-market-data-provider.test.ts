import { describe, expect, it, vi } from "vitest";
import {
  LiveMarketDataProvider,
  type CandleHistorySource,
  type RateSource,
} from "@/lib/hermes-execution/market-data/live-market-data-provider";
import { MarketDataProviderError } from "@/lib/hermes-execution/market-data/market-data-provider";
import type { Candle } from "@/lib/hermes-execution/types";
import { logger } from "@/lib/logger/logger";

const HOUR_MS = 3_600_000;

/** A deterministic, valid 60-candle hourly history ending at `endTimestamp` (defaults to now) —
 * satisfies validateHistoricalCandles' own MIN_REQUIRED_CANDLES floor (50) with headroom. */
function makeCandles(options: { count?: number; endTimestamp?: Date; basePrice?: number } = {}): Candle[] {
  const count = options.count ?? 60;
  const end = options.endTimestamp ?? new Date();
  const basePrice = options.basePrice ?? 100;
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const timestamp = new Date(end.getTime() - (count - 1 - i) * HOUR_MS).toISOString();
    const price = basePrice + i * 0.01;
    candles.push({ symbol: "BTC", timestamp, open: price, high: price + 0.5, low: price - 0.5, close: price, volume: 100 });
  }
  return candles;
}

function stubSource(overrides: {
  rate?: { bid: number; ask: number };
  rateError?: unknown;
  candles?: Candle[];
  candlesError?: unknown;
}): RateSource & CandleHistorySource {
  return {
    getRate: async () => {
      if (overrides.rateError !== undefined) throw overrides.rateError;
      return overrides.rate ?? { bid: 100, ask: 100.1 };
    },
    getHistoricalCandles: async () => {
      if (overrides.candlesError !== undefined) throw overrides.candlesError;
      return overrides.candles ?? makeCandles();
    },
  };
}

describe("LiveMarketDataProvider — successful fetch", () => {
  it("returns a snapshot built from the rate source's real bid/ask and the candle source's real history", async () => {
    const candles = makeCandles({ basePrice: 199 });
    const provider = new LiveMarketDataProvider(stubSource({ rate: { bid: 199.5, ask: 200.5 }, candles }));
    const snapshot = await provider.getMarketData("BTC");

    expect(snapshot.instrument).toBe("BTC");
    expect(snapshot.bid).toBe(199.5);
    expect(snapshot.ask).toBe(200.5);
    expect(snapshot.spread).toBeCloseTo(1, 10);
    expect(snapshot.latestPrice).toBeCloseTo(200, 10); // from getRate's mid, never the candle close
    expect(snapshot.candles).toHaveLength(candles.length);
    expect(snapshot.volume).toBe(candles[candles.length - 1]!.volume);
  });

  it("sorts candles chronologically regardless of the order the source returned them in", async () => {
    const chronological = makeCandles();
    const shuffled = [...chronological].reverse();
    const provider = new LiveMarketDataProvider(stubSource({ candles: shuffled }));
    const snapshot = await provider.getMarketData("BTC");

    const timestamps = snapshot.candles.map((c) => c.timestamp);
    expect(timestamps).toEqual([...timestamps].sort());
  });

  it("produces a fresh snapshot timestamp on every call, not a cached one", async () => {
    const provider = new LiveMarketDataProvider(stubSource({}));
    const first = await provider.getMarketData("BTC");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await provider.getMarketData("BTC");
    expect(second.timestamp).not.toBe(first.timestamp);
  });

  it("passes the configured timeframe/candleCount through to the candle source", async () => {
    const getHistoricalCandles = vi.fn().mockResolvedValue(makeCandles());
    const source: RateSource & CandleHistorySource = {
      getRate: async () => ({ bid: 100, ask: 100.1 }),
      getHistoricalCandles,
    };
    const provider = new LiveMarketDataProvider(source, { timeframe: "4h", candleCount: 75 });
    await provider.getMarketData("ETH");

    expect(getHistoricalCandles).toHaveBeenCalledWith("ETH", "4h", 75);
  });
});

describe("LiveMarketDataProvider — rate-source failure (no fallback)", () => {
  it("wraps a rate-source rejection in a MarketDataProviderError with reason 'fetch-failed'", async () => {
    const provider = new LiveMarketDataProvider(stubSource({ rateError: new Error("connection reset") }));
    await expect(provider.getMarketData("BTC")).rejects.toMatchObject({
      name: "MarketDataProviderError",
      reason: "fetch-failed",
    });
  });

  it("never calls getHistoricalCandles once getRate has already failed", async () => {
    const getHistoricalCandles = vi.fn();
    const source: RateSource & CandleHistorySource = {
      getRate: async () => {
        throw new Error("down");
      },
      getHistoricalCandles,
    };
    const provider = new LiveMarketDataProvider(source);
    await expect(provider.getMarketData("BTC")).rejects.toThrow();
    expect(getHistoricalCandles).not.toHaveBeenCalled();
  });

  it("rejects an inverted rate (ask below bid) without ever touching the candle source", async () => {
    const getHistoricalCandles = vi.fn();
    const source: RateSource & CandleHistorySource = {
      getRate: async () => ({ bid: 105, ask: 100 }),
      getHistoricalCandles,
    };
    const provider = new LiveMarketDataProvider(source);
    await expect(provider.getMarketData("BTC")).rejects.toThrow(/inverted rate/);
    expect(getHistoricalCandles).not.toHaveBeenCalled();
  });
});

describe("LiveMarketDataProvider — candle-source failure and validation (no fallback)", () => {
  it("wraps a candle-source rejection in a MarketDataProviderError with reason 'fetch-failed'", async () => {
    const provider = new LiveMarketDataProvider(stubSource({ candlesError: new Error("timeout") }));
    await expect(provider.getMarketData("BTC")).rejects.toMatchObject({
      name: "MarketDataProviderError",
      reason: "fetch-failed",
    });
  });

  it("rejects insufficient candles rather than proceeding with a short history", async () => {
    const provider = new LiveMarketDataProvider(stubSource({ candles: makeCandles({ count: 10 }) }));
    await expect(provider.getMarketData("BTC")).rejects.toMatchObject({
      name: "MarketDataProviderError",
      reason: "malformed-data",
    });
  });

  it("rejects stale candles (latest candle older than maxCandleAgeSeconds)", async () => {
    const staleEnd = new Date(Date.now() - 10 * HOUR_MS);
    const provider = new LiveMarketDataProvider(stubSource({ candles: makeCandles({ endTimestamp: staleEnd }) }), {
      maxCandleAgeSeconds: 3_600,
    });
    await expect(provider.getMarketData("BTC")).rejects.toMatchObject({ reason: "malformed-data" });
  });

  it("never falls back to a synthetic/mock candle series on any failure — it always throws", async () => {
    const provider = new LiveMarketDataProvider(stubSource({ candlesError: new Error("boom") }));
    await expect(provider.getMarketData("BTC")).rejects.toBeInstanceOf(MarketDataProviderError);
  });
});

describe("LiveMarketDataProvider — structured logging", () => {
  it("logs provider, instrument, timeframe, candleCount, first/lastTimestamp, latestClosedPrice, and brokerMidPrice on success", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const candles = makeCandles({ count: 60 });
      const provider = new LiveMarketDataProvider(stubSource({ rate: { bid: 99, ask: 101 }, candles }), {
        timeframe: "1h",
      });
      await provider.getMarketData("BTC");

      const sorted = [...candles].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      expect(infoSpy).toHaveBeenCalledWith(
        "Live market data quote fetched",
        expect.objectContaining({
          component: "market-data",
          provider: "live",
          instrument: "BTC",
          timeframe: "1h",
          candleCount: 60,
          firstTimestamp: sorted[0]!.timestamp,
          lastTimestamp: sorted[sorted.length - 1]!.timestamp,
          latestClosedPrice: sorted[sorted.length - 1]!.close,
          brokerMidPrice: 100,
          fallbackOccurred: false,
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("never logs the raw rate object, credentials, or headers", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const provider = new LiveMarketDataProvider(stubSource({}));
      await provider.getMarketData("BTC");

      const [, context] = infoSpy.mock.calls[0]!;
      expect(context).not.toHaveProperty("apiKey");
      expect(context).not.toHaveProperty("userKey");
      expect(context).not.toHaveProperty("headers");
      expect(context).not.toHaveProperty("rate");
      expect(context).not.toHaveProperty("candles");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("logs an error with fallbackOccurred:false when the candle fetch fails, and still throws", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      const provider = new LiveMarketDataProvider(stubSource({ candlesError: new Error("connection reset") }));
      await expect(provider.getMarketData("BTC")).rejects.toThrow(MarketDataProviderError);

      expect(errorSpy).toHaveBeenCalledWith(
        "Live historical candle fetch failed — no fallback attempted",
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

  it("logs an error with fallbackOccurred:false when candle validation fails, and still throws", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      const provider = new LiveMarketDataProvider(stubSource({ candles: makeCandles({ count: 5 }) }));
      await expect(provider.getMarketData("BTC")).rejects.toThrow(MarketDataProviderError);

      expect(errorSpy).toHaveBeenCalledWith(
        "Live historical candle validation failed — no fallback attempted",
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
