import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetHermesIntegrationConfigCacheForTests, MIN_HERMES_INTEGRATION_TOKEN_LENGTH } from "@/lib/hermes-integration/config";

const VALID_TOKEN = "a".repeat(MIN_HERMES_INTEGRATION_TOKEN_LENGTH);
const originalToken = process.env.HERMES_INTEGRATION_TOKEN;

const mockGetBrokerSnapshot = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-integration/broker-snapshot", () => ({ getBrokerSnapshot: mockGetBrokerSnapshot }));

import { GET } from "@/app/api/hermes/positions/route";

function makeRequest(): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/hermes/positions", { headers: { authorization: `Bearer ${VALID_TOKEN}` } });
}

describe("GET /api/hermes/positions", () => {
  beforeEach(() => {
    process.env.HERMES_INTEGRATION_TOKEN = VALID_TOKEN;
    resetHermesIntegrationConfigCacheForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.HERMES_INTEGRATION_TOKEN;
    else process.env.HERMES_INTEGRATION_TOKEN = originalToken;
    resetHermesIntegrationConfigCacheForTests();
  });

  it("returns the standard success envelope with live positions", async () => {
    mockGetBrokerSnapshot.mockResolvedValue({
      ok: true,
      provider: "etoro-demo",
      accountMode: "demo",
      cash: 100,
      positions: [{ instrument: "1001", side: "BUY", quantity: 50, entryPrice: 100, currentPrice: null, unrealisedPnl: null, openedAt: null, provider: "etoro-demo", accountMode: "demo" }],
      positionsAreLiveGroundTruth: true,
    });
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, data: { count: 1, provider: "etoro-demo", positionsAreLiveGroundTruth: true }, meta: { timestamp: expect.any(String) } });
  });

  it("returns 503 with a stable error code when the broker is unavailable — never fabricates positions", async () => {
    mockGetBrokerSnapshot.mockResolvedValue({ ok: false, message: "eToro connection refused" });
    const response = await GET(makeRequest());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, error: { code: "BROKER_UNAVAILABLE", message: "eToro connection refused" } });
  });

  it("401s when unauthenticated", async () => {
    const response = await GET(new NextRequest("http://127.0.0.1:3000/api/hermes/positions"));
    expect(response.status).toBe(401);
  });
});
