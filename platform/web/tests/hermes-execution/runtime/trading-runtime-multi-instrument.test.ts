import { describe, expect, it, vi } from "vitest";
import { TradingRuntime } from "@/lib/hermes-execution/runtime/trading-runtime";
import { AlwaysOpenMarketHoursPolicy } from "@/lib/hermes-execution/runtime/market-hours-policy";
import { MockMarketDataProvider } from "@/lib/hermes-execution/market-data/mock-market-data-provider";
import type { MarketDataProvider, MarketDataSnapshot } from "@/lib/hermes-execution/market-data/market-data-provider";
import { TradeLifecycleService } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-service";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { InMemoryTradeCandidateRepository } from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import { approveTradeCandidate } from "@/lib/hermes-execution/trade-approval/trade-candidate-service";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";
import type { PaperBroker } from "@/lib/hermes-execution/paper-broker";
import type { Account, CompletedTrade, InternalStrategy, OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";
import type { TradeLifecycleRecord } from "@/lib/hermes-execution/trade-lifecycle/types";
import { ManualSchedulerClock } from "./support/manual-scheduler-clock";

// Prototype 1.0 — official Hermes Agent decision integration (Phase 3): multi-instrument runtime
// lifecycle management. Every test here proves the SAME existing, unmodified per-instrument logic
// (recovery/reconciliation/repair/exit-monitor/approved-candidate-execution/duplicate-suppression/
// fresh-candidate-handling) now runs for EVERY configured instrument, not just one — via
// TradingRuntime.runInstrumentCycle, looped once per instrument. One runtime, one scheduler, one
// shared broker/lifecycle/candidate repository/audit trail throughout. No real broker, market
// data, or Hermes CLI anywhere in this file.

const NOW = new Date("2026-01-01T12:00:00.000Z");

const STRATEGY: InternalStrategy = {
  strategyId: "DEMO-0001",
  version: 1,
  sourceType: "HERMES_APPROVED",
  enabled: true,
  instrument: "BTC",
  timeframe: "1h",
  entryRules: [],
  exitRules: [],
  riskRules: { maxPositionValue: 1000 },
};

const PERMISSIVE_RISK_CONFIG: PortfolioRiskConfig = {
  portfolioMaxOpenPositions: 5,
  maxDailyTrades: 20,
  maxPortfolioExposure: 1_000_000,
};

// Fixed numeric instrument ids — mirrors eToro's own numeric instrumentID/positionID scheme
// closely enough for position-reconciliation.ts's raw-portfolio matching path to work
// deterministically in tests (matching by `String(raw.positionID) === record.brokerPositionId`,
// never by instrument name alone once a durable identifier is available).
const INSTRUMENT_NUMERIC_ID: Record<string, number> = { BTC: 100001, ETH: 100002, SOL: 100003, AAPL: 100004, MSFT: 100005, NVDA: 100006 };

function brokerPositionIdFor(instrument: string): string {
  return String(INSTRUMENT_NUMERIC_ID[instrument] ?? 999999);
}

/** Raw-portfolio-capable (getRawPortfolio/resolveInstrument/adoptPosition) so
 * position-reconciliation.ts's advanced path actually attaches a matching TradeLifecycleRecord —
 * required for exit-monitor.ts's stop-loss/take-profit/kill-switch checks to ever run (they are
 * gated on `currentRecord` being truthy, which the plain getOpenPositions()-only fallback path
 * never provides). Each `openPositions` entry must correspond to a lifecycle record whose own
 * `brokerPositionId` is `brokerPositionIdFor(instrument)` — see makeOpenLifecycleRecord below. */
function makeMockBroker(openPositions: PaperPosition[] = []): PaperBroker & {
  placeMarketOrder: ReturnType<typeof vi.fn>;
  closePosition: ReturnType<typeof vi.fn>;
  getRawPortfolio: ReturnType<typeof vi.fn>;
  resolveInstrument: ReturnType<typeof vi.fn>;
  adoptPosition: ReturnType<typeof vi.fn>;
} {
  const account: Account = { cashBalance: 1_000_000, startingCashBalance: 1_000_000 };
  const completedTrades: CompletedTrade[] = [];
  let positionSeq = 0;

  return {
    getAccount: () => account,
    getOpenPositions: () => openPositions,
    getCompletedTrades: () => completedTrades,
    getRawPortfolio: vi.fn(async () => ({
      clientPortfolio: {
        positions: openPositions.map((p) => ({
          positionID: INSTRUMENT_NUMERIC_ID[p.instrument] ?? 999999,
          orderID: 1,
          instrumentID: INSTRUMENT_NUMERIC_ID[p.instrument] ?? 999999,
          isBuy: p.side === "BUY",
          amount: p.quantity,
          openRate: p.entryPrice,
          openDateTime: p.entryTimestamp,
        })),
        credit: account.cashBalance,
      },
    })),
    resolveInstrument: vi.fn(async (term: string) => ({ instrumentId: INSTRUMENT_NUMERIC_ID[term.toUpperCase()] ?? 999999 })),
    adoptPosition: vi.fn(),
    placeMarketOrder: vi.fn(async (order: OrderRequest) => {
      positionSeq += 1;
      const position: PaperPosition = {
        positionId: `mock-position-${positionSeq}`,
        strategyId: order.strategyId,
        strategyVersion: order.strategyVersion,
        sourceType: order.sourceType,
        instrument: order.instrument,
        side: order.side,
        quantity: order.quantity,
        entryPrice: order.price,
        entryTimestamp: order.timestamp,
        entryOrderId: `mock-order-${positionSeq}`,
      };
      openPositions.push(position);
      return { position, orderId: `mock-order-${positionSeq}` };
    }),
    closePosition: vi.fn(async (positionId: string, exitPrice: number, exitTimestamp: string, closeReason: string) => {
      const index = openPositions.findIndex((p) => p.positionId === positionId);
      const position = openPositions[index]!;
      openPositions.splice(index, 1);
      const trade: CompletedTrade = {
        tradeId: `mock-trade-${positionId}`,
        positionId,
        strategyId: position.strategyId,
        strategyVersion: position.strategyVersion,
        sourceType: position.sourceType,
        instrument: position.instrument,
        side: position.side,
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        entryTimestamp: position.entryTimestamp,
        entryOrderId: position.entryOrderId,
        exitPrice,
        exitTimestamp,
        exitOrderId: `mock-close-${positionId}`,
        realisedPnl: exitPrice - position.entryPrice,
        closeReason,
      };
      completedTrades.push(trade);
      return { trade, orderId: `mock-close-${positionId}` };
    }),
  };
}

function makeOpenLifecycleRecord(overrides: Partial<TradeLifecycleRecord> = {}): TradeLifecycleRecord {
  const symbol = overrides.symbol ?? "BTC";
  return {
    id: `lifecycle-${symbol}`,
    brokerProvider: "etoro-demo",
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    symbol: "BTC",
    side: "BUY",
    quantity: 10,
    sizingMode: "UNITS",
    decision: "BUY",
    confidence: 0.8,
    decisionReasons: ["seed"],
    status: "OPEN",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    openedAt: NOW.toISOString(),
    entryPrice: 100,
    brokerPositionId: brokerPositionIdFor(symbol),
    brokerOrderId: `order-${symbol}`,
    ...overrides,
  };
}

interface MultiRuntimeHarness {
  runtime: TradingRuntime;
  broker: ReturnType<typeof makeMockBroker>;
  clock: ManualSchedulerClock;
  auditTrail: InMemoryAuditTrail;
  tradeCandidateRepository: InMemoryTradeCandidateRepository;
  lifecycleStore: InMemoryTradeLifecycleStore;
}

function makeMultiInstrumentRuntime(overrides: {
  instruments: string[];
  openPositions?: PaperPosition[];
  lifecycleStore?: InMemoryTradeLifecycleStore;
  marketDataProvider?: MarketDataProvider;
  killSwitchEnabled?: boolean;
  portfolioRiskConfig?: PortfolioRiskConfig;
  broker?: ReturnType<typeof makeMockBroker>;
  tradeCandidateRepository?: InMemoryTradeCandidateRepository;
}): MultiRuntimeHarness {
  const broker = overrides.broker ?? makeMockBroker(overrides.openPositions ?? []);
  const clock = new ManualSchedulerClock(NOW);
  const auditTrail = new InMemoryAuditTrail();
  const lifecycleStore = overrides.lifecycleStore ?? new InMemoryTradeLifecycleStore();
  const lifecycleService = new TradeLifecycleService({ store: lifecycleStore, auditTrail, executionRunId: "test-run", now: () => clock.now() });
  const marketDataProvider = overrides.marketDataProvider ?? new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
  const tradeCandidateRepository = overrides.tradeCandidateRepository ?? new InMemoryTradeCandidateRepository();

  const runtime = new TradingRuntime({
    broker,
    marketDataProvider,
    strategy: STRATEGY,
    instrument: overrides.instruments[0]!,
    instruments: overrides.instruments,
    amount: 10,
    orderSizingMode: "UNITS",
    brokerProvider: "etoro-demo",
    portfolioRiskConfig: overrides.portfolioRiskConfig ?? PERMISSIVE_RISK_CONFIG,
    lifecycleService,
    lifecycleStore,
    auditTrail,
    marketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
    clock,
    intervalMs: 10_000,
    immediateFirstRun: true,
    tradeCandidateRepository,
    tradeCandidateExpiryMs: 20 * 60_000,
    approvalMode: "MANUAL",
    autoDemoMinConfidence: 0.75,
    killSwitchEnabled: overrides.killSwitchEnabled ?? false,
    recoveryThresholdMs: 5 * 60_000,
  });

  return { runtime, broker, clock, auditTrail, tradeCandidateRepository, lifecycleStore };
}

describe("Multi-instrument runtime — ETH candidate executes through the existing approval path", () => {
  it("a human-approved ETH candidate executes via the broker on the next cycle, alongside BTC's own independent candidate", async () => {
    const { runtime, broker, clock, auditTrail, tradeCandidateRepository } = makeMultiInstrumentRuntime({ instruments: ["BTC", "ETH"] });
    await runtime.start();
    await clock.advance(0); // cycle 1: creates PENDING candidates for both BTC and ETH

    const pendingEth = (await tradeCandidateRepository.list({ status: "PENDING" })).find((c) => c.instrument === "ETH");
    expect(pendingEth).toBeDefined();

    await approveTradeCandidate({
      repository: tradeCandidateRepository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: pendingEth!.id,
      approvedByUserId: "user-1",
      now: clock.now(),
    });

    await clock.advance(10_000); // cycle 2: executes the now-approved ETH candidate

    expect(broker.placeMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ instrument: "ETH" }));
    const executedEth = await tradeCandidateRepository.getById(pendingEth!.id);
    expect(executedEth?.status).toBe("EXECUTED");

    await runtime.stop();
  });
});

describe("Multi-instrument runtime — ETH OPEN lifecycle is reconciled after restart", () => {
  it("an ETH position already open at the broker is reconciled (not re-adopted as an orphan) on the first cycle after restart", async () => {
    const ethPosition: PaperPosition = {
      positionId: "eth-existing",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "ETH",
      side: "BUY",
      quantity: 10,
      entryPrice: 100,
      entryTimestamp: NOW.toISOString(),
      entryOrderId: "eth-order-1",
      brokerPositionId: brokerPositionIdFor("ETH"),
    };
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(
      makeOpenLifecycleRecord({ id: "lifecycle-eth", symbol: "ETH", stopLoss: undefined, takeProfit: undefined }),
    );

    const { runtime, clock, auditTrail } = makeMultiInstrumentRuntime({
      instruments: ["BTC", "ETH"],
      openPositions: [ethPosition],
      lifecycleStore,
    });
    await runtime.start();
    await clock.advance(0);

    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).not.toContain("BROKER_POSITION_ORPHANED");
    const stored = await lifecycleStore.getById("lifecycle-eth");
    expect(stored?.status).toBe("OPEN"); // untouched — genuinely still open, correctly reconciled

    await runtime.stop();
  });
});

describe("Multi-instrument runtime — ETH stop-loss closes automatically", () => {
  it("closes ETH via the broker when its stop-loss is hit, independent of BTC", async () => {
    const ethPosition: PaperPosition = {
      positionId: "eth-existing",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "ETH",
      side: "BUY",
      quantity: 10,
      entryPrice: 100,
      entryTimestamp: NOW.toISOString(),
      entryOrderId: "eth-order-1",
      brokerPositionId: brokerPositionIdFor("ETH"),
    };
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    // stopLoss far ABOVE any plausible mock bid — guarantees freshBid <= stopLoss (STOP_LOSS) fires.
    await lifecycleStore.create(
      makeOpenLifecycleRecord({ id: "lifecycle-eth", symbol: "ETH", stopLoss: 999_999, takeProfit: undefined }),
    );

    const { runtime, broker, clock, auditTrail } = makeMultiInstrumentRuntime({
      instruments: ["BTC", "ETH"],
      openPositions: [ethPosition],
      lifecycleStore,
    });
    await runtime.start();
    await clock.advance(0);

    expect(broker.closePosition).toHaveBeenCalledWith("eth-existing", expect.anything(), expect.anything(), expect.anything());
    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toContain("AUTOMATIC_EXIT_TRIGGERED");
    const triggered = (await auditTrail.getEvents()).find((e) => e.eventType === "AUTOMATIC_EXIT_TRIGGERED" && e.instrument === "ETH");
    expect(triggered?.details.trigger).toBe("STOP_LOSS");

    await runtime.stop();
  });
});

describe("Multi-instrument runtime — SOL take-profit closes automatically", () => {
  it("closes SOL via the broker when its take-profit is hit", async () => {
    const solPosition: PaperPosition = {
      positionId: "sol-existing",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "SOL",
      side: "BUY",
      quantity: 10,
      entryPrice: 100,
      entryTimestamp: NOW.toISOString(),
      entryOrderId: "sol-order-1",
      brokerPositionId: brokerPositionIdFor("SOL"),
    };
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    // takeProfit far BELOW any plausible mock bid — guarantees freshBid >= takeProfit (TAKE_PROFIT) fires.
    await lifecycleStore.create(
      makeOpenLifecycleRecord({ id: "lifecycle-sol", symbol: "SOL", stopLoss: undefined, takeProfit: 0.01 }),
    );

    const { runtime, broker, clock, auditTrail } = makeMultiInstrumentRuntime({
      instruments: ["BTC", "SOL"],
      openPositions: [solPosition],
      lifecycleStore,
    });
    await runtime.start();
    await clock.advance(0);

    expect(broker.closePosition).toHaveBeenCalledWith("sol-existing", expect.anything(), expect.anything(), expect.anything());
    const triggered = (await auditTrail.getEvents()).find((e) => e.eventType === "AUTOMATIC_EXIT_TRIGGERED" && e.instrument === "SOL");
    expect(triggered?.details.trigger).toBe("TAKE_PROFIT");

    await runtime.stop();
  });
});

describe("Multi-instrument runtime — an AAPL position is monitored while BTC has no proposal/position", () => {
  it("processes both instruments every cycle: AAPL's existing open position is evaluated for exit while BTC is independently evaluated for entry", async () => {
    const aaplPosition: PaperPosition = {
      positionId: "aapl-existing",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "AAPL",
      side: "BUY",
      quantity: 10,
      entryPrice: 100,
      entryTimestamp: NOW.toISOString(),
      entryOrderId: "aapl-order-1",
      brokerPositionId: brokerPositionIdFor("AAPL"),
    };
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    // No stop-loss/take-profit set — AAPL should simply be held (no exit trigger), never ignored.
    await lifecycleStore.create(
      makeOpenLifecycleRecord({ id: "lifecycle-aapl", symbol: "AAPL", stopLoss: undefined, takeProfit: undefined }),
    );

    const { runtime, clock } = makeMultiInstrumentRuntime({ instruments: ["BTC", "AAPL"], openPositions: [aaplPosition], lifecycleStore });
    await runtime.start();
    await clock.advance(0);

    const status = runtime.getStatus();
    expect(Object.keys(status.lastResult?.perInstrument ?? {})).toEqual(expect.arrayContaining(["BTC", "AAPL"]));
    expect(status.lastResult?.perInstrument?.AAPL?.positionOpen).toBe(true);

    await runtime.stop();
  });
});

describe("Multi-instrument runtime — kill switch across multiple instruments", () => {
  it("force-closes every open position across BTC and ETH, and blocks any new entry for either", async () => {
    const btcPosition: PaperPosition = {
      positionId: "btc-existing",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "BTC",
      side: "BUY",
      quantity: 10,
      entryPrice: 100,
      entryTimestamp: NOW.toISOString(),
      entryOrderId: "btc-order-1",
      brokerPositionId: brokerPositionIdFor("BTC"),
    };
    const ethPosition: PaperPosition = {
      positionId: "eth-existing",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "ETH",
      side: "BUY",
      quantity: 10,
      entryPrice: 100,
      entryTimestamp: NOW.toISOString(),
      entryOrderId: "eth-order-1",
      brokerPositionId: brokerPositionIdFor("ETH"),
    };
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ id: "lifecycle-btc", symbol: "BTC" }));
    await lifecycleStore.create(makeOpenLifecycleRecord({ id: "lifecycle-eth", symbol: "ETH" }));

    const { runtime, broker, clock } = makeMultiInstrumentRuntime({
      instruments: ["BTC", "ETH"],
      openPositions: [btcPosition, ethPosition],
      lifecycleStore,
      killSwitchEnabled: true,
    });
    await runtime.start();
    await clock.advance(0);

    expect(broker.closePosition).toHaveBeenCalledWith("btc-existing", expect.anything(), expect.anything(), expect.anything());
    expect(broker.closePosition).toHaveBeenCalledWith("eth-existing", expect.anything(), expect.anything(), expect.anything());
    // No new BUY entry created for either instrument while the kill switch is on.
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();

    await runtime.stop();
  });
});

describe("Multi-instrument runtime — one instrument's failure never blocks another's exit check", () => {
  it("BTC's market-data failure does not prevent ETH's own stop-loss from closing", async () => {
    const ethPosition: PaperPosition = {
      positionId: "eth-existing",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "ETH",
      side: "BUY",
      quantity: 10,
      entryPrice: 100,
      entryTimestamp: NOW.toISOString(),
      entryOrderId: "eth-order-1",
      brokerPositionId: brokerPositionIdFor("ETH"),
    };
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(
      makeOpenLifecycleRecord({ id: "lifecycle-eth", symbol: "ETH", stopLoss: 999_999, takeProfit: undefined }),
    );

    const goodProvider = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
    const throwingProvider: MarketDataProvider = {
      getMarketData: async (instrument: string): Promise<MarketDataSnapshot> => {
        if (instrument === "BTC") throw new Error("simulated BTC market-data outage");
        return goodProvider.getMarketData(instrument);
      },
    };

    const { runtime, broker, clock } = makeMultiInstrumentRuntime({
      instruments: ["BTC", "ETH"],
      openPositions: [ethPosition],
      lifecycleStore,
      marketDataProvider: throwingProvider,
    });
    await runtime.start();
    await clock.advance(0);

    // BTC's own failure was isolated; ETH's stop-loss still fired.
    expect(broker.closePosition).toHaveBeenCalledWith("eth-existing", expect.anything(), expect.anything(), expect.anything());
    const status = runtime.getStatus();
    expect(status.failedRunCount).toBe(0); // the cycle itself completed successfully overall — isolation, not a cycle-wide failure
    // Candle-gap production incident fix. A market-data (candle) failure is no longer conflated
    // with a reconciliation failure — BTC's reconciliation itself succeeded; only fresh analysis
    // is blocked, honestly reported via marketDataUnavailableReason instead.
    expect(status.lastResult?.perInstrument?.BTC?.reconciliationFailed).toBeUndefined();
    expect(status.lastResult?.perInstrument?.BTC?.marketDataUnavailableReason).toBe("simulated BTC market-data outage");
    expect(status.lastResult?.perInstrument?.ETH?.exitTrigger).toBe("STOP_LOSS"); // ETH's own outcome is entirely unaffected

    await runtime.stop();
  });
});

describe("Multi-instrument runtime — portfolio maximum is shared across all instruments", () => {
  it("a third instrument's approved BUY is blocked by the existing PortfolioRiskEngine once two positions are already open", async () => {
    const btcPosition: PaperPosition = {
      positionId: "btc-existing",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "BTC",
      side: "BUY",
      quantity: 10,
      entryPrice: 100,
      entryTimestamp: NOW.toISOString(),
      entryOrderId: "btc-order-1",
      brokerPositionId: brokerPositionIdFor("BTC"),
    };
    const ethPosition: PaperPosition = {
      positionId: "eth-existing",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "ETH",
      side: "BUY",
      quantity: 10,
      entryPrice: 100,
      entryTimestamp: NOW.toISOString(),
      entryOrderId: "eth-order-1",
      brokerPositionId: brokerPositionIdFor("ETH"),
    };
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ id: "lifecycle-btc", symbol: "BTC" }));
    await lifecycleStore.create(makeOpenLifecycleRecord({ id: "lifecycle-eth", symbol: "ETH" }));

    const tradeCandidateRepository = new InMemoryTradeCandidateRepository();
    // A pre-approved SOL BUY candidate, ready to execute this cycle.
    const solCandidate = await tradeCandidateRepository.create({
      analysisRunId: undefined,
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      instrument: "SOL",
      direction: "BUY",
      confidence: 0.8,
      entryPrice: 100,
      stopLoss: 90,
      takeProfit: 110,
      riskReward: 2,
      reasoning: ["seed"],
      validationNotes: [],
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      execution: {
        amount: 10,
        sizingMode: "UNITS",
        marketContext: {
          instrument: "SOL",
          bid: 100,
          ask: 100.05,
          spread: 0.05,
          midPrice: 100.025,
          timestamp: NOW.toISOString(),
          positionOpen: false,
          strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "HERMES_APPROVED" },
          recentCandles: [],
          ema20: 110,
          ema50: 100,
          rsi14: 55,
          atr14: 1.5,
          volume: 10,
          dailyHigh: 100,
          dailyLow: 100,
          volatility24h: 0.01,
          marketSession: "Crypto Always Open",
          trend: "Bullish",
        },
        marketDataSnapshot: { instrument: "SOL", timestamp: NOW.toISOString(), candles: [], bid: 100, ask: 100.05, spread: 0.05, latestPrice: 100.025, volume: 10 },
      },
    });
    await tradeCandidateRepository.transition(solCandidate.id, "PENDING", { status: "APPROVED", approvedAt: NOW.toISOString(), approvedByUserId: "user-1" });

    const broker = makeMockBroker([btcPosition, ethPosition]);
    const restrictiveRiskConfig: PortfolioRiskConfig = { portfolioMaxOpenPositions: 2, maxDailyTrades: 20, maxPortfolioExposure: 1_000_000 };

    const { runtime, clock } = makeMultiInstrumentRuntime({
      instruments: ["BTC", "ETH", "SOL"],
      broker,
      lifecycleStore,
      portfolioRiskConfig: restrictiveRiskConfig,
      tradeCandidateRepository,
    });
    await runtime.start();
    await clock.advance(0);

    // The SOL candidate was never executed — 2 positions already open, portfolioMaxOpenPositions is 2.
    expect(broker.placeMarketOrder).not.toHaveBeenCalledWith(expect.objectContaining({ instrument: "SOL" }));

    await runtime.stop();
  });
});

describe("Multi-instrument runtime — no duplicate broker orders across cycles", () => {
  it("an already-executed candidate is never re-submitted to the broker on a later cycle", async () => {
    const { runtime, broker, clock, auditTrail, tradeCandidateRepository } = makeMultiInstrumentRuntime({ instruments: ["BTC", "ETH"] });
    await runtime.start();
    await clock.advance(0); // creates PENDING candidates

    const pendingBtc = (await tradeCandidateRepository.list({ status: "PENDING" })).find((c) => c.instrument === "BTC");
    await approveTradeCandidate({
      repository: tradeCandidateRepository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: pendingBtc!.id,
      approvedByUserId: "user-1",
      now: clock.now(),
    });

    await clock.advance(10_000); // executes BTC
    expect(broker.placeMarketOrder).toHaveBeenCalledTimes(1);

    await clock.advance(10_000); // a further cycle — the same candidate must never execute again
    expect(broker.placeMarketOrder).toHaveBeenCalledTimes(1);

    await runtime.stop();
  });
});

describe("Multi-instrument runtime — one runtime and scheduler handle the whole universe", () => {
  it("a single TradingRuntime/scheduler processes all six configured instruments every tick", async () => {
    const universe = ["BTC", "ETH", "SOL", "AAPL", "MSFT", "NVDA"];
    const { runtime, clock } = makeMultiInstrumentRuntime({ instruments: universe });
    await runtime.start();
    await clock.advance(0);

    const status = runtime.getStatus();
    expect(status.successfulRunCount).toBe(1);
    expect(Object.keys(status.lastResult?.perInstrument ?? {}).sort()).toEqual([...universe].sort());

    await runtime.stop();
  });
});
