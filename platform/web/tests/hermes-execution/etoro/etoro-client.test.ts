import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EtoroApiError, EtoroClient, EtoroTimeoutError, ETORO_BASE_URL } from "@/lib/hermes-execution/etoro/etoro-client";

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

// Prototype V1 — Reliability Fix. Confirmed via live testing (see the mission report) that an
// unbounded eToro request can hang a trading cycle — and, transitively, TradingRuntime.stop() —
// indefinitely. Every test here uses fake timers so "time passes without a response" never involves
// a real wait.
describe("EtoroClient — bounded request timeout", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Simulates a real fetch() honouring an AbortSignal: the returned promise only ever settles
   * (by rejecting, exactly like a real aborted fetch) when the signal passed to it fires — it never
   * resolves on its own, modelling a request that never gets a response. */
  function hangingFetch(): ReturnType<typeof vi.fn> {
    return vi.fn((_url: URL, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted.");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
  }

  it("a request completing well within the timeout succeeds normally", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { instrumentDisplayDatas: [] }));
    const client = new EtoroClient(API_KEY, USER_KEY, 5_000);
    await expect(client.searchInstruments("BTC")).resolves.toEqual({ instrumentDisplayDatas: [] });
  });

  it("throws a typed EtoroTimeoutError once the configured timeout elapses with no response", async () => {
    fetchMock.mockImplementation(hangingFetch());
    const client = new EtoroClient(API_KEY, USER_KEY, 5_000);

    const pending = client.searchInstruments("BTC");
    const assertion = expect(pending).rejects.toBeInstanceOf(EtoroTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("the timeout error names the operation and configured timeout, never the URL, headers, or body", async () => {
    fetchMock.mockImplementation(hangingFetch());
    const client = new EtoroClient(API_KEY, USER_KEY, 5_000);

    const pending = client.searchInstruments("BTC");
    const check = (async () => {
      try {
        await pending;
        throw new Error("expected searchInstruments to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(EtoroTimeoutError);
        const timeoutError = error as EtoroTimeoutError;
        expect(timeoutError.operation).toBe("searchInstruments");
        expect(timeoutError.timeoutMs).toBe(5_000);
        expect(timeoutError.message).toBe("eToro searchInstruments timed out after 5000ms.");
        expect(timeoutError.message).not.toContain(API_KEY);
        expect(timeoutError.message).not.toContain(USER_KEY);
        expect(timeoutError.message).not.toContain(ETORO_BASE_URL);
      }
    })();
    await vi.advanceTimersByTimeAsync(5_000);
    await check;
  });

  it("defaults to a 10s timeout when the caller supplies none", async () => {
    fetchMock.mockImplementation(hangingFetch());
    const client = new EtoroClient(API_KEY, USER_KEY); // no timeoutMs argument

    const pending = client.searchInstruments("BTC");
    const assertion = expect(pending).rejects.toMatchObject({ timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("does not time out prematurely — a response arriving just before the bound still succeeds", async () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const client = new EtoroClient(API_KEY, USER_KEY, 5_000);

    const pending = client.searchInstruments("BTC");
    await vi.advanceTimersByTimeAsync(4_000); // well before the 5s bound
    resolveFetch(jsonResponse(200, { instrumentDisplayDatas: [] }));
    await expect(pending).resolves.toEqual({ instrumentDisplayDatas: [] });
  });
});
