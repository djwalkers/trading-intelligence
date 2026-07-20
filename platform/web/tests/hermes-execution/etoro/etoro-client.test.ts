import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EtoroApiError, EtoroClient, ETORO_BASE_URL } from "@/lib/hermes-execution/etoro/etoro-client";

const API_KEY = "test-api-key-value";
const USER_KEY = "test-user-key-value";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function emptyErrorResponse(status: number): Response {
  return new Response("", { status });
}

describe("EtoroClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("only ever calls the official public-api.etoro.com host", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { instrumentDisplayDatas: [] }));
    const client = new EtoroClient(API_KEY, USER_KEY);
    await client.searchInstruments("BTC");

    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString().startsWith(ETORO_BASE_URL)).toBe(true);
    expect(ETORO_BASE_URL).toBe("https://public-api.etoro.com");
  });

  it("sends x-api-key and x-user-key headers, never a combined/raw credential string", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { instrumentDisplayDatas: [] }));
    const client = new EtoroClient(API_KEY, USER_KEY);
    await client.searchInstruments("BTC");

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(API_KEY);
    expect(headers["x-user-key"]).toBe(USER_KEY);
    expect(headers["x-request-id"]).toBeTruthy();
  });

  it("sends a well-formed UUID x-request-id, unique on every request", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { instrumentDisplayDatas: [] }));
    const client = new EtoroClient(API_KEY, USER_KEY);
    await client.searchInstruments("BTC");
    await client.searchInstruments("ETH");

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const [, init1] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const [, init2] = fetchMock.mock.calls[1] as [URL, RequestInit];
    const id1 = (init1.headers as Record<string, string>)["x-request-id"];
    const id2 = (init2.headers as Record<string, string>)["x-request-id"];

    expect(id1).toMatch(uuidPattern);
    expect(id2).toMatch(uuidPattern);
    expect(id1).not.toBe(id2);
  });

  it("searchInstruments issues a GET against /api/v1/market-data/instruments with searchText", async () => {
    // Confirmed live: /api/v1/market-data/search is a real, different endpoint (an unrelated
    // market-screener dataset) — /api/v1/market-data/instruments is the correct instrument-
    // metadata source (see etoro-client.ts's EtoroInstrumentSearchResult doc comment).
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { instrumentDisplayDatas: [] }));
    const client = new EtoroClient(API_KEY, USER_KEY);
    await client.searchInstruments("BTC");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect((init.method ?? "GET").toUpperCase()).toBe("GET");
    expect(url.pathname).toBe("/api/v1/market-data/instruments");
    expect(url.searchParams.get("searchText")).toBe("BTC");
  });

  it("getRates issues a GET against /api/v1/market-data/instruments/rates with comma-separated ids", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { rates: [] }));
    const client = new EtoroClient(API_KEY, USER_KEY);
    await client.getRates([100, 200]);

    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/api/v1/market-data/instruments/rates");
    expect(url.searchParams.get("instrumentIds")).toBe("100,200");
  });

  it("getDemoPortfolio issues a GET against the documented demo trading-info path", async () => {
    // Real shape confirmed live: everything nested under clientPortfolio, not returned flat.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { clientPortfolio: { positions: [], orders: [], credit: 0 } }));
    const client = new EtoroClient(API_KEY, USER_KEY);
    await client.getDemoPortfolio();

    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/api/v1/trading/info/demo/portfolio");
  });

  it("placeDemoMarketOrder POSTs the unified v2 demo route with the documented body shape", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { positionId: 555 }));
    const client = new EtoroClient(API_KEY, USER_KEY);
    await client.placeDemoMarketOrder({ instrumentId: 1001, isBuy: true, amount: 50, orderCurrency: "usd" });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/api/v2/trading/execution/demo/orders");
    expect((init.method ?? "").toUpperCase()).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      action: "open",
      transaction: "buy",
      instrumentId: 1001,
      orderType: "mkt",
      leverage: 1,
      amount: 50,
      orderCurrency: "usd",
    });
  });

  it("placeDemoMarketOrder never targets the real (non-demo) v2 route", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { positionId: 555 }));
    const client = new EtoroClient(API_KEY, USER_KEY);
    await client.placeDemoMarketOrder({ instrumentId: 1, isBuy: true, amount: 1, orderCurrency: "usd" });

    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).not.toBe("/api/v2/trading/execution/orders");
    expect(url.pathname).toContain("/demo/");
  });

  it("closeDemoPosition POSTs to a path structurally containing '/demo/', never the real close route", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: "abc" }));
    const client = new EtoroClient(API_KEY, USER_KEY);
    await client.closeDemoPosition(1001, 555);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/api/v1/trading/execution/demo/market-close-orders/positions/555");
    expect(url.pathname).toContain("/demo/");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ instrumentId: 1001, unitsToDeduct: null });
  });

  it("cancelPendingCloseOrder issues a DELETE to a path structurally containing '/demo/'", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: "abc" }));
    const client = new EtoroClient(API_KEY, USER_KEY);
    await client.cancelPendingCloseOrder(777);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect((init.method ?? "").toUpperCase()).toBe("DELETE");
    expect(url.pathname).toBe("/api/v1/trading/execution/demo/market-close-orders/777");
    expect(url.pathname).toContain("/demo/");
  });

  it("throws EtoroApiError with operation, status, requestId, and a safe message for a failed request", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { message: "Invalid instrument" }));
    const client = new EtoroClient(API_KEY, USER_KEY);

    try {
      await client.searchInstruments("XX");
      throw new Error("expected searchInstruments to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EtoroApiError);
      const apiError = error as EtoroApiError;
      expect(apiError.operation).toBe("searchInstruments");
      expect(apiError.status).toBe(400);
      expect(apiError.requestId).toBeTruthy();
      expect(apiError.safeMessage).toBe("Invalid instrument");
    }
  });

  it("extracts a broker error code when supplied", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(422, { errorCode: "INSTRUMENT_NOT_TRADABLE", message: "Not tradable" }));
    const client = new EtoroClient(API_KEY, USER_KEY);

    try {
      await client.searchInstruments("XX");
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as EtoroApiError).brokerErrorCode).toBe("INSTRUMENT_NOT_TRADABLE");
    }
  });

  it("falls back to a generic safe message when the error body has none of the known message fields", async () => {
    fetchMock.mockResolvedValueOnce(emptyErrorResponse(500));
    const client = new EtoroClient(API_KEY, USER_KEY);

    try {
      await client.searchInstruments("XX");
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as EtoroApiError).safeMessage).toBe("eToro API request failed with status 500.");
    }
  });

  it("never includes the API key or user key in a thrown error's message", async () => {
    fetchMock.mockResolvedValueOnce(emptyErrorResponse(401));
    const client = new EtoroClient(API_KEY, USER_KEY);

    try {
      await client.searchInstruments("XX");
      throw new Error("expected to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(API_KEY);
      expect(message).not.toContain(USER_KEY);
    }
  });
});
