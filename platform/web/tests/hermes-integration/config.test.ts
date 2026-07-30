import { describe, expect, it } from "vitest";
import { buildHermesIntegrationConfig, MIN_HERMES_INTEGRATION_TOKEN_LENGTH } from "@/lib/hermes-integration/config";
import { ConfigError } from "@/lib/config/env";

// Split-deployment fix. HERMES_INTEGRATION_BASE_URL is now required together with
// HERMES_INTEGRATION_TOKEN — the dashboard proxy can no longer assume /api/hermes/* is on the same
// host as the incoming request (frontend on Vercel, Hermes runtime on a VPS).

const VALID_TOKEN = "a".repeat(MIN_HERMES_INTEGRATION_TOKEN_LENGTH);
const VALID_REMOTE_BASE_URL = "https://hermes.example-vps.com";
const VALID_LOCAL_BASE_URL = "http://127.0.0.1:3000";

describe("buildHermesIntegrationConfig — both absent (feature off)", () => {
  it("returns null when both HERMES_INTEGRATION_TOKEN and HERMES_INTEGRATION_BASE_URL are unset", () => {
    expect(buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: undefined, HERMES_INTEGRATION_BASE_URL: undefined })).toBeNull();
  });

  it("returns null when both are blank/whitespace-only", () => {
    expect(buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: "   ", HERMES_INTEGRATION_BASE_URL: "   " })).toBeNull();
  });
});

describe("buildHermesIntegrationConfig — half-configured pair always fails closed", () => {
  it("throws ConfigError when the token is set but HERMES_INTEGRATION_BASE_URL is missing", () => {
    expect(() => buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: VALID_TOKEN, HERMES_INTEGRATION_BASE_URL: undefined })).toThrow(
      ConfigError,
    );
    expect(() => buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: VALID_TOKEN, HERMES_INTEGRATION_BASE_URL: undefined })).toThrow(
      /HERMES_INTEGRATION_BASE_URL/,
    );
  });

  it("throws ConfigError when HERMES_INTEGRATION_BASE_URL is set but the token is missing", () => {
    expect(() =>
      buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: undefined, HERMES_INTEGRATION_BASE_URL: VALID_REMOTE_BASE_URL }),
    ).toThrow(ConfigError);
    expect(() =>
      buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: undefined, HERMES_INTEGRATION_BASE_URL: VALID_REMOTE_BASE_URL }),
    ).toThrow(/HERMES_INTEGRATION_TOKEN/);
  });
});

describe("buildHermesIntegrationConfig — token validation (unchanged)", () => {
  it("throws ConfigError when the token is set but shorter than the minimum length", () => {
    expect(() =>
      buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: "short-token", HERMES_INTEGRATION_BASE_URL: VALID_REMOTE_BASE_URL }),
    ).toThrow(ConfigError);
  });

  it("the ConfigError message never includes the actual token value", () => {
    const shortToken = "super-secret-but-too-short";
    try {
      buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: shortToken, HERMES_INTEGRATION_BASE_URL: VALID_REMOTE_BASE_URL });
      throw new Error("expected buildHermesIntegrationConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain(shortToken);
    }
  });

  it("accepts a token at exactly the minimum length", () => {
    const config = buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: VALID_TOKEN, HERMES_INTEGRATION_BASE_URL: VALID_REMOTE_BASE_URL });
    expect(config).toEqual({ token: VALID_TOKEN, baseUrl: VALID_REMOTE_BASE_URL });
  });

  it("accepts a token longer than the minimum length", () => {
    const longToken = VALID_TOKEN + "-extra-characters";
    const config = buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: longToken, HERMES_INTEGRATION_BASE_URL: VALID_REMOTE_BASE_URL });
    expect(config).toEqual({ token: longToken, baseUrl: VALID_REMOTE_BASE_URL });
  });
});

describe("buildHermesIntegrationConfig — HERMES_INTEGRATION_BASE_URL validation", () => {
  it("accepts a Vercel-style remote https:// base URL", () => {
    const config = buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: VALID_TOKEN, HERMES_INTEGRATION_BASE_URL: VALID_REMOTE_BASE_URL });
    expect(config?.baseUrl).toBe(VALID_REMOTE_BASE_URL);
  });

  it("accepts a local development http://127.0.0.1 base URL", () => {
    const config = buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: VALID_TOKEN, HERMES_INTEGRATION_BASE_URL: VALID_LOCAL_BASE_URL });
    expect(config?.baseUrl).toBe(VALID_LOCAL_BASE_URL);
  });

  it("accepts a local development http://localhost base URL", () => {
    const config = buildHermesIntegrationConfig({
      HERMES_INTEGRATION_TOKEN: VALID_TOKEN,
      HERMES_INTEGRATION_BASE_URL: "http://localhost:3000",
    });
    expect(config?.baseUrl).toBe("http://localhost:3000");
  });

  it("rejects a blank/whitespace-only HERMES_INTEGRATION_BASE_URL as if it were missing", () => {
    expect(() => buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: VALID_TOKEN, HERMES_INTEGRATION_BASE_URL: "   " })).toThrow(
      ConfigError,
    );
  });

  it("rejects a malformed (non-URL) HERMES_INTEGRATION_BASE_URL", () => {
    expect(() =>
      buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: VALID_TOKEN, HERMES_INTEGRATION_BASE_URL: "not a url at all" }),
    ).toThrow(ConfigError);
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() =>
      buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: VALID_TOKEN, HERMES_INTEGRATION_BASE_URL: "ftp://hermes.example.com" }),
    ).toThrow(ConfigError);
  });

  describe("HTTPS is required outside local development", () => {
    it("rejects a remote http:// base URL (not localhost/127.0.0.1/::1)", () => {
      expect(() =>
        buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: VALID_TOKEN, HERMES_INTEGRATION_BASE_URL: "http://hermes.example-vps.com" }),
      ).toThrow(ConfigError);
      expect(() =>
        buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: VALID_TOKEN, HERMES_INTEGRATION_BASE_URL: "http://hermes.example-vps.com" }),
      ).toThrow(/https/i);
    });

    it("rejects a remote http:// base URL even with a raw IP address host", () => {
      expect(() =>
        buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: VALID_TOKEN, HERMES_INTEGRATION_BASE_URL: "http://203.0.113.5:8080" }),
      ).toThrow(ConfigError);
    });

    it("accepts https:// for ::1 as a loopback exception too", () => {
      const config = buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: VALID_TOKEN, HERMES_INTEGRATION_BASE_URL: "http://[::1]:3000" });
      expect(config?.baseUrl).toBe("http://[::1]:3000");
    });
  });

  describe("trailing slash handling is safe", () => {
    it("strips a single trailing slash", () => {
      const config = buildHermesIntegrationConfig({
        HERMES_INTEGRATION_TOKEN: VALID_TOKEN,
        HERMES_INTEGRATION_BASE_URL: `${VALID_REMOTE_BASE_URL}/`,
      });
      expect(config?.baseUrl).toBe(VALID_REMOTE_BASE_URL);
    });

    it("strips multiple trailing slashes", () => {
      const config = buildHermesIntegrationConfig({
        HERMES_INTEGRATION_TOKEN: VALID_TOKEN,
        HERMES_INTEGRATION_BASE_URL: `${VALID_REMOTE_BASE_URL}///`,
      });
      expect(config?.baseUrl).toBe(VALID_REMOTE_BASE_URL);
    });

    it("a value with no trailing slash is left exactly as-is", () => {
      const config = buildHermesIntegrationConfig({ HERMES_INTEGRATION_TOKEN: VALID_TOKEN, HERMES_INTEGRATION_BASE_URL: VALID_REMOTE_BASE_URL });
      expect(config?.baseUrl).toBe(VALID_REMOTE_BASE_URL);
    });

    it("preserves a legitimate path prefix (e.g. a reverse-proxied deployment) while still stripping its own trailing slash", () => {
      const config = buildHermesIntegrationConfig({
        HERMES_INTEGRATION_TOKEN: VALID_TOKEN,
        HERMES_INTEGRATION_BASE_URL: "https://hermes.example-vps.com/proxy-prefix/",
      });
      expect(config?.baseUrl).toBe("https://hermes.example-vps.com/proxy-prefix");
    });
  });
});
