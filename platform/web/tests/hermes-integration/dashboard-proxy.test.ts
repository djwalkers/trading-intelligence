import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxyHermesGet, proxyOperationsProcessesGet } from "@/lib/hermes-integration/dashboard-proxy";
import { resetHermesIntegrationConfigCacheForTests, MIN_HERMES_INTEGRATION_TOKEN_LENGTH } from "@/lib/hermes-integration/config";

// Main Dashboard Hermes/eToro fix + split-deployment fix. proxyHermesGet is the ONE place the
// dashboard's own browser-facing routes bridge to the bearer-token-gated /api/hermes/* namespace,
// now potentially on an entirely different host (frontend on Vercel, Hermes runtime on a VPS) — see
// dashboard-proxy.ts's own doc comment. Every test here mocks global fetch; no real network call is
// ever made, and neither HERMES_INTEGRATION_TOKEN nor HERMES_INTEGRATION_BASE_URL is ever exposed
// in a response body.

const VALID_TOKEN = "a".repeat(MIN_HERMES_INTEGRATION_TOKEN_LENGTH);
const VERCEL_STYLE_REMOTE_BASE_URL = "https://hermes.example-vps.com";
const LOCAL_DEV_BASE_URL = "http://127.0.0.1:3000";
const originalToken = process.env.HERMES_INTEGRATION_TOKEN;
const originalBaseUrl = process.env.HERMES_INTEGRATION_BASE_URL;
const originalFetch = global.fetch;

function setEnv(token: string | undefined, baseUrl: string | undefined): void {
  if (token === undefined) delete process.env.HERMES_INTEGRATION_TOKEN;
  else process.env.HERMES_INTEGRATION_TOKEN = token;
  if (baseUrl === undefined) delete process.env.HERMES_INTEGRATION_BASE_URL;
  else process.env.HERMES_INTEGRATION_BASE_URL = baseUrl;
  resetHermesIntegrationConfigCacheForTests();
}

describe("proxyHermesGet", () => {
  beforeEach(() => {
    setEnv(VALID_TOKEN, VERCEL_STYLE_REMOTE_BASE_URL);
  });

  afterEach(() => {
    setEnv(originalToken, originalBaseUrl);
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("split-deployment base URL", () => {
    it("calls the exact upstream URL built from a Vercel-style remote HERMES_INTEGRATION_BASE_URL", async () => {
      setEnv(VALID_TOKEN, VERCEL_STYLE_REMOTE_BASE_URL);
      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await proxyHermesGet("portfolio");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe("https://hermes.example-vps.com/api/hermes/portfolio");
    });

    it("calls the exact upstream URL built from a local development HERMES_INTEGRATION_BASE_URL", async () => {
      setEnv(VALID_TOKEN, LOCAL_DEV_BASE_URL);
      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await proxyHermesGet("positions");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe("http://127.0.0.1:3000/api/hermes/positions");
    });

    it("resolves the same upstream URL whether or not HERMES_INTEGRATION_BASE_URL has a trailing slash", async () => {
      setEnv(VALID_TOKEN, `${VERCEL_STYLE_REMOTE_BASE_URL}/`);
      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await proxyHermesGet("summary");

      const [url] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe("https://hermes.example-vps.com/api/hermes/summary");
    });
  });

  it("attaches the bearer token server-side, never exposing either value to the caller", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, data: { cash: 100 } }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const response = await proxyHermesGet("portfolio");
    const body = await response.json();

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${VALID_TOKEN}`);
    const serialisedBody = JSON.stringify(body);
    expect(serialisedBody).not.toContain(VALID_TOKEN);
    expect(serialisedBody).not.toContain(VERCEL_STYLE_REMOTE_BASE_URL);
    expect(body).toEqual({ ok: true, data: { cash: 100 } });
  });

  it("forwards the upstream success status and envelope unchanged", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { positions: [] } }), { status: 200 })) as unknown as typeof fetch;

    const response = await proxyHermesGet("positions");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { positions: [] } });
  });

  it("forwards a genuine upstream 401 (e.g. a misconfigured token) as-is — a real unauthorised state, never masked", async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "bad token" } }), { status: 401 }),
    ) as unknown as typeof fetch;

    const response = await proxyHermesGet("portfolio");
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("forwards a genuine upstream 500 as-is", async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, error: { code: "UNKNOWN_ERROR", message: "boom" } }), { status: 500 }),
    ) as unknown as typeof fetch;

    const response = await proxyHermesGet("summary");
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it("returns a clear 502 (never throws) when the upstream response body is not valid JSON", async () => {
    global.fetch = vi.fn(async () => new Response("<html>not json</html>", { status: 200 })) as unknown as typeof fetch;

    const response = await proxyHermesGet("portfolio");
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UPSTREAM_MALFORMED_RESPONSE");
  });

  it("returns a clear 500 CONFIG_ERROR (never a raw exception), without ever calling fetch, when HERMES_INTEGRATION_BASE_URL is missing but the token is set — a half-configured pair", async () => {
    setEnv(VALID_TOKEN, undefined);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const response = await proxyHermesGet("portfolio");
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("CONFIG_ERROR");
    expect(body.error.message).toContain("HERMES_INTEGRATION_BASE_URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHORIZED itself, without ever calling fetch, when HERMES_INTEGRATION_TOKEN is missing", async () => {
    setEnv(undefined, undefined);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const response = await proxyHermesGet("portfolio");
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a 500 CONFIG_ERROR (never a raw exception) when only HERMES_INTEGRATION_BASE_URL is set — a half-configured pair", async () => {
    setEnv(undefined, VERCEL_STYLE_REMOTE_BASE_URL);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const response = await proxyHermesGet("portfolio");
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("CONFIG_ERROR");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a 502 (never throws) when the upstream fetch itself fails", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const response = await proxyHermesGet("summary");
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });
});

// Split-deployment defect fix. The Runtime Processes panel's browser-facing route must reach the
// VPS-side PM2 collector (GET /api/operations/processes) through this exact same bridge — never a
// direct browser call, which would execute (and fail) against Vercel's own copy of that route,
// where no PM2 process exists. proxyOperationsProcessesGet shares 100% of proxyHermesGet's own
// networking/config/error-handling logic (same internal proxyGet helper) — these tests only cover
// what differs: the upstream path, and that a 401/403 from the VPS collector (e.g. a misconfigured
// or missing HERMES_INTEGRATION_TOKEN on one side) is both forwarded faithfully to the browser AND
// logged server-side for diagnosis, without ever leaking the token itself into either.
describe("proxyOperationsProcessesGet", () => {
  beforeEach(() => {
    setEnv(VALID_TOKEN, VERCEL_STYLE_REMOTE_BASE_URL);
  });

  afterEach(() => {
    setEnv(originalToken, originalBaseUrl);
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("calls the VPS operations-processes endpoint, never /api/hermes/*", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, data: { processes: [] } }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await proxyOperationsProcessesGet();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://hermes.example-vps.com/api/operations/processes");
  });

  it("attaches the bearer token server-side, never exposing it in the response", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, data: { processes: [] } }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const response = await proxyOperationsProcessesGet();
    const body = await response.json();

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${VALID_TOKEN}`);
    const serialisedBody = JSON.stringify(body);
    expect(serialisedBody).not.toContain(VALID_TOKEN);
    expect(serialisedBody).not.toContain(VERCEL_STYLE_REMOTE_BASE_URL);
  });

  it("forwards the upstream success envelope unchanged", async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, data: { processes: [{ key: "web" }] } }), { status: 200 }),
    ) as unknown as typeof fetch;

    const response = await proxyOperationsProcessesGet();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { processes: [{ key: "web" }] } });
  });

  it("returns a clean degraded response (never a raw error) when the VPS is unreachable, and retains no secret in it", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:3000");
    }) as unknown as typeof fetch;

    const response = await proxyOperationsProcessesGet();
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.ok).toBe(false);
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(VALID_TOKEN);
    expect(serialised).not.toContain(VERCEL_STYLE_REMOTE_BASE_URL);
  });

  it("forwards a genuine upstream 401 (e.g. a misconfigured token) as-is, without leaking the token", async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "Missing or invalid credentials." } }), { status: 401 }),
    ) as unknown as typeof fetch;

    const response = await proxyOperationsProcessesGet();
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(JSON.stringify(body)).not.toContain(VALID_TOKEN);
  });

  it("returns 401 itself, without ever calling fetch, when HERMES_INTEGRATION_TOKEN is missing", async () => {
    setEnv(undefined, undefined);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const response = await proxyOperationsProcessesGet();
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
