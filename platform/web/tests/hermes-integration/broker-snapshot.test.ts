import { afterEach, describe, expect, it, vi } from "vitest";
import { getBrokerSnapshot } from "@/lib/hermes-integration/broker-snapshot";

// Never calls a real broker/API — BrokerFactory.create is mocked below so this suite exercises
// only broker-snapshot.ts's own mapping/error-handling logic, deterministically and offline.
const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-execution/broker-factory", () => ({
  BrokerFactory: { create: mockCreate },
}));

const mockGetConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-execution/config", () => ({
  getHermesExecutionConfig: mockGetConfig,
}));

const BASE_CONFIG = {
  brokerProvider: "etoro-demo",
  runtimeTrading: { mode: "demo" },
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("getBrokerSnapshot", () => {
  it("returns ok: false when config cannot be built", async () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("HERMES_STRATEGY_REGISTRY_PATH is not set.");
    });
    const result = await getBrokerSnapshot();
    expect(result).toEqual({ ok: false, message: "HERMES_STRATEGY_REGISTRY_PATH is not set." });
  });

  it("returns ok: false when the broker fails to connect", async () => {
    mockGetConfig.mockReturnValue(BASE_CONFIG);
    mockCreate.mockRejectedValue(new Error("eToro connection refused"));
    const result = await getBrokerSnapshot();
    expect(result).toEqual({ ok: false, message: "eToro connection refused" });
  });

  it("uses live getRawPortfolio() ground truth when the broker exposes it (eToro-demo)", async () => {
    mockGetConfig.mockReturnValue(BASE_CONFIG);
    mockCreate.mockResolvedValue({
      getAccount: () => ({ cashBalance: 1234.5, startingCashBalance: 1234.5 }),
      getOpenPositions: () => {
        throw new Error("getOpenPositions should never be called when getRawPortfolio() is available");
      },
      getRawPortfolio: async () => ({
        clientPortfolio: {
          credit: 1234.5,
          positions: [
            { instrumentID: 1001, isBuy: true, amount: 50, openRate: 100, openDateTime: "2026-01-01T00:00:00.000Z" },
            { instrumentID: 1002, isBuy: false, amount: 20 },
          ],
        },
      }),
    });

    const result = await getBrokerSnapshot();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.positionsAreLiveGroundTruth).toBe(true);
    expect(result.cash).toBe(1234.5);
    expect(result.positions).toEqual([
      {
        instrument: "1001",
        side: "BUY",
        quantity: 50,
        entryPrice: 100,
        currentPrice: null,
        unrealisedPnl: null,
        openedAt: "2026-01-01T00:00:00.000Z",
        provider: "etoro-demo",
        accountMode: "demo",
      },
      {
        instrument: "1002",
        side: "SELL",
        quantity: 20,
        entryPrice: null,
        currentPrice: null,
        unrealisedPnl: null,
        openedAt: null,
        provider: "etoro-demo",
        accountMode: "demo",
      },
    ]);
  });

  it("falls back to the generic PaperBroker interface for a broker with no getRawPortfolio()", async () => {
    mockGetConfig.mockReturnValue({ brokerProvider: "local", runtimeTrading: { mode: "paper" } });
    mockCreate.mockResolvedValue({
      getAccount: () => ({ cashBalance: 500, startingCashBalance: 1000 }),
      getOpenPositions: () => [
        { positionId: "p1", instrument: "BTC", side: "BUY", quantity: 1, entryPrice: 100, entryTimestamp: "2026-01-01T00:00:00.000Z" },
      ],
    });

    const result = await getBrokerSnapshot();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.positionsAreLiveGroundTruth).toBe(false);
    expect(result.positions).toEqual([
      {
        instrument: "BTC",
        side: "BUY",
        quantity: 1,
        entryPrice: 100,
        currentPrice: null,
        unrealisedPnl: null,
        openedAt: "2026-01-01T00:00:00.000Z",
        provider: "local",
        accountMode: "paper",
      },
    ]);
  });

  it("returns ok: false, not a thrown error, when getRawPortfolio() itself fails", async () => {
    mockGetConfig.mockReturnValue(BASE_CONFIG);
    mockCreate.mockResolvedValue({
      getAccount: () => ({ cashBalance: 0, startingCashBalance: 0 }),
      getOpenPositions: () => [],
      getRawPortfolio: async () => {
        throw new Error("eToro portfolio read timed out");
      },
    });

    const result = await getBrokerSnapshot();
    expect(result).toEqual({ ok: false, message: "eToro portfolio read timed out" });
  });
});
