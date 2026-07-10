import { describe, expect, it } from "vitest";
import { buildServerConfig } from "@/lib/config/server-config";
import { ConfigError } from "@/lib/config/env";

const EMPTY = {
  ALPHA_VANTAGE_API_KEY: undefined,
  SUPABASE_SERVICE_ROLE_KEY: undefined,
  NEXT_PUBLIC_SUPABASE_URL: undefined,
  WORKER_POLL_INTERVAL_MS: undefined,
};

describe("buildServerConfig", () => {
  it("is fully valid with nothing configured", () => {
    const config = buildServerConfig(EMPTY);
    expect(config.isAlphaVantageConfigured).toBe(false);
    expect(config.isServiceRoleConfigured).toBe(false);
    expect(config.workerPollIntervalMs).toBe(30_000);
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
});
