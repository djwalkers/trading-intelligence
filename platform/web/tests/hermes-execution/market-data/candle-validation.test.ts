import { describe, expect, it } from "vitest";
import {
  MIN_REQUIRED_CANDLES,
  SUPPORTED_MARKET_TIMEFRAMES,
  TIMEFRAME_DURATIONS_MS,
  validateHistoricalCandles,
} from "@/lib/hermes-execution/market-data/candle-validation";
import { MarketDataProviderError } from "@/lib/hermes-execution/market-data/market-data-provider";
import type { Candle } from "@/lib/hermes-execution/types";

const HOUR_MS = TIMEFRAME_DURATIONS_MS["1h"];
const NOW = new Date("2026-01-02T00:00:00.000Z");

function makeValidCandles(count = MIN_REQUIRED_CANDLES, endTimestamp: Date = NOW): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const timestamp = new Date(endTimestamp.getTime() - (count - 1 - i) * HOUR_MS).toISOString();
    const price = 100 + i * 0.1;
    candles.push({ symbol: "BTC", timestamp, open: price, high: price + 1, low: price - 1, close: price, volume: 50 });
  }
  return candles;
}

describe("candle-validation — SUPPORTED_MARKET_TIMEFRAMES / TIMEFRAME_DURATIONS_MS", () => {
  it("has a duration entry for every supported timeframe", () => {
    for (const timeframe of SUPPORTED_MARKET_TIMEFRAMES) {
      expect(TIMEFRAME_DURATIONS_MS[timeframe]).toBeGreaterThan(0);
    }
  });

  it("durations are strictly increasing across the granularity ladder", () => {
    const durations = SUPPORTED_MARKET_TIMEFRAMES.map((tf) => TIMEFRAME_DURATIONS_MS[tf]);
    for (let i = 1; i < durations.length; i++) {
      expect(durations[i]!).toBeGreaterThan(durations[i - 1]!);
    }
  });
});

describe("validateHistoricalCandles — happy path", () => {
  it("accepts a well-formed, sufficiently long, fresh candle history", () => {
    const candles = makeValidCandles();
    expect(() =>
      validateHistoricalCandles(candles, "BTC", { timeframe: "1h", maxCandleAgeSeconds: 7_200, now: NOW }),
    ).not.toThrow();
  });
});

describe("validateHistoricalCandles — insufficient candles", () => {
  it("rejects a history shorter than MIN_REQUIRED_CANDLES", () => {
    const candles = makeValidCandles(MIN_REQUIRED_CANDLES - 1);
    expect(() =>
      validateHistoricalCandles(candles, "BTC", { timeframe: "1h", maxCandleAgeSeconds: 7_200, now: NOW }),
    ).toThrow(MarketDataProviderError);
  });

  it("rejects an empty candle array", () => {
    expect(() => validateHistoricalCandles([], "BTC", { timeframe: "1h", maxCandleAgeSeconds: 7_200, now: NOW })).toThrow(
      /received 0 candle/,
    );
  });
});

describe("validateHistoricalCandles — duplicate timestamps", () => {
  it("rejects two candles sharing the same timestamp", () => {
    const candles = makeValidCandles();
    candles[10] = { ...candles[10]!, timestamp: candles[11]!.timestamp };
    expect(() =>
      validateHistoricalCandles(candles, "BTC", { timeframe: "1h", maxCandleAgeSeconds: 7_200, now: NOW }),
    ).toThrow(/duplicate candle timestamp/);
  });
});

describe("validateHistoricalCandles — missing candles (gaps)", () => {
  it("rejects a history with a skipped candle wider than the timeframe tolerates", () => {
    // 60 candles so removing one still leaves 59 — comfortably above MIN_REQUIRED_CANDLES (50) —
    // isolating this test to the gap check specifically, not an incidental insufficient-count trip.
    const candles = makeValidCandles(60);
    candles.splice(30, 1);
    expect(() =>
      validateHistoricalCandles(candles, "BTC", { timeframe: "1h", maxCandleAgeSeconds: 7_200, now: NOW }),
    ).toThrow(/missing candle/);
  });

  it("tolerates normal small jitter in candle boundaries", () => {
    const candles = makeValidCandles();
    // Nudge one interior timestamp by 2 minutes — well within the 1.5x tolerance for an hourly series.
    const jittered = new Date(Date.parse(candles[20]!.timestamp) + 2 * 60_000).toISOString();
    candles[20] = { ...candles[20]!, timestamp: jittered };
    expect(() =>
      validateHistoricalCandles(candles, "BTC", { timeframe: "1h", maxCandleAgeSeconds: 7_200, now: NOW }),
    ).not.toThrow();
  });
});

describe("validateHistoricalCandles — malformed OHLC", () => {
  it("rejects high below low", () => {
    const candles = makeValidCandles();
    candles[5] = { ...candles[5]!, high: 90, low: 95 };
    expect(() =>
      validateHistoricalCandles(candles, "BTC", { timeframe: "1h", maxCandleAgeSeconds: 7_200, now: NOW }),
    ).toThrow(/high.*below low/);
  });

  it("rejects an open above the high", () => {
    const candles = makeValidCandles();
    candles[5] = { ...candles[5]!, open: candles[5]!.high + 10 };
    expect(() =>
      validateHistoricalCandles(candles, "BTC", { timeframe: "1h", maxCandleAgeSeconds: 7_200, now: NOW }),
    ).toThrow(/outside the \[low, high\] range/);
  });

  it("rejects a close below the low", () => {
    const candles = makeValidCandles();
    candles[5] = { ...candles[5]!, close: candles[5]!.low - 10 };
    expect(() =>
      validateHistoricalCandles(candles, "BTC", { timeframe: "1h", maxCandleAgeSeconds: 7_200, now: NOW }),
    ).toThrow(/outside the \[low, high\] range/);
  });
});

describe("validateHistoricalCandles — non-positive prices", () => {
  it("rejects a zero close", () => {
    const candles = makeValidCandles();
    candles[5] = { ...candles[5]!, close: 0 };
    expect(() =>
      validateHistoricalCandles(candles, "BTC", { timeframe: "1h", maxCandleAgeSeconds: 7_200, now: NOW }),
    ).toThrow(/non-positive OHLC/);
  });

  it("rejects a negative open", () => {
    const candles = makeValidCandles();
    candles[5] = { ...candles[5]!, open: -1 };
    expect(() =>
      validateHistoricalCandles(candles, "BTC", { timeframe: "1h", maxCandleAgeSeconds: 7_200, now: NOW }),
    ).toThrow(/non-positive OHLC/);
  });
});

describe("validateHistoricalCandles — NaN / non-finite values", () => {
  it("rejects a NaN close", () => {
    const candles = makeValidCandles();
    candles[5] = { ...candles[5]!, close: Number.NaN };
    expect(() =>
      validateHistoricalCandles(candles, "BTC", { timeframe: "1h", maxCandleAgeSeconds: 7_200, now: NOW }),
    ).toThrow(/non-finite/);
  });

  it("rejects an Infinity volume", () => {
    const candles = makeValidCandles();
    candles[5] = { ...candles[5]!, volume: Number.POSITIVE_INFINITY };
    expect(() =>
      validateHistoricalCandles(candles, "BTC", { timeframe: "1h", maxCandleAgeSeconds: 7_200, now: NOW }),
    ).toThrow(/non-finite/);
  });
});

describe("validateHistoricalCandles — stale data", () => {
  it("rejects a history whose latest candle is older than maxCandleAgeSeconds", () => {
    const candles = makeValidCandles(MIN_REQUIRED_CANDLES, new Date(NOW.getTime() - 5 * HOUR_MS));
    expect(() =>
      validateHistoricalCandles(candles, "BTC", { timeframe: "1h", maxCandleAgeSeconds: 3_600, now: NOW }),
    ).toThrow(/stale data/);
  });

  it("accepts a history right at the freshness boundary", () => {
    const candles = makeValidCandles(MIN_REQUIRED_CANDLES, new Date(NOW.getTime() - 3_500 * 1000));
    expect(() =>
      validateHistoricalCandles(candles, "BTC", { timeframe: "1h", maxCandleAgeSeconds: 7_200, now: NOW }),
    ).not.toThrow();
  });
});

describe("validateHistoricalCandles — never silently repairs, always throws MarketDataProviderError", () => {
  it("every rejection is a MarketDataProviderError with reason 'malformed-data'", () => {
    const candles = makeValidCandles();
    candles[5] = { ...candles[5]!, close: -1 };
    try {
      validateHistoricalCandles(candles, "BTC", { timeframe: "1h", maxCandleAgeSeconds: 7_200, now: NOW });
      expect.unreachable("expected validateHistoricalCandles to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MarketDataProviderError);
      expect((error as MarketDataProviderError).reason).toBe("malformed-data");
    }
  });
});
