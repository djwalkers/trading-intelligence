import { describe, expect, it, vi } from "vitest";
import { TradingRuntime } from "@/lib/hermes-execution/runtime/trading-runtime";
import { AlwaysOpenMarketHoursPolicy } from "@/lib/hermes-execution/runtime/market-hours-policy";
import { MockMarketDataProvider } from "@/lib/hermes-execution/market-data/mock-market-data-provider";
import type { MarketDataProvider, MarketDataSnapshot } from "@/lib/hermes-execution/market-data/market-data-provider";
import { TradeLifecycleService } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-service";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { InMemoryTradeCandidateRepository } from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";
import type { PaperBroker } from "@/lib/hermes-execution/paper-broker";
import type { Account, CompletedTrade, InternalStrategy, OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";
import type { TradeLifecycleRecord } from "@/lib/hermes-execution/trade-lifecycle/types";
import { ManualSchedulerClock } from "./support/manual-scheduler-clock";
import { getHermesAgentInternalStrategy } from "@/lib/hermes-execution/hermes-agent/hermes-agent-strategy";
import { hermesAgentStrategy as sharedHermesAgentStrategy } from "@/lib/hermes-execution/strategies/default-strategy-registry";
import type { HermesCliRunner, HermesCliRunResult } from "@/lib/hermes-execution/hermes-agent/hermes-cli-runner";
import type { HermesAgentAdapterConfig } from "@/lib/hermes-execution/hermes-agent/hermes-agent-adapter";
import { TelegramAlertingAuditTrail, type AlertSender } from "@/lib/hermes-execution/telegram/telegram-alerting-audit-trail";
import type { TradingRuntimeUniverseScanDeps } from "@/lib/hermes-execution/runtime/trading-runtime";

// Prototype 1.0 — runtime ordering hardening. Proves the fix for the confirmed deployment-blocking
// defect: TradingRuntime used to await the Hermes universe scan BEFORE any instrument's own
// lifecycle recovery/reconciliation/automatic-exit processing, so a slow/timed-out/unavailable
// Hermes call could delay stop-loss/take-profit/kill-switch/max-holding/strategy-disabled exits for
// every configured instrument. Every test here wires a REAL `universeScan` into a REAL
// TradingRuntime (never a bare unit test of runUniverseScan alone) and proves ordering/isolation
// end-to-end. No real broker, market data, or Hermes CLI anywhere in this file.

const NOW = new Date("2026-01-01T12:00:00.000Z");

const HERMES_STRATEGY: InternalStrategy = getHermesAgentInternalStrategy();

const PERMISSIVE_RISK_CONFIG: PortfolioRiskConfig = {
  portfolioMaxOpenPositions: 5,
  maxDailyTrades: 20,
  maxPortfolioExposure: 1_000_000,
};

const HERMES_ADAPTER_CONFIG: HermesAgentAdapterConfig = {
  cliPath: "/home/andy/.local/bin/hermes",
  decisionTimeoutMs: 60_000,
  maxStdoutBytes: 65_536,
};

const INSTRUMENT_NUMERIC_ID: Record<string, number> = { BTC: 100001, ETH: 100002, SOL: 100003, AAPL: 100004, MSFT: 100005, NVDA: 100006 };

function brokerPositionIdFor(instrument: string): string {
  return String(INSTRUMENT_NUMERIC_ID[instrument] ?? 999999);
}

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
    strategyId: HERMES_STRATEGY.strategyId,
    strategyVersion: HERMES_STRATEGY.version,
    symbol,
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

/** Mirrors universe-scanner.test.ts's own FakeHermesRunner exactly — a plain (non-vi.fn) method so
 * call-order tests below can attach their own `vi.spyOn` wrapper without a double-mock conflict. */
class FakeHermesRunner implements HermesCliRunner {
  public callCount = 0;
  constructor(private readonly result: HermesCliRunResult) {}
  async run(_cliPath: string, _args: string[]): Promise<HermesCliRunResult> {
    this.callCount += 1;
    return this.result;
  }
}

function hermesResponse(proposals: Array<Record<string, unknown>>): HermesCliRunResult {
  return { ok: true, stdout: JSON.stringify({ proposals }) };
}

interface HermesRuntimeHarness {
  runtime: TradingRuntime;
  broker: ReturnType<typeof makeMockBroker>;
  clock: ManualSchedulerClock;
  auditTrail: InMemoryAuditTrail;
  tradeCandidateRepository: InMemoryTradeCandidateRepository;
  lifecycleStore: InMemoryTradeLifecycleStore;
  hermesRunner: FakeHermesRunner;
}

function makeHermesRuntime(overrides: {
  instruments: string[];
  openPositions?: PaperPosition[];
  lifecycleStore?: InMemoryTradeLifecycleStore;
  marketDataProvider?: MarketDataProvider;
  killSwitchEnabled?: boolean;
  portfolioRiskConfig?: PortfolioRiskConfig;
  broker?: ReturnType<typeof makeMockBroker>;
  tradeCandidateRepository?: InMemoryTradeCandidateRepository;
  hermesResult?: HermesCliRunResult;
  approvalMode?: "MANUAL" | "AUTO_DEMO";
  auditTrail?: InMemoryAuditTrail | TelegramAlertingAuditTrail;
  maxOpenPositions?: number;
  maxOpenPositionsPerInstrument?: number;
}): HermesRuntimeHarness {
  const broker = overrides.broker ?? makeMockBroker(overrides.openPositions ?? []);
  const clock = new ManualSchedulerClock(NOW);
  const auditTrail = overrides.auditTrail ?? new InMemoryAuditTrail();
  const lifecycleStore = overrides.lifecycleStore ?? new InMemoryTradeLifecycleStore();
  const lifecycleService = new TradeLifecycleService({ store: lifecycleStore, auditTrail, executionRunId: "test-run", now: () => clock.now() });
  const marketDataProvider = overrides.marketDataProvider ?? new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
  const tradeCandidateRepository = overrides.tradeCandidateRepository ?? new InMemoryTradeCandidateRepository();
  const hermesRunner = new FakeHermesRunner(overrides.hermesResult ?? hermesResponse([]));

  const universeScan: TradingRuntimeUniverseScanDeps = {
    hermesAgentStrategy: sharedHermesAgentStrategy,
    hermesAdapterConfig: HERMES_ADAPTER_CONFIG,
    hermesCliRunner: hermesRunner,
    maxProposalsPerScan: overrides.maxOpenPositions ?? 2,
    maxOpenPositions: overrides.maxOpenPositions ?? 5,
    maxOpenPositionsPerInstrument: overrides.maxOpenPositionsPerInstrument ?? 1,
    equityMarketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
  };

  const runtime = new TradingRuntime({
    broker,
    marketDataProvider,
    strategy: HERMES_STRATEGY,
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
    approvalMode: overrides.approvalMode ?? "MANUAL",
    autoDemoMinConfidence: 0.75,
    killSwitchEnabled: overrides.killSwitchEnabled ?? false,
    recoveryThresholdMs: 5 * 60_000,
    universeScan,
  });

  return { runtime, broker, clock, auditTrail: auditTrail as InMemoryAuditTrail, tradeCandidateRepository, lifecycleStore, hermesRunner };
}

function openPosition(instrument: string, positionId = `${instrument.toLowerCase()}-existing`): PaperPosition {
  return {
    positionId,
    strategyId: HERMES_STRATEGY.strategyId,
    strategyVersion: HERMES_STRATEGY.version,
    sourceType: "HERMES_APPROVED",
    instrument,
    side: "BUY",
    quantity: 10,
    entryPrice: 100,
    entryTimestamp: NOW.toISOString(),
    entryOrderId: `${instrument.toLowerCase()}-order-1`,
    brokerPositionId: brokerPositionIdFor(instrument),
  };
}

describe("Runtime ordering — Hermes timeout never delays an existing position's stop-loss", () => {
  it("closes ETH via stop-loss BEFORE the (eventually-timed-out) Hermes call even resolves, and submits no entry order", async () => {
    const ethPosition = openPosition("ETH");
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ id: "lifecycle-eth", symbol: "ETH", stopLoss: 999_999, takeProfit: undefined }));

    const { runtime, broker, clock, hermesRunner } = makeHermesRuntime({
      instruments: ["BTC", "ETH"],
      openPositions: [ethPosition],
      lifecycleStore,
      hermesResult: { ok: false, reason: "timeout", stderrExcerpt: "" },
    });
    const runSpy = vi.spyOn(hermesRunner, "run");

    await runtime.start();
    await clock.advance(0);

    expect(broker.closePosition).toHaveBeenCalledWith("eth-existing", expect.anything(), expect.anything(), expect.anything());
    expect(runSpy).toHaveBeenCalledTimes(1);
    // THE ordering proof: ETH's own risk-reducing close was invoked strictly before the Hermes
    // subprocess call — Phase A completed (and could have completed even if Hermes hung
    // indefinitely) before the scan step ever started.
    expect(broker.closePosition.mock.invocationCallOrder[0]).toBeLessThan(runSpy.mock.invocationCallOrder[0]!);
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();

    await runtime.stop();
  });
});

describe("Runtime ordering — Hermes unavailable while the kill switch is enabled", () => {
  it("force-closes every eligible open position and blocks new entries regardless of the Hermes spawn error", async () => {
    const btcPosition = openPosition("BTC");
    const ethPosition = openPosition("ETH");
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ id: "lifecycle-btc", symbol: "BTC" }));
    await lifecycleStore.create(makeOpenLifecycleRecord({ id: "lifecycle-eth", symbol: "ETH" }));

    const { runtime, broker, clock } = makeHermesRuntime({
      instruments: ["BTC", "ETH"],
      openPositions: [btcPosition, ethPosition],
      lifecycleStore,
      killSwitchEnabled: true,
      hermesResult: { ok: false, reason: "spawn-error", message: "ENOENT: hermes binary not found" },
    });

    await runtime.start();
    await clock.advance(0);

    expect(broker.closePosition).toHaveBeenCalledWith("btc-existing", expect.anything(), expect.anything(), expect.anything());
    expect(broker.closePosition).toHaveBeenCalledWith("eth-existing", expect.anything(), expect.anything(), expect.anything());
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();

    await runtime.stop();
  });
});

describe("Runtime ordering — empty Hermes response", () => {
  it("still monitors and closes an existing position via stop-loss", async () => {
    const solPosition = openPosition("SOL", "sol-existing");
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ id: "lifecycle-sol", symbol: "SOL", takeProfit: 0.01, stopLoss: undefined }));

    const { runtime, broker, clock } = makeHermesRuntime({
      instruments: ["BTC", "SOL"],
      openPositions: [solPosition],
      lifecycleStore,
      hermesResult: hermesResponse([]),
    });

    await runtime.start();
    await clock.advance(0);

    expect(broker.closePosition).toHaveBeenCalledWith("sol-existing", expect.anything(), expect.anything(), expect.anything());

    await runtime.stop();
  });
});

describe("Runtime ordering — malformed Hermes response", () => {
  it("Phase A exits still occur, and Phase B creates no candidate for an instrument with no valid proposal", async () => {
    const ethPosition = openPosition("ETH");
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ id: "lifecycle-eth", symbol: "ETH", stopLoss: 999_999, takeProfit: undefined }));

    const { runtime, broker, clock, tradeCandidateRepository, auditTrail } = makeHermesRuntime({
      instruments: ["BTC", "ETH"],
      openPositions: [ethPosition],
      lifecycleStore,
      hermesResult: { ok: true, stdout: "this is not valid json at all {{{" },
    });

    await runtime.start();
    await clock.advance(0);

    expect(broker.closePosition).toHaveBeenCalledWith("eth-existing", expect.anything(), expect.anything(), expect.anything());
    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toContain("HERMES_RESPONSE_REJECTED");

    const btcCandidates = await tradeCandidateRepository.list({ instrument: "BTC" });
    expect(btcCandidates).toHaveLength(0);

    await runtime.stop();
  });
});

describe("Runtime ordering — one instrument's Phase A failure never blocks another's stop-loss/kill-switch processing", () => {
  it("BTC's market-data outage does not prevent ETH's own stop-loss from closing, even with a real Hermes scan wired in", async () => {
    const ethPosition = openPosition("ETH");
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ id: "lifecycle-eth", symbol: "ETH", stopLoss: 999_999, takeProfit: undefined }));

    const goodProvider = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
    const throwingProvider: MarketDataProvider = {
      getMarketData: async (instrument: string): Promise<MarketDataSnapshot> => {
        if (instrument === "BTC") throw new Error("simulated BTC market-data outage");
        return goodProvider.getMarketData(instrument);
      },
    };

    const { runtime, broker, clock } = makeHermesRuntime({
      instruments: ["BTC", "ETH"],
      openPositions: [ethPosition],
      lifecycleStore,
      marketDataProvider: throwingProvider,
    });

    await runtime.start();
    await clock.advance(0);

    expect(broker.closePosition).toHaveBeenCalledWith("eth-existing", expect.anything(), expect.anything(), expect.anything());
    const status = runtime.getStatus();
    expect(status.failedRunCount).toBe(0);
    // Candle-gap production incident fix. A market-data (candle) failure is no longer conflated
    // with a reconciliation failure — reconciliation itself succeeded for BTC; only fresh analysis
    // is blocked. See runInstrumentPhaseA's own doc comment.
    expect(status.lastResult?.perInstrument?.BTC?.reconciliationFailed).toBeUndefined();
    expect(status.lastResult?.perInstrument?.BTC?.marketDataUnavailableReason).toBe("simulated BTC market-data outage");
    expect(status.lastResult?.perInstrument?.ETH?.exitTrigger).toBe("STOP_LOSS");

    await runtime.stop();
  });
});

describe("Runtime ordering — a selected Hermes proposal is consumed only by the instrument it names", () => {
  it("an ETH-only BUY proposal is never applied to BTC in the same scan, and never persists into the next scan", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    // A mutable-result fake so cycle 2 (below) can swap in an empty response, proving
    // setScanProposals() REPLACES the shared strategy's map every scan rather than merging into it
    // (see hermes-agent-strategy.ts's own doc comment on this exact contract).
    let currentResult: HermesCliRunResult = hermesResponse([{ instrument: "ETH", action: "BUY", confidence: 0.9, reasoning: ["strong ETH setup"] }]);
    class MutableHermesRunner implements HermesCliRunner {
      callCount = 0;
      async run(): Promise<HermesCliRunResult> {
        this.callCount += 1;
        return currentResult;
      }
    }
    const mutableRunner = new MutableHermesRunner();

    const broker = makeMockBroker();
    const clock = new ManualSchedulerClock(NOW);
    const auditTrail = new InMemoryAuditTrail();
    const lifecycleService = new TradeLifecycleService({ store: lifecycleStore, auditTrail, executionRunId: "test-run", now: () => clock.now() });
    const marketDataProvider = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
    const tradeCandidateRepository = new InMemoryTradeCandidateRepository();

    const runtime = new TradingRuntime({
      broker,
      marketDataProvider,
      strategy: HERMES_STRATEGY,
      instrument: "BTC",
      instruments: ["BTC", "ETH"],
      amount: 10,
      orderSizingMode: "UNITS",
      brokerProvider: "etoro-demo",
      portfolioRiskConfig: PERMISSIVE_RISK_CONFIG,
      lifecycleService,
      lifecycleStore,
      auditTrail,
      marketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
      clock,
      intervalMs: 10_000,
      immediateFirstRun: true,
      tradeCandidateRepository,
      tradeCandidateExpiryMs: 20 * 60_000,
      approvalMode: "AUTO_DEMO",
      autoDemoMinConfidence: 0.75,
      killSwitchEnabled: false,
      recoveryThresholdMs: 5 * 60_000,
      universeScan: {
        hermesAgentStrategy: sharedHermesAgentStrategy,
        hermesAdapterConfig: HERMES_ADAPTER_CONFIG,
        hermesCliRunner: mutableRunner,
        maxProposalsPerScan: 2,
        maxOpenPositions: 5,
        maxOpenPositionsPerInstrument: 1,
        equityMarketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
      },
    });

    await runtime.start();
    await clock.advance(0); // cycle 1 — ETH's own proposal is selected, a candidate is created and (AUTO_DEMO) auto-approved; BTC has none

    expect(broker.placeMarketOrder).not.toHaveBeenCalled(); // approved-candidate execution runs at the top of the NEXT cycle, not this one
    const btcCandidatesCycle1 = await tradeCandidateRepository.list({ instrument: "BTC" });
    expect(btcCandidatesCycle1).toHaveLength(0);
    const ethCandidatesCycle1 = await tradeCandidateRepository.list({ instrument: "ETH" });
    expect(ethCandidatesCycle1).toHaveLength(1);
    expect(ethCandidatesCycle1[0]?.status).toBe("APPROVED");

    await clock.advance(10_000); // cycle 2 — executes the now-approved ETH candidate
    expect(broker.placeMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ instrument: "ETH" }));
    expect(broker.placeMarketOrder).not.toHaveBeenCalledWith(expect.objectContaining({ instrument: "BTC" }));

    // Cycle 3: Hermes now proposes NOTHING — ETH's own now-open position must correctly resolve to
    // HOLD (no stale proposal reused from cycle 1's own selection map), remaining open with no
    // automatic close (there is no stop-loss/take-profit configured, and no fresh SELL proposal).
    currentResult = hermesResponse([]);

    await clock.advance(10_000); // cycle 3
    expect(broker.closePosition).not.toHaveBeenCalled();
    const status = runtime.getStatus();
    expect(status.lastResult?.perInstrument?.ETH?.decision).toBe("HOLD");

    await runtime.stop();
  });
});

describe("Runtime ordering — a position closed in Phase A is never re-closed or mis-executed in Phase B", () => {
  it("Phase B sees the already-closed state and neither re-submits a close nor treats a stale Hermes SELL proposal as actionable", async () => {
    const ethPosition = openPosition("ETH");
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ id: "lifecycle-eth", symbol: "ETH", stopLoss: 999_999, takeProfit: undefined }));

    const { runtime, broker, clock } = makeHermesRuntime({
      instruments: ["BTC", "ETH"],
      openPositions: [ethPosition],
      lifecycleStore,
      // Hermes (unaware that Phase A already closed ETH via stop-loss) also proposes a SELL for
      // ETH this same scan — Phase B must not act on it a second time.
      hermesResult: hermesResponse([{ instrument: "ETH", action: "SELL", confidence: 0.8, reasoning: ["stale exit view"] }]),
    });

    await runtime.start();
    await clock.advance(0);

    expect(broker.closePosition).toHaveBeenCalledTimes(1);
    expect(broker.closePosition).toHaveBeenCalledWith("eth-existing", expect.anything(), expect.anything(), expect.anything());
    const status = runtime.getStatus();
    expect(status.lastResult?.perInstrument?.ETH?.exitTrigger).toBe("STOP_LOSS");
    expect(status.lastResult?.perInstrument?.ETH?.decision).toBe("HOLD"); // positionOpen is false by Phase B; a SELL proposal cannot satisfy entry conditions

    await runtime.stop();
  });
});

describe("Runtime ordering — Telegram delivery failure never affects broker/lifecycle execution", () => {
  it("a stop-loss close still commits successfully, and TELEGRAM_NOTIFICATION_FAILED is audit-visible, with no broker retry", async () => {
    const ethPosition = openPosition("ETH");
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ id: "lifecycle-eth", symbol: "ETH", stopLoss: 999_999, takeProfit: undefined }));

    const innerAuditTrail = new InMemoryAuditTrail();
    const failingAlertSender: AlertSender = { sendAlert: vi.fn(async () => { throw new Error("simulated Telegram transport failure"); }) };
    const auditTrail = new TelegramAlertingAuditTrail(innerAuditTrail, failingAlertSender);

    const { runtime, broker, clock } = makeHermesRuntime({
      instruments: ["BTC", "ETH"],
      openPositions: [ethPosition],
      lifecycleStore,
      auditTrail,
    });

    await runtime.start();
    await clock.advance(0);

    expect(broker.closePosition).toHaveBeenCalledTimes(1);
    expect(broker.closePosition).toHaveBeenCalledWith("eth-existing", expect.anything(), expect.anything(), expect.anything());

    // Telegram alert refinement — AUTOMATIC_EXIT_TRIGGERED is deliberately no longer alert-worthy
    // (curated down to only TRADE_OPENED/TRADE_CLOSED/critical failures); the automatic stop-loss
    // exit's own TRADE_CLOSED event is what the Telegram alert path now attempts (and fails) for.
    const events = await innerAuditTrail.getEvents();
    const failure = events.find(
      (e) => e.eventType === "TELEGRAM_NOTIFICATION_FAILED" && e.details.originalEventType === "TRADE_CLOSED",
    );
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure)).not.toContain("super-secret");

    // No broker retry caused by the notification failure — exactly one close, ever.
    expect(broker.closePosition).toHaveBeenCalledTimes(1);

    await runtime.stop();
  });
});

describe("Runtime ordering — one runtime and scheduler handles the whole universe with a real Hermes scan wired in", () => {
  it("a single TradingRuntime/scheduler processes all six configured instruments every tick, calling Hermes exactly once", async () => {
    const universe = ["BTC", "ETH", "SOL", "AAPL", "MSFT", "NVDA"];
    const { runtime, clock, hermesRunner } = makeHermesRuntime({
      instruments: universe,
      hermesResult: hermesResponse([{ instrument: "ETH", action: "BUY", confidence: 0.9, reasoning: ["seed"] }]),
    });

    await runtime.start();
    await clock.advance(0);

    const status = runtime.getStatus();
    expect(status.successfulRunCount).toBe(1);
    expect(Object.keys(status.lastResult?.perInstrument ?? {}).sort()).toEqual([...universe].sort());
    expect(hermesRunner.callCount).toBe(1);

    await runtime.stop();
  });
});
