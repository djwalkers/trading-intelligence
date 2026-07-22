import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetHermesIntegrationConfigCacheForTests, MIN_HERMES_INTEGRATION_TOKEN_LENGTH } from "@/lib/hermes-integration/config";

const VALID_TOKEN = "a".repeat(MIN_HERMES_INTEGRATION_TOKEN_LENGTH);
const originalToken = process.env.HERMES_INTEGRATION_TOKEN;

const { getMarketDiagnosticsMock } = vi.hoisted(() => ({ getMarketDiagnosticsMock: vi.fn() }));
vi.mock("@/lib/hermes-execution/market-diagnostics-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hermes-execution/market-diagnostics-service")>(
    "@/lib/hermes-execution/market-diagnostics-service",
  );
  return { ...actual, getMarketDiagnostics: getMarketDiagnosticsMock };
});

const { GET } = await import("@/app/api/hermes/market-diagnostics/route");
const { MarketDiagnosticsError } = await import("@/lib/hermes-execution/market-diagnostics-service");

function makeRequest(authorized = true): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/hermes/market-diagnostics", {
    headers: authorized ? { authorization: `Bearer ${VALID_TOKEN}` } : {},
  });
}

const SAMPLE_DIAGNOSTICS = {
  instrument: "BTC",
  provider: "live" as const,
  brokerProvider: "etoro-demo" as const,
  timeframe: "1h" as const,
  requestedCandleCount: 200,
  receivedCandleCount: 200,
  fetchedAt: "2026-01-01T00:00:00.000Z",
  firstCandleTimestamp: "2025-12-23T00:00:00.000Z",
  lastCandleTimestamp: "2026-01-01T00:00:00.000Z",
  currentQuote: { bid: 50_000, ask: 50_010, mid: 50_005 },
  lastClosedCandle: { timestamp: "2026-01-01T00:00:00.000Z", open: 49_990, high: 50_010, low: 49_980, close: 50_000, volume: 12 },
  indicators: { ema20: 50_000, ema50: 49_900, rsi14: 55, atr14: 100, trend: "Bullish" as const },
  series: { timestamps: ["2026-01-01T00:00:00.000Z"], ema20: [50_000], ema50: [49_900], rsi14: [55] },
  validation: {
    fallbackOccurred: false as const,
    dataAgeSeconds: 30,
    maxCandleAgeSeconds: 7_200,
    volumeAvailable: true,
    duplicateTimestampsPassed: true as const,
    ohlcValidationPassed: true as const,
    staleDataValidationPassed: true as const,
  },
  candles: [{ timestamp: "2026-01-01T00:00:00.000Z", open: 49_990, high: 50_010, low: 49_980, close: 50_000 }],
};

describe("GET /api/hermes/market-diagnostics", () => {
  beforeEach(() => {
    process.env.HERMES_INTEGRATION_TOKEN = VALID_TOKEN;
    resetHermesIntegrationConfigCacheForTests();
    getMarketDiagnosticsMock.mockReset();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.HERMES_INTEGRATION_TOKEN;
    else process.env.HERMES_INTEGRATION_TOKEN = originalToken;
    resetHermesIntegrationConfigCacheForTests();
  });

  it("returns 401 with the standard error envelope when unauthenticated, and never calls the diagnostics service", async () => {
    const response = await GET(makeRequest(false));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(getMarketDiagnosticsMock).not.toHaveBeenCalled();
  });

  it("returns { ok: true, diagnostics } with status 200 on success", async () => {
    getMarketDiagnosticsMock.mockResolvedValue(SAMPLE_DIAGNOSTICS);
    const response = await GET(makeRequest(true));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, diagnostics: SAMPLE_DIAGNOSTICS });
  });

  it("returns { ok: false, error: { code, message } } with a mapped status on a MarketDiagnosticsError", async () => {
    getMarketDiagnosticsMock.mockRejectedValue(new MarketDiagnosticsError("CANDLE_VALIDATION_FAILED", "insufficient candles"));
    const response = await GET(makeRequest(true));
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toEqual({ ok: false, error: { code: "CANDLE_VALIDATION_FAILED", message: "insufficient candles" } });
  });

  it("maps BROKER_NOT_CONFIGURED/UNSUPPORTED_BROKER to 503", async () => {
    getMarketDiagnosticsMock.mockRejectedValue(new MarketDiagnosticsError("BROKER_NOT_CONFIGURED", "missing credentials"));
    const response = await GET(makeRequest(true));
    expect(response.status).toBe(503);
  });

  it("maps an unrecognised error code to 500", async () => {
    getMarketDiagnosticsMock.mockRejectedValue(new Error("something unexpected"));
    const response = await GET(makeRequest(true));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("DIAGNOSTICS_FAILED");
    expect(body.error.message).toBe("something unexpected");
  });

  it("never calls placeMarketOrder/closePosition or any execution method — this route only ever calls getMarketDiagnostics", async () => {
    getMarketDiagnosticsMock.mockResolvedValue(SAMPLE_DIAGNOSTICS);
    await GET(makeRequest(true));
    expect(getMarketDiagnosticsMock).toHaveBeenCalledTimes(1);
    expect(getMarketDiagnosticsMock).toHaveBeenCalledWith(); // no order/execution-shaped arguments
  });

  it("never includes a token, credential, or account identifier in the response", async () => {
    getMarketDiagnosticsMock.mockResolvedValue(SAMPLE_DIAGNOSTICS);
    const response = await GET(makeRequest(true));
    const body = await response.json();
    const text = JSON.stringify(body);
    expect(text).not.toContain(VALID_TOKEN);
    expect(text.toLowerCase()).not.toMatch(/apikey|api_key|userkey|user_key|password|accountid|account_id/);
  });

  it("sets no-store cache headers on both success and failure", async () => {
    getMarketDiagnosticsMock.mockResolvedValue(SAMPLE_DIAGNOSTICS);
    const success = await GET(makeRequest(true));
    expect(success.headers.get("Cache-Control")).toContain("no-store");

    getMarketDiagnosticsMock.mockRejectedValue(new MarketDiagnosticsError("CANDLE_FETCH_FAILED", "timeout"));
    const failure = await GET(makeRequest(true));
    expect(failure.headers.get("Cache-Control")).toContain("no-store");
  });
});
