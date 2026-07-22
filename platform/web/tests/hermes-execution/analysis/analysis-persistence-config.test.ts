import { describe, expect, it, vi } from "vitest";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. getServerConfig() is a
// cached singleton with no reset hook (unlike getHermesExecutionConfig/getHermesIntegrationConfig)
// — mocked here rather than relying on process.env + the real cache, so each test can set its own
// isServiceRoleConfigured value independent of test ordering.
const mockGetServerConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config/server-config", () => ({ getServerConfig: mockGetServerConfig }));

const { buildAnalysisPersistenceConfig } = await import("@/lib/hermes-execution/analysis/analysis-persistence-config");

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("buildAnalysisPersistenceConfig", () => {
  it("is disabled when HERMES_SUPABASE_USER_ID is unset, even with the service role configured", () => {
    mockGetServerConfig.mockReturnValue({ isServiceRoleConfigured: true });
    const config = buildAnalysisPersistenceConfig({ HERMES_SUPABASE_USER_ID: undefined });
    expect(config.enabled).toBe(false);
    expect(config.ownerUserId).toBeUndefined();
  });

  it("is disabled when the service role is not configured, even with a valid owner id set", () => {
    mockGetServerConfig.mockReturnValue({ isServiceRoleConfigured: false });
    const config = buildAnalysisPersistenceConfig({ HERMES_SUPABASE_USER_ID: VALID_UUID });
    expect(config.enabled).toBe(false);
  });

  it("is enabled when both the service role and a valid owner id are configured", () => {
    mockGetServerConfig.mockReturnValue({ isServiceRoleConfigured: true });
    const config = buildAnalysisPersistenceConfig({ HERMES_SUPABASE_USER_ID: VALID_UUID });
    expect(config.enabled).toBe(true);
    expect(config.ownerUserId).toBe(VALID_UUID);
  });

  it("throws a clear error for a malformed (non-UUID) HERMES_SUPABASE_USER_ID rather than silently disabling", () => {
    mockGetServerConfig.mockReturnValue({ isServiceRoleConfigured: true });
    expect(() => buildAnalysisPersistenceConfig({ HERMES_SUPABASE_USER_ID: "not-a-uuid" })).toThrow(/well-formed UUID/);
  });

  it("treats an empty string the same as unset", () => {
    mockGetServerConfig.mockReturnValue({ isServiceRoleConfigured: true });
    const config = buildAnalysisPersistenceConfig({ HERMES_SUPABASE_USER_ID: "" });
    expect(config.enabled).toBe(false);
    expect(config.ownerUserId).toBeUndefined();
  });
});
