import { describe, expect, it, vi } from "vitest";
import { TradingRuntime } from "@/lib/hermes-execution/runtime/trading-runtime";
import { AlwaysOpenMarketHoursPolicy } from "@/lib/hermes-execution/runtime/market-hours-policy";
import { MockMarketDataProvider } from "@/lib/hermes-execution/market-data/mock-market-data-provider";
import type { MarketDataProvider } from "@/lib/hermes-execution/market-data/market-data-provider";
import { TradeLifecycleService } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-service";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { InMemoryTradeCandidateRepository } from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";
import type { PaperBroker } from "@/lib/hermes-execution/paper-broker";
import type { Account, CompletedTrade, InternalStrategy, OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";
import type { TradeLifecycleRecord } from "@/lib/hermes-execution/trade-lifecycle/types";
import { ManualSchedulerClock } from "./support/manual-scheduler-clock";

// Production candle-gap incident fix. Every scenario the mission's own requirement 6 lists,
// end-to-end through a real TradingRuntime (never a bare unit test of one helper in isolation) —
// mirrors the existing conventions in trading-runtime.test.ts and
// trading-runtime-hermes-scan-ordering.test.ts rather than introducing a new pattern.

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

const GAP_ERROR_MESSAGE =
  'Invalid historical candle history for "BTC": missing candle(s) — a 7200000ms gap between ' +
  "2026-07-30T14:00:00.000Z and 2026-07-30T16:00:00.000Z exceeds the expected 1h interval (3600000ms).";

const INSTRUMENT_NUMERIC_ID: Record<string, number> = { BTC: 100001, ETH: 100002, SOL: 100003 };

function brokerPositionIdFor(instrument: string): string {
  return String(INSTRUMENT_NUMERIC_ID[instrument] ?? 999999);
}

function makeMockBroker(
  openPositions: PaperPosition[] = [],
  rate: { bid: number; ask: number } = { bid: 100, ask: 100.1 },
): PaperBroker & {
  placeMarketOrder: ReturnType<typeof vi.fn>;
  closePosition: ReturnType<typeof vi.fn>;
  getRate: ReturnType<typeof vi.fn>;
  getRawPortfolio: ReturnType<typeof vi.fn>;
  resolveInstrument: ReturnType<typeof vi.fn>;
} {
  const account: Account = { cashBalance: 1_000_000, startingCashBalance: 1_000_000 };
  const completedTrades: CompletedTrade[] = [];
  let positionSeq = 0;

  return {
    getAccount: () => account,
    getOpenPositions: () => openPositions,
    getCompletedTrades: () => completedTrades,
    // Duck-typed by exit-monitor.ts's hasRateFetching — the fallback quote source Phase A uses
    // when buildMarketDecisionContext itself failed (an invalid candle history), exactly as
    // EtoroDemoBroker.getRate is used in production.
    getRate: vi.fn(async () => rate),
    // reconcileBrokerPosition (position-reconciliation.ts) only trusts a durable brokerPositionId
    // match via getRawPortfolio()/resolveInstrument() — without these two, it falls back to a
    // bare getOpenPositions()-derived boolean with no `record`, which would leave currentRecord
    // undefined and make every exit-protection check below a no-op. Mirrors
    // trading-runtime-hermes-scan-ordering.test.ts's own makeMockBroker exactly.
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
    strategyId: STRATEGY.strategyId,
    strategyVersion: STRATEGY.version,
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

function openPosition(instrument: string, positionId = `${instrument.toLowerCase()}-existing`): PaperPosition {
  return {
    positionId,
    strategyId: STRATEGY.strategyId,
    strategyVersion: STRATEGY.version,
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

interface RuntimeHarness {
  runtime: TradingRuntime;
  broker: ReturnType<typeof makeMockBroker>;
  clock: ManualSchedulerClock;
  auditTrail: InMemoryAuditTrail;
  tradeCandidateRepository: InMemoryTradeCandidateRepository;
  lifecycleStore: InMemoryTradeLifecycleStore;
}

function makeRuntime(
  overrides: {
    instruments?: string[];
    broker?: ReturnType<typeof makeMockBroker>;
    marketDataProvider?: MarketDataProvider;
    lifecycleStore?: InMemoryTradeLifecycleStore;
    intervalMs?: number;
    marketDataIncidentReminderIntervalMs?: number;
  } = {},
): RuntimeHarness {
  const instruments = overrides.instruments ?? ["BTC"];
  const broker = overrides.broker ?? makeMockBroker([]);
  const clock = new ManualSchedulerClock(NOW);
  const auditTrail = new InMemoryAuditTrail();
  const lifecycleStore = overrides.lifecycleStore ?? new InMemoryTradeLifecycleStore();
  const lifecycleService = new TradeLifecycleService({ store: lifecycleStore, auditTrail, executionRunId: "test-run", now: () => clock.now() });
  const marketDataProvider = overrides.marketDataProvider ?? new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
  const tradeCandidateRepository = new InMemoryTradeCandidateRepository();

  const runtime = new TradingRuntime({
    broker,
    marketDataProvider,
    strategy: STRATEGY,
    instrument: instruments[0]!,
    instruments,
    amount: 10,
    orderSizingMode: "UNITS",
    brokerProvider: "etoro-demo",
    portfolioRiskConfig: PERMISSIVE_RISK_CONFIG,
    lifecycleService,
    lifecycleStore,
    auditTrail,
    marketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
    clock,
    intervalMs: overrides.intervalMs ?? 10_000,
    immediateFirstRun: true,
    tradeCandidateRepository,
    tradeCandidateExpiryMs: 20 * 60_000,
    approvalMode: "MANUAL",
    autoDemoMinConfidence: 0.75,
    killSwitchEnabled: false,
    recoveryThresholdMs: 5 * 60_000,
    marketDataIncidentReminderIntervalMs: overrides.marketDataIncidentReminderIntervalMs,
  });

  return { runtime, broker, clock, auditTrail, tradeCandidateRepository, lifecycleStore };
}

function throwingProvider(message = GAP_ERROR_MESSAGE): MarketDataProvider {
  return {
    getMarketData: async () => {
      throw new Error(message);
    },
  };
}

describe("Candle-gap incident — missing candle blocks new entry analysis", () => {
  it("a market-data-provider throw produces a HOLD cycle with no candidate, instead of a fabricated decision", async () => {
    const { runtime, clock, tradeCandidateRepository } = makeRuntime({ marketDataProvider: throwingProvider() });

    await runtime.start();
    await clock.advance(0);

    const status = runtime.getStatus();
    expect(status.successfulRunCount).toBe(1);
    expect(status.failedRunCount).toBe(0);
    expect(status.lastResult?.decision).toBe("HOLD");
    expect(status.lastResult?.candidateCreated).toBe(false);
    expect(status.lastResult?.marketDataUnavailableReason).toBe(GAP_ERROR_MESSAGE);

    expect(await tradeCandidateRepository.list()).toHaveLength(0);
  });
});

describe("Candle-gap incident — malformed candles cannot create a new candidate", () => {
  it("the exact same instrument/strategy that produces a BUY candidate with healthy data creates none once candles are invalid", async () => {
    // Control: the default healthy provider/strategy combination in this file DOES create a
    // PENDING candidate (mirrors trading-runtime.test.ts's own "successful cycle" test) — proving
    // the absence of one below is caused by the invalid candle history, not an unrelated gap in
    // this harness's own setup.
    const healthy = makeRuntime();
    await healthy.runtime.start();
    await healthy.clock.advance(0);
    expect(healthy.runtime.getStatus().lastResult?.candidateCreated).toBe(true);
    expect(await healthy.tradeCandidateRepository.list({ status: "PENDING" })).toHaveLength(1);

    const degraded = makeRuntime({ marketDataProvider: throwingProvider() });
    await degraded.runtime.start();
    await degraded.clock.advance(0);
    expect(degraded.runtime.getStatus().lastResult?.candidateCreated).toBe(false);
    expect(await degraded.tradeCandidateRepository.list()).toHaveLength(0);

    // A second cycle while candles remain invalid still creates nothing — not a one-cycle fluke.
    await degraded.clock.advance(10_000);
    expect(degraded.runtime.getStatus().lastResult?.candidateCreated).toBe(false);
    expect(await degraded.tradeCandidateRepository.list()).toHaveLength(0);
  });
});

describe("Candle-gap incident — quote-based stop-loss protection survives an invalid candle history", () => {
  it("closes the position via STOP_LOSS using the broker's own getRate(), even though candle history is invalid", async () => {
    const broker = makeMockBroker([openPosition("BTC")], { bid: 50, ask: 50.2 }); // below stopLoss
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ stopLoss: 90, takeProfit: undefined }));

    const { runtime, clock, broker: sameBroker } = makeRuntime({ broker, lifecycleStore, marketDataProvider: throwingProvider() });

    await runtime.start();
    await clock.advance(0);

    expect(sameBroker.getRate).toHaveBeenCalledWith("BTC");
    expect(sameBroker.closePosition).toHaveBeenCalledWith("btc-existing", expect.anything(), expect.anything(), expect.anything());

    const status = runtime.getStatus();
    expect(status.lastResult?.exitTrigger).toBe("STOP_LOSS");
    expect(status.lastResult?.exitClosed).toBe(true);
    expect(status.lastResult?.marketDataUnavailableReason).toBe(GAP_ERROR_MESSAGE);
    expect(status.lastResult?.protectionChecksRun).toEqual(
      expect.arrayContaining(["KILL_SWITCH", "STOP_LOSS", "TAKE_PROFIT", "STRATEGY_DISABLED", "MAX_HOLDING_DURATION"]),
    );
  });
});

describe("Candle-gap incident — quote-based take-profit protection survives an invalid candle history", () => {
  it("closes the position via TAKE_PROFIT using the broker's own getRate(), even though candle history is invalid", async () => {
    const broker = makeMockBroker([openPosition("BTC")], { bid: 150, ask: 150.2 }); // above takeProfit
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ stopLoss: undefined, takeProfit: 120 }));

    const { runtime, clock, broker: sameBroker } = makeRuntime({ broker, lifecycleStore, marketDataProvider: throwingProvider() });

    await runtime.start();
    await clock.advance(0);

    expect(sameBroker.closePosition).toHaveBeenCalledWith("btc-existing", expect.anything(), expect.anything(), expect.anything());

    const status = runtime.getStatus();
    expect(status.lastResult?.exitTrigger).toBe("TAKE_PROFIT");
    expect(status.lastResult?.exitClosed).toBe(true);
    expect(status.lastResult?.marketDataUnavailableReason).toBe(GAP_ERROR_MESSAGE);
  });
});

describe("Candle-gap incident — opposing-signal exit is honestly reported as unavailable", () => {
  it("does not close the position, and reports OPPOSING_SIGNAL among the skipped checks, when candles are invalid but no fixed threshold is breached", async () => {
    const broker = makeMockBroker([openPosition("BTC")], { bid: 100, ask: 100.2 }); // no stop/take-profit breach
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ stopLoss: 10, takeProfit: 1000 }));

    const { runtime, clock, broker: sameBroker } = makeRuntime({ broker, lifecycleStore, marketDataProvider: throwingProvider() });

    await runtime.start();
    await clock.advance(0);

    expect(sameBroker.closePosition).not.toHaveBeenCalled();

    const status = runtime.getStatus();
    expect(status.lastResult?.exitTrigger).toBeUndefined();
    expect(status.lastResult?.marketDataUnavailableReason).toBe(GAP_ERROR_MESSAGE);
    expect(status.lastResult?.protectionChecksRun).toEqual(
      expect.arrayContaining(["KILL_SWITCH", "STOP_LOSS", "TAKE_PROFIT", "STRATEGY_DISABLED", "MAX_HOLDING_DURATION"]),
    );
    expect(status.lastResult?.protectionChecksSkipped).toEqual(["OPPOSING_SIGNAL"]);
  });
});

describe("Candle-gap incident — a failed quote never claims protection ran", () => {
  it("marks every fixed check (and OPPOSING_SIGNAL) as skipped, and never closes the position, when candles are invalid AND the fallback quote fetch also fails", async () => {
    const broker = makeMockBroker([openPosition("BTC")]);
    broker.getRate.mockRejectedValue(new Error("simulated broker rate-fetch outage"));
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ stopLoss: 10, takeProfit: 1000 }));

    const { runtime, broker: sameBroker } = makeRuntime({ broker, lifecycleStore, marketDataProvider: throwingProvider() });

    await runtime.start();
    const outcome = await runtime.runNow({ overridePause: true });

    expect(sameBroker.closePosition).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("completed");

    const status = runtime.getStatus();
    expect(status.lastResult?.exitTrigger).toBeUndefined();
    // The candle failure is reported, never silently replaced by the quote failure.
    expect(status.lastResult?.marketDataUnavailableReason).toBe(GAP_ERROR_MESSAGE);
    // Nothing was actually evaluated — protectionChecksRun must be empty, never claiming a check
    // ran just because a live quote would ordinarily have been available.
    expect(status.lastResult?.protectionChecksRun).toEqual([]);
    expect(status.lastResult?.protectionChecksSkipped?.slice().sort()).toEqual(
      ["KILL_SWITCH", "MAX_HOLDING_DURATION", "OPPOSING_SIGNAL", "STOP_LOSS", "STRATEGY_DISABLED", "TAKE_PROFIT"].sort(),
    );

    // The reasoning text itself must not claim protection "ran" when it didn't.
    const reasoning = outcome.kind === "completed" ? outcome.result.decision.reasoning.join(" ") : "";
    expect(reasoning).not.toMatch(/still ran/i);
    expect(reasoning).toMatch(/No live quote available/);
  });
});

describe("Candle-gap incident — a shared provider gap across instruments is a single classified incident", () => {
  it("BTC, ETH and SOL all failing with the same provider gap in one cycle produce exactly one MARKET_DATA_INCIDENT_ALERT naming all three", async () => {
    const { runtime, clock, auditTrail } = makeRuntime({
      instruments: ["BTC", "ETH", "SOL"],
      marketDataProvider: throwingProvider(),
    });

    await runtime.start();
    await clock.advance(0);

    const events = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_ALERT");
    expect(events).toHaveLength(1);
    const details = events[0]!.details as { isReminder: boolean; affectedInstruments: string[] };
    expect(details.isReminder).toBe(false);
    expect(details.affectedInstruments.slice().sort()).toEqual(["BTC", "ETH", "SOL"]);

    // Per-instrument MARKET_DATA_DEGRADED still fires for every one of them, independent of the
    // shared/rate-limited incident alert above.
    const degradedEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_DEGRADED");
    expect(degradedEvents.map((e) => e.instrument).sort()).toEqual(["BTC", "ETH", "SOL"]);
  });
});

describe("Candle-gap incident — no duplicate alerts every cycle, a reminder only after the configured interval", () => {
  it("sends exactly one initial alert, stays silent through many short-interval cycles, then sends exactly one reminder once the interval elapses", async () => {
    const reminderIntervalMs = 30 * 60_000;
    const { runtime, clock, auditTrail } = makeRuntime({
      instruments: ["BTC", "ETH", "SOL"],
      marketDataProvider: throwingProvider(),
      intervalMs: 60_000,
      marketDataIncidentReminderIntervalMs: reminderIntervalMs,
    });

    await runtime.start();
    await clock.advance(0); // cycle 1 (t=0) — new incident

    // Fires every scheduled tick between now and the target time — 30 more cycles land in this one
    // call (t=60_000 .. 1_800_000), the last one exactly at the reminder threshold.
    await clock.advance(reminderIntervalMs);

    const status = runtime.getStatus();
    expect(status.successfulRunCount).toBe(31); // 1 immediate + 30 scheduled ticks
    expect(status.failedRunCount).toBe(0);

    const events = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_ALERT");
    expect(events).toHaveLength(2);
    expect((events[0]!.details as { isReminder: boolean }).isReminder).toBe(false);
    expect((events[1]!.details as { isReminder: boolean }).isReminder).toBe(true);
  });
});

describe("Candle-gap incident — recovered candle history clears the incident state", () => {
  it("sends exactly one MARKET_DATA_INCIDENT_RECOVERED once every instrument's candle history is valid again, and a later new outage raises a fresh incident", async () => {
    const goodProvider = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
    let healthy = false;
    const flakyProvider: MarketDataProvider = {
      getMarketData: async (instrument: string) => {
        if (healthy) return goodProvider.getMarketData(instrument);
        throw new Error(GAP_ERROR_MESSAGE);
      },
    };

    const { runtime, clock, auditTrail } = makeRuntime({
      instruments: ["BTC", "ETH", "SOL"],
      marketDataProvider: flakyProvider,
      intervalMs: 10_000,
    });

    await runtime.start();
    await clock.advance(0); // cycle 1 — new incident, all three degraded

    let alertEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_ALERT");
    expect(alertEvents).toHaveLength(1);

    healthy = true;
    await clock.advance(10_000); // cycle 2 — candles recover for every instrument

    const recoveredEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_RECOVERED");
    expect(recoveredEvents).toHaveLength(1);
    const perInstrumentRecovered = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_RECOVERED");
    expect(perInstrumentRecovered.map((e) => e.instrument).sort()).toEqual(["BTC", "ETH", "SOL"]);

    const statusAfterRecovery = runtime.getStatus();
    expect(statusAfterRecovery.lastResult?.marketDataUnavailableReason).toBeUndefined();

    // A brand new outage after recovery is treated as a genuinely NEW incident (isReminder: false),
    // proving the tracker's state was actually cleared rather than merely staying silent.
    healthy = false;
    await clock.advance(10_000); // cycle 3 — degrades again

    alertEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_ALERT");
    expect(alertEvents).toHaveLength(2);
    expect((alertEvents[1]!.details as { isReminder: boolean }).isReminder).toBe(false);
  });
});
