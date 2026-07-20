import { describe, expect, it } from "vitest";
import { LocalPaperBroker } from "@/lib/hermes-execution/paper-broker";
import { InMemoryPaperBrokerStore } from "@/lib/hermes-execution/paper-broker-store";
import type { OrderRequest } from "@/lib/hermes-execution/types";

function makeOrder(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    sourceType: "DEMO_ONLY",
    instrument: "DEMO-USD",
    side: "BUY",
    quantity: 4,
    price: 103,
    timestamp: "2026-01-01T00:05:00Z",
    takeProfitPercent: 2,
    stopLossPercent: 1,
    ...overrides,
  };
}

describe("LocalPaperBroker", () => {
  it("starts with the configured virtual cash and no positions/trades", async () => {
    const broker = await LocalPaperBroker.create(new InMemoryPaperBrokerStore(), 10_000, { resetState: true });
    expect(broker.getAccount()).toEqual({ cashBalance: 10_000, startingCashBalance: 10_000 });
    expect(broker.getOpenPositions()).toEqual([]);
    expect(broker.getCompletedTrades()).toEqual([]);
  });

  it("opens a position at the fixture price, deducting cash and assigning stable ids", async () => {
    const broker = await LocalPaperBroker.create(new InMemoryPaperBrokerStore(), 10_000, { resetState: true });
    const { position, orderId } = await broker.placeMarketOrder(makeOrder());

    expect(orderId).toBe("order-1");
    expect(position.positionId).toBe("position-1");
    expect(position.entryPrice).toBe(103);
    expect(position.quantity).toBe(4);
    expect(position.strategyId).toBe("DEMO-0001");
    expect(position.strategyVersion).toBe(1);

    expect(broker.getAccount().cashBalance).toBe(10_000 - 4 * 103);
    expect(broker.getOpenPositions()).toHaveLength(1);
  });

  it("prevents opening a second position for the same strategy + instrument", async () => {
    const broker = await LocalPaperBroker.create(new InMemoryPaperBrokerStore(), 10_000, { resetState: true });
    await broker.placeMarketOrder(makeOrder());
    await expect(broker.placeMarketOrder(makeOrder())).rejects.toThrow(/already has an open position/i);
  });

  it("rejects a non-positive quantity", async () => {
    const broker = await LocalPaperBroker.create(new InMemoryPaperBrokerStore(), 10_000, { resetState: true });
    await expect(broker.placeMarketOrder(makeOrder({ quantity: 0 }))).rejects.toThrow();
  });

  it("rejects an order that exceeds available cash", async () => {
    const broker = await LocalPaperBroker.create(new InMemoryPaperBrokerStore(), 10, { resetState: true });
    await expect(broker.placeMarketOrder(makeOrder())).rejects.toThrow(/insufficient paper cash/i);
  });

  it("closes a position and calculates realised P/L and ending cash correctly", async () => {
    const broker = await LocalPaperBroker.create(new InMemoryPaperBrokerStore(), 10_000, { resetState: true });
    const { position } = await broker.placeMarketOrder(makeOrder());

    const { trade, orderId } = await broker.closePosition(position.positionId, 105.5, "2026-01-01T00:08:00Z", "take-profit");

    expect(orderId).toBe("order-2");
    expect(trade.tradeId).toBe("trade-1");
    expect(trade.realisedPnl).toBeCloseTo((105.5 - 103) * 4, 10);
    expect(trade.exitPrice).toBe(105.5);
    expect(trade.closeReason).toBe("take-profit");

    expect(broker.getOpenPositions()).toEqual([]);
    expect(broker.getCompletedTrades()).toHaveLength(1);

    const expectedCash = 10_000 - 4 * 103 + 4 * 105.5;
    expect(broker.getAccount().cashBalance).toBeCloseTo(expectedCash, 10);
  });

  it("throws clearly when closing a position that doesn't exist (or was already closed)", async () => {
    const broker = await LocalPaperBroker.create(new InMemoryPaperBrokerStore(), 10_000, { resetState: true });
    const { position } = await broker.placeMarketOrder(makeOrder());
    await broker.closePosition(position.positionId, 105, "2026-01-01T00:08:00Z", "test");

    // Closing the same position id a second time must fail clearly, not silently double-book P/L.
    await expect(
      broker.closePosition(position.positionId, 105, "2026-01-01T00:09:00Z", "test-again"),
    ).rejects.toThrow(/no open position/i);
  });

  it("resetState: true always starts fresh regardless of what the store already has", async () => {
    const store = new InMemoryPaperBrokerStore();
    const first = await LocalPaperBroker.create(store, 10_000, { resetState: true });
    await first.placeMarketOrder(makeOrder());

    const second = await LocalPaperBroker.create(store, 10_000, { resetState: true });
    expect(second.getOpenPositions()).toEqual([]);
    expect(second.getAccount().cashBalance).toBe(10_000);
  });
});
