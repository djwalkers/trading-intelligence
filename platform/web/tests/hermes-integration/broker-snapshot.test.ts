import { afterEach, describe, expect, it, vi } from "vitest";
import { getBrokerSnapshot, resetInstrumentIdToSymbolCacheForTests } from "@/lib/hermes-integration/broker-snapshot";

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
  hermesAgent: { instrumentUniverse: ["BTC", "ETH", "SOL", "AAPL", "MSFT", "NVDA"] },
};

afterEach(() => {
  vi.clearAllMocks();
  resetInstrumentIdToSymbolCacheForTests();
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

  // Main Dashboard Hermes/eToro fix — instrument-ID-to-symbol mapping. eToro exposes only a
  // numeric instrumentID on a raw position; a broker adapter that ALSO supports resolveInstrument()
  // must have its known ids mapped back to the app's own configured symbol, never left as an
  // opaque number when a resolution is available.
  describe("instrument-ID-to-symbol mapping", () => {
    function makeResolvableBroker(idsBySymbol: Record<string, number>, positions: Array<{ instrumentID: number; isBuy?: boolean; amount?: number }>) {
      const resolveInstrument = vi.fn(async (term: string) => {
        const instrumentId = idsBySymbol[term];
        if (instrumentId === undefined) throw new Error(`no fixture id for ${term}`);
        return { instrumentId, displayName: term, symbol: term };
      });
      return {
        getAccount: () => ({ cashBalance: 1000, startingCashBalance: 1000 }),
        getOpenPositions: () => [],
        getRawPortfolio: async () => ({ clientPortfolio: { credit: 1000, positions } }),
        resolveInstrument,
      };
    }

    it("maps a known instrument id to its configured symbol instead of the raw numeric id", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      const broker = makeResolvableBroker({ BTC: 100_000, ETH: 100_001 }, [{ instrumentID: 100_000, isBuy: true, amount: 10 }]);
      mockCreate.mockResolvedValue(broker);

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.positions[0]?.instrument).toBe("BTC");
    });

    it("falls back to the raw numeric id (never guesses) for an instrument that fails to resolve", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      const broker = makeResolvableBroker({ BTC: 100_000 }, [{ instrumentID: 999_999, isBuy: true, amount: 10 }]);
      mockCreate.mockResolvedValue(broker);

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.positions[0]?.instrument).toBe("999999");
    });

    it("resolves the configured universe only once (module-level cache) across repeated calls", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      const broker = makeResolvableBroker({ BTC: 100_000, ETH: 100_001 }, [{ instrumentID: 100_000, isBuy: true, amount: 10 }]);
      mockCreate.mockResolvedValue(broker);

      await getBrokerSnapshot();
      const callsAfterFirst = broker.resolveInstrument.mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);

      await getBrokerSnapshot();
      expect(broker.resolveInstrument.mock.calls.length).toBe(callsAfterFirst); // no new calls
    });

    it("never attempts resolution at all for a broker with no resolveInstrument capability", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      mockCreate.mockResolvedValue({
        getAccount: () => ({ cashBalance: 1000, startingCashBalance: 1000 }),
        getOpenPositions: () => [],
        getRawPortfolio: async () => ({ clientPortfolio: { credit: 1000, positions: [{ instrumentID: 100_000, isBuy: true, amount: 10 }] } }),
      });

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.positions[0]?.instrument).toBe("100000");
    });
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
