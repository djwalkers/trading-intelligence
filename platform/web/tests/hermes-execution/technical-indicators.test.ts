import { describe, expect, it } from "vitest";
import {
  calculateAtr,
  calculateEma,
  calculateRsi,
  calculateVolatility24h,
  classifyTrend,
} from "@/lib/hermes-execution/technical-indicators";
import { resolveMarketSession } from "@/lib/hermes-execution/market-session";
import type { Candle } from "@/lib/hermes-execution/types";

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    symbol: "BTC",
    timestamp: "2026-01-01T00:00:00Z",
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
    ...overrides,
  };
}

describe("calculateEma", () => {
  it("returns a plain average when there isn't enough history for a full period", () => {
    expect(calculateEma([10, 20], 20)).toBe(15);
  });

  it("weights recent values more heavily than older ones", () => {
    const flat = calculateEma(Array(30).fill(100), 20);
    expect(flat).toBeCloseTo(100, 5);

    const risingThenFlat = [...Array(20).fill(100), ...Array(10).fill(110)];
    const ema = calculateEma(risingThenFlat, 20);
    expect(ema).toBeGreaterThan(100);
    expect(ema).toBeLessThan(110);
  });

  it("returns a higher EMA for a monotonically rising series than a monotonically falling one", () => {
    // Same absolute price range (100-159) for both, just traversed in opposite directions, so the
    // comparison isolates the effect of recency weighting rather than differing series means.
    const rising = Array.from({ length: 60 }, (_, i) => 100 + i);
    const falling = Array.from({ length: 60 }, (_, i) => 159 - i);
    expect(calculateEma(rising, 20)).toBeGreaterThan(calculateEma(falling, 20));
  });
});

describe("calculateRsi", () => {
  it("returns 50 (neutral) when there isn't enough history for one period", () => {
    expect(calculateRsi([100, 101, 102], 14)).toBe(50);
  });

  it("returns a high RSI for a monotonically rising price series", () => {
    const rising = Array.from({ length: 20 }, (_, i) => 100 + i);
    const rsi = calculateRsi(rising, 14);
    expect(rsi).toBeGreaterThan(70);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  it("returns a low RSI for a monotonically falling price series", () => {
    const falling = Array.from({ length: 20 }, (_, i) => 200 - i);
    const rsi = calculateRsi(falling, 14);
    expect(rsi).toBeLessThan(30);
    expect(rsi).toBeGreaterThanOrEqual(0);
  });

  it("returns a mid-range RSI for a series that alternates up and down by equal amounts", () => {
    const alternating = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
    const rsi = calculateRsi(alternating, 14);
    expect(rsi).toBeGreaterThan(30);
    expect(rsi).toBeLessThan(70);
  });

  it("never returns NaN/Infinity when there have been no losses at all", () => {
    const alwaysUp = Array.from({ length: 20 }, (_, i) => 100 + i);
    const rsi = calculateRsi(alwaysUp, 14);
    expect(Number.isFinite(rsi)).toBe(true);
  });
});

describe("calculateAtr", () => {
  it("returns 0 for fewer than two candles", () => {
    expect(calculateAtr([], 14)).toBe(0);
    expect(calculateAtr([makeCandle()], 14)).toBe(0);
  });

  it("returns a positive value proportional to the size of the daily ranges", () => {
    const tight = Array.from({ length: 20 }, (_, i) =>
      makeCandle({ timestamp: `2026-01-01T${String(i).padStart(2, "0")}:00:00Z`, high: 100.5, low: 99.5, close: 100 }),
    );
    const wide = Array.from({ length: 20 }, (_, i) =>
      makeCandle({ timestamp: `2026-01-01T${String(i).padStart(2, "0")}:00:00Z`, high: 110, low: 90, close: 100 }),
    );
    expect(calculateAtr(wide, 14)).toBeGreaterThan(calculateAtr(tight, 14));
  });
});

describe("calculateVolatility24h", () => {
  it("returns undefined when there isn't enough history to compute any return", () => {
    expect(calculateVolatility24h([makeCandle()])).toBeUndefined();
    expect(calculateVolatility24h([])).toBeUndefined();
  });

  it("returns a higher value for a more volatile recent series", () => {
    const stable = Array.from({ length: 24 }, (_, i) => makeCandle({ close: 100 + (i % 2 === 0 ? 0.01 : -0.01) }));
    const volatile = Array.from({ length: 24 }, (_, i) => makeCandle({ close: i % 2 === 0 ? 100 : 130 }));
    const stableVol = calculateVolatility24h(stable)!;
    const volatileVol = calculateVolatility24h(volatile)!;
    expect(volatileVol).toBeGreaterThan(stableVol);
  });
});

describe("classifyTrend", () => {
  it("classifies Bullish when EMA20 is clearly above EMA50", () => {
    expect(classifyTrend(110, 100)).toBe("Bullish");
  });

  it("classifies Bearish when EMA20 is clearly below EMA50", () => {
    expect(classifyTrend(90, 100)).toBe("Bearish");
  });

  it("classifies Sideways when the two EMAs are within the tolerance band", () => {
    expect(classifyTrend(100.02, 100)).toBe("Sideways");
  });
});

describe("resolveMarketSession", () => {
  it("always reports 'Crypto Always Open' for a crypto instrument, regardless of hour", () => {
    expect(resolveMarketSession("BTC", new Date("2026-01-01T03:00:00Z"))).toBe("Crypto Always Open");
    expect(resolveMarketSession("btc", new Date("2026-01-01T18:00:00Z"))).toBe("Crypto Always Open");
  });

  it("buckets a non-crypto instrument into Asia/Europe/US by UTC hour", () => {
    expect(resolveMarketSession("AAPL", new Date("2026-01-01T03:00:00Z"))).toBe("Asia");
    expect(resolveMarketSession("AAPL", new Date("2026-01-01T10:00:00Z"))).toBe("Europe");
    expect(resolveMarketSession("AAPL", new Date("2026-01-01T18:00:00Z"))).toBe("US");
  });
});
