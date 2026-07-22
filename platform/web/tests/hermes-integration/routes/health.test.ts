import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetHermesIntegrationConfigCacheForTests, MIN_HERMES_INTEGRATION_TOKEN_LENGTH } from "@/lib/hermes-integration/config";

const VALID_TOKEN = "a".repeat(MIN_HERMES_INTEGRATION_TOKEN_LENGTH);
const originalToken = process.env.HERMES_INTEGRATION_TOKEN;

const mockGetConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-execution/config", () => ({ getHermesExecutionConfig: mockGetConfig }));

const mockGetBrokerSnapshot = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-integration/broker-snapshot", () => ({ getBrokerSnapshot: mockGetBrokerSnapshot }));

const mockReadAuditLog = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-integration/audit-log-reader", () => ({ readHermesRuntimeAuditLog: mockReadAuditLog }));

import { GET } from "@/app/api/hermes/health/route";

function makeRequest(authorized = true): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/hermes/health", {
    headers: authorized ? { authorization: `Bearer ${VALID_TOKEN}` } : {},
  });
}

const BASE_CONFIG = {
  runtimeTrading: { mode: "demo" },
  brokerProvider: "etoro-demo",
  marketDataProvider: "live",
};

describe("GET /api/hermes/health", () => {
  beforeEach(() => {
    process.env.HERMES_INTEGRATION_TOKEN = VALID_TOKEN;
    resetHermesIntegrationConfigCacheForTests();
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue(BASE_CONFIG);
    mockGetBrokerSnapshot.mockResolvedValue({ ok: true, provider: "etoro-demo", accountMode: "demo", cash: 100, positions: [], positionsAreLiveGroundTruth: true });
    mockReadAuditLog.mockResolvedValue({ events: [], available: true });
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.HERMES_INTEGRATION_TOKEN;
    else process.env.HERMES_INTEGRATION_TOKEN = originalToken;
    resetHermesIntegrationConfigCacheForTests();
  });

  it("returns 401 with the standard error envelope when unauthenticated", async () => {
    const response = await GET(makeRequest(false));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" }, meta: { timestamp: expect.any(String) } });
  });

  it("returns the standard success envelope with the documented shape when everything is healthy", async () => {
    mockReadAuditLog.mockResolvedValue({
      events: [{ timestamp: "2026-01-01T00:00:00.000Z", eventType: "TRADING_RUNTIME_STARTED", executionRunId: "r1", details: { intervalMs: 60000 } }],
      available: true,
    });
    const response = await GET(makeRequest(true));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      data: {
        ok: true,
        status: "healthy",
        runtimeMode: "demo",
        brokerProvider: "etoro-demo",
        marketDataProvider: "live",
        components: { application: "healthy", broker: "healthy", marketData: "healthy", runtime: "RUNNING" },
        warnings: [],
      },
      meta: { timestamp: expect.any(String) },
    });
  });

  it("reports broker: unavailable and an overall unavailable status when the broker cannot connect", async () => {
    mockGetBrokerSnapshot.mockResolvedValue({ ok: false, message: "eToro connection refused" });
    const response = await GET(makeRequest(true));
    const body = await response.json();
    expect(body.data.components.broker).toBe("unavailable");
    expect(body.data.status).toBe("unavailable");
    expect(body.data.warnings.some((w: string) => w.includes("eToro connection refused"))).toBe(true);
  });

  it("reports runtime: unknown when no audit log is available, without crashing", async () => {
    mockReadAuditLog.mockResolvedValue({ events: [], available: false });
    const response = await GET(makeRequest(true));
    const body = await response.json();
    expect(body.data.components.runtime).toBe("unknown");
  });

  it("never includes a token or credential-shaped value in the response", async () => {
    const response = await GET(makeRequest(true));
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain(VALID_TOKEN);
  });
});
