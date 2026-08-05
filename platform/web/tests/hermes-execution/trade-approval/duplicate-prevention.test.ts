import { describe, expect, it, vi } from "vitest";
import { checkForDuplicateEntry } from "@/lib/hermes-execution/trade-approval/duplicate-prevention";
import { InMemoryTradeCandidateRepository } from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import type { TradeCandidateInput } from "@/lib/hermes-execution/trade-approval/types";
import type { TradeLifecycleRecord, TradeLifecycleStatus } from "@/lib/hermes-execution/trade-lifecycle/types";

// Restart-Resilient Autonomy Phase — Phase 6 (Duplicate prevention).
//
// Covers required scenarios:
//  17. Duplicate pending candidates are suppressed.
//  18. Duplicate approved candidates are suppressed.
//  19. Existing open lifecycle prevents another entry.
// (Scenario 2 — "existing broker position prevents a duplicate BUY candidate" — is covered at the
// TradingRuntime integration level in trading-runtime.test.ts, since that check happens structurally
// via position-reconciliation.ts's own positionOpen override, upstream of this module.)

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
    analysisRunId: undefined,
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    instrument: "BTC",
    direction: "BUY",
    confidence: 0.8,
    entryPrice: 100,
    stopLoss: 95,
    takeProfit: 110,
    riskReward: 2,
    reasoning: ["seed"],
    validationNotes: [],
    expiresAt: "2026-01-01T00:20:00.000Z",
    execution: { amount: 10, sizingMode: "UNITS", marketContext: MARKET_CONTEXT, marketDataSnapshot: MARKET_SNAPSHOT },
    ...overrides,
  };
}

function makeLifecycleRecord(overrides: Partial<TradeLifecycleRecord> = {}): TradeLifecycleRecord {
  return {
    id: "lifecycle-1",
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("checkForDuplicateEntry — no conflicts", () => {
  it("reports no duplicate when nothing exists for this strategy+instrument", async () => {
    const result = await checkForDuplicateEntry({
      tradeCandidateRepository: new InMemoryTradeCandidateRepository(),
      lifecycleStore: new InMemoryTradeLifecycleStore(),
      strategyId: "DEMO-0001",
      instrument: "BTC",
    });
    expect(result.duplicate).toBe(false);
  });
});

describe("checkForDuplicateEntry — duplicate PENDING candidate (scenario 17)", () => {
  it("suppresses a new BUY when a PENDING BUY candidate already exists", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    await repository.create(makeCandidateInput());

    const result = await checkForDuplicateEntry({
      tradeCandidateRepository: repository,
      lifecycleStore: new InMemoryTradeLifecycleStore(),
      strategyId: "DEMO-0001",
      instrument: "BTC",
    });
    expect(result.duplicate).toBe(true);
    if (result.duplicate) expect(result.reason).toMatch(/PENDING BUY candidate/);
  });

  it("does not suppress on a PENDING candidate for a different instrument", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    await repository.create(makeCandidateInput({ instrument: "ETH" }));

    const result = await checkForDuplicateEntry({
      tradeCandidateRepository: repository,
      lifecycleStore: new InMemoryTradeLifecycleStore(),
      strategyId: "DEMO-0001",
      instrument: "BTC",
    });
    expect(result.duplicate).toBe(false);
  });
});

describe("checkForDuplicateEntry — duplicate APPROVED candidate (scenario 18)", () => {
  it("suppresses a new BUY when an APPROVED BUY candidate is already awaiting execution", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const created = await repository.create(makeCandidateInput());
    await repository.transition(created.id, "PENDING", {
      status: "APPROVED",
      approvedAt: "2026-01-01T00:05:00.000Z",
      approvedByUserId: "user-1",
    });

    const result = await checkForDuplicateEntry({
      tradeCandidateRepository: repository,
      lifecycleStore: new InMemoryTradeLifecycleStore(),
      strategyId: "DEMO-0001",
      instrument: "BTC",
    });
    expect(result.duplicate).toBe(true);
    if (result.duplicate) expect(result.reason).toMatch(/APPROVED BUY candidate/);
  });
});

describe("checkForDuplicateEntry — existing open/in-flight lifecycle record (scenario 19)", () => {
  // CLOSE_FAILED/DECISION_CREATED/APPROVED added by the reconciliation-hardening safety review —
  // CLOSE_FAILED in particular closes a real gap: a prior position that only failed to close
  // (still genuinely live at the broker) must not be treated as "free" for a fresh BUY.
  it.each<TradeLifecycleStatus>(["OPEN", "CLOSE_REQUESTED", "EXECUTION_SUBMITTED", "CLOSE_FAILED", "DECISION_CREATED", "APPROVED"])(
    "suppresses a new BUY when a durable record with status %s already exists",
    async (status) => {
      const lifecycleStore = new InMemoryTradeLifecycleStore();
      await lifecycleStore.create(makeLifecycleRecord({ status }));

      const result = await checkForDuplicateEntry({
        tradeCandidateRepository: new InMemoryTradeCandidateRepository(),
        lifecycleStore,
        strategyId: "DEMO-0001",
        instrument: "BTC",
      });
      expect(result.duplicate).toBe(true);
    },
  );

  it("does not suppress when the only existing record is terminal (CLOSED)", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeLifecycleRecord({ status: "CLOSED" }));

    const result = await checkForDuplicateEntry({
      tradeCandidateRepository: new InMemoryTradeCandidateRepository(),
      lifecycleStore,
      strategyId: "DEMO-0001",
      instrument: "BTC",
    });
    expect(result.duplicate).toBe(false);
  });

  it("does not suppress when the only existing record is terminal (CLOSED_UNRECONCILED)", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeLifecycleRecord({ status: "CLOSED_UNRECONCILED" }));

    const result = await checkForDuplicateEntry({
      tradeCandidateRepository: new InMemoryTradeCandidateRepository(),
      lifecycleStore,
      strategyId: "DEMO-0001",
      instrument: "BTC",
    });
    expect(result.duplicate).toBe(false);
  });

  it("does not suppress for a different strategy on the same instrument", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeLifecycleRecord({ status: "OPEN", strategyId: "OTHER-STRAT" }));

    const result = await checkForDuplicateEntry({
      tradeCandidateRepository: new InMemoryTradeCandidateRepository(),
      lifecycleStore,
      strategyId: "DEMO-0001",
      instrument: "BTC",
    });
    expect(result.duplicate).toBe(false);
  });
});

// Egress-containment fix (production incident: Supabase egress ~800% over the Free-plan quota).
// checkForDuplicateEntry runs before every fresh BUY decision — it used to call lifecycleStore.list()
// (a full-table select("*")) every time. Pinning that it now calls the bounded, scoped alternative is
// the regression test proving this specific egress source cannot silently come back.
describe("checkForDuplicateEntry — egress-containment regression", () => {
  it("never calls lifecycleStore.list() — uses the bounded listActiveLifecycleRecords instead", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const listSpy = vi.spyOn(lifecycleStore, "list");
    const listActiveSpy = vi.spyOn(lifecycleStore, "listActiveLifecycleRecords");

    await checkForDuplicateEntry({
      tradeCandidateRepository: new InMemoryTradeCandidateRepository(),
      lifecycleStore,
      strategyId: "DEMO-0001",
      instrument: "BTC",
    });

    expect(listSpy).not.toHaveBeenCalled();
    expect(listActiveSpy).toHaveBeenCalledWith(expect.objectContaining({ strategyId: "DEMO-0001", instrument: "BTC" }));
  });
});
