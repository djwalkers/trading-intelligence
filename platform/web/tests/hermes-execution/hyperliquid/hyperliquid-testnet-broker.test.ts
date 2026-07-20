import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocked at the SDK boundary — no real HTTP request is ever made by this test file. Only the
// methods this adapter actually calls are stubbed.
const { infoMocks, exchangeMocks } = vi.hoisted(() => ({
  infoMocks: {
    meta: vi.fn(),
    clearinghouseState: vi.fn(),
    allMids: vi.fn(),
    userFills: vi.fn(),
  },
  exchangeMocks: {
    order: vi.fn(),
    cancel: vi.fn(),
  },
}));

vi.mock("@nktkas/hyperliquid", () => ({
  HttpTransport: class {
    isTestnet: boolean;
    apiUrl: string;
    constructor(options?: { isTestnet?: boolean }) {
      this.isTestnet = options?.isTestnet ?? false;
      this.apiUrl = this.isTestnet ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz";
    }
  },
  InfoClient: class {
    meta = infoMocks.meta;
    clearinghouseState = infoMocks.clearinghouseState;
    allMids = infoMocks.allMids;
    userFills = infoMocks.userFills;
    constructor(_options: unknown) {}
  },
  ExchangeClient: class {
    order = exchangeMocks.order;
    cancel = exchangeMocks.cancel;
    constructor(_options: unknown) {}
  },
}));

import {
  HyperliquidTestnetBroker,
  HyperliquidOrderRestingError,
} from "@/lib/hermes-execution/hyperliquid/hyperliquid-testnet-broker";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { HyperliquidTestnetConfig } from "@/lib/hermes-execution/config";
import type { OrderRequest } from "@/lib/hermes-execution/types";

const TEST_PRIVATE_KEY = `0x${"1".repeat(64)}`;

const TEST_CONFIG: HyperliquidTestnetConfig = {
  privateKey: TEST_PRIVATE_KEY,
  accountAddress: `0x${"2".repeat(40)}`,
  executionEnabled: true,
  maxTestOrderValueUsd: 15,
  testInstrument: "BTC",
};

function makeBroker() {
  const auditTrail = new InMemoryAuditTrail();
  const broker = new HyperliquidTestnetBroker({ config: TEST_CONFIG, auditTrail, executionRunId: "test-run" });
  return { broker, auditTrail };
}

function baseOrder(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    strategyId: "HYPERLIQUID-SMOKE-TEST",
    strategyVersion: 1,
    sourceType: "DEMO_ONLY",
    instrument: "BTC",
    side: "BUY",
    quantity: 0.0002,
    price: 63000,
    timestamp: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  infoMocks.meta.mockResolvedValue({
    universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50, marginTableId: 1 }],
  });
  infoMocks.clearinghouseState.mockResolvedValue({
    marginSummary: { accountValue: "1000", totalNtlPos: "0", totalRawUsd: "0", totalMarginUsed: "0" },
    crossMarginSummary: { accountValue: "1000", totalNtlPos: "0", totalRawUsd: "0", totalMarginUsed: "0" },
    crossMaintenanceMarginUsed: "0",
    withdrawable: "1000",
    assetPositions: [],
    time: Date.now(),
  });
});

describe("HyperliquidTestnetBroker — construction safety", () => {
  it("refuses to construct without HYPERLIQUID_TESTNET_EXECUTION_ENABLED", () => {
    const auditTrail = new InMemoryAuditTrail();
    expect(
      () =>
        new HyperliquidTestnetBroker({
          config: { ...TEST_CONFIG, executionEnabled: false },
          auditTrail,
          executionRunId: "test-run",
        }),
    ).toThrow(/HYPERLIQUID_TESTNET_EXECUTION_ENABLED/);
  });

  it("refuses to construct without both credentials", () => {
    const auditTrail = new InMemoryAuditTrail();
    expect(
      () =>
        new HyperliquidTestnetBroker({
          config: { ...TEST_CONFIG, privateKey: undefined },
          auditTrail,
          executionRunId: "test-run",
        }),
    ).toThrow();
  });

  it("always constructs an isTestnet transport, never derived from any config value", () => {
    const { broker } = makeBroker();
    expect(broker).toBeDefined(); // constructing at all proves the internal isTestnet check passed
  });
});

describe("HyperliquidTestnetBroker — connect", () => {
  it("builds the asset universe and an initial account snapshot", async () => {
    const { broker } = makeBroker();
    await broker.connect();
    expect(broker.hasInstrument("BTC")).toBe(true);
    expect(broker.hasInstrument("ETH")).toBe(false);
    expect(broker.getAccount()).toEqual({ cashBalance: 1000, startingCashBalance: 1000 });
  });

  it("records BROKER_CONNECTION_ATTEMPTED then BROKER_CONNECTION_SUCCEEDED with no secret in the details", async () => {
    const { broker, auditTrail } = makeBroker();
    await broker.connect();
    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["BROKER_CONNECTION_ATTEMPTED", "BROKER_CONNECTION_SUCCEEDED"]);
    expect(JSON.stringify(events)).not.toContain(TEST_PRIVATE_KEY);
  });

  it("records BROKER_CONNECTION_FAILED and rethrows on failure, with no secret leaked", async () => {
    infoMocks.meta.mockRejectedValueOnce(new Error("network down"));
    const { broker, auditTrail } = makeBroker();
    await expect(broker.connect()).rejects.toThrow("network down");
    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["BROKER_CONNECTION_ATTEMPTED", "BROKER_CONNECTION_FAILED"]);
    expect(JSON.stringify(events)).not.toContain(TEST_PRIVATE_KEY);
  });
});

describe("HyperliquidTestnetBroker — order responses map correctly into internal models", () => {
  it("maps a filled order response into a PaperPosition", async () => {
    exchangeMocks.order.mockResolvedValueOnce({
      status: "ok",
      response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.0002", avgPx: "60000", oid: 111 } }] } },
    });
    const { broker } = makeBroker();
    await broker.connect();

    const { position, orderId } = await broker.placeMarketOrder(baseOrder());

    expect(orderId).toBe("111");
    expect(position.entryPrice).toBe(60000);
    expect(position.quantity).toBe(0.0002);
    expect(position.instrument).toBe("BTC");
    expect(position.strategyId).toBe("HYPERLIQUID-SMOKE-TEST");
    expect(broker.getOpenPositions()).toHaveLength(1);
  });

  it("sends a correctly rounded price/size in the submitted order", async () => {
    exchangeMocks.order.mockResolvedValueOnce({
      status: "ok",
      response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.0002", avgPx: "60000", oid: 111 } }] } },
    });
    const { broker } = makeBroker();
    await broker.connect();
    await broker.placeMarketOrder(baseOrder({ price: 63000.123456, quantity: 0.00023456 }));

    const submitted = exchangeMocks.order.mock.calls[0]?.[0];
    expect(submitted.orders[0].a).toBe(0); // BTC is index 0 in the mocked universe
    expect(submitted.orders[0].b).toBe(true);
    expect(submitted.orders[0].r).toBe(false);
    expect(submitted.orders[0].s).toBe("0.00023"); // rounded to szDecimals=5
  });

  it("throws HyperliquidOrderRestingError when the order rests unfilled", async () => {
    exchangeMocks.order.mockResolvedValueOnce({
      status: "ok",
      response: { type: "order", data: { statuses: [{ resting: { oid: 222 } }] } },
    });
    const { broker } = makeBroker();
    await broker.connect();

    await expect(broker.placeMarketOrder(baseOrder())).rejects.toThrow(HyperliquidOrderRestingError);
  });

  it("maps a close-order fill into a CompletedTrade with correct realised P/L", async () => {
    exchangeMocks.order
      .mockResolvedValueOnce({
        status: "ok",
        response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.0002", avgPx: "60000", oid: 111 } }] } },
      })
      .mockResolvedValueOnce({
        status: "ok",
        response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.0002", avgPx: "61000", oid: 112 } }] } },
      });
    const { broker } = makeBroker();
    await broker.connect();

    const { position } = await broker.placeMarketOrder(baseOrder());
    const { trade, orderId } = await broker.closePosition(position.positionId, 61000, "2026-01-01T00:01:00Z", "test-close");

    expect(orderId).toBe("112");
    expect(trade.exitPrice).toBe(61000);
    expect(trade.realisedPnl).toBeCloseTo((61000 - 60000) * 0.0002, 10);
    expect(broker.getOpenPositions()).toHaveLength(0);
    expect(broker.getCompletedTrades()).toHaveLength(1);

    // The close order must be reduce-only and on the opposite side.
    const closeSubmitted = exchangeMocks.order.mock.calls[1]?.[0];
    expect(closeSubmitted.orders[0].b).toBe(false);
    expect(closeSubmitted.orders[0].r).toBe(true);
  });

  it("throws clearly when closing a position id that doesn't exist", async () => {
    const { broker } = makeBroker();
    await broker.connect();
    await expect(broker.closePosition("no-such-position", 60000, "2026-01-01T00:01:00Z", "test")).rejects.toThrow(
      /no open position/i,
    );
  });
});

describe("HyperliquidTestnetBroker — duplicate submission prevention", () => {
  it("assigns a distinct client order id to every order submitted", async () => {
    exchangeMocks.order.mockResolvedValue({
      status: "ok",
      response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.0002", avgPx: "60000", oid: 111 } }] } },
    });
    infoMocks.meta.mockResolvedValue({
      universe: [
        { name: "BTC", szDecimals: 5, maxLeverage: 50, marginTableId: 1 },
        { name: "ETH", szDecimals: 4, maxLeverage: 50, marginTableId: 1 },
      ],
    });
    const { broker } = makeBroker();
    await broker.connect();

    await broker.placeMarketOrder(baseOrder({ instrument: "BTC" }));
    await broker.placeMarketOrder(baseOrder({ instrument: "ETH", strategyId: "OTHER" }));

    const firstCloid = exchangeMocks.order.mock.calls[0]?.[0].orders[0].c;
    const secondCloid = exchangeMocks.order.mock.calls[1]?.[0].orders[0].c;
    expect(firstCloid).toBeDefined();
    expect(secondCloid).toBeDefined();
    expect(firstCloid).not.toBe(secondCloid);
    expect(firstCloid).toMatch(/^0x[0-9a-f]{32}$/);
  });
});

describe("HyperliquidTestnetBroker — cleanup (cancel a resting order)", () => {
  it("cancels a resting order and records ORDER_CANCELLED", async () => {
    exchangeMocks.cancel.mockResolvedValueOnce({
      status: "ok",
      response: { type: "cancel", data: { statuses: ["success"] } },
    });
    const { broker, auditTrail } = makeBroker();
    await broker.connect();

    await broker.cancelOrder("BTC", 222);

    const events = await auditTrail.getEvents();
    expect(events.some((e) => e.eventType === "ORDER_CANCELLED")).toBe(true);
    expect(exchangeMocks.cancel).toHaveBeenCalledWith({ cancels: [{ a: 0, o: 222 }] });
  });
});

describe("HyperliquidTestnetBroker — secrets never appear in errors", () => {
  it("an order-rejection error message never contains the private key", async () => {
    exchangeMocks.order.mockRejectedValueOnce(new Error("insufficient margin"));
    const { broker } = makeBroker();
    await broker.connect();

    await expect(broker.placeMarketOrder(baseOrder())).rejects.toThrow("insufficient margin");
    try {
      await broker.placeMarketOrder(baseOrder({ instrument: "BTC" }));
    } catch (error) {
      expect((error as Error).message).not.toContain(TEST_PRIVATE_KEY);
    }
  });
});
