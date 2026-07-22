import { describe, expect, it } from "vitest";
import {
  buildLinePath,
  candleSlotWidth,
  computePriceScale,
  indexToX,
  nearestIndexForFraction,
  priceToY,
} from "@/components/market-intelligence/diagnostics/chart-geometry";

// Phase 2A.1 — Internal Market Diagnostics UI. "Chart data transformation" from this phase's own
// test list — pure geometry functions, no rendering involved.

describe("computePriceScale", () => {
  it("pads the min/max of the given values", () => {
    const scale = computePriceScale([100, 110, 90]);
    expect(scale.min).toBeLessThan(90);
    expect(scale.max).toBeGreaterThan(110);
  });

  it("never produces a zero-height scale for a perfectly flat series", () => {
    const scale = computePriceScale([100, 100, 100]);
    expect(scale.max).toBeGreaterThan(scale.min);
  });

  it("returns an arbitrary but valid scale for an empty array", () => {
    const scale = computePriceScale([]);
    expect(scale.max).toBeGreaterThan(scale.min);
  });
});

describe("priceToY", () => {
  const scale = { min: 0, max: 100 };

  it("maps the scale minimum to the chart's bottom edge", () => {
    expect(priceToY(0, scale, 200)).toBeCloseTo(200, 5);
  });

  it("maps the scale maximum to the chart's top edge", () => {
    expect(priceToY(100, scale, 200)).toBeCloseTo(0, 5);
  });

  it("maps the midpoint to the vertical center", () => {
    expect(priceToY(50, scale, 200)).toBeCloseTo(100, 5);
  });

  it("never divides by zero for a zero-range scale", () => {
    expect(priceToY(5, { min: 5, max: 5 }, 200)).toBe(100);
  });
});

describe("indexToX / candleSlotWidth", () => {
  it("evenly spaces candles left to right across the chart width", () => {
    const count = 4;
    const width = 400;
    const xs = [0, 1, 2, 3].map((i) => indexToX(i, count, width));
    expect(xs).toEqual([50, 150, 250, 350]);
  });

  it("candleSlotWidth divides the chart width evenly by count", () => {
    expect(candleSlotWidth(4, 400)).toBe(100);
  });

  it("centers a single candle", () => {
    expect(indexToX(0, 1, 400)).toBe(200);
  });
});

describe("buildLinePath", () => {
  it("returns an empty string for fewer than two points", () => {
    expect(buildLinePath([50], 1, 400, 200, { min: 0, max: 100 })).toBe("");
    expect(buildLinePath([], 0, 400, 200, { min: 0, max: 100 })).toBe("");
  });

  it("starts with M and uses L for subsequent points, one command per value", () => {
    const path = buildLinePath([10, 20, 30], 3, 300, 200, { min: 0, max: 100 });
    const commands = path.split(" ");
    expect(commands).toHaveLength(3);
    expect(commands[0]!.startsWith("M")).toBe(true);
    expect(commands[1]!.startsWith("L")).toBe(true);
    expect(commands[2]!.startsWith("L")).toBe(true);
  });
});

describe("nearestIndexForFraction", () => {
  it("maps fraction 0 to the first index and 1 to the last", () => {
    expect(nearestIndexForFraction(0, 10)).toBe(0);
    expect(nearestIndexForFraction(1, 10)).toBe(9);
  });

  it("maps the midpoint fraction to a middle index", () => {
    expect(nearestIndexForFraction(0.5, 11)).toBe(5);
  });

  it("clamps out-of-range fractions", () => {
    expect(nearestIndexForFraction(-0.5, 10)).toBe(0);
    expect(nearestIndexForFraction(1.5, 10)).toBe(9);
  });

  it("never returns a negative index for a zero count", () => {
    expect(nearestIndexForFraction(0.5, 0)).toBe(0);
  });
});
