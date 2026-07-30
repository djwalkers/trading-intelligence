import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetHermesIntegrationConfigCacheForTests, MIN_HERMES_INTEGRATION_TOKEN_LENGTH } from "@/lib/hermes-integration/config";

const VALID_TOKEN = "a".repeat(MIN_HERMES_INTEGRATION_TOKEN_LENGTH);
const VALID_BASE_URL = "https://hermes.example-vps.com";
const originalToken = process.env.HERMES_INTEGRATION_TOKEN;
const originalBaseUrl = process.env.HERMES_INTEGRATION_BASE_URL;

const mockGetConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-execution/config", () => ({ getHermesExecutionConfig: mockGetConfig }));

const mockGetBrokerSnapshot = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-integration/broker-snapshot", () => ({ getBrokerSnapshot: mockGetBrokerSnapshot }));

const mockReadAuditLog = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-integration/audit-log-reader", () => ({ readHermesRuntimeAuditLog: mockReadAuditLog }));

import { GET } from "@/app/api/hermes/summary/route";

function makeRequest(): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/hermes/summary", {
    headers: { authorization: `Bearer ${VALID_TOKEN}` },
  });
}

const BASE_CONFIG = { runtimeTrading: { mode: "demo" }, brokerProvider: "etoro-demo", marketDataProvider: "live" };

describe("GET /api/hermes/summary — subsystem failure degradation", () => {
  beforeEach(() => {
    process.env.HERMES_INTEGRATION_TOKEN = VALID_TOKEN;
    process.env.HERMES_INTEGRATION_BASE_URL = VALID_BASE_URL;
    resetHermesIntegrationConfigCacheForTests();
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue(BASE_CONFIG);
    mockGetBrokerSnapshot.mockResolvedValue({ ok: true, provider: "etoro-demo", accountMode: "demo", cash: 100, positions: [], positionsAreLiveGroundTruth: true });
    mockReadAuditLog.mockResolvedValue({ events: [], available: true });
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.HERMES_INTEGRATION_TOKEN;
    else process.env.HERMES_INTEGRATION_TOKEN = originalToken;
    if (originalBaseUrl === undefined) delete process.env.HERMES_INTEGRATION_BASE_URL;
    else process.env.HERMES_INTEGRATION_BASE_URL = originalBaseUrl;
    resetHermesIntegrationConfigCacheForTests();
  });

  it("returns ok:true with a full body when every subsystem succeeds", async () => {
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.portfolio).not.toBeNull();
    expect(body.data.warnings).toEqual([]);
  });

  it("does not crash when getBrokerSnapshot() rejects — degrades with a warning instead", async () => {
    mockGetBrokerSnapshot.mockRejectedValue(new Error("unexpected broker crash"));
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.portfolio).toBeNull();
    expect(body.data.openPositionCount).toBeNull();
    expect(body.data.warnings.some((w: string) => w.includes("unexpected broker crash"))).toBe(true);
  });

  it("does not crash when getBrokerSnapshot() resolves with ok:false", async () => {
    mockGetBrokerSnapshot.mockResolvedValue({ ok: false, message: "eToro unreachable" });
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.portfolio).toBeNull();
    expect(body.data.warnings.some((w: string) => w.includes("eToro unreachable"))).toBe(true);
  });

  it("does not crash when the audit log read rejects — runtime/decisions degrade, portfolio still reported", async () => {
    mockReadAuditLog.mockRejectedValue(new Error("disk read failed"));
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.runtime).toBeNull();
    expect(body.data.latestDecision).toBeNull();
    expect(body.data.portfolio).not.toBeNull(); // broker subsystem is independent, still succeeded
    expect(body.data.warnings.some((w: string) => w.includes("disk read failed"))).toBe(true);
  });

  it("does not crash when the audit log is simply unavailable (not an exception, just available:false)", async () => {
    mockReadAuditLog.mockResolvedValue({ events: [], available: false });
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.runtime).toBeNull();
    expect(body.data.warnings.length).toBeGreaterThan(0);
  });

  it("does not crash when getHermesExecutionConfig() throws", async () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("bad config");
    });
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.health.runtimeMode).toBe("unknown");
    expect(body.data.warnings.some((w: string) => w.includes("bad config"))).toBe(true);
  });

  it("still returns 401 via the standard error envelope when unauthenticated — the guard runs before any subsystem", async () => {
    const response = await GET(new NextRequest("http://127.0.0.1:3000/api/hermes/summary"));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(mockGetBrokerSnapshot).not.toHaveBeenCalled();
  });

  it("never includes the configured token anywhere in the response, even under failure", async () => {
    mockGetBrokerSnapshot.mockRejectedValue(new Error("crash"));
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain(VALID_TOKEN);
  });

  // Restart-Resilient Autonomy Phase — CLOSED_UNRECONCILED operator visibility (deployment safety
  // review, required test 12: "CLOSED_UNRECONCILED appears in summary/Telegram diagnostics").
  it("surfaces a CLOSED_UNRECONCILED closure in both unreconciledClosures and warnings", async () => {
    mockReadAuditLog.mockResolvedValue({
      events: [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          eventType: "BROKER_RECONCILIATION_MISMATCH",
          executionRunId: "run-1",
          instrument: "BTC",
          strategyId: "DEMO-0001",
          details: { resolution: "reconciled-closed-unreconciled", lifecycleRecordId: "lifecycle-1" },
        },
      ],
      available: true,
    });
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.unreconciledClosures).toEqual([
      { timestamp: "2026-01-01T00:00:00.000Z", instrument: "BTC", strategyId: "DEMO-0001", lifecycleRecordId: "lifecycle-1" },
    ]);
    expect(body.data.warnings.some((w: string) => w.includes("CLOSED_UNRECONCILED"))).toBe(true);
  });

  it("returns an empty unreconciledClosures array (never omitted) when there are none", async () => {
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.unreconciledClosures).toEqual([]);
  });
});
