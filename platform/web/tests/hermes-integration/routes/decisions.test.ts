import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetHermesIntegrationConfigCacheForTests, MIN_HERMES_INTEGRATION_TOKEN_LENGTH } from "@/lib/hermes-integration/config";

const VALID_TOKEN = "a".repeat(MIN_HERMES_INTEGRATION_TOKEN_LENGTH);
const originalToken = process.env.HERMES_INTEGRATION_TOKEN;

const mockReadAuditLog = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-integration/audit-log-reader", () => ({ readHermesRuntimeAuditLog: mockReadAuditLog }));

import { GET } from "@/app/api/hermes/decisions/route";

function makeRequest(query = ""): NextRequest {
  return new NextRequest(`http://127.0.0.1:3000/api/hermes/decisions${query}`, {
    headers: { authorization: `Bearer ${VALID_TOKEN}` },
  });
}

const EVENTS = [
  {
    timestamp: "2026-01-01T00:00:00.000Z",
    eventType: "MARKET_DECISION_RECEIVED",
    executionRunId: "run-1",
    instrument: "BTC",
    strategyId: "STRAT-0001",
    details: { action: "BUY", confidence: 0.7, reasoning: ["EMA20 above EMA50"], trend: "Bullish" },
  },
  {
    timestamp: "2026-01-02T00:00:00.000Z",
    eventType: "MARKET_DECISION_RECEIVED",
    executionRunId: "run-1",
    instrument: "ETH",
    strategyId: "STRAT-0001",
    details: { action: "HOLD", confidence: 0.5, reasoning: [], trend: "Sideways" },
  },
];

describe("GET /api/hermes/decisions", () => {
  beforeEach(() => {
    process.env.HERMES_INTEGRATION_TOKEN = VALID_TOKEN;
    resetHermesIntegrationConfigCacheForTests();
    vi.clearAllMocks();
    mockReadAuditLog.mockResolvedValue({ events: EVENTS, available: true });
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.HERMES_INTEGRATION_TOKEN;
    else process.env.HERMES_INTEGRATION_TOKEN = originalToken;
    resetHermesIntegrationConfigCacheForTests();
  });

  it("returns 400 with a stable error code for an invalid limit", async () => {
    const response = await GET(makeRequest("?limit=abc"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, error: { code: "INVALID_QUERY_PARAMETER" }, meta: { timestamp: expect.any(String) } });
  });

  it("returns 400 for a limit over 100", async () => {
    const response = await GET(makeRequest("?limit=101"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toContain("100");
  });

  it("returns 400 for an invalid since value", async () => {
    const response = await GET(makeRequest("?since=not-a-date"));
    expect(response.status).toBe(400);
  });

  it("returns 400 for an invalid outcome value", async () => {
    const response = await GET(makeRequest("?outcome=MAYBE"));
    expect(response.status).toBe(400);
  });

  it("applies valid symbol filtering and returns the standard success envelope", async () => {
    const response = await GET(makeRequest("?symbol=ETH"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.decisions).toHaveLength(1);
    expect(body.data.decisions[0].symbol).toBe("ETH");
    expect(body.data.filters).toEqual({ limit: 20, symbol: "ETH", outcome: null, since: null });
  });

  it("applies valid outcome filtering", async () => {
    const response = await GET(makeRequest("?outcome=buy"));
    const body = await response.json();
    expect(body.data.decisions).toHaveLength(1);
    expect(body.data.decisions[0].outcome).toBe("BUY");
  });

  it("returns newest first with no filters", async () => {
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.decisions.map((d: { symbol: string }) => d.symbol)).toEqual(["ETH", "BTC"]);
  });

  it("401s when unauthenticated, using the standard error envelope", async () => {
    const response = await GET(new NextRequest("http://127.0.0.1:3000/api/hermes/decisions"));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
  });
});
