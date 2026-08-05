import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetHermesIntegrationConfigCacheForTests, MIN_HERMES_INTEGRATION_TOKEN_LENGTH } from "@/lib/hermes-integration/config";

const VALID_TOKEN = "a".repeat(MIN_HERMES_INTEGRATION_TOKEN_LENGTH);
const VALID_BASE_URL = "https://hermes.example-vps.com";
const originalToken = process.env.HERMES_INTEGRATION_TOKEN;
const originalBaseUrl = process.env.HERMES_INTEGRATION_BASE_URL;

const mockGetBrokerSnapshot = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-integration/broker-snapshot", () => ({ getBrokerSnapshot: mockGetBrokerSnapshot }));

// Egress-containment fix (production incident: Supabase egress ~800% over the Free-plan quota,
// this exact route polled every 30s by the dashboard): the route no longer calls listClosed()/
// listUnreconciled() (full-row select("*"), JSONB `detail` blob included) — it calls the store's own
// bounded aggregate methods instead (sumRealisedPnlForClosedTrades selects only realised_pnl;
// countUnreconciledClosedTrades is a count-only query). Mocked here at that same boundary.
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
  // A `function` expression, not an arrow function — the route calls `new SupabaseTradeLifecycleStore(...)`.
  SupabaseTradeLifecycleStore: vi.fn().mockImplementation(function SupabaseTradeLifecycleStore() {
    return { sumRealisedPnlForClosedTrades: sumRealisedPnlForClosedTradesMock, countUnreconciledClosedTrades: countUnreconciledClosedTradesMock };
  }),
}));

const { GET } = await import("@/app/api/hermes/portfolio/route");

function makeRequest(): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/hermes/portfolio", { headers: { authorization: `Bearer ${VALID_TOKEN}` } });
}

function makePosition(overrides: Record<string, unknown> = {}) {
  return {
    instrument: "1001",
    side: "BUY",
    quantity: 50,
    units: 2,
    entryPrice: 100,
    currentPrice: 110,
    unrealisedPnl: 20,
    pricingTimestamp: "2026-01-01T00:00:00.000Z",
    pricingSource: "broker",
    openedAt: null,
    provider: "etoro-demo",
    accountMode: "demo",
    brokerPositionId: "5001",
    ...overrides,
  };
}

describe("GET /api/hermes/portfolio", () => {
  beforeEach(() => {
    process.env.HERMES_INTEGRATION_TOKEN = VALID_TOKEN;
    process.env.HERMES_INTEGRATION_BASE_URL = VALID_BASE_URL;
    resetHermesIntegrationConfigCacheForTests();
    vi.clearAllMocks();

    mockGetBrokerSnapshot.mockResolvedValue({
      ok: true,
      provider: "etoro-demo",
      accountMode: "demo",
      cash: 900,
      positions: [makePosition()],
      positionsAreLiveGroundTruth: true,
      unrealisedPnlComplete: true,
      unrealisedPnlUnavailableReason: null,
    });

    buildAnalysisPersistenceConfigMock.mockReturnValue({ enabled: true, ownerUserId: "owner-1" });
    getServiceRoleClientMock.mockReturnValue({});
    sumRealisedPnlForClosedTradesMock.mockResolvedValue({ realisedPnl: 20, realisedTradeCount: 2 }); // 25 + (-5)
    countUnreconciledClosedTradesMock.mockResolvedValue(0);
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.HERMES_INTEGRATION_TOKEN;
    else process.env.HERMES_INTEGRATION_TOKEN = originalToken;
    if (originalBaseUrl === undefined) delete process.env.HERMES_INTEGRATION_BASE_URL;
    else process.env.HERMES_INTEGRATION_BASE_URL = originalBaseUrl;
    resetHermesIntegrationConfigCacheForTests();
  });

  it("returns cash, investedValue, realisedPnl (durable, aggregated), unrealisedPnl, and calculated equity", async () => {
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      accountMode: "demo",
      provider: "etoro-demo",
      cash: 900,
      investedValue: 50,
      realisedPnl: 20, // 25 + (-5)
      realisedTradeCount: 2,
      unreconciledClosedTradeCount: 0,
      unrealisedPnl: 20,
      unrealisedPnlComplete: true,
      unrealisedPnlUnavailableReason: null,
      equity: 900 + 50 + 20,
      equitySource: "CALCULATED",
      openPositionCount: 1,
      currency: "USD",
      positionsAreLiveGroundTruth: true,
    });
    expect(typeof body.data.realisedPnlScope).toBe("string");
    expect(body.data.realisedPnlScope).not.toContain("audit log is not durable");
  });

  it("excludes CLOSED_UNRECONCILED trades from the realised P/L sum but reports their count separately", async () => {
    // The store's own sumRealisedPnlForClosedTrades/countUnreconciledClosedTrades already exclude
    // CLOSED_UNRECONCILED from the sum server-side (status = CLOSED only) / count it separately
    // (status = CLOSED_UNRECONCILED only) — this route trusts those pre-aggregated figures verbatim.
    sumRealisedPnlForClosedTradesMock.mockResolvedValue({ realisedPnl: 25, realisedTradeCount: 1 });
    countUnreconciledClosedTradesMock.mockResolvedValue(2);

    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.realisedPnl).toBe(25);
    expect(body.data.realisedTradeCount).toBe(1);
    expect(body.data.unreconciledClosedTradeCount).toBe(2);
  });

  it("never counts a CLOSED record with no confirmed realisedPnl as a zero-P/L trade", async () => {
    // sumRealisedPnlForClosedTrades itself is responsible for this exclusion now (never fabricating
    // a figure for a CLOSED row missing realised_pnl) — see its own dedicated store-level tests
    // (trade-lifecycle-store.test.ts / supabase-trade-lifecycle-store.test.ts) for that guarantee;
    // this route-level test only pins that the route reports whatever the store returns verbatim.
    sumRealisedPnlForClosedTradesMock.mockResolvedValue({ realisedPnl: 25, realisedTradeCount: 1 });

    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.realisedPnl).toBe(25);
    expect(body.data.realisedTradeCount).toBe(1);
  });

  it("returns realisedPnl: null with a clear scope message when trade lifecycle persistence is not configured", async () => {
    buildAnalysisPersistenceConfigMock.mockReturnValue({ enabled: false, ownerUserId: undefined });
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.realisedPnl).toBeNull();
    expect(body.data.realisedTradeCount).toBe(0);
    expect(body.data.unreconciledClosedTradeCount).toBe(0);
    expect(body.data.realisedPnlScope).toContain("not configured");
  });

  it("returns realisedPnl: null (never throws) when the trade lifecycle store query fails", async () => {
    sumRealisedPnlForClosedTradesMock.mockRejectedValue(new Error("connection reset"));
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.realisedPnl).toBeNull();
    expect(body.data.realisedPnlScope).toContain("connection reset");
  });

  it("reports unrealisedPnl: null and equity: UNAVAILABLE when the broker snapshot's own total is incomplete", async () => {
    mockGetBrokerSnapshot.mockResolvedValue({
      ok: true,
      provider: "etoro-demo",
      accountMode: "demo",
      cash: 900,
      positions: [makePosition({ currentPrice: null, unrealisedPnl: null, pricingSource: "unavailable" })],
      positionsAreLiveGroundTruth: true,
      unrealisedPnlComplete: false,
      unrealisedPnlUnavailableReason: "Could not fetch a live price for: 1001.",
    });

    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.unrealisedPnl).toBeNull();
    expect(body.data.unrealisedPnlComplete).toBe(false);
    expect(body.data.unrealisedPnlUnavailableReason).toBe("Could not fetch a live price for: 1001.");
    expect(body.data.equity).toBeNull();
    expect(body.data.equitySource).toBe("UNAVAILABLE");
  });

  it("aggregates unrealisedPnl across multiple positions correctly", async () => {
    mockGetBrokerSnapshot.mockResolvedValue({
      ok: true,
      provider: "etoro-demo",
      accountMode: "demo",
      cash: 900,
      positions: [
        makePosition({ instrument: "1001", quantity: 50, unrealisedPnl: 20 }),
        makePosition({ instrument: "1002", quantity: 30, unrealisedPnl: -8 }),
      ],
      positionsAreLiveGroundTruth: true,
      unrealisedPnlComplete: true,
      unrealisedPnlUnavailableReason: null,
    });

    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.investedValue).toBe(80);
    expect(body.data.unrealisedPnl).toBe(12);
    expect(body.data.equity).toBe(900 + 80 + 12);
  });

  it("returns 503 when the broker is unavailable", async () => {
    mockGetBrokerSnapshot.mockResolvedValue({ ok: false, message: "eToro timeout" });
    const response = await GET(makeRequest());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("BROKER_UNAVAILABLE");
  });
});
