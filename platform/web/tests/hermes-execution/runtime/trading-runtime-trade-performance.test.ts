import { describe, expect, it } from "vitest";
import { TradingRuntime } from "@/lib/hermes-execution/runtime/trading-runtime";
import { AlwaysOpenMarketHoursPolicy } from "@/lib/hermes-execution/runtime/market-hours-policy";
import { MockMarketDataProvider } from "@/lib/hermes-execution/market-data/mock-market-data-provider";
import type { MarketDataProvider, MarketDataSnapshot } from "@/lib/hermes-execution/market-data/market-data-provider";
import { TradeLifecycleService } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-service";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { InMemoryTradeCandidateRepository } from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import { InMemoryTradePerformanceRepository } from "@/lib/hermes-execution/trade-performance/trade-performance-repository";
import { approveTradeCandidate } from "@/lib/hermes-execution/trade-approval/trade-candidate-service";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";
import type { PaperBroker } from "@/lib/hermes-execution/paper-broker";
import type { Account, CompletedTrade, InternalStrategy, OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";
import { ManualSchedulerClock } from "./support/manual-scheduler-clock";

// Phase 4 — Trade Performance Engine. End-to-end through the REAL TradingRuntime, the same "highest
// risk part of this phase" scheduler-integration coverage trading-runtime-analysis-persistence.test.ts
// already established for Phase 2B's own bolt-on. Proves: (1) a full BUY-approve-execute,
// SELL-approve-execute cycle produces exactly one trade_performance row via the additive hook, (2)
// a broken performance layer never affects the cycle's own decision/execution/approval outcome, (3)
// when deps.tradePerformance is undefined (the default), behaviour is unaffected.

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

function makeMockBroker(openPositions: PaperPosition[] = []): PaperBroker {
  const account: Account = { cashBalance: 1_000_000, startingCashBalance: 1_000_000 };
  const completedTrades: CompletedTrade[] = [];
  let positionSeq = 0;

  return {
    getAccount: () => account,
    getOpenPositions: () => openPositions,
    getCompletedTrades: () => completedTrades,
    placeMarketOrder: async (order: OrderRequest) => {
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
    },
    closePosition: async (positionId: string, exitPrice: number, exitTimestamp: string, closeReason: string) => {
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
    },
  };
}

/** Bullish market data until switch() is called, bearish afterwards — lets a single test drive a
 * position from open (BUY, requires a Bullish trend) through to close (SELL, requires an open
 * position + Bearish trend), the same two-phase-provider technique
 * trading-runtime-analysis-persistence.test.ts doesn't need but market-decision-runner.test.ts's
 * own bearish-context fixtures rely on for the same underlying reason. */
class SwitchableMarketDataProvider implements MarketDataProvider {
  private bearish = false;
  private readonly bullish = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
  private readonly bearishProvider = new MockMarketDataProvider({ bias: "bearish", seed: 42, now: NOW });

  switchToBearish(): void {
    this.bearish = true;
  }

  async getMarketData(instrument: string): Promise<MarketDataSnapshot> {
    return this.bearish ? this.bearishProvider.getMarketData(instrument) : this.bullish.getMarketData(instrument);
  }
}

function makeHarness() {
  const broker = makeMockBroker([]);
  const clock = new ManualSchedulerClock(NOW);
  const auditTrail = new InMemoryAuditTrail();
  // The SAME store instance is passed to both TradeLifecycleService (which mutates it during
  // execution) and directly into TradingRuntimeDeps.tradePerformance.lifecycleStore (which only
  // ever reads it) — mirroring RuntimeDependencies' own established "lifecycleService +
  // lifecycleStore, same underlying store" precedent (runtime-dependency-factory.ts).
  const lifecycleStore = new InMemoryTradeLifecycleStore();
  const lifecycleService = new TradeLifecycleService({
    store: lifecycleStore,
    auditTrail,
    executionRunId: "test-run",
    now: () => clock.now(),
  });
  const marketDataProvider = new SwitchableMarketDataProvider();
  const tradeCandidateRepository = new InMemoryTradeCandidateRepository();
  const tradePerformanceRepository = new InMemoryTradePerformanceRepository();

  const runtime = new TradingRuntime({
    broker,
    marketDataProvider,
    strategy: STRATEGY,
    instrument: "BTC",
    amount: 10,
    portfolioRiskConfig: PERMISSIVE_RISK_CONFIG,
    lifecycleService,
    auditTrail,
    marketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
    clock,
    intervalMs: 10_000,
    immediateFirstRun: true,
    tradeCandidateRepository,
    tradeCandidateExpiryMs: 60 * 60_000,
    tradePerformance: { lifecycleStore, repository: tradePerformanceRepository },
  });

  return { runtime, clock, auditTrail, tradeCandidateRepository, tradePerformanceRepository, marketDataProvider };
}

describe("TradingRuntime — trade performance measurement (Phase 4)", () => {
  it("records exactly one trade_performance row once a full BUY-open, SELL-close cycle completes", async () => {
    const { runtime, clock, tradeCandidateRepository, tradePerformanceRepository, marketDataProvider, auditTrail } = makeHarness();

    await runtime.start();
    await clock.advance(0); // cycle 1: creates a PENDING BUY candidate

    const [buyCandidate] = await tradeCandidateRepository.list({ status: "PENDING" });
    expect(buyCandidate?.direction).toBe("BUY");
    const approvedBuy = await approveTradeCandidate({
      repository: tradeCandidateRepository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: buyCandidate!.id,
      approvedByUserId: "user-1",
      now: clock.now(),
    });
    expect(approvedBuy.outcome).toBe("approved");

    await clock.advance(10_000); // cycle 2: executes the BUY (position opens); no performance row yet
    expect(await tradePerformanceRepository.list()).toHaveLength(0);

    marketDataProvider.switchToBearish();
    await clock.advance(10_000); // cycle 3: position now open + Bearish trend -> creates a PENDING SELL candidate

    const [sellCandidate] = await tradeCandidateRepository.list({ status: "PENDING" });
    expect(sellCandidate?.direction).toBe("SELL");
    const approvedSell = await approveTradeCandidate({
      repository: tradeCandidateRepository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: sellCandidate!.id,
      approvedByUserId: "user-1",
      now: clock.now(),
    });
    expect(approvedSell.outcome).toBe("approved");

    await clock.advance(10_000); // cycle 4: executes the SELL -> position closes -> performance hook fires

    const performanceRecords = await tradePerformanceRepository.list();
    expect(performanceRecords).toHaveLength(1);
    expect(performanceRecords[0]!.strategyId).toBe("DEMO-0001");
    expect(performanceRecords[0]!.instrument).toBe("BTC");
    expect(performanceRecords[0]!.candidateId).toBe(sellCandidate!.id);
    expect(typeof performanceRecords[0]!.netPnl).toBe("number");
    expect(["WIN", "LOSS", "BREAKEVEN"]).toContain(performanceRecords[0]!.winLoss);
  });

  it("a broken performance repository never fails the cycle or blocks execution", async () => {
    const { runtime, clock, tradeCandidateRepository, marketDataProvider, auditTrail, tradePerformanceRepository } = makeHarness();
    tradePerformanceRepository.upsert = async () => {
      throw new Error("Supabase unreachable");
    };

    await runtime.start();
    await clock.advance(0);
    const [buyCandidate] = await tradeCandidateRepository.list({ status: "PENDING" });
    await approveTradeCandidate({
      repository: tradeCandidateRepository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: buyCandidate!.id,
      approvedByUserId: "user-1",
      now: clock.now(),
    });
    await clock.advance(10_000);

    marketDataProvider.switchToBearish();
    await clock.advance(10_000);
    const [sellCandidate] = await tradeCandidateRepository.list({ status: "PENDING" });
    await approveTradeCandidate({
      repository: tradeCandidateRepository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: sellCandidate!.id,
      approvedByUserId: "user-1",
      now: clock.now(),
    });

    const outcome = await runtime.runNow();
    expect(outcome.kind).toBe("completed"); // the cycle itself still succeeds despite the broken performance layer

    const status = runtime.getStatus();
    expect(status.failedRunCount).toBe(0);
  });

  it("never touches trade_performance when deps.tradePerformance is undefined (the default)", async () => {
    const broker = makeMockBroker([]);
    const clock = new ManualSchedulerClock(NOW);
    const auditTrail = new InMemoryAuditTrail();
    const lifecycleService = new TradeLifecycleService({
      store: new InMemoryTradeLifecycleStore(),
      auditTrail,
      executionRunId: "test-run",
      now: () => clock.now(),
    });
    const runtime = new TradingRuntime({
      broker,
      marketDataProvider: new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW }),
      strategy: STRATEGY,
      instrument: "BTC",
      amount: 10,
      portfolioRiskConfig: PERMISSIVE_RISK_CONFIG,
      lifecycleService,
      auditTrail,
      marketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
      clock,
      intervalMs: 10_000,
      immediateFirstRun: true,
      tradeCandidateRepository: new InMemoryTradeCandidateRepository(),
      tradeCandidateExpiryMs: 60 * 60_000,
      // tradePerformance omitted entirely
    });

    await runtime.start();
    const outcome = await runtime.runNow();
    expect(outcome.kind).toBe("completed");
  });
});
