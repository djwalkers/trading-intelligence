import { describe, expect, it, vi } from "vitest";
import { MockMarketDataProvider } from "@/lib/hermes-execution/market-data/mock-market-data-provider";
import { logger } from "@/lib/logger/logger";

const NOW = new Date("2026-01-01T12:00:00Z");

describe("MockMarketDataProvider — deterministic behaviour", () => {
  it("returns byte-for-byte identical snapshots across repeated calls given the same seed and now", async () => {
    const provider = new MockMarketDataProvider({ bias: "bullish", seed: 7, now: NOW });
    const first = await provider.getMarketData("BTC");
    const second = await provider.getMarketData("BTC");
    expect(second).toEqual(first);
  });

  it("returns identical snapshots across two separate provider instances given the same options", async () => {
    const a = await new MockMarketDataProvider({ bias: "sideways", seed: 99, now: NOW }).getMarketData("ETH");
    const b = await new MockMarketDataProvider({ bias: "sideways", seed: 99, now: NOW }).getMarketData("ETH");
    expect(b).toEqual(a);
  });

  it("without an explicit `now`, defaults to the real current time (so timestamps drift call to call)", async () => {
    const provider = new MockMarketDataProvider({ seed: 7 });
    const first = await provider.getMarketData("BTC");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await provider.getMarketData("BTC");
    expect(second.timestamp).not.toBe(first.timestamp);
    // Everything except the clock-derived timestamps is still identical for the same seed.
    expect(second.candles.map((c) => c.close)).toEqual(first.candles.map((c) => c.close));
  });

  it("produces a different candle series for a different seed", async () => {
    const a = await new MockMarketDataProvider({ seed: 1 }).getMarketData("BTC");
    const b = await new MockMarketDataProvider({ seed: 2 }).getMarketData("BTC");
    expect(a.candles).not.toEqual(b.candles);
  });
});

describe("MockMarketDataProvider — snapshot shape", () => {
  it("stamps the instrument and carries the requested candle count through", async () => {
    const provider = new MockMarketDataProvider({ count: 30 });
    const snapshot = await provider.getMarketData("BTC");
    expect(snapshot.instrument).toBe("BTC");
    expect(snapshot.candles).toHaveLength(30);
  });

  it("derives bid/ask around the latest close with ask above bid", async () => {
    const provider = new MockMarketDataProvider({ seed: 5 });
    const snapshot = await provider.getMarketData("BTC");
    const latestClose = snapshot.candles[snapshot.candles.length - 1]!.close;
    expect(snapshot.latestPrice).toBe(latestClose);
    expect(snapshot.ask).toBeGreaterThan(snapshot.bid);
    expect(snapshot.spread).toBeCloseTo(snapshot.ask - snapshot.bid, 10);
    expect(snapshot.bid).toBeLessThanOrEqual(latestClose);
    expect(snapshot.ask).toBeGreaterThanOrEqual(latestClose);
  });

  it("uses the latest candle's own volume and timestamp", async () => {
    const provider = new MockMarketDataProvider({ seed: 3 });
    const snapshot = await provider.getMarketData("BTC");
    const latest = snapshot.candles[snapshot.candles.length - 1]!;
    expect(snapshot.volume).toBe(latest.volume);
    expect(snapshot.timestamp).toBe(latest.timestamp);
  });

  it("widens or narrows the spread proportionally to spreadRatio", async () => {
    const tight = await new MockMarketDataProvider({ seed: 5, spreadRatio: 0.0001 }).getMarketData("BTC");
    const wide = await new MockMarketDataProvider({ seed: 5, spreadRatio: 0.01 }).getMarketData("BTC");
    expect(wide.spread).toBeGreaterThan(tight.spread);
  });
});

describe("MockMarketDataProvider — bias", () => {
  it("produces an upward-drifting close series under a bullish bias", async () => {
    const snapshot = await new MockMarketDataProvider({ bias: "bullish", seed: 42, count: 60 }).getMarketData("BTC");
    const first = snapshot.candles[0]!.close;
    const last = snapshot.candles[snapshot.candles.length - 1]!.close;
    expect(last).toBeGreaterThan(first);
  });

  it("produces a downward-drifting close series under a bearish bias", async () => {
    const snapshot = await new MockMarketDataProvider({ bias: "bearish", seed: 42, count: 60 }).getMarketData("BTC");
    const first = snapshot.candles[0]!.close;
    const last = snapshot.candles[snapshot.candles.length - 1]!.close;
    expect(last).toBeLessThan(first);
  });
});

describe("MockMarketDataProvider — structured quote-fetch logging", () => {
  it("logs provider:'mock' with the same field shape LiveMarketDataProvider uses — so a VPS log stream can tell the two apart at a glance", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const provider = new MockMarketDataProvider({ seed: 5, count: 20 });
      const snapshot = await provider.getMarketData("BTC");

      expect(infoSpy).toHaveBeenCalledWith(
        "Mock market data quote generated",
        expect.objectContaining({
          component: "market-data",
          provider: "mock",
          instrument: "BTC",
          quoteTimestamp: snapshot.timestamp,
          latestPrice: snapshot.latestPrice,
          candleCount: 20,
          fallbackOccurred: false,
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });
});
