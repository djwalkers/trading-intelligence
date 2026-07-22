import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetHermesIntegrationConfigCacheForTests, MIN_HERMES_INTEGRATION_TOKEN_LENGTH } from "@/lib/hermes-integration/config";

const VALID_TOKEN = "a".repeat(MIN_HERMES_INTEGRATION_TOKEN_LENGTH);
const originalToken = process.env.HERMES_INTEGRATION_TOKEN;

const mockGetConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-execution/config", () => ({ getHermesExecutionConfig: mockGetConfig }));

const mockReadAuditLog = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-integration/audit-log-reader", () => ({ readHermesRuntimeAuditLog: mockReadAuditLog }));

import { GET } from "@/app/api/hermes/runtime/route";

function makeRequest(): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/hermes/runtime", { headers: { authorization: `Bearer ${VALID_TOKEN}` } });
}

describe("GET /api/hermes/runtime", () => {
  beforeEach(() => {
    process.env.HERMES_INTEGRATION_TOKEN = VALID_TOKEN;
    resetHermesIntegrationConfigCacheForTests();
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue({ scheduler: { intervalMs: 60000 }, runtimeTrading: { mode: "demo" } });
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.HERMES_INTEGRATION_TOKEN;
    else process.env.HERMES_INTEGRATION_TOKEN = originalToken;
    resetHermesIntegrationConfigCacheForTests();
  });

  it("reports state: unknown and nextRunAt: null when no audit log exists yet — never invents data", async () => {
    mockReadAuditLog.mockResolvedValue({ events: [], available: true });
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      state: "unknown",
      startedAt: null,
      nextRunAt: null,
      successfulRunCount: 0,
      configuredIntervalMs: 60000,
      runtimeMode: "demo",
      observedFromAuditLog: true,
    });
  });

  it("reports observed RUNNING state and counts from the audit trail", async () => {
    mockReadAuditLog.mockResolvedValue({
      events: [
        { timestamp: "2026-01-01T00:00:00.000Z", eventType: "TRADING_RUNTIME_STARTED", executionRunId: "r1", details: { intervalMs: 60000 } },
        { timestamp: "2026-01-01T00:01:00.000Z", eventType: "TRADING_CYCLE_COMPLETED", executionRunId: "r1", details: {} },
      ],
      available: true,
    });
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.state).toBe("RUNNING");
    expect(body.data.successfulRunCount).toBe(1);
    expect(body.data.startedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("reports state: unknown (not STOPPED/crashed) when the audit log itself is unavailable", async () => {
    mockReadAuditLog.mockResolvedValue({ events: [], available: false });
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.state).toBe("unknown");
    expect(body.data.observedFromAuditLog).toBe(false);
  });
});
