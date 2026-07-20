import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EtoroDemoBroker,
  EtoroNoInstrumentMatchError,
  EtoroAmbiguousInstrumentError,
  EtoroRateUnavailableError,
  EtoroReconciliationError,
  EtoroCleanupRequiredError,
} from "@/lib/hermes-execution/etoro/etoro-demo-broker";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { EtoroDemoConfig } from "@/lib/hermes-execution/config";
import type { OrderRequest } from "@/lib/hermes-execution/types";

const TEST_API_KEY = "test-api-key-value";
const TEST_USER_KEY = "test-user-key-value";

const TEST_CONFIG: EtoroDemoConfig = {
  env: "demo",
  apiKey: TEST_API_KEY,
  userKey: TEST_USER_KEY,
  testInstrument: "BTC",
  testAmount: 50,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Routes {
  search: () => Response;
  rates: () => Response;
  portfolio: () => Response;
  order: () => Response;
  close: () => Response;
}

// Shape matches a real, live GET /api/v1/market-data/instruments response for Bitcoin (verified
// against the actual API): instrumentID (capital ID), instrumentDisplayName, symbolFull,
// instrumentTypeID, exchangeID. There is no isTradable/isCurrentlyTradable-equivalent field on
// this endpoint at all.
const BTC_SEARCH_RESULT = {
  instrumentID: 100000,
  instrumentDisplayName: "Bitcoin",
  symbolFull: "BTC",
  instrumentTypeID: 10,
  exchangeID: 8,
};

// Empty clientPortfolio — the shape confirmed live from GET /api/v1/trading/info/demo/portfolio:
// everything nested under `clientPortfolio`, not returned flat.
function emptyPortfolio(credit = 1000): Response {
  return jsonResponse(200, { clientPortfolio: { positions: [], orders: [], credit } });
}

function portfolioWith(options: { positions?: unknown[]; orders?: unknown[]; credit?: number }): Response {
  return jsonResponse(200, {
    clientPortfolio: { positions: options.positions ?? [], orders: options.orders ?? [], credit: options.credit ?? 1000 },
  });
}

function defaultRoutes(overrides: Partial<Routes> = {}): Routes {
  return {
    search: () => jsonResponse(200, { instrumentDisplayDatas: [BTC_SEARCH_RESULT] }),
    // Shape matches a real, live GET /api/v1/market-data/instruments/rates response for BTC
    // (verified against the actual API): instrumentID (capital ID), bid, ask.
    rates: () => jsonResponse(200, { rates: [{ instrumentID: 100000, bid: 50000, ask: 50010 }] }),
    portfolio: () => emptyPortfolio(),
    // Shape matches a real, live POST /api/v2/trading/execution/demo/orders response: exactly
    // { orderId, token }, no positionId — confirmed against a genuine order submission.
    order: () => jsonResponse(200, { orderId: 555, token: "test-token" }),
    close: () => jsonResponse(200, { token: "close-token" }),
    ...overrides,
  };
}

function makeFetchMock(routes: Routes) {
  return vi.fn(async (url: URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/api/v1/market-data/instruments") return routes.search();
    if (url.pathname === "/api/v1/market-data/instruments/rates") return routes.rates();
    if (url.pathname === "/api/v1/trading/info/demo/portfolio") return routes.portfolio();
    if (url.pathname === "/api/v2/trading/execution/demo/orders" && method === "POST") return routes.order();
    if (url.pathname.startsWith("/api/v1/trading/execution/demo/market-close-orders/positions/") && method === "POST") {
      return routes.close();
    }
    throw new Error(`Unhandled mock route: ${method} ${url.pathname}`);
  });
}

function baseOrder(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    strategyId: "ETORO-SMOKE-TEST",
    strategyVersion: 1,
    sourceType: "DEMO_ONLY",
    instrument: "BTC",
    side: "BUY",
    quantity: 50,
    price: 50010,
    timestamp: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeBroker(routes: Routes = defaultRoutes()) {
  vi.stubGlobal("fetch", makeFetchMock(routes));
  const auditTrail = new InMemoryAuditTrail();
  const broker = new EtoroDemoBroker({ config: TEST_CONFIG, auditTrail, executionRunId: "test-run" });
  return { broker, auditTrail };
}

// Shape matches a real, live position from GET /api/v1/trading/info/demo/portfolio
// (clientPortfolio.positions[]): positionID, orderID (links back to the order-submission
// response's orderId), instrumentID, isBuy, amount, units, openRate, leverage, openDateTime, plus
// account/fee/settlement fields this adapter has no use for and doesn't model.
const OPEN_POSITION = {
  positionID: 555,
  orderID: 555,
  instrumentID: 100000,
  isBuy: true,
  amount: 50,
  units: 0.000781,
  openRate: 50010,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("EtoroDemoBroker — construction safety", () => {
  it("refuses to construct without ETORO_ENV=demo", () => {
    const auditTrail = new InMemoryAuditTrail();
    expect(
      () => new EtoroDemoBroker({ config: { ...TEST_CONFIG, env: undefined }, auditTrail, executionRunId: "r" }),
    ).toThrow(/ETORO_ENV=demo/);
  });

  it("refuses to construct without an API key", () => {
    const auditTrail = new InMemoryAuditTrail();
    expect(
      () => new EtoroDemoBroker({ config: { ...TEST_CONFIG, apiKey: undefined }, auditTrail, executionRunId: "r" }),
    ).toThrow(/ETORO_API_KEY/);
  });

  it("refuses to construct without a user key", () => {
    const auditTrail = new InMemoryAuditTrail();
    expect(
      () => new EtoroDemoBroker({ config: { ...TEST_CONFIG, userKey: undefined }, auditTrail, executionRunId: "r" }),
    ).toThrow(/ETORO_USER_KEY/);
  });
});

describe("EtoroDemoBroker — connection and nested clientPortfolio mapping", () => {
  it("connects via a demo-portfolio read and records BROKER_CONNECTION_ATTEMPTED/SUCCEEDED with no secret in details", async () => {
    const { broker, auditTrail } = makeBroker();
    await broker.connect();
    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["BROKER_CONNECTION_ATTEMPTED", "BROKER_CONNECTION_SUCCEEDED"]);
    expect(JSON.stringify(events)).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(events)).not.toContain(TEST_USER_KEY);
  });

  it("records BROKER_CONNECTION_FAILED and rethrows on a credential failure (401)", async () => {
    const { broker, auditTrail } = makeBroker(defaultRoutes({ portfolio: () => new Response("", { status: 401 }) }));
    await expect(broker.connect()).rejects.toThrow();
    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["BROKER_CONNECTION_ATTEMPTED", "BROKER_CONNECTION_FAILED"]);
    expect(JSON.stringify(events)).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(events)).not.toContain(TEST_USER_KEY);
  });

  it("reads demo credit from the nested clientPortfolio.credit field, not a guessed top-level field", async () => {
    // Regression coverage for the exact live bug: getAccount() previously always returned the
    // {cashBalance:0, startingCashBalance:0} default because connect() never read `credit` at all
    // (let alone from the correct nested path).
    const { broker } = makeBroker(defaultRoutes({ portfolio: () => portfolioWith({ credit: 103169.71 }) }));
    await broker.connect();
    expect(broker.getAccount()).toEqual({ cashBalance: 103169.71, startingCashBalance: 103169.71 });
  });

  it("counts positions from the nested clientPortfolio.positions field", async () => {
    const { broker, auditTrail } = makeBroker(
      defaultRoutes({ portfolio: () => portfolioWith({ positions: [OPEN_POSITION, { ...OPEN_POSITION, positionID: 556 }] }) }),
    );
    await broker.connect();
    const succeeded = (await auditTrail.getEvents()).find((e) => e.eventType === "BROKER_CONNECTION_SUCCEEDED");
    expect(succeeded?.details).toMatchObject({ openPositions: 2 });
  });

  it("counts pending orders from the nested clientPortfolio.orders field", async () => {
    const { broker, auditTrail } = makeBroker(
      defaultRoutes({ portfolio: () => portfolioWith({ orders: [{ orderID: 900, instrumentID: 100000 }] }) }),
    );
    await broker.connect();
    const succeeded = (await auditTrail.getEvents()).find((e) => e.eventType === "BROKER_CONNECTION_SUCCEEDED");
    expect(succeeded?.details).toMatchObject({ pendingOrders: 1 });
  });
});

describe("EtoroDemoBroker — instrument resolution", () => {
  it("resolves an exact symbol match", async () => {
    const { broker } = makeBroker();
    await broker.connect();
    const resolved = await broker.resolveInstrument("BTC");
    expect(resolved).toEqual({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC" });
    expect(broker.hasResolvedInstrument("BTC")).toBe(true);
  });

  it("throws EtoroNoInstrumentMatchError when nothing matches", async () => {
    const { broker } = makeBroker(defaultRoutes({ search: () => jsonResponse(200, { instrumentDisplayDatas: [] }) }));
    await broker.connect();
    await expect(broker.resolveInstrument("NONEXISTENT")).rejects.toThrow(EtoroNoInstrumentMatchError);
  });

  it("resolves a case-insensitive symbol match when no exact match exists", async () => {
    const { broker } = makeBroker();
    await broker.connect();
    const resolved = await broker.resolveInstrument("btc");
    expect(resolved.instrumentId).toBe(100000);
  });

  it("resolves an exact display-name match when the symbol doesn't match at all", async () => {
    const { broker } = makeBroker();
    await broker.connect();
    const resolved = await broker.resolveInstrument("Bitcoin");
    expect(resolved.instrumentId).toBe(100000);
  });

  it("resolves a case-insensitive display-name match as the last-resort tier", async () => {
    const { broker } = makeBroker();
    await broker.connect();
    const resolved = await broker.resolveInstrument("bitcoin");
    expect(resolved.instrumentId).toBe(100000);
  });

  it("never falls through to a looser tier once a stricter one has a match", async () => {
    // Two candidates: one is an exact symbol match, the other only an exact display-name match for
    // the same search term — the exact-symbol tier must win outright, the display-name one must
    // never even be considered.
    const { broker } = makeBroker(
      defaultRoutes({
        search: () =>
          jsonResponse(200, {
            instrumentDisplayDatas: [
              { instrumentID: 1, instrumentDisplayName: "Something Else", symbolFull: "XYZ", instrumentTypeID: 10, exchangeID: 8 },
              { instrumentID: 2, instrumentDisplayName: "XYZ", symbolFull: "ABC", instrumentTypeID: 10, exchangeID: 8 },
            ],
          }),
      }),
    );
    await broker.connect();
    const resolved = await broker.resolveInstrument("XYZ");
    expect(resolved.instrumentId).toBe(1);
  });

  it("disambiguates a tied match set by selecting the exact crypto instrument", async () => {
    // Mirrors what "Bitcoin" resolves against in the real API: a native crypto asset alongside a
    // same-named future/ETF/equity — instrumentTypeID 10 uniquely identifies the crypto one.
    const { broker } = makeBroker(
      defaultRoutes({
        search: () =>
          jsonResponse(200, {
            instrumentDisplayDatas: [
              { instrumentID: 100000, instrumentDisplayName: "Bitcoin", symbolFull: "BTC", instrumentTypeID: 10, exchangeID: 8 },
              { instrumentID: 315, instrumentDisplayName: "Bitcoin Future CME", symbolFull: "BTC", instrumentTypeID: 4, exchangeID: 3 },
            ],
          }),
      }),
    );
    await broker.connect();
    const resolved = await broker.resolveInstrument("BTC");
    expect(resolved.instrumentId).toBe(100000);
  });

  it("still throws EtoroAmbiguousInstrumentError when more than one crypto-type candidate ties", async () => {
    const { broker } = makeBroker(
      defaultRoutes({
        search: () =>
          jsonResponse(200, {
            instrumentDisplayDatas: [
              { instrumentID: 1, instrumentDisplayName: "BTC", symbolFull: "BTCA", instrumentTypeID: 10, exchangeID: 8 },
              { instrumentID: 2, instrumentDisplayName: "BTC", symbolFull: "BTCB", instrumentTypeID: 10, exchangeID: 8 },
            ],
          }),
      }),
    );
    await broker.connect();
    await expect(broker.resolveInstrument("BTC")).rejects.toThrow(EtoroAmbiguousInstrumentError);
  });
});

describe("EtoroDemoBroker — rate retrieval", () => {
  it("matches the rate entry using the real instrumentID field and maps bid/ask correctly", async () => {
    const { broker } = makeBroker();
    await broker.connect();
    await broker.resolveInstrument("BTC");
    await expect(broker.getRate("BTC")).resolves.toEqual({ bid: 50000, ask: 50010 });
  });

  it("does not report INCONCLUSIVE/unavailable when a valid rate exists (regression: instrumentId vs instrumentID casing bug)", async () => {
    const { broker } = makeBroker(
      defaultRoutes({
        rates: () => jsonResponse(200, { rates: [{ instrumentID: 100000, bid: 63997.35, ask: 63997.36 }] }),
      }),
    );
    await broker.connect();
    await broker.resolveInstrument("BTC");
    await expect(broker.getRate("BTC")).resolves.toEqual({ bid: 63997.35, ask: 63997.36 });
  });

  it("throws EtoroRateUnavailableError(reason: 'absent') when the requested instrument is missing from the response", async () => {
    const { broker } = makeBroker(defaultRoutes({ rates: () => jsonResponse(200, { rates: [] }) }));
    await broker.connect();
    await broker.resolveInstrument("BTC");
    await expect(broker.getRate("BTC")).rejects.toMatchObject({ name: "EtoroRateUnavailableError", reason: "absent" });
  });

  it("throws EtoroRateUnavailableError(reason: 'unpriced') when a rate entry exists but has no bid/ask", async () => {
    const { broker } = makeBroker(
      defaultRoutes({ rates: () => jsonResponse(200, { rates: [{ instrumentID: 100000 }] }) }),
    );
    await broker.connect();
    await broker.resolveInstrument("BTC");
    await expect(broker.getRate("BTC")).rejects.toMatchObject({ name: "EtoroRateUnavailableError", reason: "unpriced" });
  });

  it("distinguishes an absent instrument from one present with only a bid (no ask)", async () => {
    const { broker } = makeBroker(
      defaultRoutes({ rates: () => jsonResponse(200, { rates: [{ instrumentID: 100000, bid: 50000 }] }) }),
    );
    await broker.connect();
    await broker.resolveInstrument("BTC");
    await expect(broker.getRate("BTC")).rejects.toMatchObject({ reason: "unpriced" });
  });
});

describe("EtoroDemoBroker — order placement guards", () => {
  it("refuses a NaN amount without ever calling the order API", async () => {
    const orderSpy = vi.fn();
    const { broker } = makeBroker(defaultRoutes({ order: orderSpy }));
    await broker.connect();
    await broker.resolveInstrument("BTC");
    await expect(broker.placeMarketOrder(baseOrder({ quantity: NaN }))).rejects.toThrow(/not a valid positive finite number/);
    expect(orderSpy).not.toHaveBeenCalled();
  });

  it("refuses an undefined amount without ever calling the order API", async () => {
    const orderSpy = vi.fn();
    const { broker } = makeBroker(defaultRoutes({ order: orderSpy }));
    await broker.connect();
    await broker.resolveInstrument("BTC");
    await expect(
      broker.placeMarketOrder(baseOrder({ quantity: undefined as unknown as number })),
    ).rejects.toThrow(/not a valid positive finite number/);
    expect(orderSpy).not.toHaveBeenCalled();
  });

  it("refuses a zero amount without ever calling the order API", async () => {
    const orderSpy = vi.fn();
    const { broker } = makeBroker(defaultRoutes({ order: orderSpy }));
    await broker.connect();
    await broker.resolveInstrument("BTC");
    await expect(broker.placeMarketOrder(baseOrder({ quantity: 0 }))).rejects.toThrow(/not a valid positive finite number/);
    expect(orderSpy).not.toHaveBeenCalled();
  });

  it("refuses an Infinity amount without ever calling the order API", async () => {
    const orderSpy = vi.fn();
    const { broker } = makeBroker(defaultRoutes({ order: orderSpy }));
    await broker.connect();
    await broker.resolveInstrument("BTC");
    await expect(broker.placeMarketOrder(baseOrder({ quantity: Infinity }))).rejects.toThrow(/not a valid positive finite number/);
    expect(orderSpy).not.toHaveBeenCalled();
  });

  it("refuses a negative amount without ever calling the order API", async () => {
    const orderSpy = vi.fn();
    const { broker } = makeBroker(defaultRoutes({ order: orderSpy }));
    await broker.connect();
    await broker.resolveInstrument("BTC");
    await expect(broker.placeMarketOrder(baseOrder({ quantity: -5 }))).rejects.toThrow(/not a valid positive finite number/);
    expect(orderSpy).not.toHaveBeenCalled();
  });

  it("refuses to submit an order for an instrument that was never resolved", async () => {
    const orderSpy = vi.fn();
    const { broker } = makeBroker(defaultRoutes({ order: orderSpy }));
    await broker.connect();
    await expect(broker.placeMarketOrder(baseOrder())).rejects.toThrow(/never resolved/);
    expect(orderSpy).not.toHaveBeenCalled();
  });

  it("only supports opening long (BUY) positions", async () => {
    const { broker } = makeBroker();
    await broker.connect();
    await broker.resolveInstrument("BTC");
    await expect(broker.placeMarketOrder(baseOrder({ side: "SELL" }))).rejects.toThrow(/only opens long/);
  });
});

describe("EtoroDemoBroker — order placement and reconciliation", () => {
  it("reconciles directly when the order response includes positionId (not observed live, but a supported path)", async () => {
    const routes = defaultRoutes({
      order: () => jsonResponse(200, { positionId: 555 }),
      portfolio: () => portfolioWith({ positions: [OPEN_POSITION] }),
    });
    const { broker, auditTrail } = makeBroker(routes);
    await broker.connect();
    await broker.resolveInstrument("BTC");

    const { position, orderId } = await broker.placeMarketOrder(baseOrder());

    expect(orderId).toBe("555");
    expect(position.instrument).toBe("BTC");
    expect(position.quantity).toBe(50);
    expect(position.entryPrice).toBe(50010);
    expect(broker.getOpenPositions()).toHaveLength(1);

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual([
      "BROKER_CONNECTION_ATTEMPTED",
      "BROKER_CONNECTION_SUCCEEDED",
      "ORDER_SUBMITTED",
      "ORDER_ACKNOWLEDGED",
      "POSITION_CONFIRMED",
      "POSITION_OPENED",
    ]);
  });

  it("reconciles by polling for a position whose orderID matches the submitted orderId (the confirmed live shape)", async () => {
    const routes = defaultRoutes({
      order: () => jsonResponse(200, { orderId: 555, token: "test-token" }),
      portfolio: () => portfolioWith({ positions: [OPEN_POSITION] }),
    });
    const { broker, auditTrail } = makeBroker(routes);
    await broker.connect();
    await broker.resolveInstrument("BTC");

    const { position, orderId } = await broker.placeMarketOrder(baseOrder());

    expect(orderId).toBe("555");
    expect(position.instrument).toBe("BTC");
    expect(position.quantity).toBe(50);
    expect(broker.getOpenPositions()).toHaveLength(1);

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual([
      "BROKER_CONNECTION_ATTEMPTED",
      "BROKER_CONNECTION_SUCCEEDED",
      "ORDER_SUBMITTED",
      "ORDER_ACKNOWLEDGED",
      "RECONCILIATION_STARTED",
      "POSITION_CONFIRMED",
      "POSITION_OPENED",
    ]);
    // orderId is a plain reference number, safe to record; the token's actual value must never
    // appear anywhere in the audit trail (only whether one was received).
    const acknowledged = events.find((e) => e.eventType === "ORDER_ACKNOWLEDGED");
    expect(acknowledged?.details).toMatchObject({ orderId: 555, tokenReceived: true });
    expect(JSON.stringify(events)).not.toContain("test-token");
  });

  it("reconciles by orderID after several poll attempts before the position appears", async () => {
    vi.useFakeTimers();
    let call = 0;
    const routes = defaultRoutes({
      order: () => jsonResponse(200, { orderId: 555, token: "test-token" }),
      portfolio: () => {
        call += 1;
        // call 1 = connect(); calls 2-3 = poll misses; call 4 = the position has appeared.
        if (call < 4) return emptyPortfolio();
        return portfolioWith({ positions: [OPEN_POSITION] });
      },
    });
    const { broker } = makeBroker(routes);
    await broker.connect();
    await broker.resolveInstrument("BTC");

    const resultPromise = broker.placeMarketOrder(baseOrder());
    await vi.advanceTimersByTimeAsync(10_000);
    const { position, orderId } = await resultPromise;

    expect(orderId).toBe("555");
    expect(position.instrument).toBe("BTC");
    expect(call).toBeGreaterThanOrEqual(4);
  });

  it("throws EtoroReconciliationError('pending') when the order remains in clientPortfolio.orders past the poll window", async () => {
    vi.useFakeTimers();
    const routes = defaultRoutes({
      order: () => jsonResponse(200, { orderId: 555, token: "test-token" }),
      portfolio: () => portfolioWith({ orders: [{ orderID: 555, instrumentID: 100000 }] }),
    });
    const { broker, auditTrail } = makeBroker(routes);
    await broker.connect();
    await broker.resolveInstrument("BTC");

    const resultPromise = broker.placeMarketOrder(baseOrder());
    const assertion = expect(resultPromise).rejects.toMatchObject({
      name: "EtoroReconciliationError",
      reason: "pending",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toContain("RECONCILIATION_STARTED");
    expect(events.map((e) => e.eventType)).toContain("RECONCILIATION_PENDING");
  });

  it("throws EtoroReconciliationError('timeout') when neither a position nor a pending order appears before the deadline", async () => {
    vi.useFakeTimers();
    const routes = defaultRoutes({
      order: () => jsonResponse(200, { orderId: 555, token: "test-token" }),
      portfolio: () => emptyPortfolio(),
    });
    const { broker, auditTrail } = makeBroker(routes);
    await broker.connect();
    await broker.resolveInstrument("BTC");

    const resultPromise = broker.placeMarketOrder(baseOrder());
    const assertion = expect(resultPromise).rejects.toMatchObject({
      name: "EtoroReconciliationError",
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toContain("RECONCILIATION_TIMED_OUT");
  });

  it("propagates a portfolio API failure during polling immediately, without retrying", async () => {
    let call = 0;
    const routes = defaultRoutes({
      order: () => jsonResponse(200, { orderId: 555, token: "test-token" }),
      portfolio: () => {
        call += 1;
        if (call === 1) return emptyPortfolio(); // connect()
        return new Response("", { status: 500 }); // first poll attempt fails
      },
    });
    const { broker } = makeBroker(routes);
    await broker.connect();
    await broker.resolveInstrument("BTC");

    await expect(broker.placeMarketOrder(baseOrder())).rejects.toThrow(/getDemoPortfolio failed/i);
    expect(call).toBe(2);
  });

  it("throws EtoroReconciliationError('no-identifier') when the order response has no usable identifier", async () => {
    const { broker } = makeBroker(defaultRoutes({ order: () => jsonResponse(200, {}) }));
    await broker.connect();
    await broker.resolveInstrument("BTC");

    await expect(broker.placeMarketOrder(baseOrder())).rejects.toMatchObject({
      name: "EtoroReconciliationError",
      reason: "no-identifier",
    });
  });

  it("throws EtoroReconciliationError('no-identifier') when only a token is returned (no orderId or positionId)", async () => {
    const { broker } = makeBroker(defaultRoutes({ order: () => jsonResponse(200, { token: "abc-token" }) }));
    await broker.connect();
    await broker.resolveInstrument("BTC");

    await expect(broker.placeMarketOrder(baseOrder())).rejects.toMatchObject({
      name: "EtoroReconciliationError",
      reason: "no-identifier",
    });
  });

  it("throws EtoroReconciliationError('not-found') when a positionId is returned directly but absent from the portfolio", async () => {
    const { broker } = makeBroker(defaultRoutes({ order: () => jsonResponse(200, { positionId: 555 }) }));
    await broker.connect();
    await broker.resolveInstrument("BTC");

    await expect(broker.placeMarketOrder(baseOrder())).rejects.toMatchObject({
      name: "EtoroReconciliationError",
      reason: "not-found",
    });
  });
});

describe("EtoroDemoBroker — position close", () => {
  it("verifies the close and computes CFD percentage-based realised P/L when the position is gone on the first verification read", async () => {
    let portfolioCall = 0;
    const routes = defaultRoutes({
      order: () => jsonResponse(200, { orderId: 555, token: "test-token" }),
      portfolio: () => {
        portfolioCall += 1;
        // 1 = connect(), 2 = reconcile-after-open (found), 3 = first close-verification read (gone).
        if (portfolioCall <= 2) return portfolioWith({ positions: [OPEN_POSITION] });
        return emptyPortfolio();
      },
    });
    const { broker, auditTrail } = makeBroker(routes);
    await broker.connect();
    await broker.resolveInstrument("BTC");
    const { position } = await broker.placeMarketOrder(baseOrder());

    const { trade, orderId } = await broker.closePosition(position.positionId, 55011, "2026-01-01T00:05:00Z", "test-close");

    expect(orderId).toBeTruthy();
    expect(trade.exitPrice).toBe(55011);
    // CFD notional P/L: amount * ((exit - entry) / entry) — NOT price-delta * units.
    const expectedPnl = 50 * ((55011 - 50010) / 50010);
    expect(trade.realisedPnl).toBeCloseTo(expectedPnl, 6);
    expect(broker.getOpenPositions()).toHaveLength(0);
    expect(broker.getCompletedTrades()).toHaveLength(1);

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toContain("POSITION_CLOSE_SUBMITTED");
    expect(events.map((e) => e.eventType)).toContain("CLOSE_VERIFICATION_STARTED");
    expect(events.map((e) => e.eventType)).not.toContain("CLOSE_VERIFICATION_PENDING"); // gone on the very first read
    expect(events.map((e) => e.eventType)).toContain("POSITION_CLOSED"); // serves as "close verified" — no separate event
    expect(events.map((e) => e.eventType)).toContain("REALISED_PNL");
  });

  it("verifies the close successfully (no false CLEANUP_REQUIRED) when the position disappears only after several polls", async () => {
    // Regression coverage for the exact live behaviour that motivated this change: a position can
    // still appear open on the first read right after closeDemoPosition() resolves, then vanish a
    // few seconds later — bounded polling must not mistake that delay for a failed close.
    vi.useFakeTimers();
    let portfolioCall = 0;
    const routes = defaultRoutes({
      order: () => jsonResponse(200, { orderId: 555, token: "test-token" }),
      portfolio: () => {
        portfolioCall += 1;
        // 1 = connect(), 2 = reconcile-after-open (found), 3-4 = still open, 5 = finally gone.
        if (portfolioCall <= 4) return portfolioWith({ positions: [OPEN_POSITION] });
        return emptyPortfolio();
      },
    });
    const { broker, auditTrail } = makeBroker(routes);
    await broker.connect();
    await broker.resolveInstrument("BTC");
    const { position } = await broker.placeMarketOrder(baseOrder());

    const closePromise = broker.closePosition(position.positionId, 55011, "2026-01-01T00:05:00Z", "test-close");
    await vi.advanceTimersByTimeAsync(10_000);
    const { trade } = await closePromise;

    expect(trade.exitPrice).toBe(55011);
    expect(broker.getOpenPositions()).toHaveLength(0);
    expect(portfolioCall).toBeGreaterThanOrEqual(5);

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toContain("CLOSE_VERIFICATION_PENDING");
    expect(events.map((e) => e.eventType)).toContain("POSITION_CLOSED");
    expect(events.map((e) => e.eventType)).not.toContain("CLOSE_VERIFICATION_TIMED_OUT");
  });

  it("throws EtoroCleanupRequiredError when the position remains open through the full poll timeout", async () => {
    vi.useFakeTimers();
    const routes = defaultRoutes({
      order: () => jsonResponse(200, { orderId: 555, token: "test-token" }),
      portfolio: () => portfolioWith({ positions: [OPEN_POSITION] }), // never shows it gone
    });
    const { broker, auditTrail } = makeBroker(routes);
    await broker.connect();
    await broker.resolveInstrument("BTC");
    const { position } = await broker.placeMarketOrder(baseOrder());

    const closePromise = broker.closePosition(position.positionId, 55011, "2026-01-01T00:05:00Z", "test-close");
    const assertion = expect(closePromise).rejects.toBeInstanceOf(EtoroCleanupRequiredError);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toContain("CLOSE_VERIFICATION_TIMED_OUT");
    expect(events.map((e) => e.eventType)).not.toContain("POSITION_CLOSED");
  });

  it("propagates a portfolio API failure during close verification immediately, without retrying", async () => {
    let portfolioCall = 0;
    const routes = defaultRoutes({
      order: () => jsonResponse(200, { orderId: 555, token: "test-token" }),
      portfolio: () => {
        portfolioCall += 1;
        // 1 = connect(), 2 = reconcile-after-open (found), 3 = first verification read fails.
        if (portfolioCall <= 2) return portfolioWith({ positions: [OPEN_POSITION] });
        return new Response("", { status: 500 });
      },
    });
    const { broker } = makeBroker(routes);
    await broker.connect();
    await broker.resolveInstrument("BTC");
    const { position } = await broker.placeMarketOrder(baseOrder());

    await expect(
      broker.closePosition(position.positionId, 55011, "2026-01-01T00:05:00Z", "test-close"),
    ).rejects.toThrow(/getDemoPortfolio failed/i);
    expect(portfolioCall).toBe(3);
  });

  it("propagates a close-endpoint failure before verification ever begins", async () => {
    const routes = defaultRoutes({
      order: () => jsonResponse(200, { orderId: 555, token: "test-token" }),
      portfolio: () => portfolioWith({ positions: [OPEN_POSITION] }),
      close: () => new Response("", { status: 500 }),
    });
    const { broker, auditTrail } = makeBroker(routes);
    await broker.connect();
    await broker.resolveInstrument("BTC");
    const { position } = await broker.placeMarketOrder(baseOrder());

    await expect(
      broker.closePosition(position.positionId, 55011, "2026-01-01T00:05:00Z", "test-close"),
    ).rejects.toThrow(/closeDemoPosition failed/i);

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).not.toContain("CLOSE_VERIFICATION_STARTED");
  });

  it("throws clearly when closing a position id that doesn't exist", async () => {
    const { broker } = makeBroker();
    await broker.connect();
    await expect(broker.closePosition("no-such-position", 100, "2026-01-01T00:05:00Z", "test")).rejects.toThrow(
      /no open position/i,
    );
  });
});
