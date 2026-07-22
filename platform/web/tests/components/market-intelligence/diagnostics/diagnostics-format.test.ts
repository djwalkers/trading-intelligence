import { describe, expect, it } from "vitest";
import {
  dataFreshnessLevel,
  formatDuration,
  formatPrice,
  formatSpread,
  formatVolume,
  providerBadgeClasses,
  providerLabel,
  trendBadgeClasses,
} from "@/components/market-intelligence/diagnostics/diagnostics-format";

// Phase 2A.1 — Internal Market Diagnostics UI. Pure formatting/classification helpers — "indicator
// value formatting" and "provider/fallback badges" from this phase's own test list.

describe("formatPrice / formatSpread", () => {
  it("formats a price to exactly two decimal places", () => {
    expect(formatPrice(50000)).toBe("50,000.00");
    expect(formatPrice(99.999)).toBe("100.00");
  });

  it("formats a spread to four decimal places", () => {
    expect(formatSpread(0.05012345)).toBe("0.0501");
  });
});

describe("formatVolume", () => {
  it("formats a defined numeric volume with thousands separators", () => {
    expect(formatVolume(12345)).toBe("12,345");
  });

  it("reports undefined volume as unavailable, never as zero", () => {
    expect(formatVolume(undefined)).toMatch(/n\/a/i);
    expect(formatVolume(undefined)).not.toContain("0");
  });

  it("still reports a real zero volume as '0', distinct from unavailable", () => {
    expect(formatVolume(0)).toBe("0");
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes, hours, and days at the appropriate granularity", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(125)).toBe("2m");
    expect(formatDuration(7_200)).toBe("2.0h");
    expect(formatDuration(172_800)).toBe("2.0d");
  });
});

describe("providerLabel / providerBadgeClasses", () => {
  it("labels 'live' as Live and 'mock' as Mock", () => {
    expect(providerLabel("live")).toBe("Live");
    expect(providerLabel("mock")).toBe("Mock");
  });

  it("gives live and mock visually distinct badge classes", () => {
    expect(providerBadgeClasses("live")).not.toBe(providerBadgeClasses("mock"));
    expect(providerBadgeClasses("live")).toContain("teal");
    expect(providerBadgeClasses("mock")).toContain("amber");
  });
});

describe("dataFreshnessLevel", () => {
  it("classifies well under the threshold as fresh", () => {
    expect(dataFreshnessLevel(60, 7_200)).toBe("fresh");
  });

  it("classifies 60-90% of the threshold as aging", () => {
    expect(dataFreshnessLevel(5_000, 7_200)).toBe("aging");
  });

  it("classifies 90%+ of the threshold as critical", () => {
    expect(dataFreshnessLevel(6_800, 7_200)).toBe("critical");
  });

  it("never divides by zero when maxCandleAgeSeconds is zero", () => {
    expect(() => dataFreshnessLevel(10, 0)).not.toThrow();
  });
});

describe("trendBadgeClasses", () => {
  it("gives each trend classification a distinct set of classes", () => {
    const bullish = trendBadgeClasses("Bullish");
    const bearish = trendBadgeClasses("Bearish");
    const sideways = trendBadgeClasses("Sideways");
    expect(new Set([bullish, bearish, sideways]).size).toBe(3);
  });
});
