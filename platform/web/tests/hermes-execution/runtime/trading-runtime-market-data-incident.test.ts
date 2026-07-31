import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TradingRuntime } from "@/lib/hermes-execution/runtime/trading-runtime";
import { AlwaysOpenMarketHoursPolicy } from "@/lib/hermes-execution/runtime/market-hours-policy";
import { MockMarketDataProvider } from "@/lib/hermes-execution/market-data/mock-market-data-provider";
import { MarketDataProviderError, type MarketDataFailureDetail, type MarketDataProvider } from "@/lib/hermes-execution/market-data/market-data-provider";
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
    marketDataIncidentRecoveryThreshold?: number;
    marketDataIncidentStatePath?: string;
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
    marketDataIncidentRecoveryThreshold: overrides.marketDataIncidentRecoveryThreshold,
    marketDataIncidentStatePath: overrides.marketDataIncidentStatePath,
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

// Repeated-Telegram-alert fix. A plain Error (throwingProvider above) carries no structured
// MarketDataFailureDetail at all — every fingerprint built from it therefore falls back to the
// same "unknown" category for a given instrument, which is sufficient for most of the tests in
// this file (they only need "the same failure persists" / "recovers", never "the reason changes").
// Testing an actual fingerprint CHANGE (a materially different reason) requires a real
// MarketDataProviderError with distinct structured detail — message text alone is deliberately
// EXCLUDED from the fingerprint (see market-data-incident-tracker.ts's own doc comment), so two
// throwingProvider() calls with different strings would still count as the SAME incident.
function structuredThrowingProvider(detail: MarketDataFailureDetail, message = GAP_ERROR_MESSAGE): MarketDataProvider {
  return {
    getMarketData: async () => {
      throw new MarketDataProviderError(message, "malformed-data", { detail });
    },
  };
}

const MISSING_CANDLES_DETAIL_A: MarketDataFailureDetail = {
  category: "missing-candles",
  timeframe: "1h",
  missingIntervalStartMs: Date.parse("2026-07-30T14:00:00.000Z"),
  missingIntervalEndMs: Date.parse("2026-07-30T16:00:00.000Z"),
};

const MISSING_CANDLES_DETAIL_B: MarketDataFailureDetail = {
  category: "missing-candles",
  timeframe: "1h",
  missingIntervalStartMs: Date.parse("2026-07-30T18:00:00.000Z"),
  missingIntervalEndMs: Date.parse("2026-07-30T20:00:00.000Z"),
};

interface OpenedInstrumentDetail {
  instrument: string;
  fingerprint: string;
}
interface ChangedInstrumentDetail {
  instrument: string;
  fingerprint: string;
  previousFingerprint: string;
}
interface RecoveredInstrumentDetail {
  instrument: string;
  previousFingerprint: string;
}
interface UnchangedInstrumentDetail {
  instrument: string;
  fingerprint: string;
  observationCount: number;
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

describe("Candle-gap incident — a shared provider gap across instruments is a single aggregated incident", () => {
  it("BTC, ETH and SOL all failing with the same provider gap in one cycle produce exactly one MARKET_DATA_INCIDENT_OPENED naming all three", async () => {
    const { runtime, clock, auditTrail } = makeRuntime({
      instruments: ["BTC", "ETH", "SOL"],
      marketDataProvider: throwingProvider(),
    });

    await runtime.start();
    await clock.advance(0);

    const events = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_OPENED");
    expect(events).toHaveLength(1);
    const instruments = events[0]!.details.instruments as OpenedInstrumentDetail[];
    expect(instruments.map((i) => i.instrument).slice().sort()).toEqual(["BTC", "ETH", "SOL"]);
    // Deterministic aggregation: fingerprints are stable and distinct per instrument even though
    // the underlying failure/category is identical for all three.
    expect(new Set(instruments.map((i) => i.fingerprint)).size).toBe(3);

    // Per-instrument MARKET_DATA_DEGRADED still fires for every one of them, independent of the
    // shared/aggregated incident event above.
    const degradedEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_DEGRADED");
    expect(degradedEvents.map((e) => e.instrument).sort()).toEqual(["BTC", "ETH", "SOL"]);
  });
});

describe("Candle-gap incident — no duplicate alerts every cycle, silence persists no matter how long the incident lasts", () => {
  it("fires MARKET_DATA_INCIDENT_OPENED exactly once, then only ever MARKET_DATA_INCIDENT_UNCHANGED (never a repeat OPENED) across many subsequent cycles", async () => {
    const { runtime, clock, auditTrail } = makeRuntime({
      instruments: ["BTC", "ETH", "SOL"],
      marketDataProvider: throwingProvider(),
      intervalMs: 60_000,
    });

    await runtime.start();
    await clock.advance(0); // cycle 1 — new incident

    // 50 further scheduled ticks of the exact same persistent gap — comfortably more than enough
    // to prove this never degrades into a periodic resend of any kind.
    await clock.advance(50 * 60_000);

    const status = runtime.getStatus();
    expect(status.successfulRunCount).toBe(51);
    expect(status.failedRunCount).toBe(0);

    const openedEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_OPENED");
    expect(openedEvents).toHaveLength(1);

    const changedEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_CHANGED");
    expect(changedEvents).toHaveLength(0);

    // The condition is still tracked (quietly) every cycle — this is what used to be resent as a
    // Telegram alert every cycle; it now only ever appears as a non-Telegrammed UNCHANGED event,
    // and its own observationCount keeps growing, proving the tracker really did observe every
    // cycle rather than going silent by accident.
    const unchangedEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_UNCHANGED");
    expect(unchangedEvents.length).toBe(50);
    const lastUnchanged = unchangedEvents[unchangedEvents.length - 1]!.details.instruments as UnchangedInstrumentDetail[];
    const btcEntry = lastUnchanged.find((i) => i.instrument === "BTC");
    expect(btcEntry?.observationCount).toBe(51);
  });
});

describe("Candle-gap incident — a materially changed reason produces exactly one CHANGED alert, never a duplicate OPENED", () => {
  it("fires MARKET_DATA_INCIDENT_CHANGED (not a second OPENED) when the missing-candle window itself shifts to a different gap", async () => {
    let detail = MISSING_CANDLES_DETAIL_A;
    const provider: MarketDataProvider = {
      getMarketData: async () => {
        throw new MarketDataProviderError(GAP_ERROR_MESSAGE, "malformed-data", { detail });
      },
    };

    const { runtime, clock, auditTrail } = makeRuntime({ marketDataProvider: provider, intervalMs: 10_000 });

    await runtime.start();
    await clock.advance(0); // cycle 1 — opens with gap A

    detail = MISSING_CANDLES_DETAIL_B;
    await clock.advance(10_000); // cycle 2 — same instrument, still invalid, but a DIFFERENT gap

    const openedEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_OPENED");
    expect(openedEvents).toHaveLength(1);

    const changedEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_CHANGED");
    expect(changedEvents).toHaveLength(1);
    const changed = (changedEvents[0]!.details.instruments as ChangedInstrumentDetail[])[0]!;
    expect(changed.instrument).toBe("BTC");
    expect(changed.previousFingerprint).toBe((openedEvents[0]!.details.instruments as OpenedInstrumentDetail[])[0]!.fingerprint);
    expect(changed.fingerprint).not.toBe(changed.previousFingerprint);

    // No spurious recovery: swapping from one open incident straight to another must never emit a
    // RECOVERED event for the instrument in between.
    const recoveredEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_RECOVERED");
    expect(recoveredEvents).toHaveLength(0);
  });
});

describe("Candle-gap incident — recovery hysteresis: pending until consecutive healthy cycles, then exactly one RECOVERED, then a fresh OPENED on re-failure", () => {
  it("requires two consecutive healthy cycles (the default threshold) before declaring recovery, and never delays entry unblocking on the first healthy cycle", async () => {
    const goodProvider = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
    let healthy = false;
    const flakyProvider: MarketDataProvider = {
      getMarketData: async (instrument: string) => {
        if (healthy) return goodProvider.getMarketData(instrument);
        throw new Error(GAP_ERROR_MESSAGE);
      },
    };

    const { runtime, clock, auditTrail } = makeRuntime({
      marketDataProvider: flakyProvider,
      intervalMs: 10_000,
    });

    await runtime.start();
    await clock.advance(0); // cycle 1 — opens
    expect((await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_OPENED")).toHaveLength(1);

    healthy = true;
    await clock.advance(10_000); // cycle 2 — first healthy cycle: pending, not yet recovered

    expect((await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_RECOVERED")).toHaveLength(0);
    const pendingEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_RECOVERY_PENDING");
    expect(pendingEvents).toHaveLength(1);
    // Trading safety is never gated by the tracker's own hysteresis — this cycle's market data
    // genuinely validated, so a fresh candidate is created exactly as it would be on any other
    // healthy cycle, entirely independent of whether the incident tracker has "forgiven" it yet.
    expect(runtime.getStatus().lastResult?.marketDataUnavailableReason).toBeUndefined();
    expect(runtime.getStatus().lastResult?.candidateCreated).toBe(true);

    await clock.advance(10_000); // cycle 3 — second consecutive healthy cycle: recovered

    const recoveredEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_RECOVERED");
    expect(recoveredEvents).toHaveLength(1);
    const perInstrumentRecovered = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_RECOVERED");
    expect(perInstrumentRecovered).toHaveLength(1);
    expect(perInstrumentRecovered[0]!.instrument).toBe("BTC");

    // A later re-failure is a BRAND NEW incident (fresh OPENED), never silently treated as a
    // continuation of the one that already recovered.
    healthy = false;
    await clock.advance(10_000); // cycle 4 — fails again

    const openedEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_OPENED");
    expect(openedEvents).toHaveLength(2);
  });
});

describe("Candle-gap incident — independent per-instrument tracking", () => {
  it("ETH opening an incident never affects SOL's independent healthy state, and each instrument's fingerprint is scoped to itself", async () => {
    const goodProvider = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
    const provider: MarketDataProvider = {
      getMarketData: async (instrument: string) => {
        if (instrument === "ETH") throw new Error(GAP_ERROR_MESSAGE);
        return goodProvider.getMarketData(instrument);
      },
    };

    const { runtime, clock, auditTrail } = makeRuntime({ instruments: ["ETH", "SOL"], marketDataProvider: provider });

    await runtime.start();
    await clock.advance(0);

    const openedEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_OPENED");
    expect(openedEvents).toHaveLength(1);
    const instruments = openedEvents[0]!.details.instruments as OpenedInstrumentDetail[];
    expect(instruments.map((i) => i.instrument)).toEqual(["ETH"]);

    const degradedEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_DEGRADED");
    expect(degradedEvents.map((e) => e.instrument)).toEqual(["ETH"]);
  });

  it("one instrument recovering while another remains invalid in the same cycle produces independent, correctly-classified transitions for each", async () => {
    const goodProvider = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
    let ethHealthy = false;
    const provider: MarketDataProvider = {
      getMarketData: async (instrument: string) => {
        if (instrument === "ETH" && ethHealthy) return goodProvider.getMarketData(instrument);
        if (instrument === "ETH") throw new Error(GAP_ERROR_MESSAGE);
        if (instrument === "SOL") throw new Error(GAP_ERROR_MESSAGE);
        return goodProvider.getMarketData(instrument);
      },
    };

    const { runtime, clock, auditTrail } = makeRuntime({
      instruments: ["ETH", "SOL"],
      marketDataProvider: provider,
      marketDataIncidentRecoveryThreshold: 1,
      intervalMs: 10_000,
    });

    await runtime.start();
    await clock.advance(0); // cycle 1 — both ETH and SOL open

    ethHealthy = true;
    await clock.advance(10_000); // cycle 2 — ETH recovers (threshold 1), SOL remains invalid (unchanged)

    const recoveredEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_RECOVERED");
    expect(recoveredEvents).toHaveLength(1);
    const recoveredInstruments = recoveredEvents[0]!.details.instruments as RecoveredInstrumentDetail[];
    expect(recoveredInstruments.map((i) => i.instrument)).toEqual(["ETH"]);

    const unchangedEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_UNCHANGED");
    const lastUnchanged = unchangedEvents[unchangedEvents.length - 1]!.details.instruments as UnchangedInstrumentDetail[];
    expect(lastUnchanged.map((i) => i.instrument)).toEqual(["SOL"]);

    // ETH's own recovery never generated a stray OPENED/CHANGED event for SOL, and vice versa.
    const openedThisCycle = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_OPENED");
    expect(openedThisCycle).toHaveLength(1); // only the original cycle-1 opening (both instruments)
  });
});

describe("Candle-gap incident — durable persistence survives a restart without resending an unchanged incident", () => {
  it("a fresh TradingRuntime instance pointed at the same state file recognises an already-open incident as UNCHANGED, never a new OPENED", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "market-data-incident-state-test-"));
    const statePath = path.join(stateDir, "incident-state.json");
    try {
      const first = makeRuntime({ marketDataProvider: throwingProvider(), marketDataIncidentStatePath: statePath });
      await first.runtime.start();
      await first.clock.advance(0);

      expect((await first.auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_OPENED")).toHaveLength(1);
      // Persistence is fire-and-forget from a cycle's own perspective (never awaited inline, so a
      // slow disk never delays trading) — stop() is the documented, explicit flush point that
      // guarantees any in-flight write has landed before we inspect the file or simulate a restart.
      await first.runtime.stop();
      const persisted = JSON.parse(await fs.readFile(statePath, "utf-8"));
      expect(persisted.schemaVersion).toBe(1);
      expect(Object.keys(persisted.incidents)).toEqual(["BTC"]);

      // Simulate a process restart: a brand new TradingRuntime/tracker instance, same file.
      const second = makeRuntime({ marketDataProvider: throwingProvider(), marketDataIncidentStatePath: statePath });
      await second.runtime.start();
      await second.clock.advance(0);

      expect((await second.auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_OPENED")).toHaveLength(0);
      expect((await second.auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_UNCHANGED")).toHaveLength(1);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("a corrupted state file fails safe to an empty state — the next incident is still correctly reported as newly OPENED, never a crash", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "market-data-incident-state-corrupt-test-"));
    const statePath = path.join(stateDir, "incident-state.json");
    try {
      await fs.writeFile(statePath, "{ this is not valid json at all", "utf-8");

      const { runtime, clock, auditTrail } = makeRuntime({ marketDataProvider: throwingProvider(), marketDataIncidentStatePath: statePath });
      await expect(runtime.start()).resolves.toBeUndefined();
      await clock.advance(0);

      const openedEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_OPENED");
      expect(openedEvents).toHaveLength(1);
      expect(runtime.getStatus().failedRunCount).toBe(0);

      await runtime.stop(); // flush any in-flight persist before the temp directory is removed below.
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("without a configured persistence path, the tracker works correctly in-memory but a restart would lose dedup state (documented limitation, not exercised here beyond confirming normal in-memory behaviour)", async () => {
    const { runtime, clock, auditTrail } = makeRuntime({ marketDataProvider: throwingProvider() });
    await runtime.start();
    await clock.advance(0);
    await clock.advance(10_000);

    expect((await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_OPENED")).toHaveLength(1);
    expect((await auditTrail.getEvents()).filter((e) => e.eventType === "MARKET_DATA_INCIDENT_UNCHANGED")).toHaveLength(1);
  });
});

describe("Candle-gap incident — incident tracking itself never calls the broker or the market-data provider beyond the one call the cycle already makes", () => {
  it("no extra placeMarketOrder/closePosition/getRate calls are attributable to incident bookkeeping across many cycles of a persistent, unresolved incident", async () => {
    const broker = makeMockBroker([]);
    const { runtime, clock } = makeRuntime({ broker, marketDataProvider: throwingProvider(), intervalMs: 10_000 });

    await runtime.start();
    await clock.advance(0);
    await clock.advance(50_000); // 5 more cycles of the same unresolved incident

    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
    expect(broker.closePosition).not.toHaveBeenCalled();
    // No open position this whole scenario, so the fallback getRate() quote path (used only to
    // protect an OPEN position when candles are invalid) is never reached either.
    expect(broker.getRate).not.toHaveBeenCalled();
  });
});
