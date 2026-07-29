import { describe, expect, it, vi } from "vitest";
import { TradingRuntime } from "@/lib/hermes-execution/runtime/trading-runtime";
import type { TradingRuntimeUniverseScanDeps } from "@/lib/hermes-execution/runtime/trading-runtime";
import { AlwaysOpenMarketHoursPolicy } from "@/lib/hermes-execution/runtime/market-hours-policy";
import { MockMarketDataProvider } from "@/lib/hermes-execution/market-data/mock-market-data-provider";
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
import { getHermesAgentInternalStrategy } from "@/lib/hermes-execution/hermes-agent/hermes-agent-strategy";
import { hermesAgentStrategy as sharedHermesAgentStrategy } from "@/lib/hermes-execution/strategies/default-strategy-registry";
import type { HermesCliRunner, HermesCliRunResult } from "@/lib/hermes-execution/hermes-agent/hermes-cli-runner";
import type { HermesAgentAdapterConfig } from "@/lib/hermes-execution/hermes-agent/hermes-agent-adapter";

// Hardening pass — opposing-signal exit stability. Every test wires a REAL TradingRuntime with a
// REAL universeScan (fake Hermes CLI, never the real one) so the minimum-hold-period +
// consecutive-confirmation gate is proven end to end, not just at the OpposingSignalStabilityTracker
// unit level. No real Hermes CLI, broker, Telegram, or Supabase call anywhere in this file.

const NOW = new Date("2026-01-01T12:00:00.000Z");
const HERMES_STRATEGY: InternalStrategy = getHermesAgentInternalStrategy();

const PERMISSIVE_RISK_CONFIG: PortfolioRiskConfig = { portfolioMaxOpenPositions: 5, maxDailyTrades: 20, maxPortfolioExposure: 1_000_000 };
const HERMES_ADAPTER_CONFIG: HermesAgentAdapterConfig = { cliPath: "/home/andy/.local/bin/hermes", decisionTimeoutMs: 60_000, maxStdoutBytes: 65_536 };

const INSTRUMENT_NUMERIC_ID: Record<string, number> = { BTC: 100001, ETH: 100002 };

function makeMockBroker(openPositions: PaperPosition[] = []): PaperBroker & {
  closePosition: ReturnType<typeof vi.fn>;
  placeMarketOrder: ReturnType<typeof vi.fn>;
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
    // Raw-portfolio-capable (getRawPortfolio/resolveInstrument/adoptPosition) so
    // position-reconciliation.ts's advanced path actually attaches a matching
    // TradeLifecycleRecord — required for exit-monitor.ts's own stop-loss/take-profit/
    // opposing-signal checks to ever run at all (gated on `currentRecord` being truthy).
    getRawPortfolio: vi.fn(async () => ({
      clientPortfolio: {
        // Reads each position's OWN brokerPositionId when set (falling back to the fixed
        // instrument-derived id only for fixtures that never set one) — a real broker assigns a
        // genuinely unique id per position, never reusing a prior, now-closed position's own id
        // for a later, unrelated one on the same instrument (see placeMarketOrder below, which
        // assigns a fresh, sequence-based id for exactly this reason).
        positions: openPositions.map((p) => ({
          positionID: p.brokerPositionId !== undefined ? Number(p.brokerPositionId) : (INSTRUMENT_NUMERIC_ID[p.instrument] ?? 999999),
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
        // A genuinely unique id per NEWLY placed position (instrument-derived base + this
        // position's own sequence number) — never the SAME id an earlier, now-closed position on
        // this instrument used (see openPosition()'s own fixed "100001"-style ids for pre-seeded
        // positions) — realistic for a broker that never reassigns a closed position's own id to a
        // later, unrelated one, and required for reconciliation to correctly recognise a newly
        // executed candidate's own position (rather than flagging an ambiguous duplicate
        // reference) on a LATER cycle.
        brokerPositionId: String((INSTRUMENT_NUMERIC_ID[order.instrument] ?? 999999) * 1000 + positionSeq),
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
    brokerPositionId: "100001",
    brokerOrderId: "order-btc",
    ...overrides,
  };
}

function openPosition(instrument = "BTC"): PaperPosition {
  return {
    positionId: "btc-existing",
    strategyId: HERMES_STRATEGY.strategyId,
    strategyVersion: HERMES_STRATEGY.version,
    sourceType: "HERMES_APPROVED",
    instrument,
    side: "BUY",
    quantity: 10,
    entryPrice: 100,
    entryTimestamp: NOW.toISOString(),
    entryOrderId: "btc-order-1",
    brokerPositionId: "100001",
  };
}

class MutableHermesRunner implements HermesCliRunner {
  public result: HermesCliRunResult = { ok: true, stdout: JSON.stringify({ proposals: [] }) };
  async run(): Promise<HermesCliRunResult> {
    return this.result;
  }
}

function hermesResponse(proposals: Array<Record<string, unknown>>): HermesCliRunResult {
  return { ok: true, stdout: JSON.stringify({ proposals }) };
}

interface Harness {
  runtime: TradingRuntime;
  broker: ReturnType<typeof makeMockBroker>;
  clock: ManualSchedulerClock;
  auditTrail: InMemoryAuditTrail;
  hermesRunner: MutableHermesRunner;
  tradeCandidateRepository: InMemoryTradeCandidateRepository;
}

function makeHarness(overrides: {
  openPositions?: PaperPosition[];
  lifecycleStore?: InMemoryTradeLifecycleStore;
  opposingExitMinHoldMs?: number;
  opposingExitRequiredConfirmations?: number;
} = {}): Harness {
  const broker = makeMockBroker(overrides.openPositions ?? []);
  const clock = new ManualSchedulerClock(NOW);
  const auditTrail = new InMemoryAuditTrail();
  const lifecycleStore = overrides.lifecycleStore ?? new InMemoryTradeLifecycleStore();
  const lifecycleService = new TradeLifecycleService({ store: lifecycleStore, auditTrail, executionRunId: "test-run", now: () => clock.now() });
  const marketDataProvider = new MockMarketDataProvider({ bias: "sideways", seed: 7, now: NOW });
  const tradeCandidateRepository = new InMemoryTradeCandidateRepository();
  const hermesRunner = new MutableHermesRunner();

  const universeScan: TradingRuntimeUniverseScanDeps = {
    hermesAgentStrategy: sharedHermesAgentStrategy,
    hermesAdapterConfig: HERMES_ADAPTER_CONFIG,
    hermesCliRunner: hermesRunner,
    maxProposalsPerScan: 2,
    maxOpenPositions: 5,
    maxOpenPositionsPerInstrument: 1,
    equityMarketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
  };

  const runtime = new TradingRuntime({
    broker,
    marketDataProvider,
    strategy: HERMES_STRATEGY,
    instrument: "BTC",
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
    approvalMode: "MANUAL",
    autoDemoMinConfidence: 0.75,
    killSwitchEnabled: false,
    recoveryThresholdMs: 5 * 60_000,
    opposingExitMinHoldMs: overrides.opposingExitMinHoldMs,
    opposingExitRequiredConfirmations: overrides.opposingExitRequiredConfirmations,
    universeScan,
  });

  return { runtime, broker, clock, auditTrail, hermesRunner, tradeCandidateRepository };
}

describe("Opposing-signal exit stability — stop-loss/take-profit remain immediate", () => {
  it("closes on stop-loss on the very first cycle, unaffected by a large minimum-hold/confirmation configuration", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ stopLoss: 999_999, takeProfit: undefined }));
    const { runtime, broker, clock, hermesRunner } = makeHarness({
      openPositions: [openPosition()],
      lifecycleStore,
      opposingExitMinHoldMs: 5 * 60_000,
      opposingExitRequiredConfirmations: 2,
    });
    hermesRunner.result = hermesResponse([{ instrument: "BTC", action: "SELL", confidence: 0.9, reasoning: ["also opposing, irrelevant"] }]);

    await runtime.start();
    await clock.advance(0);

    expect(broker.closePosition).toHaveBeenCalledWith("btc-existing", expect.anything(), expect.anything(), expect.anything());
    const status = runtime.getStatus();
    expect(status.lastResult?.exitTrigger).toBe("STOP_LOSS");

    await runtime.stop();
  });
});

describe("Opposing-signal exit stability — minimum hold period", () => {
  it("defers the exit while within the minimum hold period, then allows it once elapsed and confirmed", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ stopLoss: undefined, takeProfit: undefined, openedAt: NOW.toISOString() }));
    const { runtime, broker, clock, auditTrail, hermesRunner } = makeHarness({
      openPositions: [openPosition()],
      lifecycleStore,
      opposingExitMinHoldMs: 2_000,
      opposingExitRequiredConfirmations: 2,
    });
    hermesRunner.result = hermesResponse([{ instrument: "BTC", action: "SELL", confidence: 0.9, reasoning: ["opposing"] }]);

    await runtime.start();
    await clock.advance(0); // cycle 1 — held 0ms < 2000ms minimum

    expect(broker.closePosition).not.toHaveBeenCalled();
    const deferredEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "OPPOSING_SIGNAL_EXIT_DEFERRED");
    expect(deferredEvents).toHaveLength(1);
    expect(deferredEvents[0]!.details).toMatchObject({ reason: "min-hold-not-reached", consecutiveCount: 1, requiredConsecutiveSignals: 2 });

    await clock.advance(10_000); // cycle 2 (the scheduler's own next tick, per intervalMs) — now held >= 2000ms, and this is the 2nd consecutive opposing signal
    expect(broker.closePosition).toHaveBeenCalledWith("btc-existing", expect.anything(), expect.anything(), expect.anything());
    const status = runtime.getStatus();
    expect(status.lastResult?.exitTrigger).toBe("OPPOSING_SIGNAL");

    await runtime.stop();
  });
});

describe("Opposing-signal exit stability — consecutive confirmations", () => {
  it("defers a single opposing signal (insufficient-confirmations) and logs the current/required count", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ stopLoss: undefined, takeProfit: undefined, openedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() }));
    const { runtime, broker, auditTrail, clock, hermesRunner } = makeHarness({
      openPositions: [openPosition()],
      lifecycleStore,
      opposingExitMinHoldMs: 0,
      opposingExitRequiredConfirmations: 2,
    });
    hermesRunner.result = hermesResponse([{ instrument: "BTC", action: "SELL", confidence: 0.9, reasoning: ["opposing"] }]);

    await runtime.start();
    await clock.advance(0);

    expect(broker.closePosition).not.toHaveBeenCalled();
    const deferred = (await auditTrail.getEvents()).find((e) => e.eventType === "OPPOSING_SIGNAL_EXIT_DEFERRED");
    expect(deferred?.details).toMatchObject({ reason: "insufficient-confirmations", consecutiveCount: 1, requiredConsecutiveSignals: 2 });

    await runtime.stop();
  });

  it("allows the exit once the required number of consecutive opposing signals is reached", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ stopLoss: undefined, takeProfit: undefined, openedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() }));
    const { runtime, broker, clock, hermesRunner } = makeHarness({
      openPositions: [openPosition()],
      lifecycleStore,
      opposingExitMinHoldMs: 0,
      opposingExitRequiredConfirmations: 2,
    });
    hermesRunner.result = hermesResponse([{ instrument: "BTC", action: "SELL", confidence: 0.9, reasoning: ["opposing"] }]);

    await runtime.start();
    await clock.advance(0); // 1st consecutive — deferred
    expect(broker.closePosition).not.toHaveBeenCalled();

    await clock.advance(10_000); // 2nd consecutive — allowed
    expect(broker.closePosition).toHaveBeenCalledWith("btc-existing", expect.anything(), expect.anything(), expect.anything());

    await runtime.stop();
  });

  it("resets the confirmation count when the signal reverts to non-opposing, requiring fresh confirmations afterwards", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ stopLoss: undefined, takeProfit: undefined, openedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() }));
    const { runtime, broker, clock, hermesRunner } = makeHarness({
      openPositions: [openPosition()],
      lifecycleStore,
      opposingExitMinHoldMs: 0,
      opposingExitRequiredConfirmations: 2,
    });

    hermesRunner.result = hermesResponse([{ instrument: "BTC", action: "SELL", confidence: 0.9, reasoning: ["opposing"] }]);
    await runtime.start();
    await clock.advance(0); // 1st consecutive opposing — deferred
    expect(broker.closePosition).not.toHaveBeenCalled();

    hermesRunner.result = hermesResponse([]); // signal reverts to HOLD (no proposal) — resets the count
    await clock.advance(10_000);
    expect(broker.closePosition).not.toHaveBeenCalled();

    hermesRunner.result = hermesResponse([{ instrument: "BTC", action: "SELL", confidence: 0.9, reasoning: ["opposing again"] }]);
    await clock.advance(10_000); // only the 1st consecutive signal since the reset — still deferred, not closed
    expect(broker.closePosition).not.toHaveBeenCalled();

    await clock.advance(10_000); // 2nd consecutive since the reset — now allowed
    expect(broker.closePosition).toHaveBeenCalledWith("btc-existing", expect.anything(), expect.anything(), expect.anything());

    await runtime.stop();
  });
});

describe("Opposing-signal exit stability — config wiring defaults", () => {
  it("defaults to a 5-minute hold and 2 confirmations when TradingRuntimeDeps omits both (unconfigured single-instrument callers)", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ stopLoss: undefined, takeProfit: undefined, openedAt: NOW.toISOString() }));
    // No opposingExitMinHoldMs/opposingExitRequiredConfirmations passed — proves the defaults apply.
    const { runtime, broker, clock, hermesRunner } = makeHarness({ openPositions: [openPosition()], lifecycleStore });
    hermesRunner.result = hermesResponse([{ instrument: "BTC", action: "SELL", confidence: 0.9, reasoning: ["opposing"] }]);

    await runtime.start();
    await clock.advance(0); // held 0ms — well within the 5-minute default

    expect(broker.closePosition).not.toHaveBeenCalled();

    await runtime.stop();
  });
});

// Remediation pass (senior review finding C1) — end-to-end regression test through the REAL
// TradingRuntime, proving stale opposing-signal state cannot survive a position closing via
// broker reconciliation (never via this runtime's own automatic-exit/candidate-execution path) and
// leak into a later, unrelated position on the same instrument.
describe("Opposing-signal exit stability — no stale state survives a reconciliation-driven closure (finding C1 regression)", () => {
  it("a new position on the same instrument does not inherit a stale confirmation count from a previous, externally-closed position", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenLifecycleRecord({ id: "lifecycle-btc-1", stopLoss: undefined, takeProfit: undefined, openedAt: NOW.toISOString() }));
    const { runtime, broker, clock, hermesRunner, tradeCandidateRepository, auditTrail } = makeHarness({
      openPositions: [openPosition()],
      lifecycleStore,
      opposingExitMinHoldMs: 0,
      opposingExitRequiredConfirmations: 2,
    });

    await runtime.start();

    // Cycle 1: the first position (L1) accumulates one opposing confirmation — deferred, since
    // requiredConsecutiveSignals is 2.
    hermesRunner.result = hermesResponse([{ instrument: "BTC", action: "SELL", confidence: 0.9, reasoning: ["opposing"] }]);
    await clock.advance(0);
    expect(broker.closePosition).not.toHaveBeenCalled();

    // L1 closes EXTERNALLY — simulated by removing it directly from the broker's own open-position
    // list, with NO call to this runtime's own executeAutomaticExit/candidate-execution path at
    // all (a manual out-of-band closure, or any other externally-observed disappearance).
    broker.getOpenPositions().length = 0;
    hermesRunner.result = hermesResponse([]); // nothing to propose while no position is open

    // Cycle 2: reconciliation discovers the mismatch (local OPEN record, broker reports nothing)
    // and resolves it to CLOSED_UNRECONCILED — this is what fires syncPosition("BTC", undefined)
    // in Phase A, cleaning up L1's own stale confirmation count.
    await clock.advance(10_000);
    const mismatchEvents = (await auditTrail.getEvents()).filter((e) => e.eventType === "BROKER_RECONCILIATION_MISMATCH");
    expect(mismatchEvents.some((e) => e.details.resolution === "reconciled-closed-unreconciled")).toBe(true);

    // Cycle 3: Hermes proposes a fresh BUY — a brand new, entirely unrelated candidate is created.
    // (Cycle 1's own SELL decision, deferred by the opposing-signal gate rather than executed as
    // an automatic exit, also left a stale PENDING SELL fallback candidate for the now-closed L1 —
    // selecting by `direction: "BUY"` specifically avoids picking that one up by mistake.)
    hermesRunner.result = hermesResponse([{ instrument: "BTC", action: "BUY", confidence: 0.9, reasoning: ["fresh setup"] }]);
    await clock.advance(10_000);
    const pendingCandidate = (await tradeCandidateRepository.list({ status: "PENDING", instrument: "BTC" })).find((c) => c.direction === "BUY");
    expect(pendingCandidate).toBeDefined();

    await approveTradeCandidate({
      repository: tradeCandidateRepository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: pendingCandidate!.id,
      approvedByUserId: "user-1",
      now: clock.now(),
    });

    // Cycle 4: the approved BUY candidate executes — a brand NEW position (L2) opens on BTC.
    await clock.advance(10_000);
    expect(broker.placeMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ instrument: "BTC", side: "BUY" }));

    // Cycle 5: Hermes proposes SELL again — THIS is L2's very first opposing signal. If L2 had
    // inherited L1's stale count of 1, this single signal would incorrectly satisfy
    // requiredConsecutiveSignals (2) and close immediately. It must instead be deferred.
    hermesRunner.result = hermesResponse([{ instrument: "BTC", action: "SELL", confidence: 0.9, reasoning: ["opposing again"] }]);
    await clock.advance(10_000);
    expect(broker.closePosition).not.toHaveBeenCalled();
    const deferredForL2 = (await auditTrail.getEvents())
      .filter((e) => e.eventType === "OPPOSING_SIGNAL_EXIT_DEFERRED")
      .at(-1);
    expect(deferredForL2?.details).toMatchObject({ consecutiveCount: 1, requiredConsecutiveSignals: 2 });

    // Cycle 6: confirming a SECOND consecutive opposing signal now correctly closes L2 — proving
    // the gate genuinely requires 2 real confirmations for this position, not 1.
    await clock.advance(10_000);
    expect(broker.closePosition).toHaveBeenCalledTimes(1);

    await runtime.stop();
  });
});
