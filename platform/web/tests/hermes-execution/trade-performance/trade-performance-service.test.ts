import { describe, expect, it } from "vitest";
import { recordTradePerformanceForExecutedCandidate } from "@/lib/hermes-execution/trade-performance/trade-performance-service";
import { InMemoryTradePerformanceRepository } from "@/lib/hermes-execution/trade-performance/trade-performance-repository";
import { InMemoryTradeCandidateRepository } from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import type { TradeCandidateInput } from "@/lib/hermes-execution/trade-approval/types";
import type { TradeLifecycleRecord } from "@/lib/hermes-execution/trade-lifecycle/types";

// Phase 4 — Trade Performance Engine. Exercises the actual "chain-linking" logic
// (recordTradePerformanceForExecutedCandidate -> findOpeningCandidate) end to end against the same
// in-memory test doubles the runtime hook itself is built on — this is the closest thing to an
// integration test for "whenever a trade closes" without a live database or a real TradingRuntime.

const MARKET_CONTEXT = {
  instrument: "BTC",
  bid: 100,
  ask: 100.05,
  spread: 0.05,
  midPrice: 100.025,
  timestamp: "2026-01-01T00:00:00.000Z",
  positionOpen: false,
  strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "HERMES_APPROVED" as const },
  recentCandles: [],
  ema20: 110,
  ema50: 100,
  rsi14: 55,
  atr14: 1.5,
  volume: 120,
  dailyHigh: 112,
  dailyLow: 98,
  volatility24h: 0.01,
  marketSession: "Crypto Always Open" as const,
  trend: "Bullish" as const,
};

const MARKET_SNAPSHOT = {
  instrument: "BTC",
  timestamp: "2026-01-01T00:00:00.000Z",
  candles: [],
  bid: 100,
  ask: 100.05,
  spread: 0.05,
  latestPrice: 100.025,
  volume: 120,
};

function makeCandidateInput(overrides: Partial<TradeCandidateInput> = {}): TradeCandidateInput {
  return {
    analysisRunId: "analysis-run-1",
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    instrument: "BTC",
    direction: "BUY",
    confidence: 0.75,
    entryPrice: 100,
    stopLoss: 95,
    takeProfit: 110,
    riskReward: 2,
    reasoning: ["EMA20 above EMA50"],
    validationNotes: [],
    expiresAt: "2026-01-01T00:20:00.000Z",
    execution: { amount: 10, marketContext: MARKET_CONTEXT, marketDataSnapshot: MARKET_SNAPSHOT },
    ...overrides,
  };
}

function makeClosedLifecycleRecord(overrides: Partial<TradeLifecycleRecord> = {}): TradeLifecycleRecord {
  return {
    id: "trade-lifecycle-1",
    strategyId: "DEMO-0001",
    symbol: "BTC",
    side: "BUY",
    quantity: 10,
    decision: "SELL",
    confidence: 0.8,
    decisionReasons: ["Trend has turned Bearish"],
    marketDataSnapshot: MARKET_SNAPSHOT,
    intelligenceSummary: MARKET_CONTEXT,
    status: "CLOSED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T01:00:00.000Z",
    openedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "2026-01-01T01:00:00.000Z",
    entryPrice: 100,
    exitPrice: 106,
    exitReason: "market-decision-sell",
    realisedPnl: 60,
    realisedPnlPercent: 6,
    holdingDurationMs: 3_600_000,
    maximumFavourableExcursion: 80,
    maximumAdverseExcursion: -10,
    ...overrides,
  };
}

describe("recordTradePerformanceForExecutedCandidate", () => {
  it("resolves the opening BUY candidate, links the full chain, and persists a TradePerformanceRecord", async () => {
    const candidateRepository = new InMemoryTradeCandidateRepository();
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const performanceRepository = new InMemoryTradePerformanceRepository();

    const opening = await candidateRepository.create(makeCandidateInput({ direction: "BUY", entryPrice: 100, stopLoss: 95 }));
    await candidateRepository.transition(opening.id, "PENDING", { status: "APPROVED", approvedAt: "x", approvedByUserId: "u" });
    const openingExecuted = await candidateRepository.transition(opening.id, "APPROVED", {
      status: "EXECUTED",
      executedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(openingExecuted).toBeDefined();

    const lifecycleRecord = makeClosedLifecycleRecord();
    await lifecycleStore.create({ ...lifecycleRecord, status: "OPEN", exitPrice: undefined, closedAt: undefined, realisedPnl: undefined, realisedPnlPercent: undefined, holdingDurationMs: undefined });
    await lifecycleStore.update(lifecycleRecord);

    const closing = await candidateRepository.create(
      makeCandidateInput({ direction: "SELL", entryPrice: 106, stopLoss: 110, analysisRunId: "analysis-run-close" }),
    );
    await candidateRepository.transition(closing.id, "PENDING", { status: "APPROVED", approvedAt: "x", approvedByUserId: "u" });
    const closingExecuted = await candidateRepository.transition(closing.id, "APPROVED", {
      status: "EXECUTED",
      executedAt: "2026-01-01T01:00:00.000Z",
      lifecycleRecordId: lifecycleRecord.id,
    });
    expect(closingExecuted).toBeDefined();

    const result = await recordTradePerformanceForExecutedCandidate({
      candidateRepository,
      lifecycleStore,
      performanceRepository,
      candidateId: closing.id,
    });

    expect(result).toBeDefined();
    expect(result?.tradeId).toBe(lifecycleRecord.id);
    expect(result?.candidateId).toBe(closing.id); // links to the CLOSING candidate, per the schema's own convention
    expect(result?.analysisRunId).toBe("analysis-run-close");
    expect(result?.netPnl).toBe(60);
    // risk multiple uses the OPENING candidate's stop-loss (100 -> 95, risk $50), not the closing
    // candidate's own stopLoss (110): 60 / 50 = 1.2.
    expect(result?.riskMultiple).toBeCloseTo(1.2);

    const stored = await performanceRepository.getByTradeId(lifecycleRecord.id);
    expect(stored).toEqual(result);
  });

  it("returns undefined (nothing to record) for a BUY-direction executed candidate — that opens a position, it does not close one", async () => {
    const candidateRepository = new InMemoryTradeCandidateRepository();
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const performanceRepository = new InMemoryTradePerformanceRepository();

    const candidate = await candidateRepository.create(makeCandidateInput({ direction: "BUY" }));
    await candidateRepository.transition(candidate.id, "PENDING", { status: "APPROVED", approvedAt: "x", approvedByUserId: "u" });
    await candidateRepository.transition(candidate.id, "APPROVED", { status: "EXECUTED", executedAt: "2026-01-01T00:00:00.000Z" });

    const result = await recordTradePerformanceForExecutedCandidate({
      candidateRepository,
      lifecycleStore,
      performanceRepository,
      candidateId: candidate.id,
    });
    expect(result).toBeUndefined();
    expect(await performanceRepository.list()).toHaveLength(0);
  });

  it("returns undefined for an unknown candidate id, never throws", async () => {
    const result = await recordTradePerformanceForExecutedCandidate({
      candidateRepository: new InMemoryTradeCandidateRepository(),
      lifecycleStore: new InMemoryTradeLifecycleStore(),
      performanceRepository: new InMemoryTradePerformanceRepository(),
      candidateId: "does-not-exist",
    });
    expect(result).toBeUndefined();
  });

  it("still records performance (with riskMultiple undefined) when no opening candidate can be resolved", async () => {
    const candidateRepository = new InMemoryTradeCandidateRepository();
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const performanceRepository = new InMemoryTradePerformanceRepository();

    const lifecycleRecord = makeClosedLifecycleRecord({ id: "trade-lifecycle-orphan" });
    await lifecycleStore.create({ ...lifecycleRecord, status: "OPEN", exitPrice: undefined, closedAt: undefined, realisedPnl: undefined, realisedPnlPercent: undefined, holdingDurationMs: undefined });
    await lifecycleStore.update(lifecycleRecord);

    const closing = await candidateRepository.create(makeCandidateInput({ direction: "SELL" }));
    await candidateRepository.transition(closing.id, "PENDING", { status: "APPROVED", approvedAt: "x", approvedByUserId: "u" });
    await candidateRepository.transition(closing.id, "APPROVED", {
      status: "EXECUTED",
      executedAt: "2026-01-01T01:00:00.000Z",
      lifecycleRecordId: lifecycleRecord.id,
    });

    const result = await recordTradePerformanceForExecutedCandidate({
      candidateRepository,
      lifecycleStore,
      performanceRepository,
      candidateId: closing.id,
    });

    expect(result).toBeDefined();
    expect(result?.riskMultiple).toBeUndefined();
  });

  it("is idempotent — calling it twice for the same closed trade upserts, never duplicates", async () => {
    const candidateRepository = new InMemoryTradeCandidateRepository();
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const performanceRepository = new InMemoryTradePerformanceRepository();

    const lifecycleRecord = makeClosedLifecycleRecord({ id: "trade-lifecycle-dup" });
    await lifecycleStore.create({ ...lifecycleRecord, status: "OPEN", exitPrice: undefined, closedAt: undefined, realisedPnl: undefined, realisedPnlPercent: undefined, holdingDurationMs: undefined });
    await lifecycleStore.update(lifecycleRecord);

    const closing = await candidateRepository.create(makeCandidateInput({ direction: "SELL" }));
    await candidateRepository.transition(closing.id, "PENDING", { status: "APPROVED", approvedAt: "x", approvedByUserId: "u" });
    await candidateRepository.transition(closing.id, "APPROVED", {
      status: "EXECUTED",
      executedAt: "2026-01-01T01:00:00.000Z",
      lifecycleRecordId: lifecycleRecord.id,
    });

    await recordTradePerformanceForExecutedCandidate({ candidateRepository, lifecycleStore, performanceRepository, candidateId: closing.id });
    await recordTradePerformanceForExecutedCandidate({ candidateRepository, lifecycleStore, performanceRepository, candidateId: closing.id });

    expect(await performanceRepository.list()).toHaveLength(1);
  });
});
