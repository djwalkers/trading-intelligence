import { describe, expect, it } from "vitest";
import { buildClientConfig } from "@/lib/config/client-config";
import { ConfigError } from "@/lib/config/env";

const EMPTY = {
  NEXT_PUBLIC_MARKET_DATA_PROVIDER: undefined,
  NEXT_PUBLIC_MARKET_DATA_API_KEY: undefined,
  NEXT_PUBLIC_SUPABASE_URL: undefined,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
};

describe("buildClientConfig", () => {
  it("is fully valid with nothing configured (local prototype mode)", () => {
    const config = buildClientConfig(EMPTY);
    expect(config.isExternalMarketDataConfigured).toBe(false);
    expect(config.isSupabaseConfigured).toBe(false);
  });

  it("is valid when both market data variables are set", () => {
    const config = buildClientConfig({
      ...EMPTY,
      NEXT_PUBLIC_MARKET_DATA_PROVIDER: "Finnhub",
      NEXT_PUBLIC_MARKET_DATA_API_KEY: "test-key",
    });
    expect(config.isExternalMarketDataConfigured).toBe(true);
  });

  it("is valid when both Supabase variables are set with a real URL", () => {
    const config = buildClientConfig({
      ...EMPTY,
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    });
    expect(config.isSupabaseConfigured).toBe(true);
  });

  it("throws when only the market data provider is set, not the key", () => {
    expect(() =>
      buildClientConfig({ ...EMPTY, NEXT_PUBLIC_MARKET_DATA_PROVIDER: "Finnhub" }),
    ).toThrow(ConfigError);
  });

  it("throws when only the Supabase anon key is set, not the URL", () => {
    expect(() =>
      buildClientConfig({ ...EMPTY, NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key" }),
    ).toThrow(ConfigError);
  });

  it("throws when the Supabase URL is not a valid URL", () => {
    expect(() =>
      buildClientConfig({
        ...EMPTY,
        NEXT_PUBLIC_SUPABASE_URL: "not-a-url",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      }),
    ).toThrow(ConfigError);
  });
});
