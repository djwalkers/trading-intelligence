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

// Realised-P/L restart-consistency fix. GET /api/hermes/summary now sources realisedPnl from the
// SAME durable-realised-pnl.ts helper GET /api/hermes/portfolio uses — mocked here at the exact same
// boundary portfolio.test.ts mocks (getServiceRoleClient / buildAnalysisPersistenceConfig /
// SupabaseTradeLifecycleStore), never from the runtime audit log any more.
const { getServiceRoleClientMock, buildAnalysisPersistenceConfigMock, sumRealisedPnlForClosedTradesMock, countUnreconciledClosedTradesMock } = vi.hoisted(
  () => ({
    getServiceRoleClientMock: vi.fn(),
    buildAnalysisPersistenceConfigMock: vi.fn(),
    sumRealisedPnlForClosedTradesMock: vi.fn(),
    countUnreconciledClosedTradesMock: vi.fn(),
  }),
);

vi.mock("@/lib/supabase/service-role-client", () => ({ getServiceRoleClient: getServiceRoleClientMock }));
vi.mock("@/lib/hermes-execution/analysis/analysis-persistence-config", () => ({
  buildAnalysisPersistenceConfig: buildAnalysisPersistenceConfigMock,
}));
vi.mock("@/lib/hermes-execution/trade-lifecycle/supabase-trade-lifecycle-store", () => ({
  // A `function` expression, not an arrow function — the shared helper calls
  // `new SupabaseTradeLifecycleStore(...)`. Deliberately exposes ONLY the two bounded aggregate
  // methods — no list()/listClosed()/listUnreconciled() on this mock at all, so if the summary
  // route (or the shared helper) ever regressed to calling one of those, it would throw
  // "... is not a function" rather than silently succeeding.
  SupabaseTradeLifecycleStore: vi.fn().mockImplementation(function SupabaseTradeLifecycleStore() {
    return { sumRealisedPnlForClosedTrades: sumRealisedPnlForClosedTradesMock, countUnreconciledClosedTrades: countUnreconciledClosedTradesMock };
  }),
}));

import { GET } from "@/app/api/hermes/summary/route";

function makeRequest(): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/hermes/summary", {
    headers: { authorization: `Bearer ${VALID_TOKEN}` },
  });
}

const BASE_CONFIG = {
  runtimeTrading: { mode: "demo" },
  brokerProvider: "etoro-demo",
  marketDataProvider: "live",
  killSwitchEnabled: false,
  scheduler: { enabled: true, intervalMs: 60_000 },
};

describe("GET /api/hermes/summary — subsystem failure degradation", () => {
  beforeEach(() => {
    process.env.HERMES_INTEGRATION_TOKEN = VALID_TOKEN;
    process.env.HERMES_INTEGRATION_BASE_URL = VALID_BASE_URL;
    resetHermesIntegrationConfigCacheForTests();
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue(BASE_CONFIG);
    mockGetBrokerSnapshot.mockResolvedValue({ ok: true, provider: "etoro-demo", accountMode: "demo", cash: 100, positions: [], positionsAreLiveGroundTruth: true });
    mockReadAuditLog.mockResolvedValue({ events: [], available: true });

    // Durable persistence configured and healthy by default — individual tests override to
    // exercise degradation paths.
    buildAnalysisPersistenceConfigMock.mockReturnValue({ enabled: true, ownerUserId: "owner-1" });
    getServiceRoleClientMock.mockReturnValue({});
    sumRealisedPnlForClosedTradesMock.mockResolvedValue({ realisedPnl: 42, realisedTradeCount: 3 });
    countUnreconciledClosedTradesMock.mockResolvedValue(1);
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
    expect(body.data.portfolio.realisedPnl).toBe(42);
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
    // Realised-P/L restart-consistency fix. realisedPnl is independent of the audit log entirely —
    // an audit-log read failure must never take the durable realised P/L figure down with it.
    expect(body.data.portfolio.realisedPnl).toBe(42);
    expect(body.data.warnings.some((w: string) => w.includes("disk read failed"))).toBe(true);
  });

  it("does not crash when the audit log is simply unavailable (not an exception, just available:false)", async () => {
    mockReadAuditLog.mockResolvedValue({ events: [], available: false });
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.runtime).toBeNull();
    expect(body.data.warnings.length).toBeGreaterThan(0);
    // Same independence guarantee as the read-rejection case above.
    expect(body.data.portfolio.realisedPnl).toBe(42);
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
  // review, required test 12: "CLOSED_UNRECONCILED appears in summary/Telegram diagnostics"). Detail
  // records (timestamp/instrument/strategyId/lifecycleRecordId) have no durable equivalent — only a
  // durable COUNT exists (countUnreconciledClosedTrades) — so this stays audit-log-derived.
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

// Realised-P/L restart-consistency fix. Production evidence: GET /api/hermes/portfolio correctly
// reported a durable realisedPnl after a runtime restart, but GET /api/hermes/summary reported null
// — traced to summary's own former sumRealisedPnlSinceLastStart(auditLog.events), a process-session
// scan that returns null whenever no position has closed since the CURRENT process's own most recent
// TRADING_RUNTIME_STARTED event. These tests pin the fix and guard against regressing back to it.
describe("GET /api/hermes/summary — realised P/L restart consistency", () => {
  beforeEach(() => {
    process.env.HERMES_INTEGRATION_TOKEN = VALID_TOKEN;
    process.env.HERMES_INTEGRATION_BASE_URL = VALID_BASE_URL;
    resetHermesIntegrationConfigCacheForTests();
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue(BASE_CONFIG);
    mockGetBrokerSnapshot.mockResolvedValue({ ok: true, provider: "etoro-demo", accountMode: "demo", cash: 100, positions: [], positionsAreLiveGroundTruth: true });
    buildAnalysisPersistenceConfigMock.mockReturnValue({ enabled: true, ownerUserId: "owner-1" });
    getServiceRoleClientMock.mockReturnValue({});
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.HERMES_INTEGRATION_TOKEN;
    else process.env.HERMES_INTEGRATION_TOKEN = originalToken;
    if (originalBaseUrl === undefined) delete process.env.HERMES_INTEGRATION_BASE_URL;
    else process.env.HERMES_INTEGRATION_BASE_URL = originalBaseUrl;
    resetHermesIntegrationConfigCacheForTests();
  });

  it("returns the durable realised P/L after a simulated runtime restart with no closes yet this process run", async () => {
    // Mirrors the production evidence exactly: a fresh TRADING_RUNTIME_STARTED event (a restart
    // just happened) with no TRADE_CLOSED event anywhere after it — the old audit-log-scoped
    // calculation would return null here; the durable store has 37 historical closed trades.
    mockReadAuditLog.mockResolvedValue({
      events: [
        { timestamp: "2026-08-05T09:00:00.000Z", eventType: "TRADING_RUNTIME_STARTED", executionRunId: "run-2", instrument: "BTC", strategyId: "DEMO-0001", details: {} },
      ],
      available: true,
    });
    sumRealisedPnlForClosedTradesMock.mockResolvedValue({ realisedPnl: -0.12692509766610416, realisedTradeCount: 37 });
    countUnreconciledClosedTradesMock.mockResolvedValue(11);

    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.portfolio.realisedPnl).toBe(-0.12692509766610416);
    expect(body.data.warnings).toEqual([]);
  });

  it("summary and portfolio report the same realisedPnl for the same durable data — both derive it from the identical shared helper", async () => {
    sumRealisedPnlForClosedTradesMock.mockResolvedValue({ realisedPnl: 156.78, realisedTradeCount: 9 });
    countUnreconciledClosedTradesMock.mockResolvedValue(2);

    const { getDurableRealisedPnlSummary } = await import("@/lib/hermes-integration/durable-realised-pnl");
    const directResult = await getDurableRealisedPnlSummary();

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.data.portfolio.realisedPnl).toBe(directResult.realisedPnl);
    expect(body.data.portfolio.realisedPnl).toBe(156.78);
  });

  it("never uses an audit-log-derived realised P/L figure — a TRADE_CLOSED event's own detail.realisedPnl is ignored entirely", async () => {
    // If summary still summed TRADE_CLOSED events (the removed code path), this would report 999 —
    // asserting it reports the durable mock's value instead proves that path is gone.
    mockReadAuditLog.mockResolvedValue({
      events: [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          eventType: "TRADE_CLOSED",
          executionRunId: "run-1",
          instrument: "BTC",
          strategyId: "DEMO-0001",
          details: { realisedPnl: 999 },
        },
      ],
      available: true,
    });
    sumRealisedPnlForClosedTradesMock.mockResolvedValue({ realisedPnl: 5, realisedTradeCount: 1 });

    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.portfolio.realisedPnl).toBe(5);
    expect(body.data.portfolio.realisedPnl).not.toBe(999);
  });

  it("degrades safely (ok:true, realisedPnl:null, clear warning) when durable persistence is not configured", async () => {
    buildAnalysisPersistenceConfigMock.mockReturnValue({ enabled: false, ownerUserId: undefined });
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.portfolio.realisedPnl).toBeNull();
    expect(body.data.warnings.some((w: string) => w.includes("Durable realised P/L unavailable") && w.includes("not configured"))).toBe(true);
  });

  it("degrades safely (ok:true, realisedPnl:null, clear warning) when the durable store query itself fails", async () => {
    sumRealisedPnlForClosedTradesMock.mockRejectedValue(new Error("connection reset"));
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.portfolio.realisedPnl).toBeNull();
    expect(body.data.warnings.some((w: string) => w.includes("Durable realised P/L unavailable") && w.includes("connection reset"))).toBe(true);
  });

  it("never calls a full-row lifecycle list query — only the two bounded aggregate methods, each exactly once", async () => {
    sumRealisedPnlForClosedTradesMock.mockResolvedValue({ realisedPnl: 1, realisedTradeCount: 1 });
    countUnreconciledClosedTradesMock.mockResolvedValue(0);

    await GET(makeRequest());

    // The mocked SupabaseTradeLifecycleStore instance exposes ONLY these two methods — no list()/
    // listClosed()/listUnreconciled() at all — so calling either of those would have thrown, not
    // silently succeeded. Asserting call count 1 (never repeated — see requirement "avoid two
    // identical Supabase queries inside one summary request") completes the proof.
    expect(sumRealisedPnlForClosedTradesMock).toHaveBeenCalledTimes(1);
    expect(sumRealisedPnlForClosedTradesMock).toHaveBeenCalledWith();
    expect(countUnreconciledClosedTradesMock).toHaveBeenCalledTimes(1);
    expect(countUnreconciledClosedTradesMock).toHaveBeenCalledWith();
  });
});

// Runtime Processes panel (Operations Centre). Additive fields on the existing `health` object —
// sourced from the SAME HermesExecutionConfig the route already reads for runtimeMode/
// brokerProvider, never a new business-logic path or Supabase call.
describe("GET /api/hermes/summary — killSwitchEnabled / schedulerEnabled / schedulerIntervalMs (Runtime Processes panel)", () => {
  beforeEach(() => {
    process.env.HERMES_INTEGRATION_TOKEN = VALID_TOKEN;
    process.env.HERMES_INTEGRATION_BASE_URL = VALID_BASE_URL;
    resetHermesIntegrationConfigCacheForTests();
    vi.clearAllMocks();
    mockGetBrokerSnapshot.mockResolvedValue({ ok: true, provider: "etoro-demo", accountMode: "demo", cash: 100, positions: [], positionsAreLiveGroundTruth: true });
    mockReadAuditLog.mockResolvedValue({ events: [], available: true });
    buildAnalysisPersistenceConfigMock.mockReturnValue({ enabled: false, ownerUserId: undefined });
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.HERMES_INTEGRATION_TOKEN;
    else process.env.HERMES_INTEGRATION_TOKEN = originalToken;
    if (originalBaseUrl === undefined) delete process.env.HERMES_INTEGRATION_BASE_URL;
    else process.env.HERMES_INTEGRATION_BASE_URL = originalBaseUrl;
    resetHermesIntegrationConfigCacheForTests();
  });

  it("surfaces killSwitchEnabled: true when the kill switch is on", async () => {
    mockGetConfig.mockReturnValue({ ...BASE_CONFIG, killSwitchEnabled: true });
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.health.killSwitchEnabled).toBe(true);
  });

  it("surfaces killSwitchEnabled: false when the kill switch is off", async () => {
    mockGetConfig.mockReturnValue({ ...BASE_CONFIG, killSwitchEnabled: false });
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.health.killSwitchEnabled).toBe(false);
  });

  it("surfaces schedulerEnabled and schedulerIntervalMs from config.scheduler", async () => {
    mockGetConfig.mockReturnValue({ ...BASE_CONFIG, scheduler: { enabled: true, intervalMs: 60_000 } });
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.health.schedulerEnabled).toBe(true);
    expect(body.data.health.schedulerIntervalMs).toBe(60_000);
  });

  it("surfaces schedulerEnabled: false with the configured interval still reported (interval is independent of the on/off flag)", async () => {
    mockGetConfig.mockReturnValue({ ...BASE_CONFIG, scheduler: { enabled: false, intervalMs: 30_000 } });
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.health.schedulerEnabled).toBe(false);
    expect(body.data.health.schedulerIntervalMs).toBe(30_000);
  });

  it("degrades all three new fields to null (never a guessed default) when config itself fails to load", async () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("bad config");
    });
    const response = await GET(makeRequest());
    expect(response.status).toBe(200); // still ok:true overall — see the existing config-error degradation test
    const body = await response.json();
    expect(body.data.health.killSwitchEnabled).toBeNull();
    expect(body.data.health.schedulerEnabled).toBeNull();
    expect(body.data.health.schedulerIntervalMs).toBeNull();
  });
});
