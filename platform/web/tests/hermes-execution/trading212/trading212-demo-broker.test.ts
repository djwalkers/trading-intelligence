import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Trading212DemoBroker,
  Trading212OrderPendingError,
  resolveSessionState,
} from "@/lib/hermes-execution/trading212/trading212-demo-broker";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { Trading212DemoConfig } from "@/lib/hermes-execution/config";
import type { OrderRequest } from "@/lib/hermes-execution/types";

const TEST_API_KEY = "test-api-key-value";
const TEST_API_SECRET = "test-api-secret-value";

const TEST_CONFIG: Trading212DemoConfig = {
  apiKey: TEST_API_KEY,
  apiSecret: TEST_API_SECRET,
  executionEnabled: true,
  testInstrument: "AAPL_US_EQ",
  testOrderQuantity: 0.01,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Routes {
  accountInfo: () => Response;
  accountCash: () => Response;
  instruments: () => Response;
  exchanges: () => Response;
  order: (body: { ticker: string; quantity: number }) => Response;
  getOrder: (id: number) => Response;
  cancelOrder: (id: number) => Response;
}

function defaultRoutes(overrides: Partial<Routes> = {}): Routes {
  return {
    accountInfo: () => jsonResponse(200, { id: 1, currencyCode: "USD" }),
    accountCash: () => jsonResponse(200, { free: 1000, total: 1000, invested: 0, ppl: 0, result: 0 }),
    // Shape matches a real, live GET /api/v0/equity/metadata/instruments response for AAPL_US_EQ
    // (verified against the actual API — see docs/trading212-demo-adapter-phase-1.md): notably, no
    // `minTradeQuantity` field exists, despite the OpenAPI spec documenting one.
    instruments: () =>
      jsonResponse(200, [
        {
          ticker: "AAPL_US_EQ",
          type: "STOCK",
          workingScheduleId: 71,
          isin: "US0378331005",
          currencyCode: "USD",
          name: "Apple",
          shortName: "AAPL",
          maxOpenQuantity: 44156,
          extendedHours: true,
          addedOn: "2018-07-12T07:10:11.000+03:00",
        },
      ]),
    // Shape matches a real, live GET /api/v0/equity/metadata/exchanges response for NASDAQ
    // (workingScheduleId 71, matching AAPL_US_EQ's instrument metadata above): a chronological
    // list of session-boundary events. Covers a single trading day: pre-market -> open -> after
    // hours -> closed for the (long) overnight/weekend gap that follows.
    exchanges: () =>
      jsonResponse(200, [
        {
          id: 53,
          name: "NASDAQ",
          workingSchedules: [
            {
              id: 71,
              timeEvents: [
                { date: "2026-01-05T08:00:00.000Z", type: "PRE_MARKET_OPEN" },
                { date: "2026-01-05T13:30:00.000Z", type: "OPEN" },
                { date: "2026-01-05T20:00:00.000Z", type: "AFTER_HOURS_OPEN" },
                { date: "2026-01-06T00:00:00.000Z", type: "AFTER_HOURS_CLOSE" },
              ],
            },
          ],
        },
      ]),
    order: () =>
      jsonResponse(200, {
        id: 111,
        ticker: "AAPL_US_EQ",
        type: "MARKET",
        status: "FILLED",
        strategy: "QUANTITY",
        filledQuantity: 0.01,
        filledValue: 2,
        creationTime: "2026-01-01T00:00:00Z",
      }),
    getOrder: (id) =>
      jsonResponse(200, {
        id,
        ticker: "AAPL_US_EQ",
        type: "MARKET",
        status: "FILLED",
        strategy: "QUANTITY",
        filledQuantity: 0.01,
        filledValue: 2,
        creationTime: "2026-01-01T00:00:00Z",
      }),
    cancelOrder: () => new Response("", { status: 200 }),
    ...overrides,
  };
}

function makeFetchMock(routes: Routes) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(url as string);
    const method = (init?.method ?? "GET").toUpperCase();

    if (u.pathname === "/api/v0/equity/account/info") return routes.accountInfo();
    if (u.pathname === "/api/v0/equity/account/cash") return routes.accountCash();
    if (u.pathname === "/api/v0/equity/metadata/instruments") return routes.instruments();
    if (u.pathname === "/api/v0/equity/metadata/exchanges") return routes.exchanges();
    if (u.pathname === "/api/v0/equity/orders/market" && method === "POST") {
      return routes.order(JSON.parse(init!.body as string));
    }
    const orderIdMatch = /^\/api\/v0\/equity\/orders\/(\d+)$/.exec(u.pathname);
    if (orderIdMatch && method === "GET") return routes.getOrder(Number(orderIdMatch[1]));
    if (orderIdMatch && method === "DELETE") return routes.cancelOrder(Number(orderIdMatch[1]));
    throw new Error(`Unhandled mock route: ${method} ${u.pathname}`);
  });
}

function baseOrder(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    strategyId: "TRADING212-SMOKE-TEST",
    strategyVersion: 1,
    sourceType: "DEMO_ONLY",
    instrument: "AAPL_US_EQ",
    side: "BUY",
    quantity: 0.01,
    price: 0,
    timestamp: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeBroker(routes: Routes = defaultRoutes()) {
  vi.stubGlobal("fetch", makeFetchMock(routes));
  const auditTrail = new InMemoryAuditTrail();
  const broker = new Trading212DemoBroker({ config: TEST_CONFIG, auditTrail, executionRunId: "test-run" });
  return { broker, auditTrail };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Trading212DemoBroker — construction safety", () => {
  it("refuses to construct without TRADING212_DEMO_EXECUTION_ENABLED", () => {
    const auditTrail = new InMemoryAuditTrail();
    expect(
      () => new Trading212DemoBroker({ config: { ...TEST_CONFIG, executionEnabled: false }, auditTrail, executionRunId: "r" }),
    ).toThrow(/TRADING212_DEMO_EXECUTION_ENABLED/);
  });

  it("refuses to construct without an API key", () => {
    const auditTrail = new InMemoryAuditTrail();
    expect(
      () => new Trading212DemoBroker({ config: { ...TEST_CONFIG, apiKey: undefined }, auditTrail, executionRunId: "r" }),
    ).toThrow();
  });

  it("refuses to construct without an API secret", () => {
    const auditTrail = new InMemoryAuditTrail();
    expect(
      () => new Trading212DemoBroker({ config: { ...TEST_CONFIG, apiSecret: undefined }, auditTrail, executionRunId: "r" }),
    ).toThrow(/TRADING212_API_SECRET/);
  });
});

describe("Trading212DemoBroker — successful connection", () => {
  it("connects, mapping account/cash into Account and confirming the instrument list", async () => {
    const { broker } = makeBroker();
    await broker.connect();
    expect(broker.hasInstrument("AAPL_US_EQ")).toBe(true);
    expect(broker.hasInstrument("MSFT_US_EQ")).toBe(false);
    expect(broker.getAccount()).toEqual({ cashBalance: 1000, startingCashBalance: 1000 });
  });

  it("records BROKER_CONNECTION_ATTEMPTED then BROKER_CONNECTION_SUCCEEDED, with no secret in the details", async () => {
    const { broker, auditTrail } = makeBroker();
    await broker.connect();
    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["BROKER_CONNECTION_ATTEMPTED", "BROKER_CONNECTION_SUCCEEDED"]);
    expect(JSON.stringify(events)).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(events)).not.toContain(TEST_API_SECRET);
  });

  it("records BROKER_CONNECTION_FAILED and rethrows on an invalid API key (401)", async () => {
    const { broker, auditTrail } = makeBroker(defaultRoutes({ accountInfo: () => new Response("", { status: 401 }) }));
    await expect(broker.connect()).rejects.toThrow(/Bad API key/i);
    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["BROKER_CONNECTION_ATTEMPTED", "BROKER_CONNECTION_FAILED"]);
    expect(JSON.stringify(events)).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(events)).not.toContain(TEST_API_SECRET);
  });
});

describe("Trading212DemoBroker — account mapping", () => {
  it("maps Cash.free to cashBalance and Cash.total to startingCashBalance", async () => {
    const { broker } = makeBroker(
      defaultRoutes({ accountCash: () => jsonResponse(200, { free: 456.78, total: 999.99, invested: 0, ppl: 0, result: 0 }) }),
    );
    await broker.connect();
    expect(broker.getAccount()).toEqual({ cashBalance: 456.78, startingCashBalance: 999.99 });
  });
});

describe("Trading212DemoBroker — order and position mapping", () => {
  it("maps a filled order response into a PaperPosition using filledValue/filledQuantity as the average price", async () => {
    const { broker } = makeBroker();
    await broker.connect();

    const { position, orderId } = await broker.placeMarketOrder(baseOrder());

    expect(orderId).toBe("111");
    expect(position.entryPrice).toBeCloseTo(2 / 0.01, 10); // filledValue / filledQuantity
    expect(position.quantity).toBe(0.01);
    expect(position.instrument).toBe("AAPL_US_EQ");
    expect(broker.getOpenPositions()).toHaveLength(1);
  });

  it("submits a positive quantity to buy", async () => {
    const orderSpy = vi.fn((body: { ticker: string; quantity: number }) =>
      jsonResponse(200, {
        id: 111,
        ticker: body.ticker,
        type: "MARKET",
        status: "FILLED",
        strategy: "QUANTITY",
        filledQuantity: 0.01,
        filledValue: 2,
        creationTime: "2026-01-01T00:00:00Z",
      }),
    );
    const { broker } = makeBroker(defaultRoutes({ order: orderSpy }));
    await broker.connect();
    await broker.placeMarketOrder(baseOrder());
    expect(orderSpy).toHaveBeenCalledWith({ ticker: "AAPL_US_EQ", quantity: 0.01 });
  });

  it("closes a position with a negative (sell) quantity and computes realised P/L", async () => {
    let call = 0;
    const orderRoute = (_body: { ticker: string; quantity: number }) => {
      call += 1;
      if (call === 1) {
        return jsonResponse(200, {
          id: 111,
          ticker: "AAPL_US_EQ",
          type: "MARKET",
          status: "FILLED",
          strategy: "QUANTITY",
          filledQuantity: 0.01,
          filledValue: 2, // entry avg price = 200
          creationTime: "2026-01-01T00:00:00Z",
        });
      }
      return jsonResponse(200, {
        id: 112,
        ticker: "AAPL_US_EQ",
        type: "MARKET",
        status: "FILLED",
        strategy: "QUANTITY",
        filledQuantity: 0.01,
        filledValue: 2.1, // exit avg price = 210
        creationTime: "2026-01-01T00:01:00Z",
      });
    };
    const orderSpy = vi.fn(orderRoute);
    const { broker } = makeBroker(defaultRoutes({ order: orderSpy }));
    await broker.connect();

    const { position } = await broker.placeMarketOrder(baseOrder());
    const { trade, orderId } = await broker.closePosition(position.positionId, 0, "2026-01-01T00:01:00Z", "test-close");

    expect(orderId).toBe("112");
    expect(trade.exitPrice).toBeCloseTo(2.1 / 0.01, 10);
    expect(trade.realisedPnl).toBeCloseTo((2.1 / 0.01 - 2 / 0.01) * 0.01, 10);
    expect(broker.getOpenPositions()).toHaveLength(0);
    expect(broker.getCompletedTrades()).toHaveLength(1);

    // The close call must submit a negative quantity — orderSpy receives the already-parsed body.
    expect(orderSpy).toHaveBeenCalledTimes(2);
    const closeCallBody = orderSpy.mock.calls[1]?.[0];
    expect(closeCallBody?.quantity).toBeLessThan(0);
  });

  it("throws clearly when closing a position id that doesn't exist", async () => {
    const { broker } = makeBroker();
    await broker.connect();
    await expect(broker.closePosition("no-such-position", 0, "2026-01-01T00:01:00Z", "test")).rejects.toThrow(
      /no open position/i,
    );
  });
});

describe("resolveSessionState — pure market-hours resolution", () => {
  // Regression coverage for the investigation into why an order can stay NEW indefinitely:
  // Trading212 documents that a market order placed while the exchange is closed is queued, not
  // filled or rejected, until it reopens. These assert the pure logic reads a real working
  // schedule's OPEN/CLOSE time-event sequence correctly.
  const timeEvents = [
    { date: "2026-01-05T08:00:00.000Z", type: "PRE_MARKET_OPEN" },
    { date: "2026-01-05T13:30:00.000Z", type: "OPEN" },
    { date: "2026-01-05T20:00:00.000Z", type: "AFTER_HOURS_OPEN" },
    { date: "2026-01-06T00:00:00.000Z", type: "AFTER_HOURS_CLOSE" },
  ];

  it("reports OPEN during the regular trading session", () => {
    expect(resolveSessionState(timeEvents, new Date("2026-01-05T15:00:00.000Z"))).toBe("OPEN");
  });

  it("reports OPEN during pre-market and after-hours sessions too", () => {
    expect(resolveSessionState(timeEvents, new Date("2026-01-05T09:00:00.000Z"))).toBe("OPEN");
    expect(resolveSessionState(timeEvents, new Date("2026-01-05T21:00:00.000Z"))).toBe("OPEN");
  });

  it("reports CLOSED after the after-hours session ends (e.g. over a weekend gap)", () => {
    expect(resolveSessionState(timeEvents, new Date("2026-01-06T12:00:00.000Z"))).toBe("CLOSED");
  });

  it("reports UNKNOWN when `now` predates every known time event", () => {
    expect(resolveSessionState(timeEvents, new Date("2025-01-01T00:00:00.000Z"))).toBe("UNKNOWN");
  });

  it("reports UNKNOWN for an empty schedule", () => {
    expect(resolveSessionState([], new Date())).toBe("UNKNOWN");
  });
});

describe("Trading212DemoBroker — describeMarketSession", () => {
  it("reports OPEN when `now` falls inside the instrument's trading session", async () => {
    const { broker } = makeBroker();
    await broker.connect();
    vi.setSystemTime(new Date("2026-01-05T15:00:00.000Z"));
    await expect(broker.describeMarketSession("AAPL_US_EQ")).resolves.toBe("OPEN");
  });

  it("reports CLOSED when `now` falls after the session's last CLOSE event", async () => {
    const { broker } = makeBroker();
    await broker.connect();
    vi.setSystemTime(new Date("2026-01-06T12:00:00.000Z"));
    await expect(broker.describeMarketSession("AAPL_US_EQ")).resolves.toBe("CLOSED");
  });

  it("reports UNKNOWN for a ticker the broker has never heard of", async () => {
    const { broker } = makeBroker();
    await broker.connect();
    await expect(broker.describeMarketSession("NOPE_US_EQ")).resolves.toBe("UNKNOWN");
  });

  it("reports UNKNOWN, never throwing, when the exchanges lookup itself fails", async () => {
    const { broker } = makeBroker(defaultRoutes({ exchanges: () => new Response("", { status: 500 }) }));
    await broker.connect();
    await expect(broker.describeMarketSession("AAPL_US_EQ")).resolves.toBe("UNKNOWN");
  });
});

describe("Trading212DemoBroker — duplicate protection", () => {
  it("refuses to open a second position for an instrument that already has one tracked", async () => {
    const { broker } = makeBroker();
    await broker.connect();
    await broker.placeMarketOrder(baseOrder());
    await expect(broker.placeMarketOrder(baseOrder())).rejects.toThrow(/already has an open position/i);
  });
});

describe("Trading212DemoBroker — invalid quantity guard", () => {
  // Regression coverage for the bug where an undefined/NaN quantity (previously sourced from the
  // real API's non-existent `minTradeQuantity` field) reached Trading212 and produced a 500. The
  // broker must now refuse locally, before ever calling the order-placement API.
  it("refuses to submit an order with a NaN quantity, without calling the order API", async () => {
    const orderSpy = vi.fn();
    const { broker } = makeBroker(defaultRoutes({ order: orderSpy }));
    await broker.connect();

    await expect(broker.placeMarketOrder(baseOrder({ quantity: NaN }))).rejects.toThrow(
      /not a valid non-zero finite number/i,
    );
    expect(orderSpy).not.toHaveBeenCalled();
  });

  it("refuses to submit an order with an undefined quantity, without calling the order API", async () => {
    const orderSpy = vi.fn();
    const { broker } = makeBroker(defaultRoutes({ order: orderSpy }));
    await broker.connect();

    await expect(
      broker.placeMarketOrder(baseOrder({ quantity: undefined as unknown as number })),
    ).rejects.toThrow(/not a valid non-zero finite number/i);
    expect(orderSpy).not.toHaveBeenCalled();
  });

  it("refuses to submit an order with a zero quantity, without calling the order API", async () => {
    const orderSpy = vi.fn();
    const { broker } = makeBroker(defaultRoutes({ order: orderSpy }));
    await broker.connect();

    await expect(broker.placeMarketOrder(baseOrder({ quantity: 0 }))).rejects.toThrow(
      /not a valid non-zero finite number/i,
    );
    expect(orderSpy).not.toHaveBeenCalled();
  });

  it("refuses to submit an order with an Infinity quantity, without calling the order API", async () => {
    const orderSpy = vi.fn();
    const { broker } = makeBroker(defaultRoutes({ order: orderSpy }));
    await broker.connect();

    await expect(broker.placeMarketOrder(baseOrder({ quantity: Infinity }))).rejects.toThrow(
      /not a valid non-zero finite number/i,
    );
    expect(orderSpy).not.toHaveBeenCalled();
  });
});

describe("Trading212DemoBroker — failed order handling", () => {
  it("throws a clear error when the order is rejected (400 PlaceOrderError)", async () => {
    const { broker } = makeBroker(
      defaultRoutes({ order: () => jsonResponse(400, { code: "InsufficientResources" }) }),
    );
    await broker.connect();
    await expect(broker.placeMarketOrder(baseOrder())).rejects.toThrow(/InsufficientResources/);
  });

  it("throws a clear error when the order ends CANCELLED/REJECTED after submission", async () => {
    const { broker } = makeBroker(
      defaultRoutes({
        order: () =>
          jsonResponse(200, {
            id: 111,
            ticker: "AAPL_US_EQ",
            type: "MARKET",
            status: "REJECTED",
            strategy: "QUANTITY",
            creationTime: "2026-01-01T00:00:00Z",
          }),
      }),
    );
    await broker.connect();
    await expect(broker.placeMarketOrder(baseOrder())).rejects.toThrow(/REJECTED/);
  });

  it("throws Trading212OrderPendingError when the order never reaches FILLED within the poll window", async () => {
    vi.useFakeTimers();
    const pendingResponse = () =>
      jsonResponse(200, {
        id: 111,
        ticker: "AAPL_US_EQ",
        type: "MARKET",
        status: "NEW",
        strategy: "QUANTITY",
        creationTime: "2026-01-01T00:00:00Z",
      });
    const { broker } = makeBroker(defaultRoutes({ order: pendingResponse, getOrder: pendingResponse }));
    await broker.connect();

    const resultPromise = broker.placeMarketOrder(baseOrder());
    const assertion = expect(resultPromise).rejects.toThrow(Trading212OrderPendingError);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });
});
