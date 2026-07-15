import { describe, expect, it } from "vitest";
import { buildServerConfig } from "@/lib/config/server-config";
import { ConfigError } from "@/lib/config/env";

const EMPTY = {
  ALPHA_VANTAGE_API_KEY: undefined,
  SUPABASE_SERVICE_ROLE_KEY: undefined,
  NEXT_PUBLIC_SUPABASE_URL: undefined,
  WORKER_POLL_INTERVAL_MS: undefined,
  NEXT_PUBLIC_MARKET_DATA_PROVIDER: undefined,
  NEXT_PUBLIC_MARKET_DATA_API_KEY: undefined,
  MARKET_UNIVERSE_WORKER_ENABLED: undefined,
  MARKET_SCREENING_ROLLOUT_STAGE: undefined,
  RESEARCH_RUNS_DIRECTORY: undefined,
};

describe("buildServerConfig", () => {
  it("is fully valid with nothing configured", () => {
    const config = buildServerConfig(EMPTY);
    expect(config.isAlphaVantageConfigured).toBe(false);
    expect(config.isServiceRoleConfigured).toBe(false);
    expect(config.isFinnhubConfigured).toBe(false);
    expect(config.workerPollIntervalMs).toBe(30_000);
    expect(config.isMarketUniverseWorkerObservabilityEnabled).toBe(false);
    expect(config.marketScreeningRolloutStage).toBe("off");
  });

  it("enables Market Universe worker observability only when explicitly set", () => {
    expect(
      buildServerConfig({ ...EMPTY, MARKET_UNIVERSE_WORKER_ENABLED: "true" })
        .isMarketUniverseWorkerObservabilityEnabled,
    ).toBe(true);
    expect(buildServerConfig(EMPTY).isMarketUniverseWorkerObservabilityEnabled).toBe(false);
  });

  it("is valid when the Finnhub provider name is paired with an API key", () => {
    const config = buildServerConfig({
      ...EMPTY,
      NEXT_PUBLIC_MARKET_DATA_PROVIDER: "finnhub",
      NEXT_PUBLIC_MARKET_DATA_API_KEY: "test-finnhub-key",
    });
    expect(config.isFinnhubConfigured).toBe(true);
  });

  it("throws when the Finnhub provider name is set without an API key", () => {
    expect(() =>
      buildServerConfig({ ...EMPTY, NEXT_PUBLIC_MARKET_DATA_PROVIDER: "finnhub" }),
    ).toThrow(ConfigError);
  });

  it("is valid when the service role key is paired with a Supabase URL", () => {
    const config = buildServerConfig({
      ...EMPTY,
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    });
    expect(config.isServiceRoleConfigured).toBe(true);
  });

  it("throws when the service role key is set without a Supabase URL", () => {
    expect(() =>
      buildServerConfig({ ...EMPTY, SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key" }),
    ).toThrow(ConfigError);
  });

  it("parses a valid custom poll interval", () => {
    const config = buildServerConfig({ ...EMPTY, WORKER_POLL_INTERVAL_MS: "60000" });
    expect(config.workerPollIntervalMs).toBe(60_000);
  });

  it("throws for a malformed poll interval instead of silently producing NaN", () => {
    expect(() => buildServerConfig({ ...EMPTY, WORKER_POLL_INTERVAL_MS: "not-a-number" })).toThrow(
      ConfigError,
    );
  });

  it("defaults the market screening rollout stage to off when unset", () => {
    expect(buildServerConfig(EMPTY).marketScreeningRolloutStage).toBe("off");
  });

  it("accepts every documented market screening rollout stage", () => {
    for (const stage of ["off", "shadow", "staged", "full"]) {
      expect(buildServerConfig({ ...EMPTY, MARKET_SCREENING_ROLLOUT_STAGE: stage }).marketScreeningRolloutStage).toBe(stage);
    }
  });

  it("throws for an unrecognised market screening rollout stage instead of silently defaulting", () => {
    expect(() => buildServerConfig({ ...EMPTY, MARKET_SCREENING_ROLLOUT_STAGE: "full-throttle" })).toThrow(
      ConfigError,
    );
  });
});
