import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetHermesIntegrationConfigCacheForTests, MIN_HERMES_INTEGRATION_TOKEN_LENGTH } from "@/lib/hermes-integration/config";

const VALID_TOKEN = "a".repeat(MIN_HERMES_INTEGRATION_TOKEN_LENGTH);
const originalToken = process.env.HERMES_INTEGRATION_TOKEN;

const mockGetBrokerSnapshot = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-integration/broker-snapshot", () => ({ getBrokerSnapshot: mockGetBrokerSnapshot }));

const mockReadAuditLog = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-integration/audit-log-reader", () => ({ readHermesRuntimeAuditLog: mockReadAuditLog }));

import { GET } from "@/app/api/hermes/portfolio/route";

function makeRequest(): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/hermes/portfolio", { headers: { authorization: `Bearer ${VALID_TOKEN}` } });
}

describe("GET /api/hermes/portfolio", () => {
  beforeEach(() => {
    process.env.HERMES_INTEGRATION_TOKEN = VALID_TOKEN;
    resetHermesIntegrationConfigCacheForTests();
    vi.clearAllMocks();
    mockGetBrokerSnapshot.mockResolvedValue({
      ok: true,
      provider: "etoro-demo",
      accountMode: "demo",
      cash: 900,
      positions: [{ instrument: "1001", side: "BUY", quantity: 50, entryPrice: 100, currentPrice: null, unrealisedPnl: null, openedAt: null, provider: "etoro-demo", accountMode: "demo" }],
      positionsAreLiveGroundTruth: true,
    });
    mockReadAuditLog.mockResolvedValue({
      events: [{ timestamp: "2026-01-01T00:00:00.000Z", eventType: "TRADE_CLOSED", executionRunId: "run-1", details: { realisedPnl: 25 } }],
      available: true,
    });
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.HERMES_INTEGRATION_TOKEN;
    else process.env.HERMES_INTEGRATION_TOKEN = originalToken;
    resetHermesIntegrationConfigCacheForTests();
  });

  it("returns cash, investedValue, and realisedPnl in the standard success envelope", async () => {
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      accountMode: "demo",
      provider: "etoro-demo",
      cash: 900,
      investedValue: 50,
      realisedPnl: 25,
      unrealisedPnl: null,
      equity: null,
      openPositionCount: 1,
    });
  });

  it("returns realisedPnl: null when the audit log is unavailable, never fabricating zero", async () => {
    mockReadAuditLog.mockResolvedValue({ events: [], available: false });
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.realisedPnl).toBeNull();
  });

  it("returns 503 when the broker is unavailable", async () => {
    mockGetBrokerSnapshot.mockResolvedValue({ ok: false, message: "eToro timeout" });
    const response = await GET(makeRequest());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("BROKER_UNAVAILABLE");
  });
});
