import { afterEach, describe, expect, it, vi } from "vitest";
import { getBrokerSnapshot, resetInstrumentIdToSymbolCacheForTests } from "@/lib/hermes-integration/broker-snapshot";

// Never calls a real broker/API — BrokerFactory.create is mocked below so this suite exercises
// only broker-snapshot.ts's own mapping/pricing/error-handling logic, deterministically and
// offline.
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

  it("uses live getRawPortfolio() ground truth when the broker exposes it (eToro-demo), with no rate-quoting capability", async () => {
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
            {
              positionID: 5001,
              instrumentID: 1001,
              isBuy: true,
              amount: 50,
              units: 2,
              openRate: 100,
              openDateTime: "2026-01-01T00:00:00.000Z",
            },
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
    // No getRate() on this fake broker at all — every position must come back genuinely
    // unavailable for pricing, never a fabricated/zero price, and the total must be marked
    // incomplete rather than silently summing to a partial (here: zero-position) total.
    expect(result.unrealisedPnlComplete).toBe(false);
    expect(result.unrealisedPnlUnavailableReason).toBe("The connected broker does not support live rate quoting.");
    expect(result.positions).toEqual([
      {
        instrument: "1001",
        brokerInstrumentId: 1001,
        side: "BUY",
        quantity: 50,
        units: 2,
        entryPrice: 100,
        currentPrice: null,
        unrealisedPnl: null,
        pricingTimestamp: null,
        pricingSource: "unavailable",
        pricingFailureReason: "The connected broker does not support live rate quoting.",
        openedAt: "2026-01-01T00:00:00.000Z",
        provider: "etoro-demo",
        accountMode: "demo",
        brokerPositionId: "5001",
      },
      {
        instrument: "1002",
        brokerInstrumentId: 1002,
        side: "SELL",
        quantity: 20,
        units: null,
        entryPrice: null,
        currentPrice: null,
        unrealisedPnl: null,
        pricingTimestamp: null,
        pricingSource: "unavailable",
        pricingFailureReason: "The connected broker does not support live rate quoting.",
        openedAt: null,
        provider: "etoro-demo",
        accountMode: "demo",
        brokerPositionId: null,
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
        brokerInstrumentId: null,
        side: "BUY",
        quantity: 1,
        units: 1,
        entryPrice: 100,
        currentPrice: null,
        unrealisedPnl: null,
        pricingTimestamp: null,
        pricingSource: "unavailable",
        pricingFailureReason: "The connected broker does not support live rate quoting.",
        openedAt: "2026-01-01T00:00:00.000Z",
        provider: "local",
        accountMode: "paper",
        brokerPositionId: null,
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

  // Missing-financial-data fix — unrealised P/L computation. A broker that also implements
  // getRate() (EtoroDemoBroker's real shape) is priced position-by-position, using the position's
  // TRUE underlying units (never the notional/margin `amount`) and the side-correct quote (bid for
  // a long/BUY position, ask for a short/SELL position — the price that would actually be realised
  // by closing right now).
  describe("unrealised P/L — live pricing", () => {
    function makeQuotingBroker(
      positions: Array<{ positionID?: number; instrumentID: number; isBuy?: boolean; amount?: number; units?: number; openRate?: number }>,
      rates: Record<string, { bid: number; ask: number }>,
      cashBalance = 1000,
    ) {
      const getRate = vi.fn(async (instrument: string) => {
        const rate = rates[instrument];
        if (!rate) throw new Error(`no fixture rate for ${instrument}`);
        return rate;
      });
      return {
        getAccount: () => ({ cashBalance, startingCashBalance: cashBalance }),
        getOpenPositions: () => [],
        getRawPortfolio: async () => ({ clientPortfolio: { credit: cashBalance, positions } }),
        getRate,
      };
    }

    it("computes a long (BUY) position's unrealised P/L from the BID price and true units, not the notional amount", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      // amount (notional) is 500 — a leveraged figure deliberately different from units x price, to
      // prove the calculation uses `units` (2), never `amount`.
      mockCreate.mockResolvedValue(
        makeQuotingBroker(
          [{ instrumentID: 1001, isBuy: true, amount: 500, units: 2, openRate: 100 }],
          { "1001": { bid: 110, ask: 111 } },
        ),
      );

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.unrealisedPnlComplete).toBe(true);
      expect(result.unrealisedPnlUnavailableReason).toBeNull();
      expect(result.positions[0]?.currentPrice).toBe(110);
      expect(result.positions[0]?.pricingSource).toBe("broker");
      expect(result.positions[0]?.unrealisedPnl).toBeCloseTo((110 - 100) * 2, 6);
    });

    it("computes a short (SELL) position's unrealised P/L from the ASK price", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      mockCreate.mockResolvedValue(
        makeQuotingBroker([{ instrumentID: 1002, isBuy: false, amount: 200, units: 5, openRate: 50 }], { "1002": { bid: 45, ask: 48 } }),
      );

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.positions[0]?.currentPrice).toBe(48);
      expect(result.positions[0]?.unrealisedPnl).toBeCloseTo((50 - 48) * 5, 6);
    });

    it("aggregates multiple positions' unrealised P/L correctly when all are priced", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      mockCreate.mockResolvedValue(
        makeQuotingBroker(
          [
            { instrumentID: 1001, isBuy: true, amount: 500, units: 2, openRate: 100 },
            { instrumentID: 1002, isBuy: false, amount: 200, units: 5, openRate: 50 },
          ],
          { "1001": { bid: 110, ask: 111 }, "1002": { bid: 45, ask: 48 } },
        ),
      );

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.unrealisedPnlComplete).toBe(true);
      const total = result.positions.reduce((sum, p) => sum + (p.unrealisedPnl ?? 0), 0);
      expect(total).toBeCloseTo((110 - 100) * 2 + (50 - 48) * 5, 6);
    });

    it("marks the total incomplete (never silently zero/partial) when one position's live price cannot be fetched", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      mockCreate.mockResolvedValue(
        makeQuotingBroker(
          [
            { instrumentID: 1001, isBuy: true, amount: 500, units: 2, openRate: 100 },
            { instrumentID: 1002, isBuy: false, amount: 200, units: 5, openRate: 50 }, // no fixture rate below — getRate() throws
          ],
          { "1001": { bid: 110, ask: 111 } },
        ),
      );

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.unrealisedPnlComplete).toBe(false);
      expect(result.unrealisedPnlUnavailableReason).toContain("1002");
      const priced = result.positions.find((p) => p.instrument === "1001");
      const unpriced = result.positions.find((p) => p.instrument === "1002");
      expect(priced?.pricingSource).toBe("broker");
      expect(priced?.unrealisedPnl).not.toBeNull();
      // The successfully-priced position's own figure is still reported — only the AGGREGATE is
      // marked incomplete — but the unpriced one is never defaulted to zero.
      expect(unpriced?.pricingSource).toBe("unavailable");
      expect(unpriced?.currentPrice).toBeNull();
      expect(unpriced?.unrealisedPnl).toBeNull();
    });

    it("treats a position with no known units as unpriceable — never silently treated as zero", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      mockCreate.mockResolvedValue(
        makeQuotingBroker([{ instrumentID: 1001, isBuy: true, amount: 500, openRate: 100 }], { "1001": { bid: 110, ask: 111 } }),
      );

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.unrealisedPnlComplete).toBe(false);
      expect(result.positions[0]?.pricingSource).toBe("unavailable");
      expect(result.positions[0]?.unrealisedPnl).toBeNull();
    });

    it("treats an ambiguous ('unknown') side as unpriceable", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      mockCreate.mockResolvedValue(
        makeQuotingBroker([{ instrumentID: 1001, amount: 500, units: 2, openRate: 100 }], { "1001": { bid: 110, ask: 111 } }),
      );

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.positions[0]?.side).toBe("unknown");
      expect(result.positions[0]?.pricingSource).toBe("unavailable");
      expect(result.unrealisedPnlComplete).toBe(false);
    });

    it("unrealisedPnlComplete is vacuously true when there are no open positions at all", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      mockCreate.mockResolvedValue(makeQuotingBroker([], {}));

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.unrealisedPnlComplete).toBe(true);
      expect(result.unrealisedPnlUnavailableReason).toBeNull();
      expect(result.positions).toEqual([]);
    });

    it("exposes the broker's own positionID as brokerPositionId, stringified", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      mockCreate.mockResolvedValue(
        makeQuotingBroker([{ positionID: 42, instrumentID: 1001, isBuy: true, amount: 500, units: 2, openRate: 100 }], {
          "1001": { bid: 110, ask: 111 },
        }),
      );

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.positions[0]?.brokerPositionId).toBe("42");
    });
  });

  // Instrument-resolution defect fix. Reproduces the production error verbatim:
  // `"ETH" was never resolved through resolveInstrument()` / `"BTC" was never resolved through
  // resolveInstrument()`. This fake broker mirrors EtoroDemoBroker's REAL behaviour exactly:
  // getRate(term) refuses to quote any term this SPECIFIC broker instance has not itself resolved
  // via resolveInstrument() first — its own unresolved-instrument safety guard, never weakened or
  // bypassed by this fix.
  describe("instrument resolution before live quoting (production defect fix)", () => {
    function makeEtoroLikeBroker(
      idsBySymbol: Record<string, number>,
      positions: Array<{ positionID?: number; instrumentID: number; isBuy?: boolean; amount?: number; units?: number; openRate?: number }>,
      ratesByInstrumentId: Record<number, { bid: number; ask: number }>,
      cashBalance = 1000,
    ) {
      const resolvedInstruments = new Map<string, number>();

      const resolveInstrument = vi.fn(async (term: string) => {
        const instrumentId = idsBySymbol[term];
        if (instrumentId === undefined) throw new Error(`no fixture id for ${term}`);
        resolvedInstruments.set(term, instrumentId);
        return { instrumentId, displayName: term, symbol: term };
      });

      const getRate = vi.fn(async (term: string) => {
        const instrumentId = resolvedInstruments.get(term);
        if (instrumentId === undefined) {
          // The exact real EtoroDemoBroker.requireResolvedInstrument() safety-guard message.
          throw new Error(`"${term}" was never resolved through resolveInstrument() — refusing to submit an order against unresolved market data.`);
        }
        const rate = ratesByInstrumentId[instrumentId];
        if (!rate) throw new Error(`no fixture rate for instrument ${instrumentId}`);
        return rate;
      });

      return {
        getAccount: () => ({ cashBalance, startingCashBalance: cashBalance }),
        getOpenPositions: () => [],
        getRawPortfolio: async () => ({ clientPortfolio: { credit: cashBalance, positions } }),
        resolveInstrument,
        getRate,
      };
    }

    it("resolves and prices a raw BTC instrument id successfully, without ever relying on a prior resolveInstrument() call", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      const broker = makeEtoroLikeBroker(
        { BTC: 100_000, ETH: 100_001 },
        [{ instrumentID: 100_000, isBuy: true, amount: 500, units: 2, openRate: 100 }],
        { 100_000: { bid: 110, ask: 111 } },
      );
      mockCreate.mockResolvedValue(broker);

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(broker.resolveInstrument).toHaveBeenCalledWith("BTC");
      expect(result.positions[0]?.pricingSource).toBe("broker");
      expect(result.positions[0]?.currentPrice).toBe(110);
      expect(result.positions[0]?.unrealisedPnl).toBeCloseTo(20, 6);
      expect(result.unrealisedPnlComplete).toBe(true);
    });

    it("resolves and prices a raw ETH instrument id successfully", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      const broker = makeEtoroLikeBroker(
        { BTC: 100_000, ETH: 100_001 },
        [{ instrumentID: 100_001, isBuy: false, amount: 200, units: 5, openRate: 50 }],
        { 100_001: { bid: 45, ask: 48 } },
      );
      mockCreate.mockResolvedValue(broker);

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(broker.resolveInstrument).toHaveBeenCalledWith("ETH");
      expect(result.positions[0]?.pricingSource).toBe("broker");
      expect(result.positions[0]?.currentPrice).toBe(48);
      expect(result.positions[0]?.unrealisedPnl).toBeCloseTo((50 - 48) * 5, 6);
    });

    it("keeps friendly display symbols in the API response even though pricing resolves via the same symbol internally", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      const broker = makeEtoroLikeBroker(
        { BTC: 100_000, ETH: 100_001 },
        [
          { instrumentID: 100_000, isBuy: true, amount: 500, units: 2, openRate: 100 },
          { instrumentID: 100_001, isBuy: false, amount: 200, units: 5, openRate: 50 },
        ],
        { 100_000: { bid: 110, ask: 111 }, 100_001: { bid: 45, ask: 48 } },
      );
      mockCreate.mockResolvedValue(broker);

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.positions.map((p) => p.instrument)).toEqual(["BTC", "ETH"]);
      expect(result.positions.map((p) => p.brokerInstrumentId)).toEqual([100_000, 100_001]);
    });

    it("leaves an instrument that cannot be resolved genuinely unavailable — never bypasses the adapter's safety guard to force a price", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);
      const broker = makeEtoroLikeBroker(
        { BTC: 100_000 }, // ETH deliberately absent from the resolvable universe
        [{ instrumentID: 100_001, isBuy: true, amount: 200, units: 5, openRate: 50 }],
        { 100_001: { bid: 45, ask: 48 } },
      );
      mockCreate.mockResolvedValue(broker);

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // instrumentID 100001 has no known symbol mapping at all here, so `instrument` falls back to
      // the raw numeric id — resolveInstrument("100001") then genuinely fails (no such search term).
      expect(result.positions[0]?.instrument).toBe("100001");
      expect(result.positions[0]?.pricingSource).toBe("unavailable");
      expect(result.positions[0]?.pricingFailureReason).toContain("Could not resolve");
      expect(result.positions[0]?.currentPrice).toBeNull();
      expect(result.positions[0]?.unrealisedPnl).toBeNull();
      expect(result.unrealisedPnlComplete).toBe(false);
      // getRate() must never even be attempted once resolution has failed — the safety guard is
      // never worked around.
      expect(broker.getRate).not.toHaveBeenCalled();
    });

    it("refuses to price a position when resolving its display symbol resolves to a DIFFERENT instrument than its own known broker instrument id", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);

      // Deliberately flaky resolution: "BTC" resolves to 100000 the first time (during the
      // id-to-symbol display-mapping pass, matching this position's own raw instrumentID — so it
      // is correctly displayed as "BTC") but to a DIFFERENT id (999999) the second time (during the
      // live-pricing resolution step) — simulating an ambiguous/drifted resolution. Pricing against
      // 999999 would silently attach the WRONG market's price to this position's P/L, so it must be
      // refused rather than risked.
      let btcResolveCount = 0;
      const resolveInstrument = vi.fn(async (term: string) => {
        if (term !== "BTC") throw new Error(`no fixture id for ${term}`);
        btcResolveCount += 1;
        return { instrumentId: btcResolveCount === 1 ? 100_000 : 999_999, displayName: term, symbol: term };
      });
      const getRate = vi.fn(async () => ({ bid: 110, ask: 111 }));
      const broker = {
        getAccount: () => ({ cashBalance: 1000, startingCashBalance: 1000 }),
        getOpenPositions: () => [],
        getRawPortfolio: async () => ({
          clientPortfolio: { credit: 1000, positions: [{ instrumentID: 100_000, isBuy: true, amount: 500, units: 2, openRate: 100 }] },
        }),
        resolveInstrument,
        getRate,
      };
      mockCreate.mockResolvedValue(broker);

      const result = await getBrokerSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.positions[0]?.instrument).toBe("BTC"); // display mapping still correct
      expect(result.positions[0]?.pricingSource).toBe("unavailable");
      expect(result.positions[0]?.pricingFailureReason).toContain("resolved to a different eToro instrument");
      expect(getRate).not.toHaveBeenCalled();
    });

    it("regression: prices correctly on a brand-new broker instance even when the module-level id-to-symbol cache is already warm from a PRIOR instance", async () => {
      mockGetConfig.mockReturnValue(BASE_CONFIG);

      const firstBroker = makeEtoroLikeBroker(
        { BTC: 100_000, ETH: 100_001 },
        [{ instrumentID: 100_000, isBuy: true, amount: 500, units: 2, openRate: 100 }],
        { 100_000: { bid: 110, ask: 111 } },
      );
      mockCreate.mockResolvedValueOnce(firstBroker);
      const firstResult = await getBrokerSnapshot();
      expect(firstResult.ok).toBe(true);

      // getBrokerSnapshot() constructs a brand-new, throwaway broker per call — this second
      // instance's own resolvedInstruments cache starts EMPTY, even though the module-level
      // id-to-symbol display map is already warm from firstBroker above. Before this fix, pricing
      // relied on that stale resolution and getRate() would throw exactly the production error.
      const secondBroker = makeEtoroLikeBroker(
        { BTC: 100_000, ETH: 100_001 },
        [{ instrumentID: 100_000, isBuy: true, amount: 500, units: 2, openRate: 100 }],
        { 100_000: { bid: 120, ask: 121 } },
      );
      mockCreate.mockResolvedValueOnce(secondBroker);

      const secondResult = await getBrokerSnapshot();
      expect(secondResult.ok).toBe(true);
      if (!secondResult.ok) return;
      expect(secondBroker.resolveInstrument).toHaveBeenCalledWith("BTC");
      expect(secondResult.positions[0]?.pricingSource).toBe("broker");
      expect(secondResult.positions[0]?.currentPrice).toBe(120);
      expect(secondResult.unrealisedPnlComplete).toBe(true);
    });
  });
});
