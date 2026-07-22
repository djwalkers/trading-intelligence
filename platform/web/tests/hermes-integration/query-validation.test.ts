import { describe, expect, it } from "vitest";
import {
  parseLimitParam,
  parseOutcomeParam,
  parseSinceParam,
  parseSymbolParam,
  DEFAULT_DECISIONS_LIMIT,
  MAX_DECISIONS_LIMIT,
} from "@/lib/hermes-integration/query-validation";

describe("parseLimitParam", () => {
  it("defaults to 20 when absent", () => {
    expect(parseLimitParam(null)).toEqual({ ok: true, value: DEFAULT_DECISIONS_LIMIT });
  });

  it("accepts a valid positive integer", () => {
    expect(parseLimitParam("50")).toEqual({ ok: true, value: 50 });
  });

  it("accepts exactly the maximum (100)", () => {
    expect(parseLimitParam("100")).toEqual({ ok: true, value: MAX_DECISIONS_LIMIT });
  });

  it("rejects a limit over 100", () => {
    const result = parseLimitParam("101");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("100");
  });

  it("rejects a non-numeric limit", () => {
    const result = parseLimitParam("abc");
    expect(result.ok).toBe(false);
  });

  it("rejects a zero or negative limit", () => {
    expect(parseLimitParam("0").ok).toBe(false);
    expect(parseLimitParam("-5").ok).toBe(false);
  });

  it("rejects a non-integer limit", () => {
    expect(parseLimitParam("10.5").ok).toBe(false);
  });
});

describe("parseSinceParam", () => {
  it("returns undefined when absent", () => {
    expect(parseSinceParam(null)).toEqual({ ok: true, value: undefined });
  });

  it("accepts a valid ISO date/time and normalises it", () => {
    const result = parseSinceParam("2026-01-01T00:00:00Z");
    expect(result).toEqual({ ok: true, value: "2026-01-01T00:00:00.000Z" });
  });

  it("rejects an invalid date string", () => {
    const result = parseSinceParam("not-a-date");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("since");
  });
});

describe("parseOutcomeParam", () => {
  it("returns undefined when absent", () => {
    expect(parseOutcomeParam(null)).toEqual({ ok: true, value: undefined });
  });

  it("accepts BUY/SELL/HOLD case-insensitively", () => {
    expect(parseOutcomeParam("buy")).toEqual({ ok: true, value: "BUY" });
    expect(parseOutcomeParam("Sell")).toEqual({ ok: true, value: "SELL" });
    expect(parseOutcomeParam("HOLD")).toEqual({ ok: true, value: "HOLD" });
  });

  it("rejects an unsupported outcome value", () => {
    const result = parseOutcomeParam("MAYBE");
    expect(result.ok).toBe(false);
  });
});

describe("parseSymbolParam", () => {
  it("returns undefined when absent or blank", () => {
    expect(parseSymbolParam(null)).toBeUndefined();
    expect(parseSymbolParam("   ")).toBeUndefined();
  });

  it("trims and returns a provided symbol", () => {
    expect(parseSymbolParam(" BTC ")).toBe("BTC");
  });
});
