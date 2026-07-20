import { describe, expect, it } from "vitest";
import { formatPerpPrice, formatPerpSize } from "@/lib/hermes-execution/hyperliquid/price-formatting";

describe("formatPerpPrice", () => {
  it("passes integers through unchanged regardless of significant figures", () => {
    expect(formatPerpPrice(67891, 5)).toBe("67891");
    expect(formatPerpPrice(100000, 0)).toBe("100000");
  });

  it("rounds to 5 significant figures and clamps to (6 - szDecimals) decimal places", () => {
    // szDecimals=5 -> maxDecimals=1; 5 sig figs of 67891.234567 rounds to 67891 (an integer)
    expect(formatPerpPrice(67891.234567, 5)).toBe("67891");
    // szDecimals=2 -> maxDecimals=4; 5 sig figs of 123.456 rounds to 123.46
    expect(formatPerpPrice(123.456, 2)).toBe("123.46");
  });

  it("trims trailing zeros", () => {
    expect(formatPerpPrice(100.5, 2)).toBe("100.5");
  });

  it("rejects non-positive or non-finite prices", () => {
    expect(() => formatPerpPrice(0, 2)).toThrow();
    expect(() => formatPerpPrice(-5, 2)).toThrow();
    expect(() => formatPerpPrice(Number.NaN, 2)).toThrow();
  });
});

describe("formatPerpSize", () => {
  it("rounds to szDecimals decimal places", () => {
    expect(formatPerpSize(0.123456, 5)).toBe("0.12346");
    expect(formatPerpSize(1, 0)).toBe("1");
  });

  it("trims trailing zeros", () => {
    expect(formatPerpSize(0.1, 5)).toBe("0.1");
  });

  it("rejects non-positive or non-finite sizes", () => {
    expect(() => formatPerpSize(0, 2)).toThrow();
    expect(() => formatPerpSize(-1, 2)).toThrow();
  });
});
