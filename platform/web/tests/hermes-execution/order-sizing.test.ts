import { describe, expect, it } from "vitest";
import { assertOrderSizingMode, calculateNotional, isOrderSizingMode, UnknownOrderSizingModeError } from "@/lib/hermes-execution/order-sizing";

// Broker Sizing Semantic Fix. calculateNotional is THE single calculation path both risk engines
// use for cash-sufficiency, strategy max-position-value, and portfolio max-exposure checks — these
// tests are the ground truth for the exact bug this fix addresses: a `quantity: 10` eToro BTC order
// at ~65,114 was previously assessed as an order worth ~651,140 instead of the correct CFD notional
// of 10.

describe("calculateNotional — NOTIONAL sizing mode (eToro-style CFD amount)", () => {
  it("returns exactly `quantity`, ignoring price entirely", () => {
    expect(calculateNotional("NOTIONAL", 10, 65_114.2)).toBe(10);
  });

  it("is unaffected by wildly different prices for the same quantity", () => {
    expect(calculateNotional("NOTIONAL", 10, 1)).toBe(10);
    expect(calculateNotional("NOTIONAL", 10, 1_000_000)).toBe(10);
  });
});

describe("calculateNotional — UNITS sizing mode (share/contract count)", () => {
  it("returns quantity x price", () => {
    expect(calculateNotional("UNITS", 2, 100)).toBe(200);
  });

  it("scales linearly with both quantity and price", () => {
    expect(calculateNotional("UNITS", 4, 100)).toBe(400);
    expect(calculateNotional("UNITS", 2, 200)).toBe(400);
  });
});

describe("isOrderSizingMode", () => {
  it("accepts exactly the two known modes", () => {
    expect(isOrderSizingMode("UNITS")).toBe(true);
    expect(isOrderSizingMode("NOTIONAL")).toBe(true);
  });

  it("rejects anything else, including near-miss casing/typos, undefined, and non-strings", () => {
    expect(isOrderSizingMode("units")).toBe(false);
    expect(isOrderSizingMode("notional")).toBe(false);
    expect(isOrderSizingMode("UNIT")).toBe(false);
    expect(isOrderSizingMode("")).toBe(false);
    expect(isOrderSizingMode(undefined)).toBe(false);
    expect(isOrderSizingMode(null)).toBe(false);
    expect(isOrderSizingMode(123)).toBe(false);
    expect(isOrderSizingMode({})).toBe(false);
  });
});

describe("assertOrderSizingMode — fails closed on an unknown sizing mode", () => {
  it("returns the value unchanged when it is a known mode", () => {
    expect(assertOrderSizingMode("UNITS", "test")).toBe("UNITS");
    expect(assertOrderSizingMode("NOTIONAL", "test")).toBe("NOTIONAL");
  });

  it("throws UnknownOrderSizingModeError for a missing (undefined) sizing mode — never defaults to either mode", () => {
    expect(() => assertOrderSizingMode(undefined, "legacy candidate")).toThrow(UnknownOrderSizingModeError);
  });

  it("throws UnknownOrderSizingModeError for an unrecognised string", () => {
    expect(() => assertOrderSizingMode("units", "legacy candidate")).toThrow(UnknownOrderSizingModeError);
  });

  it("includes the offending context in the thrown error message", () => {
    expect(() => assertOrderSizingMode(undefined, "trade candidate \"abc-123\"")).toThrow(/abc-123/);
  });
});
