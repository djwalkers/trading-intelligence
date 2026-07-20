import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Trading212ApiError, Trading212Client, TRADING212_DEMO_BASE_URL } from "@/lib/hermes-execution/trading212/trading212-client";

const API_KEY = "test-api-key-value";
const API_SECRET = "test-api-secret-value";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function emptyErrorResponse(status: number): Response {
  return new Response("", { status });
}

describe("Trading212Client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("only ever calls the demo base URL, never any other host", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 1, currencyCode: "USD" }));
    const client = new Trading212Client(API_KEY, API_SECRET);
    await client.getAccountInfo();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith(TRADING212_DEMO_BASE_URL)).toBe(true);
    expect(TRADING212_DEMO_BASE_URL).toBe("https://demo.trading212.com");
  });

  it("sends HTTP Basic auth: Authorization: Basic base64(apiKey:apiSecret)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 1, currencyCode: "USD" }));
    const client = new Trading212Client(API_KEY, API_SECRET);
    await client.getAccountInfo();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const expectedEncoded = Buffer.from(`${API_KEY}:${API_SECRET}`, "utf-8").toString("base64");
    expect(headers.Authorization).toBe(`Basic ${expectedEncoded}`);
  });

  it("never sends the raw key or secret directly (must be Basic-encoded, not a raw header value)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 1, currencyCode: "USD" }));
    const client = new Trading212Client(API_KEY, API_SECRET);
    await client.getAccountInfo();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).not.toBe(API_KEY);
    expect(headers.Authorization).not.toContain(API_KEY);
    expect(headers.Authorization).not.toContain(API_SECRET);
    expect(headers.Authorization?.startsWith("Basic ")).toBe(true);
  });

  it("throws Trading212ApiError with a clear message for an invalid (401) API key", async () => {
    fetchMock.mockResolvedValue(emptyErrorResponse(401));
    const client = new Trading212Client(API_KEY, API_SECRET);

    await expect(client.getAccountInfo()).rejects.toThrow(Trading212ApiError);
    await expect(client.getAccountInfo()).rejects.toThrow(/Bad API key/i);
  });

  it("throws a clear error for a missing scope (403)", async () => {
    fetchMock.mockResolvedValue(emptyErrorResponse(403));
    const client = new Trading212Client(API_KEY, API_SECRET);
    await expect(client.getAccountCash()).rejects.toThrow(/missing a required scope/i);
  });

  it("throws a clear error including the rejection code for a failed order (400)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { code: "InsufficientResources" }));
    const client = new Trading212Client(API_KEY, API_SECRET);
    await expect(client.placeMarketOrder("AAPL_US_EQ", 1)).rejects.toThrow(/InsufficientResources/);
  });

  it("never includes the API key or secret in a thrown error's message", async () => {
    fetchMock.mockResolvedValueOnce(emptyErrorResponse(401));
    const client = new Trading212Client(API_KEY, API_SECRET);
    try {
      await client.getAccountInfo();
      throw new Error("expected getAccountInfo to throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(API_KEY);
      expect((error as Error).message).not.toContain(API_SECRET);
    }
  });

  it("submits quantity as given (positive buys, negative sells) with no sign inversion", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        id: 1,
        ticker: "AAPL_US_EQ",
        type: "MARKET",
        status: "FILLED",
        strategy: "QUANTITY",
        filledQuantity: 1,
        filledValue: 100,
        creationTime: "2026-01-01T00:00:00Z",
      }),
    );
    const client = new Trading212Client(API_KEY, API_SECRET);
    await client.placeMarketOrder("AAPL_US_EQ", -1.5);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ ticker: "AAPL_US_EQ", quantity: -1.5 });
  });
});
