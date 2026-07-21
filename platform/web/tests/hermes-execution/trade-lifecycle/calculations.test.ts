import { describe, expect, it } from "vitest";
import {
  calculateHoldingDurationMs,
  calculateRealisedPnl,
  calculateRealisedPnlPercent,
  calculateUnrealizedPnl,
  updateExcursionValues,
} from "@/lib/hermes-execution/trade-lifecycle/calculations";

describe("calculateRealisedPnl — long (BUY)", () => {
  it("is positive when exitPrice is above entryPrice", () => {
    expect(calculateRealisedPnl("BUY", 100, 110, 10)).toBeCloseTo(100, 10);
  });

  it("is negative when exitPrice is below entryPrice", () => {
    expect(calculateRealisedPnl("BUY", 100, 90, 10)).toBeCloseTo(-100, 10);
  });

  it("is zero when exitPrice equals entryPrice", () => {
    expect(calculateRealisedPnl("BUY", 100, 100, 10)).toBe(0);
  });
});

describe("calculateRealisedPnl — short (SELL)", () => {
  it("is positive when exitPrice is below entryPrice", () => {
    expect(calculateRealisedPnl("SELL", 100, 90, 10)).toBeCloseTo(100, 10);
  });

  it("is negative when exitPrice is above entryPrice", () => {
    expect(calculateRealisedPnl("SELL", 100, 110, 10)).toBeCloseTo(-100, 10);
  });

  it("is the exact negation of the equivalent long trade", () => {
    const long = calculateRealisedPnl("BUY", 50, 55, 20);
    const short = calculateRealisedPnl("SELL", 50, 55, 20);
    expect(short).toBeCloseTo(-long, 10);
  });
});

describe("calculateRealisedPnl — invalid input handling", () => {
  it.each([
    ["entryPrice", () => calculateRealisedPnl("BUY", 0, 100, 10)],
    ["entryPrice", () => calculateRealisedPnl("BUY", -5, 100, 10)],
    ["entryPrice", () => calculateRealisedPnl("BUY", Number.NaN, 100, 10)],
    ["exitPrice", () => calculateRealisedPnl("BUY", 100, 0, 10)],
    ["exitPrice", () => calculateRealisedPnl("BUY", 100, Number.POSITIVE_INFINITY, 10)],
    ["quantity", () => calculateRealisedPnl("BUY", 100, 110, 0)],
    ["quantity", () => calculateRealisedPnl("BUY", 100, 110, -1)],
  ])("throws for an invalid %s", (_label, run) => {
    expect(run).toThrow();
  });
});

describe("calculateRealisedPnlPercent", () => {
  it("computes P/L against the absolute entry notional for a long trade", () => {
    // entryNotional = 100 * 10 = 1000; pnl = (110-100)*10 = 100 -> 10%
    expect(calculateRealisedPnlPercent("BUY", 100, 110, 10)).toBeCloseTo(10, 10);
  });

  it("computes P/L against the absolute entry notional for a short trade", () => {
    // entryNotional = 100 * 10 = 1000; pnl = (100-90)*10 = 100 -> 10%
    expect(calculateRealisedPnlPercent("SELL", 100, 90, 10)).toBeCloseTo(10, 10);
  });

  it("is negative for a losing trade", () => {
    expect(calculateRealisedPnlPercent("BUY", 100, 90, 10)).toBeCloseTo(-10, 10);
  });

  it("throws rather than dividing by a zero/invalid notional", () => {
    expect(() => calculateRealisedPnlPercent("BUY", 0, 100, 10)).toThrow();
    expect(() => calculateRealisedPnlPercent("BUY", 100, 110, 0)).toThrow();
  });
});

describe("calculateHoldingDurationMs", () => {
  it("returns the millisecond difference between two ISO timestamps", () => {
    expect(calculateHoldingDurationMs("2026-01-01T00:00:00.000Z", "2026-01-01T00:05:00.000Z")).toBe(5 * 60 * 1000);
  });

  it("returns zero for identical timestamps", () => {
    expect(calculateHoldingDurationMs("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(0);
  });

  it("throws for an unparseable openedAt", () => {
    expect(() => calculateHoldingDurationMs("not-a-date", "2026-01-01T00:00:00.000Z")).toThrow(/openedAt/);
  });

  it("throws for an unparseable closedAt", () => {
    expect(() => calculateHoldingDurationMs("2026-01-01T00:00:00.000Z", "not-a-date")).toThrow(/closedAt/);
  });

  it("throws when closedAt is before openedAt", () => {
    expect(() => calculateHoldingDurationMs("2026-01-01T00:05:00.000Z", "2026-01-01T00:00:00.000Z")).toThrow(
      /negative holding duration/,
    );
  });
});

describe("calculateUnrealizedPnl", () => {
  it("matches calculateRealisedPnl when the current price is treated as the exit price", () => {
    expect(calculateUnrealizedPnl("BUY", 100, 105, 10)).toBe(calculateRealisedPnl("BUY", 100, 105, 10));
    expect(calculateUnrealizedPnl("SELL", 100, 95, 10)).toBe(calculateRealisedPnl("SELL", 100, 95, 10));
  });
});

describe("updateExcursionValues — long trade", () => {
  const zero = { maximumFavourableExcursion: 0, maximumAdverseExcursion: 0 };

  it("favourable movement (price above entry) grows MFE and leaves MAE at zero", () => {
    const next = updateExcursionValues("BUY", 100, 110, 10, zero);
    expect(next.maximumFavourableExcursion).toBeCloseTo(100, 10); // (110-100)*10
    expect(next.maximumAdverseExcursion).toBe(0);
  });

  it("adverse movement (price below entry) grows MAE (more negative) and leaves MFE at zero", () => {
    const next = updateExcursionValues("BUY", 100, 90, 10, zero);
    expect(next.maximumFavourableExcursion).toBe(0);
    expect(next.maximumAdverseExcursion).toBeCloseTo(-100, 10); // (90-100)*10
  });

  it("is monotonic — a retracement never shrinks a previously recorded MFE", () => {
    const afterRun = updateExcursionValues("BUY", 100, 120, 10, zero); // MFE=200
    const afterPullback = updateExcursionValues("BUY", 100, 105, 10, afterRun); // unrealized only 50 now
    expect(afterPullback.maximumFavourableExcursion).toBeCloseTo(200, 10);
    expect(afterPullback.maximumAdverseExcursion).toBe(0);
  });

  it("is monotonic — a bounce never shrinks a previously recorded MAE", () => {
    const afterDrop = updateExcursionValues("BUY", 100, 80, 10, zero); // MAE=-200
    const afterBounce = updateExcursionValues("BUY", 100, 95, 10, afterDrop); // unrealized only -50 now
    expect(afterBounce.maximumAdverseExcursion).toBeCloseTo(-200, 10);
    expect(afterBounce.maximumFavourableExcursion).toBe(0);
  });

  it("tracks both MFE and MAE across a price path that visits both extremes", () => {
    let excursion = zero;
    for (const price of [100, 115, 90, 105]) {
      excursion = updateExcursionValues("BUY", 100, price, 10, excursion);
    }
    expect(excursion.maximumFavourableExcursion).toBeCloseTo(150, 10); // best: (115-100)*10
    expect(excursion.maximumAdverseExcursion).toBeCloseTo(-100, 10); // worst: (90-100)*10
  });
});

describe("updateExcursionValues — short trade", () => {
  const zero = { maximumFavourableExcursion: 0, maximumAdverseExcursion: 0 };

  it("favourable movement for a short is a price DROP below entry", () => {
    const next = updateExcursionValues("SELL", 100, 90, 10, zero);
    expect(next.maximumFavourableExcursion).toBeCloseTo(100, 10); // (100-90)*10
    expect(next.maximumAdverseExcursion).toBe(0);
  });

  it("adverse movement for a short is a price RISE above entry", () => {
    const next = updateExcursionValues("SELL", 100, 110, 10, zero);
    expect(next.maximumFavourableExcursion).toBe(0);
    expect(next.maximumAdverseExcursion).toBeCloseTo(-100, 10); // (100-110)*10
  });

  it("tracks both MFE and MAE across a price path that visits both extremes", () => {
    let excursion = zero;
    for (const price of [100, 85, 120, 95]) {
      excursion = updateExcursionValues("SELL", 100, price, 10, excursion);
    }
    expect(excursion.maximumFavourableExcursion).toBeCloseTo(150, 10); // best: (100-85)*10
    expect(excursion.maximumAdverseExcursion).toBeCloseTo(-200, 10); // worst: (100-120)*10
  });
});
