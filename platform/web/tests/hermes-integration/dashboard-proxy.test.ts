import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxyHermesGet } from "@/lib/hermes-integration/dashboard-proxy";
import { resetHermesIntegrationConfigCacheForTests, MIN_HERMES_INTEGRATION_TOKEN_LENGTH } from "@/lib/hermes-integration/config";

// Main Dashboard Hermes/eToro fix. proxyHermesGet is the ONE place the dashboard's own browser-
// facing routes bridge to the bearer-token-gated /api/hermes/* namespace — see dashboard-proxy.ts's
// own doc comment. Every test here mocks global fetch; no real network call is ever made.

const VALID_TOKEN = "a".repeat(MIN_HERMES_INTEGRATION_TOKEN_LENGTH);
const originalToken = process.env.HERMES_INTEGRATION_TOKEN;
const originalFetch = global.fetch;

function makeRequest(): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/dashboard/hermes-portfolio");
}

describe("proxyHermesGet", () => {
  beforeEach(() => {
    process.env.HERMES_INTEGRATION_TOKEN = VALID_TOKEN;
    resetHermesIntegrationConfigCacheForTests();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.HERMES_INTEGRATION_TOKEN;
    else process.env.HERMES_INTEGRATION_TOKEN = originalToken;
    resetHermesIntegrationConfigCacheForTests();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("attaches the bearer token to the exact upstream /api/hermes/<path> URL, never exposing it to the caller", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, data: { cash: 100 } }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const response = await proxyHermesGet(makeRequest(), "portfolio");
    const body = await response.json();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/hermes/portfolio");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${VALID_TOKEN}`);
    expect(JSON.stringify(body)).not.toContain(VALID_TOKEN);
    expect(body).toEqual({ ok: true, data: { cash: 100 } });
  });

  it("forwards the upstream success status and envelope unchanged", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { positions: [] } }), { status: 200 })) as unknown as typeof fetch;

    const response = await proxyHermesGet(makeRequest(), "positions");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { positions: [] } });
  });

  it("forwards a genuine upstream 401 (e.g. a misconfigured token) as-is — a real unauthorised state, never masked", async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "bad token" } }), { status: 401 }),
    ) as unknown as typeof fetch;

    const response = await proxyHermesGet(makeRequest(), "portfolio");
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 UNAUTHORIZED itself, without ever calling fetch, when HERMES_INTEGRATION_TOKEN is not configured", async () => {
    delete process.env.HERMES_INTEGRATION_TOKEN;
    resetHermesIntegrationConfigCacheForTests();
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const response = await proxyHermesGet(makeRequest(), "portfolio");
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a 502 (never throws) when the upstream fetch itself fails", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const response = await proxyHermesGet(makeRequest(), "summary");
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });
});
