import { describe, expect, it } from "vitest";
import { buildHermesIntegrationConfig, MIN_HERMES_INTEGRATION_TOKEN_LENGTH } from "@/lib/hermes-integration/config";
import { ConfigError } from "@/lib/config/env";

const VALID_TOKEN = "a".repeat(MIN_HERMES_INTEGRATION_TOKEN_LENGTH);

describe("buildHermesIntegrationConfig", () => {
  it("returns null when HERMES_INTEGRATION_TOKEN is unset", () => {
    expect(buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: undefined })).toBeNull();
  });

  it("returns null when HERMES_INTEGRATION_TOKEN is blank/whitespace-only", () => {
    expect(buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: "   " })).toBeNull();
  });

  it("throws ConfigError when the token is set but shorter than the minimum length", () => {
    expect(() => buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: "short-token" })).toThrow(ConfigError);
  });

  it("the ConfigError message never includes the actual token value", () => {
    const shortToken = "super-secret-but-too-short";
    try {
      buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: shortToken });
      throw new Error("expected buildHermesIntegrationConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain(shortToken);
    }
  });

  it("accepts a token at exactly the minimum length", () => {
    const config = buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: VALID_TOKEN });
    expect(config).toEqual({ token: VALID_TOKEN });
  });

  it("accepts a token longer than the minimum length", () => {
    const longToken = VALID_TOKEN + "-extra-characters";
    const config = buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: longToken });
    expect(config).toEqual({ token: longToken });
  });
});
