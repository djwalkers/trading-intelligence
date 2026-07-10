import { describe, expect, it } from "vitest";
import { ConfigError, parseBoolean, parseInteger, parseUrl, requirePairing } from "@/lib/config/env";

describe("parseBoolean", () => {
  it("returns the fallback when unset", () => {
    expect(parseBoolean(undefined, true)).toBe(true);
    expect(parseBoolean("", false)).toBe(false);
  });

  it("parses common truthy/falsy string forms", () => {
    expect(parseBoolean("true", false)).toBe(true);
    expect(parseBoolean("1", false)).toBe(true);
    expect(parseBoolean("false", true)).toBe(false);
    expect(parseBoolean("0", true)).toBe(false);
  });

  it("throws ConfigError for an unrecognised value instead of silently defaulting", () => {
    expect(() => parseBoolean("maybe", false)).toThrow(ConfigError);
  });
});

describe("parseInteger", () => {
  it("returns the fallback when unset", () => {
    expect(parseInteger(undefined, 42)).toBe(42);
  });

  it("parses a valid integer", () => {
    expect(parseInteger("30000", 0)).toBe(30000);
  });

  it("throws ConfigError for a non-integer value", () => {
    expect(() => parseInteger("abc", 0)).toThrow(ConfigError);
    expect(() => parseInteger("12.5", 0)).toThrow(ConfigError);
  });

  it("throws ConfigError below the configured minimum", () => {
    expect(() => parseInteger("500", 0, { min: 1000 })).toThrow(ConfigError);
  });
});

describe("parseUrl", () => {
  it("returns undefined when unset", () => {
    expect(parseUrl(undefined)).toBeUndefined();
  });

  it("returns the value when it is a valid URL", () => {
    expect(parseUrl("https://example.supabase.co")).toBe("https://example.supabase.co");
  });

  it("throws ConfigError for an invalid URL", () => {
    expect(() => parseUrl("not-a-url")).toThrow(ConfigError);
  });
});

describe("requirePairing", () => {
  it("passes when both are set", () => {
    expect(() =>
      requirePairing({ name: "A", value: "1" }, { name: "B", value: "2" }),
    ).not.toThrow();
  });

  it("passes when both are unset", () => {
    expect(() =>
      requirePairing({ name: "A", value: undefined }, { name: "B", value: undefined }),
    ).not.toThrow();
  });

  it("throws ConfigError when only one is set", () => {
    expect(() =>
      requirePairing({ name: "A", value: "1" }, { name: "B", value: undefined }),
    ).toThrow(ConfigError);
  });
});
