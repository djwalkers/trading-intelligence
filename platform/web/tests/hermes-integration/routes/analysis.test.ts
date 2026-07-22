import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetHermesIntegrationConfigCacheForTests, MIN_HERMES_INTEGRATION_TOKEN_LENGTH } from "@/lib/hermes-integration/config";

const VALID_TOKEN = "a".repeat(MIN_HERMES_INTEGRATION_TOKEN_LENGTH);
const originalToken = process.env.HERMES_INTEGRATION_TOKEN;

const { getServiceRoleClientMock, buildAnalysisPersistenceConfigMock, getRecentAnalysesMock } = vi.hoisted(() => ({
  getServiceRoleClientMock: vi.fn(),
  buildAnalysisPersistenceConfigMock: vi.fn(),
  getRecentAnalysesMock: vi.fn(),
}));

vi.mock("@/lib/supabase/service-role-client", () => ({ getServiceRoleClient: getServiceRoleClientMock }));
vi.mock("@/lib/hermes-execution/analysis/analysis-persistence-config", () => ({
  buildAnalysisPersistenceConfig: buildAnalysisPersistenceConfigMock,
}));
vi.mock("@/lib/hermes-execution/analysis/analysis-repository", () => ({
  // A `function` expression, not an arrow function, so `new SupabaseAnalysisRepository(...)` (the
  // route's own construction call) works — vi.fn().mockImplementation() with an arrow function
  // can't be invoked with `new`.
  SupabaseAnalysisRepository: vi.fn().mockImplementation(function SupabaseAnalysisRepository() {
    return { getRecentAnalyses: getRecentAnalysesMock };
  }),
}));

const { GET } = await import("@/app/api/hermes/analysis/route");

function makeRequest(query = "", authorized = true): NextRequest {
  return new NextRequest(`http://127.0.0.1:3000/api/hermes/analysis${query}`, {
    headers: authorized ? { authorization: `Bearer ${VALID_TOKEN}` } : {},
  });
}

const SAMPLE_RUN = {
  id: "run-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  instrument: "BTC",
  decision: "BUY",
  executedTrade: true,
};

describe("GET /api/hermes/analysis", () => {
  beforeEach(() => {
    process.env.HERMES_INTEGRATION_TOKEN = VALID_TOKEN;
    resetHermesIntegrationConfigCacheForTests();
    getServiceRoleClientMock.mockReset();
    buildAnalysisPersistenceConfigMock.mockReset();
    getRecentAnalysesMock.mockReset();

    buildAnalysisPersistenceConfigMock.mockReturnValue({ enabled: true, ownerUserId: "owner-1" });
    getServiceRoleClientMock.mockReturnValue({});
    getRecentAnalysesMock.mockResolvedValue([SAMPLE_RUN]);
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.HERMES_INTEGRATION_TOKEN;
    else process.env.HERMES_INTEGRATION_TOKEN = originalToken;
    resetHermesIntegrationConfigCacheForTests();
  });

  it("returns 401 with the standard error envelope when unauthenticated, and never queries the repository", async () => {
    const response = await GET(makeRequest("", false));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(getRecentAnalysesMock).not.toHaveBeenCalled();
  });

  it("returns { ok: true, analyses, count } on success", async () => {
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, analyses: [SAMPLE_RUN], count: 1 });
  });

  it("returns 503 when analysis persistence is not configured", async () => {
    buildAnalysisPersistenceConfigMock.mockReturnValue({ enabled: false, ownerUserId: undefined });
    const response = await GET(makeRequest());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("ANALYSIS_PERSISTENCE_NOT_CONFIGURED");
  });

  it("returns 503 when the service role client is unavailable", async () => {
    getServiceRoleClientMock.mockReturnValue(null);
    const response = await GET(makeRequest());
    expect(response.status).toBe(503);
  });

  it("returns 502 with a safe message when the repository throws", async () => {
    getRecentAnalysesMock.mockRejectedValue(new Error("query failed"));
    const response = await GET(makeRequest());
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe("ANALYSIS_FETCH_FAILED");
    expect(body.error.message).toBe("query failed");
  });

  it("parses instrument/decision/strategy/date/limit query params into a filter", async () => {
    await GET(makeRequest("?instrument=BTC&decision=BUY&strategy=DEMO-0001&date=2026-01-01&limit=25"));
    expect(getRecentAnalysesMock).toHaveBeenCalledWith({
      instrument: "BTC",
      decision: "BUY",
      strategyId: "DEMO-0001",
      since: "2026-01-01",
      limit: 25,
    });
  });

  it("returns 400 for an invalid decision value", async () => {
    const response = await GET(makeRequest("?decision=NOT_A_DECISION"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_FILTER");
  });

  it("returns 400 for a non-positive limit", async () => {
    const response = await GET(makeRequest("?limit=-5"));
    expect(response.status).toBe(400);
  });

  it("returns 400 for an invalid retention value", async () => {
    const response = await GET(makeRequest("?retention=999d"));
    expect(response.status).toBe(400);
  });

  it("caps an excessive limit at 1000", async () => {
    await GET(makeRequest("?limit=50000"));
    expect(getRecentAnalysesMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }));
  });

  it("sets no-store cache headers on both success and failure", async () => {
    const success = await GET(makeRequest());
    expect(success.headers.get("Cache-Control")).toContain("no-store");

    getRecentAnalysesMock.mockRejectedValue(new Error("fail"));
    const failure = await GET(makeRequest());
    expect(failure.headers.get("Cache-Control")).toContain("no-store");
  });

  it("never includes a token or credential-shaped value in the response", async () => {
    const response = await GET(makeRequest());
    const body = await response.json();
    const text = JSON.stringify(body);
    expect(text).not.toContain(VALID_TOKEN);
    expect(text.toLowerCase()).not.toMatch(/apikey|api_key|userkey|user_key|password|servicerolekey/);
  });
});
