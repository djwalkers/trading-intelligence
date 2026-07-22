import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requireHermesAuth, withHermesGuard } from "@/lib/hermes-integration/auth";
import { resetHermesIntegrationConfigCacheForTests, MIN_HERMES_INTEGRATION_TOKEN_LENGTH } from "@/lib/hermes-integration/config";

const VALID_TOKEN = "a".repeat(MIN_HERMES_INTEGRATION_TOKEN_LENGTH);
const originalToken = process.env.HERMES_INTEGRATION_TOKEN;

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/hermes/health", { headers });
}

describe("requireHermesAuth", () => {
  beforeEach(() => {
    process.env.HERMES_INTEGRATION_TOKEN = VALID_TOKEN;
    resetHermesIntegrationConfigCacheForTests();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.HERMES_INTEGRATION_TOKEN;
    else process.env.HERMES_INTEGRATION_TOKEN = originalToken;
    resetHermesIntegrationConfigCacheForTests();
  });

  it("rejects a request with no Authorization header — 401", () => {
    const result = requireHermesAuth(makeRequest());
    expect(result).toEqual({ ok: false, status: 401, code: "UNAUTHORIZED", message: expect.any(String) });
  });

  it("rejects a request with an invalid/wrong token — 401", () => {
    const result = requireHermesAuth(makeRequest({ authorization: `Bearer ${"b".repeat(MIN_HERMES_INTEGRATION_TOKEN_LENGTH)}` }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("accepts a request with the correct token — ok: true", () => {
    const result = requireHermesAuth(makeRequest({ authorization: `Bearer ${VALID_TOKEN}` }));
    expect(result).toEqual({ ok: true });
  });

  it("rejects a malformed Authorization header — missing 'Bearer ' scheme", () => {
    const result = requireHermesAuth(makeRequest({ authorization: VALID_TOKEN }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a malformed Authorization header — 'Bearer' with no token", () => {
    const result = requireHermesAuth(makeRequest({ authorization: "Bearer" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed Authorization header — a different auth scheme", () => {
    const result = requireHermesAuth(makeRequest({ authorization: `Basic ${VALID_TOKEN}` }));
    expect(result.ok).toBe(false);
  });

  it("rejects every request when HERMES_INTEGRATION_TOKEN is not configured at all", () => {
    delete process.env.HERMES_INTEGRATION_TOKEN;
    resetHermesIntegrationConfigCacheForTests();
    const result = requireHermesAuth(makeRequest({ authorization: `Bearer ${VALID_TOKEN}` }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects every request when the configured token is invalid (too short)", () => {
    process.env.HERMES_INTEGRATION_TOKEN = "too-short";
    resetHermesIntegrationConfigCacheForTests();
    const result = requireHermesAuth(makeRequest({ authorization: `Bearer ${VALID_TOKEN}` }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("still authenticates correctly regardless of an x-forwarded-for header's value — that header is never trusted for allow/deny (see auth.ts's own doc comment: Next.js itself sets it on every request, including genuine local ones, and passes a client-supplied value through unchanged, so it cannot gate access without either blocking legitimate traffic or being trivially spoofed)", () => {
    const withSuspiciousHeader = requireHermesAuth(
      makeRequest({ authorization: `Bearer ${VALID_TOKEN}`, "x-forwarded-for": "1.2.3.4" }),
    );
    expect(withSuspiciousHeader).toEqual({ ok: true });

    const withLoopbackHeader = requireHermesAuth(
      makeRequest({ authorization: `Bearer ${VALID_TOKEN}`, "x-forwarded-for": "127.0.0.1" }),
    );
    expect(withLoopbackHeader).toEqual({ ok: true });
  });

  it("never reveals the configured token value in a failure result", () => {
    const result = requireHermesAuth(makeRequest({ authorization: "Bearer wrong-token-value" }));
    expect(JSON.stringify(result)).not.toContain(VALID_TOKEN);
  });
});

describe("withHermesGuard", () => {
  beforeEach(() => {
    process.env.HERMES_INTEGRATION_TOKEN = VALID_TOKEN;
    resetHermesIntegrationConfigCacheForTests();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.HERMES_INTEGRATION_TOKEN;
    else process.env.HERMES_INTEGRATION_TOKEN = originalToken;
    resetHermesIntegrationConfigCacheForTests();
  });

  it("returns the standard error envelope, with a 401 status, for an unauthenticated request", async () => {
    const response = await withHermesGuard(makeRequest(), async () => NextResponse.json({ ok: true }));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED", message: expect.any(String) }, meta: { timestamp: expect.any(String) } });
  });

  it("calls the handler and returns its response for an authenticated request", async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true, data: { hello: "world" } }));
    const response = await withHermesGuard(makeRequest({ authorization: `Bearer ${VALID_TOKEN}` }), handler);
    expect(handler).toHaveBeenCalledOnce();
    const body = await response.json();
    expect(body).toEqual({ ok: true, data: { hello: "world" } });
  });

  it("converts an unexpected thrown error into the standard error envelope, never a raw exception", async () => {
    const response = await withHermesGuard(makeRequest({ authorization: `Bearer ${VALID_TOKEN}` }), async () => {
      throw new Error("boom — something broke internally, with a stack trace attached");
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UNKNOWN_ERROR");
    expect(JSON.stringify(body)).not.toContain("boom");
    expect(JSON.stringify(body)).not.toContain(".ts:");
  });
});
