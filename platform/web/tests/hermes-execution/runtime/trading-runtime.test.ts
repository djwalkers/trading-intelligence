import { describe, expect, it, vi } from "vitest";
import { TradingRuntime } from "@/lib/hermes-execution/runtime/trading-runtime";
import { AlwaysOpenMarketHoursPolicy, type MarketHoursPolicy } from "@/lib/hermes-execution/runtime/market-hours-policy";
import { InvalidTradingRuntimeTransitionError } from "@/lib/hermes-execution/runtime/types";
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
import { ManualSchedulerClock, flushMicrotasks } from "./support/manual-scheduler-clock";

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

function makeMockBroker(openPositions: PaperPosition[] = []): PaperBroker & {
  placeMarketOrder: ReturnType<typeof vi.fn>;
  closePosition: ReturnType<typeof vi.fn>;
} {
  const account: Account = { cashBalance: 1_000_000, startingCashBalance: 1_000_000 };
  const completedTrades: CompletedTrade[] = [];
  let positionSeq = 0;

  return {
    getAccount: () => account,
    getOpenPositions: () => openPositions,
    getCompletedTrades: () => completedTrades,
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

/** Wraps a real MarketDataProvider but suspends every getMarketData() call until `gate` resolves —
 * lets tests hold a cycle "in flight" deterministically (no real waiting) to exercise overlap
 * prevention and graceful shutdown while a cycle is active. */
class GatedMarketDataProvider implements MarketDataProvider {
  constructor(
    private readonly inner: MarketDataProvider,
    private readonly gate: Promise<void>,
  ) {}
  async getMarketData(instrument: string): Promise<MarketDataSnapshot> {
    await this.gate;
    return this.inner.getMarketData(instrument);
  }
}

function makeGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface RuntimeHarness {
  runtime: TradingRuntime;
  broker: ReturnType<typeof makeMockBroker>;
  clock: ManualSchedulerClock;
  lifecycleService: TradeLifecycleService;
  auditTrail: InMemoryAuditTrail;
  tradeCandidateRepository: InMemoryTradeCandidateRepository;
}

function makeRuntime(
  overrides: {
    openPositions?: PaperPosition[];
    marketDataProvider?: MarketDataProvider;
    marketHoursPolicy?: MarketHoursPolicy;
    intervalMs?: number;
    immediateFirstRun?: boolean;
    shutdownTimeoutMs?: number;
    tradeCandidateExpiryMs?: number;
    approvalMode?: "MANUAL" | "AUTO_DEMO";
    autoDemoMinConfidence?: number;
    killSwitchEnabled?: boolean;
    broker?: PaperBroker;
    tradeCandidateRepository?: InMemoryTradeCandidateRepository;
    lifecycleStore?: InMemoryTradeLifecycleStore;
    portfolioRiskConfig?: PortfolioRiskConfig;
  } = {},
): RuntimeHarness {
  const broker = (overrides.broker ?? makeMockBroker(overrides.openPositions ?? [])) as ReturnType<typeof makeMockBroker>;
  const clock = new ManualSchedulerClock(NOW);
  const auditTrail = new InMemoryAuditTrail();
  const lifecycleStore = overrides.lifecycleStore ?? new InMemoryTradeLifecycleStore();
  const lifecycleService = new TradeLifecycleService({
    store: lifecycleStore,
    auditTrail,
    executionRunId: "test-run",
    now: () => clock.now(),
  });
  const marketDataProvider =
    overrides.marketDataProvider ?? new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
  const tradeCandidateRepository = overrides.tradeCandidateRepository ?? new InMemoryTradeCandidateRepository();

  const runtime = new TradingRuntime({
    broker,
    marketDataProvider,
    strategy: STRATEGY,
    instrument: "BTC",
    amount: 10,
    orderSizingMode: "UNITS",
    brokerProvider: "etoro-demo",
    portfolioRiskConfig: overrides.portfolioRiskConfig ?? PERMISSIVE_RISK_CONFIG,
    lifecycleService,
    lifecycleStore,
    auditTrail,
    marketHoursPolicy: overrides.marketHoursPolicy ?? new AlwaysOpenMarketHoursPolicy(),
    clock,
    intervalMs: overrides.intervalMs ?? 10_000,
    immediateFirstRun: overrides.immediateFirstRun ?? true,
    shutdownTimeoutMs: overrides.shutdownTimeoutMs,
    tradeCandidateRepository,
    tradeCandidateExpiryMs: overrides.tradeCandidateExpiryMs ?? 20 * 60_000,
    approvalMode: overrides.approvalMode ?? "MANUAL",
    autoDemoMinConfidence: overrides.autoDemoMinConfidence ?? 0.75,
    killSwitchEnabled: overrides.killSwitchEnabled ?? false,
    recoveryThresholdMs: 5 * 60_000,
  });

  return { runtime, broker, clock, lifecycleService, auditTrail, tradeCandidateRepository };
}

describe("TradingRuntime — start/stop", () => {
  it("starts STOPPED and transitions to RUNNING on start()", async () => {
    const { runtime } = makeRuntime({ immediateFirstRun: false });
    expect(runtime.getStatus().state).toBe("STOPPED");
    await runtime.start();
    expect(runtime.getStatus().state).toBe("RUNNING");
    expect(runtime.getStatus().startedAt).toBe(NOW.toISOString());
  });

  it("refuses to start an already-running runtime", async () => {
    const { runtime } = makeRuntime({ immediateFirstRun: false });
    await runtime.start();
    await expect(runtime.start()).rejects.toBeInstanceOf(InvalidTradingRuntimeTransitionError);
  });

  it("stops cleanly while idle (no cycle ever ran)", async () => {
    const { runtime } = makeRuntime({ immediateFirstRun: false });
    await runtime.start();
    await runtime.stop();
    const status = runtime.getStatus();
    expect(status.state).toBe("STOPPED");
    expect(status.stoppedAt).toBe(NOW.toISOString());
    expect(status.nextRunAt).toBeNull();
  });

  it("refuses to stop an already-stopped runtime", async () => {
    const { runtime } = makeRuntime();
    await expect(runtime.stop()).rejects.toBeInstanceOf(InvalidTradingRuntimeTransitionError);
  });
});

describe("TradingRuntime — pause/resume", () => {
  it("refuses to pause when stopped", async () => {
    const { runtime } = makeRuntime();
    await expect(runtime.pause()).rejects.toBeInstanceOf(InvalidTradingRuntimeTransitionError);
  });

  it("refuses to resume when not paused", async () => {
    const { runtime } = makeRuntime({ immediateFirstRun: false });
    await runtime.start();
    await expect(runtime.resume()).rejects.toBeInstanceOf(InvalidTradingRuntimeTransitionError);
  });

  it("pause() then resume() returns to RUNNING and records pausedAt (sticky across resume)", async () => {
    const { runtime, clock } = makeRuntime({ immediateFirstRun: false });
    await runtime.start();
    await runtime.pause();
    expect(runtime.getStatus().state).toBe("PAUSED");
    expect(runtime.getStatus().pausedAt).toBe(NOW.toISOString());

    await clock.advance(1000);
    await runtime.resume();
    expect(runtime.getStatus().state).toBe("RUNNING");
    expect(runtime.getStatus().pausedAt).toBe(NOW.toISOString()); // still the original pause time
  });

  it("stop() is valid from PAUSED (waits through STOPPING to STOPPED)", async () => {
    const { runtime } = makeRuntime({ immediateFirstRun: false });
    await runtime.start();
    await runtime.pause();
    await runtime.stop();
    expect(runtime.getStatus().state).toBe("STOPPED");
  });
});

describe("TradingRuntime — immediate first run", () => {
  it("enabled: runs a cycle as soon as start() is called", async () => {
    const { runtime, clock } = makeRuntime({ immediateFirstRun: true });
    await runtime.start();
    await clock.advance(0);
    expect(runtime.getStatus().successfulRunCount).toBe(1);
  });

  it("disabled: does not run until the first full interval elapses", async () => {
    const { runtime, clock } = makeRuntime({ immediateFirstRun: false, intervalMs: 10_000 });
    await runtime.start();
    await clock.advance(0);
    expect(runtime.getStatus().successfulRunCount).toBe(0);

    await clock.advance(10_000);
    expect(runtime.getStatus().successfulRunCount).toBe(1);
  });
});

describe("TradingRuntime — recurring scheduling", () => {
  it("runs another cycle every interval", async () => {
    const { runtime, clock } = makeRuntime({ intervalMs: 10_000 });
    await runtime.start();
    await clock.advance(0);
    expect(runtime.getStatus().successfulRunCount).toBe(1);

    await clock.advance(10_000);
    expect(runtime.getStatus().successfulRunCount).toBe(2);

    await clock.advance(10_000);
    expect(runtime.getStatus().successfulRunCount).toBe(3);
  });

  it("nextRunAt reflects the scheduler's next tick and advances after each run", async () => {
    const { runtime, clock } = makeRuntime({ intervalMs: 10_000, immediateFirstRun: false });
    await runtime.start();
    expect(runtime.getStatus().nextRunAt).toBe(new Date(NOW.getTime() + 10_000).toISOString());

    await clock.advance(10_000);
    expect(runtime.getStatus().nextRunAt).toBe(new Date(NOW.getTime() + 20_000).toISOString());
  });
});

describe("TradingRuntime — successful cycle (pipeline integration)", () => {
  it("a BUY decision creates a PENDING trade candidate and never touches the broker automatically (Phase 3.5)", async () => {
    const { runtime, broker, lifecycleService, clock, tradeCandidateRepository } = makeRuntime();
    await runtime.start();
    await clock.advance(0);

    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
    const status = runtime.getStatus();
    expect(status.successfulRunCount).toBe(1);
    expect(status.lastResult).toMatchObject({ decision: "BUY", candidateCreated: true, instrument: "BTC", executedCandidateIds: [] });
    expect(status.lastRunStartedAt).toBeDefined();
    expect(status.lastRunCompletedAt).toBeDefined();

    const candidates = await tradeCandidateRepository.list({ status: "PENDING" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ strategyId: "DEMO-0001", instrument: "BTC", direction: "BUY", status: "PENDING" });

    // No lifecycle record yet either — that only happens once a human approves the candidate and a
    // later cycle actually executes it (see the "approved candidate execution" describe block).
    const openRecord = await lifecycleService.findOpenRecord("DEMO-0001", "BTC");
    expect(openRecord).toBeUndefined();
  });
});

describe("TradingRuntime — approved candidate execution", () => {
  it("executes a candidate a human approved in a prior cycle, via the real lifecycle-aware pipeline, on the next cycle", async () => {
    const { runtime, broker, lifecycleService, clock, auditTrail, tradeCandidateRepository } = makeRuntime({ intervalMs: 10_000 });
    await runtime.start();
    await clock.advance(0); // cycle 1: creates a PENDING candidate, no broker call

    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
    const [pending] = await tradeCandidateRepository.list({ status: "PENDING" });
    expect(pending).toBeDefined();

    const approval = await approveTradeCandidate({
      repository: tradeCandidateRepository,
      auditTrail,
      executionRunId: "test-run",
      candidateId: pending!.id,
      approvedByUserId: "user-1",
      now: clock.now(),
    });
    expect(approval.outcome).toBe("approved");

    await clock.advance(10_000); // cycle 2: executes the now-approved candidate, then proposes a new one

    expect(broker.placeMarketOrder).toHaveBeenCalledOnce();
    const executed = await tradeCandidateRepository.getById(pending!.id);
    expect(executed?.status).toBe("EXECUTED");
    const status = runtime.getStatus();
    expect(status.lastResult?.executedCandidateIds).toEqual([pending!.id]);

    const openRecord = await lifecycleService.findOpenRecord("DEMO-0001", "BTC");
    expect(openRecord?.status).toBe("OPEN");
    expect(openRecord?.entryPrice).toBe(broker.getOpenPositions()[0]?.entryPrice);
  });
});

describe("TradingRuntime — failed cycle", () => {
  it("records failedRunCount/lastError without throwing, and the scheduler continues afterward", async () => {
    // Candle-gap production incident fix. A market-data-provider throw is no longer a genuine
    // cycle failure (see runInstrumentPhaseA's own dedicated try/catch) — it now degrades
    // gracefully into a completed, HOLD cycle. This test's own purpose (prove the scheduler
    // survives and continues after a truly unhandled crash) is preserved instead via a broker
    // failure in reconciliation, which sits outside that try/catch and still propagates exactly
    // like the pre-fix market-data throw once did.
    let shouldFail = true;
    const broker = makeMockBroker([]);
    const realGetOpenPositions = broker.getOpenPositions;
    broker.getOpenPositions = () => {
      if (shouldFail) throw new Error("broker unreachable");
      return realGetOpenPositions();
    };
    const { runtime, clock } = makeRuntime({ broker, intervalMs: 10_000 });

    await runtime.start();
    await clock.advance(0);

    let status = runtime.getStatus();
    expect(status.failedRunCount).toBe(1);
    expect(status.successfulRunCount).toBe(0);
    expect(status.lastError).toEqual({ message: "broker unreachable", occurredAt: NOW.toISOString() });
    expect(status.state).toBe("RUNNING"); // a failure never stops the runtime

    // Next scheduled tick succeeds normally — proves scheduling continued after the failure.
    shouldFail = false;
    await clock.advance(10_000);
    status = runtime.getStatus();
    expect(status.successfulRunCount).toBe(1);
    expect(status.failedRunCount).toBe(1); // untouched by the later success
  });

  it("lastError is a plain serialisable object, never a raw Error instance", async () => {
    const broker = makeMockBroker([]);
    broker.getOpenPositions = () => {
      throw new Error("boom");
    };
    const { runtime, clock } = makeRuntime({ broker });
    await runtime.start();
    await clock.advance(0);

    const { lastError } = runtime.getStatus();
    expect(lastError).not.toBeInstanceOf(Error);
    expect(() => JSON.stringify(runtime.getStatus())).not.toThrow();
  });
});

describe("TradingRuntime — overlap prevention", () => {
  it("skips a scheduled tick that occurs while a cycle is still active, and records it", async () => {
    const inner = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
    const gate = makeGate();
    const { runtime, clock, tradeCandidateRepository } = makeRuntime({
      marketDataProvider: new GatedMarketDataProvider(inner, gate.promise),
      intervalMs: 10_000,
    });

    await runtime.start();
    await clock.advance(0); // cycle 1 starts and blocks on the gate
    expect(runtime.getStatus().isCycleRunning).toBe(true);

    await clock.advance(10_000); // cycle 2's scheduled tick fires while cycle 1 is still active
    expect(runtime.getStatus().skippedOverlapCount).toBe(1);
    expect(runtime.getStatus().isCycleRunning).toBe(true); // still cycle 1, not replaced
    expect(await tradeCandidateRepository.list()).toHaveLength(0); // cycle 1 hasn't produced a decision yet

    gate.resolve();
    await flushMicrotasks();

    const status = runtime.getStatus();
    expect(status.isCycleRunning).toBe(false);
    expect(status.successfulRunCount).toBe(1); // only cycle 1 ever actually ran
    expect(await tradeCandidateRepository.list()).toHaveLength(1);
  });

  it("runNow() also rejects while a cycle is already active", async () => {
    const inner = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
    const gate = makeGate();
    const { runtime, clock } = makeRuntime({ marketDataProvider: new GatedMarketDataProvider(inner, gate.promise) });

    await runtime.start();
    await clock.advance(0);
    expect(runtime.getStatus().isCycleRunning).toBe(true);

    await expect(runtime.runNow()).rejects.toThrow(/already running/);

    gate.resolve();
    await flushMicrotasks();
  });
});

describe("TradingRuntime — paused tick skipping", () => {
  it("a scheduled tick while PAUSED does not run a cycle, and is counted", async () => {
    const { runtime, clock, tradeCandidateRepository } = makeRuntime({ intervalMs: 10_000, immediateFirstRun: false });
    await runtime.start();
    await runtime.pause();

    await clock.advance(10_000);
    const status = runtime.getStatus();
    expect(status.skippedPausedCount).toBe(1);
    expect(status.successfulRunCount).toBe(0);
    expect(await tradeCandidateRepository.list()).toHaveLength(0);
  });

  it("resume() does not replay the skipped tick — only future ticks run cycles again", async () => {
    const { runtime, clock } = makeRuntime({ intervalMs: 10_000, immediateFirstRun: false });
    await runtime.start();
    await runtime.pause();
    await clock.advance(10_000); // skipped
    await runtime.resume();

    expect(runtime.getStatus().successfulRunCount).toBe(0); // resume itself replays nothing
    await clock.advance(10_000); // the next real tick after resuming
    expect(runtime.getStatus().successfulRunCount).toBe(1);
  });
});

describe("TradingRuntime — runNow() pause convention", () => {
  it("rejects runNow() while PAUSED without an override", async () => {
    const { runtime } = makeRuntime({ immediateFirstRun: false });
    await runtime.start();
    await runtime.pause();
    await expect(runtime.runNow()).rejects.toThrow(/PAUSED/);
  });

  it("runs immediately when overridePause: true is supplied while PAUSED", async () => {
    const { runtime } = makeRuntime({ immediateFirstRun: false });
    await runtime.start();
    await runtime.pause();

    const outcome = await runtime.runNow({ overridePause: true });
    expect(outcome.kind).toBe("completed");
    expect(runtime.getStatus().successfulRunCount).toBe(1);
  });

  it("rejects runNow() when STOPPED", async () => {
    const { runtime } = makeRuntime();
    await expect(runtime.runNow()).rejects.toThrow(/RUNNING or PAUSED/);
  });
});

describe("TradingRuntime — market-closed tick skipping", () => {
  it("skips a tick (and the immediate first run) when the market is closed, without treating it as a failure", async () => {
    const closedPolicy: MarketHoursPolicy = { isMarketOpen: () => false };
    const { runtime, clock, tradeCandidateRepository } = makeRuntime({ marketHoursPolicy: closedPolicy });

    await runtime.start();
    await clock.advance(0);

    const status = runtime.getStatus();
    expect(status.skippedMarketClosedCount).toBe(1);
    expect(status.failedRunCount).toBe(0);
    expect(status.successfulRunCount).toBe(0);
    expect(await tradeCandidateRepository.list()).toHaveLength(0);
  });
});

describe("TradingRuntime — graceful shutdown while a cycle is active", () => {
  it("stop() transitions to STOPPING immediately, then STOPPED only once the active cycle finishes", async () => {
    const inner = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
    const gate = makeGate();
    const { runtime, clock, tradeCandidateRepository } = makeRuntime({
      marketDataProvider: new GatedMarketDataProvider(inner, gate.promise),
    });

    await runtime.start();
    await clock.advance(0);
    expect(runtime.getStatus().isCycleRunning).toBe(true);

    const stopPromise = runtime.stop();
    await flushMicrotasks();
    // stop() has begun but the cycle is still gated — must not have abandoned it.
    expect(runtime.getStatus().state).toBe("STOPPING");
    expect(await tradeCandidateRepository.list()).toHaveLength(0);

    gate.resolve();
    await stopPromise;

    expect(runtime.getStatus().state).toBe("STOPPED");
    expect(await tradeCandidateRepository.list()).toHaveLength(1); // the in-flight cycle ran to completion
    expect(runtime.getStatus().successfulRunCount).toBe(1);
  });
});

describe("TradingRuntime — bounded shutdown timeout (Prototype V1 reliability fix)", () => {
  it("a cycle that finishes well within the timeout stops normally, recording timedOut: false", async () => {
    const inner = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
    const gate = makeGate();
    const { runtime, clock, auditTrail } = makeRuntime({
      marketDataProvider: new GatedMarketDataProvider(inner, gate.promise),
      shutdownTimeoutMs: 30_000,
    });

    await runtime.start();
    await clock.advance(0);
    expect(runtime.getStatus().isCycleRunning).toBe(true);

    const stopPromise = runtime.stop();
    gate.resolve();
    await stopPromise;

    expect(runtime.getStatus().state).toBe("STOPPED");
    const events = await auditTrail.getEvents();
    const stopped = events.find((e) => e.eventType === "TRADING_RUNTIME_STOPPED");
    expect(stopped?.details).toEqual({ timedOut: false });
  });

  it("an in-flight cycle that never finishes forces STOPPED once shutdownTimeoutMs elapses, recording timedOut: true", async () => {
    const inner = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
    const gate = makeGate(); // deliberately never resolved in this test
    const { runtime, clock, auditTrail } = makeRuntime({
      marketDataProvider: new GatedMarketDataProvider(inner, gate.promise),
      shutdownTimeoutMs: 30_000,
    });

    await runtime.start();
    await clock.advance(0);
    expect(runtime.getStatus().isCycleRunning).toBe(true);

    const stopPromise = runtime.stop();
    await flushMicrotasks();
    expect(runtime.getStatus().state).toBe("STOPPING"); // still waiting, cycle never resolved

    await clock.advance(30_000); // fires the shutdown-timeout timer, not the (already-cancelled) scheduler
    await stopPromise; // now resolves — forced, not abandoned forever

    expect(runtime.getStatus().state).toBe("STOPPED");
    const events = await auditTrail.getEvents();
    const stopped = events.find((e) => e.eventType === "TRADING_RUNTIME_STOPPED");
    expect(stopped?.details).toEqual({ timedOut: true });

    // The abandoned cycle is still "running" as far as isCycleRunning is concerned — stop() forced
    // STOPPED without cancelling it, exactly as documented.
    expect(runtime.getStatus().isCycleRunning).toBe(true);

    // Resolving the gate afterwards must not crash anything — the cycle quietly finishes its own
    // bookkeeping (finally block) even though the runtime has already moved on.
    gate.resolve();
    await flushMicrotasks();
    expect(runtime.getStatus().isCycleRunning).toBe(false);
    expect(runtime.getStatus().successfulRunCount).toBe(1);
  });

  it("uses the default 30s bound when shutdownTimeoutMs is not supplied", async () => {
    const inner = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
    const gate = makeGate();
    const { runtime, clock } = makeRuntime({
      marketDataProvider: new GatedMarketDataProvider(inner, gate.promise),
      // shutdownTimeoutMs omitted entirely
    });

    await runtime.start();
    await clock.advance(0);

    const stopPromise = runtime.stop();
    await clock.advance(29_999);
    expect(runtime.getStatus().state).toBe("STOPPING"); // not yet forced

    await clock.advance(1);
    await stopPromise;
    expect(runtime.getStatus().state).toBe("STOPPED"); // forced at the 30s default
  });
});

describe("TradingRuntime — status is serialisable", () => {
  it("round-trips through JSON.stringify/parse with no loss of the fields under test", async () => {
    const { runtime, clock } = makeRuntime();
    await runtime.start();
    await clock.advance(0);

    const status = runtime.getStatus();
    const roundTripped = JSON.parse(JSON.stringify(status));
    expect(roundTripped.state).toBe(status.state);
    expect(roundTripped.successfulRunCount).toBe(status.successfulRunCount);
    expect(roundTripped.lastResult).toEqual(status.lastResult);
  });
});

// Restart-Resilient Autonomy Phase — full-runtime integration coverage.
//
// Covers required scenarios:
//   1. Runtime startup discovers an existing eToro position.
//   2. Existing broker position prevents a duplicate BUY candidate.
//   3. Reconciled position survives simulated runtime restart.
//  16. MANUAL mode remains unchanged (no candidate is ever auto-approved).
function makeEtoroLikeBroker(rawPositions: Array<{ positionID: number; orderID: number; instrumentID: number; isBuy?: boolean; amount?: number; openRate?: number }>) {
  const tracked = new Map<string, PaperPosition>();
  let seq = 0;
  return {
    getAccount: (): Account => ({ cashBalance: 1_000_000, startingCashBalance: 1_000_000 }),
    getOpenPositions: (): PaperPosition[] => [...tracked.values()],
    getCompletedTrades: (): CompletedTrade[] => [],
    resolveInstrument: async (_term: string) => ({ instrumentId: 100000 }),
    getRate: async (_instrument: string) => ({ bid: 100, ask: 100.05 }),
    getRawPortfolio: async () => ({ clientPortfolio: { positions: rawPositions, credit: 1_000_000 } }),
    adoptPosition: (
      raw: { positionID: number; orderID: number; isBuy?: boolean; amount?: number; openRate?: number },
      internalInstrument: string,
      strategyContext: { strategyId: string; strategyVersion: number; sourceType: InternalStrategy["sourceType"] },
    ): PaperPosition => {
      seq += 1;
      const position: PaperPosition = {
        positionId: `fake-position-${seq}`,
        strategyId: strategyContext.strategyId,
        strategyVersion: strategyContext.strategyVersion,
        sourceType: strategyContext.sourceType,
        instrument: internalInstrument,
        side: raw.isBuy === false ? "SELL" : "BUY",
        quantity: raw.amount ?? 10,
        entryPrice: raw.openRate ?? 100,
        entryTimestamp: NOW.toISOString(),
        entryOrderId: String(raw.orderID),
        brokerPositionId: String(raw.positionID),
      };
      tracked.set(position.positionId, position);
      return position;
    },
    placeMarketOrder: vi.fn(async (order: OrderRequest) => ({
      position: {
        positionId: "mock-position-1",
        strategyId: order.strategyId,
        strategyVersion: order.strategyVersion,
        sourceType: order.sourceType,
        instrument: order.instrument,
        side: order.side,
        quantity: order.quantity,
        entryPrice: order.price,
        entryTimestamp: order.timestamp,
        entryOrderId: "mock-order-1",
      } satisfies PaperPosition,
      orderId: "mock-order-1",
    })),
    closePosition: vi.fn(async () => {
      throw new Error("not exercised in this describe block");
    }),
  };
}

describe("TradingRuntime — Restart-Resilient Autonomy: startup reconciliation + duplicate prevention", () => {
  it("discovers an existing broker position on the very first cycle and never proposes a duplicate BUY (scenarios 1 & 2)", async () => {
    const broker = makeEtoroLikeBroker([
      { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: 10, openRate: 64_948.33 },
    ]);
    const clock = new ManualSchedulerClock(NOW);
    const auditTrail = new InMemoryAuditTrail();
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const lifecycleService = new TradeLifecycleService({ store: lifecycleStore, auditTrail, executionRunId: "test-run", now: () => clock.now() });
    const tradeCandidateRepository = new InMemoryTradeCandidateRepository();
    // Bullish market data would otherwise satisfy DEMO-0001's own entry conditions — proving any
    // absence of a BUY candidate below is due to reconciliation, not merely "no entry signal".
    const marketDataProvider = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });

    const runtime = new TradingRuntime({
      broker: broker as never,
      marketDataProvider,
      strategy: STRATEGY,
      instrument: "BTC",
      amount: 10,
      orderSizingMode: "NOTIONAL",
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
    });

    await runtime.start();
    await clock.advance(0);

    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toContain("BROKER_POSITION_DISCOVERED");
    expect(events).toContain("BROKER_POSITION_ORPHANED");

    // No BUY candidate was created — the reconciled open position blocked it.
    const candidates = await tradeCandidateRepository.list();
    expect(candidates.filter((c) => c.direction === "BUY")).toHaveLength(0);

    const status = runtime.getStatus();
    expect(status.lastResult?.positionOpen).toBe(true);
    expect(status.lastResult?.candidateCreated).toBe(false);

    await runtime.stop();
  });

  it("a position adopted in one runtime instance is recognised (RECONCILED) by a second instance sharing the same durable store, after a simulated restart (scenario 3)", async () => {
    const rawPosition = { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: 10, openRate: 64_948.33 };
    const lifecycleStore = new InMemoryTradeLifecycleStore(); // stands in for Supabase durability across the "restart"

    // --- Instance A (pre-restart) ---
    const brokerA = makeEtoroLikeBroker([rawPosition]);
    const clockA = new ManualSchedulerClock(NOW);
    const auditTrailA = new InMemoryAuditTrail();
    const lifecycleServiceA = new TradeLifecycleService({ store: lifecycleStore, auditTrail: auditTrailA, executionRunId: "run-a", now: () => clockA.now() });
    const runtimeA = new TradingRuntime({
      broker: brokerA as never,
      marketDataProvider: new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW }),
      strategy: STRATEGY,
      instrument: "BTC",
      amount: 10,
      orderSizingMode: "NOTIONAL",
      brokerProvider: "etoro-demo",
      portfolioRiskConfig: PERMISSIVE_RISK_CONFIG,
      lifecycleService: lifecycleServiceA,
      lifecycleStore,
      auditTrail: auditTrailA,
      marketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
      clock: clockA,
      intervalMs: 10_000,
      immediateFirstRun: true,
      tradeCandidateRepository: new InMemoryTradeCandidateRepository(),
      tradeCandidateExpiryMs: 20 * 60_000,
      approvalMode: "MANUAL",
      autoDemoMinConfidence: 0.75,
      killSwitchEnabled: false,
      recoveryThresholdMs: 5 * 60_000,
    });
    await runtimeA.start();
    await clockA.advance(0);
    const adoptedId = (await lifecycleStore.listOpen())[0]?.id;
    expect(adoptedId).toBeDefined();
    await runtimeA.stop();

    // --- Instance B (post-restart): brand-new broker instance (own empty trackedPositions), SAME
    // durable lifecycleStore (standing in for Supabase surviving the restart). ---
    const brokerB = makeEtoroLikeBroker([rawPosition]);
    const clockB = new ManualSchedulerClock(NOW);
    const auditTrailB = new InMemoryAuditTrail();
    const lifecycleServiceB = new TradeLifecycleService({ store: lifecycleStore, auditTrail: auditTrailB, executionRunId: "run-b", now: () => clockB.now() });
    const tradeCandidateRepositoryB = new InMemoryTradeCandidateRepository();
    const runtimeB = new TradingRuntime({
      broker: brokerB as never,
      marketDataProvider: new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW }),
      strategy: STRATEGY,
      instrument: "BTC",
      amount: 10,
      orderSizingMode: "NOTIONAL",
      brokerProvider: "etoro-demo",
      portfolioRiskConfig: PERMISSIVE_RISK_CONFIG,
      lifecycleService: lifecycleServiceB,
      lifecycleStore,
      auditTrail: auditTrailB,
      marketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
      clock: clockB,
      intervalMs: 10_000,
      immediateFirstRun: true,
      tradeCandidateRepository: tradeCandidateRepositoryB,
      tradeCandidateExpiryMs: 20 * 60_000,
      approvalMode: "MANUAL",
      autoDemoMinConfidence: 0.75,
      killSwitchEnabled: false,
      recoveryThresholdMs: 5 * 60_000,
    });
    await runtimeB.start();
    await clockB.advance(0);

    const eventsB = (await auditTrailB.getEvents()).map((e) => e.eventType);
    expect(eventsB).toContain("BROKER_POSITION_RECONCILED");
    expect(eventsB).not.toContain("BROKER_POSITION_ORPHANED"); // NOT re-adopted as a new/second record

    const stillOnlyOneRecord = await lifecycleStore.list();
    expect(stillOnlyOneRecord).toHaveLength(1);
    expect(stillOnlyOneRecord[0]!.id).toBe(adoptedId);

    // No duplicate BUY candidate was ever proposed by the post-restart instance either.
    expect((await tradeCandidateRepositoryB.list()).filter((c) => c.direction === "BUY")).toHaveLength(0);

    await runtimeB.stop();
  });

  it("MANUAL mode never auto-approves a candidate, even when confidence would clear the AUTO_DEMO threshold (scenario 16)", async () => {
    const broker = makeMockBroker([]);
    const clock = new ManualSchedulerClock(NOW);
    const auditTrail = new InMemoryAuditTrail();
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const lifecycleService = new TradeLifecycleService({ store: lifecycleStore, auditTrail, executionRunId: "test-run", now: () => clock.now() });
    const tradeCandidateRepository = new InMemoryTradeCandidateRepository();

    const runtime = new TradingRuntime({
      broker,
      marketDataProvider: new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW }),
      strategy: STRATEGY,
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
      autoDemoMinConfidence: 0, // would auto-approve ANY confidence under AUTO_DEMO
      killSwitchEnabled: false,
      recoveryThresholdMs: 5 * 60_000,
    });

    await runtime.start();
    await clock.advance(0);

    const [candidate] = await tradeCandidateRepository.list({ status: "PENDING" });
    expect(candidate).toBeDefined();
    expect(candidate?.status).toBe("PENDING"); // never auto-approved under MANUAL
    expect(await tradeCandidateRepository.list({ status: "APPROVED" })).toHaveLength(0);

    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).not.toContain("TRADE_CANDIDATE_AUTO_APPROVED");

    await runtime.stop();
  });
});

// Restart-Resilient Autonomy Phase — kill switch hardening (safety-review pass). Covers the
// required scenarios: blocks fresh BUY, blocks AUTO_DEMO auto-approval, blocks a previously
// APPROVED BUY candidate's execution, and still permits an automatic (risk-reducing) close.
describe("TradingRuntime — kill switch blocks all exposure-increasing activity", () => {
  it("blocks a fresh BUY candidate from ever being created, emitting KILL_SWITCH_ENTRY_BLOCKED", async () => {
    const { runtime, clock, tradeCandidateRepository, auditTrail } = makeRuntime({ killSwitchEnabled: true });
    await runtime.start();
    await clock.advance(0);

    expect((await tradeCandidateRepository.list()).filter((c) => c.direction === "BUY")).toHaveLength(0);
    const blocked = (await auditTrail.getEvents()).find((e) => e.eventType === "KILL_SWITCH_ENTRY_BLOCKED");
    expect(blocked).toBeDefined();
    expect(blocked?.details.context).toBe("fresh-candidate-creation");

    await runtime.stop();
  });

  it("blocks AUTO_DEMO auto-approval — no candidate is ever created, so none is ever auto-approved", async () => {
    const { runtime, clock, tradeCandidateRepository, auditTrail } = makeRuntime({
      killSwitchEnabled: true,
      approvalMode: "AUTO_DEMO",
      autoDemoMinConfidence: 0, // would auto-approve ANY confidence if the kill switch didn't block it first
    });
    await runtime.start();
    await clock.advance(0);

    expect(await tradeCandidateRepository.list({ status: "APPROVED" })).toHaveLength(0);
    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).not.toContain("TRADE_CANDIDATE_AUTO_APPROVED");
    expect(events).toContain("KILL_SWITCH_ENTRY_BLOCKED");

    await runtime.stop();
  });

  it("blocks execution of a previously-APPROVED BUY candidate — left APPROVED, untouched, for a later cycle", async () => {
    const broker = makeMockBroker([]);
    const tradeCandidateRepository = new InMemoryTradeCandidateRepository();
    const lifecycleStore = new InMemoryTradeLifecycleStore();

    // Instance A: kill switch off — creates and (a human) approves a BUY candidate, same as any
    // ordinary MANUAL-mode cycle.
    const instanceA = makeRuntime({ broker, tradeCandidateRepository, lifecycleStore, killSwitchEnabled: false });
    await instanceA.runtime.start();
    await instanceA.clock.advance(0);
    const [pending] = await tradeCandidateRepository.list({ status: "PENDING" });
    expect(pending).toBeDefined();
    await approveTradeCandidate({
      repository: tradeCandidateRepository,
      auditTrail: instanceA.auditTrail,
      executionRunId: "test-run",
      candidateId: pending!.id,
      approvedByUserId: "user-1",
      now: instanceA.clock.now(),
    });
    await instanceA.runtime.stop();

    // Instance B: same repository/store/broker, but the kill switch is now on (an operator flipped
    // it, e.g. between restarts) — the already-APPROVED BUY candidate must not execute.
    const instanceB = makeRuntime({ broker, tradeCandidateRepository, lifecycleStore, killSwitchEnabled: true });
    await instanceB.runtime.start();
    await instanceB.clock.advance(0);

    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
    const stillApproved = await tradeCandidateRepository.getById(pending!.id);
    expect(stillApproved?.status).toBe("APPROVED");

    const blocked = (await instanceB.auditTrail.getEvents()).find((e) => e.eventType === "KILL_SWITCH_ENTRY_BLOCKED");
    expect(blocked).toBeDefined();
    expect(blocked?.details.context).toBe("approved-candidate-execution");
    expect(blocked?.details.candidateId).toBe(pending!.id);

    await instanceB.runtime.stop();
  });

  it("still permits an automatic close — the kill switch forces risk-reducing exits, never blocks them", async () => {
    const rawPosition = { positionID: 555, orderID: 999, instrumentID: 100000, isBuy: true, amount: 10, openRate: 100 };
    const tracked = new Map<string, PaperPosition>();
    tracked.set("fake-position-1", {
      positionId: "fake-position-1",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "BTC",
      side: "BUY",
      quantity: 10,
      entryPrice: 100,
      entryTimestamp: NOW.toISOString(),
      entryOrderId: "999",
      brokerPositionId: "555",
    });
    const closePosition = vi.fn(async (positionId: string, exitPrice: number, exitTimestamp: string, closeReason: string) => {
      const position = tracked.get(positionId)!;
      tracked.delete(positionId);
      const trade: CompletedTrade = {
        tradeId: `trade-${positionId}`,
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
        exitOrderId: `close-${positionId}`,
        realisedPnl: exitPrice - position.entryPrice,
        closeReason,
      };
      return { trade, orderId: `close-${positionId}` };
    });
    const broker = {
      getAccount: (): Account => ({ cashBalance: 1_000_000, startingCashBalance: 1_000_000 }),
      getOpenPositions: (): PaperPosition[] => [...tracked.values()],
      getCompletedTrades: (): CompletedTrade[] => [],
      resolveInstrument: async (_term: string) => ({ instrumentId: 100000 }),
      getRate: async (_instrument: string) => ({ bid: 100, ask: 100.05 }),
      getRawPortfolio: async () => ({ clientPortfolio: { positions: [rawPosition], credit: 1_000_000 } }),
      placeMarketOrder: vi.fn(),
      closePosition,
    };

    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create({
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
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      openedAt: NOW.toISOString(),
      entryPrice: 100,
      brokerPositionId: "555",
      brokerOrderId: "999",
    });

    const { runtime, clock, auditTrail } = makeRuntime({ broker: broker as never, lifecycleStore, killSwitchEnabled: true });
    await runtime.start();
    await clock.advance(0);

    expect(closePosition).toHaveBeenCalledOnce();
    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toContain("AUTOMATIC_EXIT_TRIGGERED");
    expect(events).toContain("TRADE_CLOSED");
    const triggered = (await auditTrail.getEvents()).find((e) => e.eventType === "AUTOMATIC_EXIT_TRIGGERED");
    expect(triggered?.details.trigger).toBe("KILL_SWITCH");

    const status = runtime.getStatus();
    expect(status.lastResult?.exitTrigger).toBe("KILL_SWITCH");
    expect(status.lastResult?.exitClosed).toBe(true);
    expect(status.lastResult?.positionOpen).toBe(false);

    // No new entry is opened this same cycle either — the fresh decision was evaluated against
    // positionOpen: true (before this cycle's own exit fired, per this runtime's own "the NEXT
    // cycle's reconciliation permits a new entry, never the same one" documented design), so no
    // BUY candidate exists to create regardless of the kill switch.
    expect(runtime.getStatus().lastResult?.candidateCreated).toBe(false);

    await runtime.stop();
  });
});

// Restart-Resilient Autonomy Phase — cycle-ordering hardening (safety-review pass). Covers the
// required restart scenario: broker already has a position, an APPROVED BUY survived restart,
// reconciliation detects the position, and no duplicate order is submitted.
describe("TradingRuntime — reconciliation runs before approved-candidate execution", () => {
  it("an APPROVED BUY that survived a restart is deferred (never executed) once reconciliation shows the broker already holds a position", async () => {
    const tradeCandidateRepository = new InMemoryTradeCandidateRepository();
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const brokerA = makeMockBroker([]);

    // Instance A (pre-restart): creates and approves a BUY candidate — kill switch off, no broker
    // position yet.
    const instanceA = makeRuntime({ broker: brokerA, tradeCandidateRepository, lifecycleStore, killSwitchEnabled: false });
    await instanceA.runtime.start();
    await instanceA.clock.advance(0);
    const [pending] = await tradeCandidateRepository.list({ status: "PENDING" });
    expect(pending).toBeDefined();
    await approveTradeCandidate({
      repository: tradeCandidateRepository,
      auditTrail: instanceA.auditTrail,
      executionRunId: "test-run",
      candidateId: pending!.id,
      approvedByUserId: "user-1",
      now: instanceA.clock.now(),
    });
    await instanceA.runtime.stop();

    // Simulates a restart: a BRAND-NEW broker instance already shows a real, live BTC position
    // (e.g. this candidate's own order actually went through against the real broker before the
    // process crashed, or a human opened one directly) — reconciliation must detect this BEFORE
    // the survived APPROVED candidate is ever allowed to execute.
    const rawPosition = { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: 10, openRate: 64_948.33 };
    const brokerB = makeEtoroLikeBroker([rawPosition]);
    const instanceB = makeRuntime({
      broker: brokerB as never,
      tradeCandidateRepository,
      lifecycleStore,
      killSwitchEnabled: false,
    });
    await instanceB.runtime.start();
    await instanceB.clock.advance(0);

    // No duplicate order was ever submitted for the survived candidate.
    expect(brokerB.placeMarketOrder).not.toHaveBeenCalled();
    const stillApproved = await tradeCandidateRepository.getById(pending!.id);
    expect(stillApproved?.status).toBe("APPROVED");

    const events = (await instanceB.auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toContain("BROKER_POSITION_ORPHANED"); // the real position is adopted...
    expect(events).toContain("APPROVED_CANDIDATE_EXECUTION_DEFERRED"); // ...and the stale approval is deferred, not executed

    const deferred = (await instanceB.auditTrail.getEvents()).find((e) => e.eventType === "APPROVED_CANDIDATE_EXECUTION_DEFERRED");
    expect(deferred?.details.candidateId).toBe(pending!.id);

    // Exactly one lifecycle record exists (the adopted broker position) — never a second one from
    // the deferred candidate.
    expect((await lifecycleStore.list()).length).toBe(1);

    await instanceB.runtime.stop();
  });
});

// Restart-Resilient Autonomy Phase — prevent re-execution after reconciled closure (deployment
// safety review, required regression test): candidate remains APPROVED -> lifecycle opens -> broker
// position closes before candidate expiry -> lifecycle becomes CLOSED_UNRECONCILED -> candidate must
// not be picked up and executed again.
describe("TradingRuntime — CLOSED_UNRECONCILED cannot permit candidate re-execution (regression)", () => {
  it("a candidate stuck APPROVED behind a crash-orphaned OPEN record is repaired to EXECUTED the moment the position resolves to CLOSED_UNRECONCILED — never re-executed", async () => {
    const tradeCandidateRepository = new InMemoryTradeCandidateRepository();
    const lifecycleStore = new InMemoryTradeLifecycleStore();

    // Seeds the exact "crashed right after OPEN, before candidate -> EXECUTED" state directly,
    // rather than simulating the crash procedurally — this test's own point is what happens AFTER
    // that state already exists, not how it arose (crash-window tracing is covered by
    // lifecycle-recovery.test.ts).
    const candidate = await tradeCandidateRepository.create({
      analysisRunId: undefined,
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      instrument: "BTC",
      direction: "BUY",
      confidence: 0.8,
      entryPrice: 64_948.33,
      stopLoss: 60_000,
      takeProfit: 70_000,
      riskReward: 2,
      reasoning: ["seed"],
      validationNotes: [],
      expiresAt: "2026-01-02T00:00:00.000Z", // far in the future — never expires mid-test
      execution: {
        amount: 10,
        sizingMode: "NOTIONAL",
        marketContext: {
          instrument: "BTC",
          bid: 100,
          ask: 100.05,
          spread: 0.05,
          midPrice: 100.025,
          timestamp: "2026-01-01T00:00:00.000Z",
          positionOpen: false,
          strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "HERMES_APPROVED" },
          recentCandles: [],
          ema20: 110,
          ema50: 100,
          rsi14: 55,
          atr14: 1.5,
          volume: 120,
          dailyHigh: 112,
          dailyLow: 98,
          volatility24h: 0.01,
          marketSession: "Crypto Always Open",
          trend: "Bullish",
        },
        marketDataSnapshot: {
          instrument: "BTC",
          timestamp: "2026-01-01T00:00:00.000Z",
          candles: [],
          bid: 100,
          ask: 100.05,
          spread: 0.05,
          latestPrice: 100.025,
          volume: 120,
        },
      },
    });
    await tradeCandidateRepository.transition(candidate.id, "PENDING", {
      status: "APPROVED",
      approvedAt: NOW.toISOString(),
      approvedByUserId: "user-1",
    });

    await lifecycleStore.create({
      id: "lifecycle-1",
      candidateId: candidate.id,
      brokerProvider: "etoro-demo",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      symbol: "BTC",
      side: "BUY",
      quantity: 10,
      sizingMode: "NOTIONAL",
      decision: "BUY",
      confidence: 0.8,
      decisionReasons: ["seed"],
      status: "OPEN",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      openedAt: NOW.toISOString(),
      entryPrice: 64_948.33,
      brokerPositionId: "3568040809",
      brokerOrderId: "369015901",
    });

    // The broker's OWN raw portfolio already shows nothing for this instrument — the position
    // closed (by whatever means) before this runtime ever got a chance to observe it as OPEN again.
    const broker = makeEtoroLikeBroker([]);
    const { runtime, clock, auditTrail } = makeRuntime({ broker: broker as never, tradeCandidateRepository, lifecycleStore });

    await runtime.start();
    await clock.advance(0); // cycle 1: discovers the mismatch, repairs the candidate, resolves the lifecycle

    const lifecycleAfterCycle1 = await lifecycleStore.getById("lifecycle-1");
    expect(lifecycleAfterCycle1?.status).toBe("CLOSED_UNRECONCILED");
    const candidateAfterCycle1 = await tradeCandidateRepository.getById(candidate.id);
    expect(candidateAfterCycle1?.status).toBe("EXECUTED"); // repaired — no longer APPROVED

    const events1 = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events1).toContain("CANDIDATE_EXECUTION_RECONCILED");
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();

    // A second cycle — the strategy+instrument slot is now free (CLOSED_UNRECONCILED is terminal
    // and excluded from active uniqueness), and a fresh bullish decision would otherwise propose a
    // BUY. The point: the OLD candidate (now EXECUTED, terminal) is never picked up again — it is
    // not in the APPROVED list at all any more, so it cannot be re-executed.
    await clock.advance(10_000);

    expect(broker.placeMarketOrder).not.toHaveBeenCalled(); // no duplicate order for the OLD candidate
    expect((await tradeCandidateRepository.getById(candidate.id))?.status).toBe("EXECUTED"); // still terminal, untouched
    expect((await tradeCandidateRepository.list({ status: "APPROVED" })).filter((c) => c.id === candidate.id)).toHaveLength(0);

    await runtime.stop();
  });
});

// Deployment safety review (final hardening pass, required regression test): a genuinely ambiguous
// EXECUTION_RECONCILIATION_REQUIRED record for the same strategy+instrument must not send a
// previously-APPROVED BUY candidate into a lifecycle uniqueness violation — it must instead be
// deferred cleanly, exactly like a confirmed-open position.
describe("TradingRuntime — EXECUTION_RECONCILIATION_REQUIRED defers approved candidates (regression)", () => {
  it("defers an APPROVED BUY candidate via APPROVED_CANDIDATE_EXECUTION_DEFERRED, never a lifecycle uniqueness violation", async () => {
    const tradeCandidateRepository = new InMemoryTradeCandidateRepository();
    const lifecycleStore = new InMemoryTradeLifecycleStore();

    const candidate = await tradeCandidateRepository.create({
      analysisRunId: undefined,
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      instrument: "BTC",
      direction: "BUY",
      confidence: 0.8,
      entryPrice: 64_948.33,
      stopLoss: 60_000,
      takeProfit: 70_000,
      riskReward: 2,
      reasoning: ["seed"],
      validationNotes: [],
      expiresAt: "2026-01-02T00:00:00.000Z", // far in the future — never expires mid-test
      execution: {
        amount: 10,
        sizingMode: "NOTIONAL",
        marketContext: {
          instrument: "BTC",
          bid: 100,
          ask: 100.05,
          spread: 0.05,
          midPrice: 100.025,
          timestamp: "2026-01-01T00:00:00.000Z",
          positionOpen: false,
          strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "HERMES_APPROVED" },
          recentCandles: [],
          ema20: 110,
          ema50: 100,
          rsi14: 55,
          atr14: 1.5,
          volume: 120,
          dailyHigh: 112,
          dailyLow: 98,
          volatility24h: 0.01,
          marketSession: "Crypto Always Open",
          trend: "Bullish",
        },
        marketDataSnapshot: {
          instrument: "BTC",
          timestamp: "2026-01-01T00:00:00.000Z",
          candles: [],
          bid: 100,
          ask: 100.05,
          spread: 0.05,
          latestPrice: 100.025,
          volume: 120,
        },
      },
    });
    await tradeCandidateRepository.transition(candidate.id, "PENDING", {
      status: "APPROVED",
      approvedAt: NOW.toISOString(),
      approvedByUserId: "user-1",
    });

    // Simulates the exact crash-window state lifecycle-recovery.ts leaves behind: a genuinely
    // ambiguous record, not yet correlated back to any candidate (candidateId omitted — this also
    // proves candidate-lifecycle-repair.ts is never even reached for it this cycle).
    await lifecycleStore.create({
      id: "lifecycle-1",
      candidateId: undefined,
      brokerProvider: "etoro-demo",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      symbol: "BTC",
      side: "BUY",
      quantity: 10,
      sizingMode: "NOTIONAL",
      decision: "BUY",
      confidence: 0.8,
      decisionReasons: ["seed"],
      status: "EXECUTION_RECONCILIATION_REQUIRED",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });

    const broker = makeMockBroker([]);
    const { runtime, clock, auditTrail } = makeRuntime({ broker, tradeCandidateRepository, lifecycleStore });

    await runtime.start();
    await clock.advance(0);

    // No crash, no uniqueness violation — the cycle completed successfully.
    expect(runtime.getStatus().successfulRunCount).toBe(1);
    expect(runtime.getStatus().failedRunCount).toBe(0);

    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
    const stillApproved = await tradeCandidateRepository.getById(candidate.id);
    expect(stillApproved?.status).toBe("APPROVED");

    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toContain("APPROVED_CANDIDATE_EXECUTION_DEFERRED");
    expect(events).not.toContain("DUPLICATE_LIFECYCLE_RECORD_DETECTED");
    const deferred = (await auditTrail.getEvents()).find((e) => e.eventType === "APPROVED_CANDIDATE_EXECUTION_DEFERRED");
    expect(deferred?.details.candidateId).toBe(candidate.id);

    // The ambiguous record is left untouched this cycle — resolving it is lifecycle-recovery.ts's
    // job (once it becomes stale enough), never reconciliation's or the approved-candidate loop's.
    const stored = await lifecycleStore.getById("lifecycle-1");
    expect(stored?.status).toBe("EXECUTION_RECONCILIATION_REQUIRED");
    expect((await lifecycleStore.list()).length).toBe(1); // never a second record created

    await runtime.stop();
  });

  // Approved-candidate sequencing fix (production incident: candidate 9f177a8f-a6cb-4ddc-9fc5-
  // d277ff15ce8b — an ETH BUY approved at 0.82 confidence failed with "decision was no longer
  // executable" purely because the NEXT cycle's fresh Hermes decision had moved to HOLD).
  it("executes a durably-APPROVED BUY candidate even when this cycle's own fresh, independently-computed decision is HOLD", async () => {
    const tradeCandidateRepository = new InMemoryTradeCandidateRepository();
    const lifecycleStore = new InMemoryTradeLifecycleStore();

    const candidate = await tradeCandidateRepository.create({
      analysisRunId: undefined,
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      instrument: "BTC",
      direction: "BUY",
      confidence: 0.82,
      entryPrice: 64_948.33,
      stopLoss: 60_000,
      takeProfit: 70_000,
      riskReward: 2,
      reasoning: ["EMA20 above EMA50", "Bullish trend"],
      validationNotes: [],
      expiresAt: "2026-01-02T00:00:00.000Z", // far in the future — never expires mid-test
      execution: {
        amount: 10,
        sizingMode: "NOTIONAL",
        marketContext: {
          instrument: "BTC",
          bid: 100,
          ask: 100.05,
          spread: 0.05,
          midPrice: 100.025,
          timestamp: "2026-01-01T00:00:00.000Z",
          positionOpen: false,
          strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "HERMES_APPROVED" },
          recentCandles: [],
          ema20: 110,
          ema50: 100,
          rsi14: 55,
          atr14: 1.5,
          volume: 120,
          dailyHigh: 112,
          dailyLow: 98,
          volatility24h: 0.01,
          marketSession: "Crypto Always Open",
          trend: "Bullish",
        },
        marketDataSnapshot: {
          instrument: "BTC",
          timestamp: "2026-01-01T00:00:00.000Z",
          candles: [],
          bid: 100,
          ask: 100.05,
          spread: 0.05,
          latestPrice: 100.025,
          volume: 120,
        },
      },
    });
    await tradeCandidateRepository.transition(candidate.id, "PENDING", {
      status: "APPROVED",
      approvedAt: NOW.toISOString(),
      approvedByUserId: "user-1",
    });

    const broker = makeMockBroker([]);
    // The runtime's own live market data for THIS cycle is bearish — its OWN fresh
    // MarketDecisionEngine.evaluate() call produces HOLD (no position exists yet to SELL), a
    // completely different action than the candidate's own frozen, already-approved BUY.
    const bearishProvider = new MockMarketDataProvider({ bias: "bearish", seed: 42, now: NOW });
    const { runtime, clock, auditTrail } = makeRuntime({
      broker,
      tradeCandidateRepository,
      lifecycleStore,
      marketDataProvider: bearishProvider,
    });

    await runtime.start();
    await clock.advance(0);

    expect(runtime.getStatus().successfulRunCount).toBe(1);
    expect(runtime.getStatus().failedRunCount).toBe(0);

    // The approved BUY executed — a later/independent HOLD never invalidated it.
    expect(broker.placeMarketOrder).toHaveBeenCalledOnce();
    const executed = await tradeCandidateRepository.getById(candidate.id);
    expect(executed?.status).toBe("EXECUTED");
    expect(executed?.entryPrice).toBe(64_948.33); // the persisted snapshot's own price, never re-derived

    const openRecord = await lifecycleStore.list();
    const opened = openRecord.find((r) => r.candidateId === candidate.id);
    expect(opened?.status).toBe("OPEN");
    expect(opened?.stopLoss).toBe(60_000);
    expect(opened?.takeProfit).toBe(70_000);
    expect(opened?.confidence).toBe(0.82);

    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toContain("TRADE_CANDIDATE_EXECUTED");
    expect(events).not.toContain("TRADE_CANDIDATE_EXECUTION_FAILED");

    await runtime.stop();
  });

  // Max-daily-trades risk counter fix (production incident: risk checks reported "10 trade(s) today
  // already at the configured maximum of 10" shortly after UTC midnight, purely because the broker
  // process had accumulated 10 completedTrades before midnight — not a genuine UTC-day count).
  it("the approved-candidate execution loop's dailyTradeCount is sourced from the durable lifecycle store's confirmed-OPEN-today entries, never broker.getCompletedTrades()", async () => {
    const tradeCandidateRepository = new InMemoryTradeCandidateRepository();
    const lifecycleStore = new InMemoryTradeLifecycleStore();

    // A confirmed OPEN position, opened earlier TODAY (NOW is 2026-01-01T12:00:00Z) for this same
    // strategy — the durable evidence a correct dailyTradeCount must be built from.
    await lifecycleStore.create({
      id: "lifecycle-already-open-today",
      candidateId: undefined,
      brokerProvider: "etoro-demo",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      symbol: "ETH", // different instrument — dailyTradeCount is strategy-scoped, not instrument-scoped
      side: "BUY",
      quantity: 10,
      sizingMode: "UNITS",
      decision: "BUY",
      confidence: 0.8,
      decisionReasons: ["seed"],
      status: "OPEN",
      createdAt: "2026-01-01T01:00:00.000Z",
      updatedAt: "2026-01-01T01:00:00.000Z",
      openedAt: "2026-01-01T01:00:00.000Z",
      entryPrice: 3000,
      brokerOrderId: "seed-order-1",
    });

    const candidate = await tradeCandidateRepository.create({
      analysisRunId: undefined,
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      instrument: "BTC",
      direction: "BUY",
      confidence: 0.8,
      entryPrice: 64_948.33,
      stopLoss: 60_000,
      takeProfit: 70_000,
      riskReward: 2,
      reasoning: ["seed"],
      validationNotes: [],
      expiresAt: "2026-01-02T00:00:00.000Z",
      execution: {
        amount: 10,
        sizingMode: "NOTIONAL",
        marketContext: {
          instrument: "BTC",
          bid: 100,
          ask: 100.05,
          spread: 0.05,
          midPrice: 100.025,
          timestamp: "2026-01-01T00:00:00.000Z",
          positionOpen: false,
          strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "HERMES_APPROVED" },
          recentCandles: [],
          ema20: 110,
          ema50: 100,
          rsi14: 55,
          atr14: 1.5,
          volume: 120,
          dailyHigh: 112,
          dailyLow: 98,
          volatility24h: 0.01,
          marketSession: "Crypto Always Open",
          trend: "Bullish",
        },
        marketDataSnapshot: {
          instrument: "BTC",
          timestamp: "2026-01-01T00:00:00.000Z",
          candles: [],
          bid: 100,
          ask: 100.05,
          spread: 0.05,
          latestPrice: 100.025,
          volume: 120,
        },
      },
    });
    await tradeCandidateRepository.transition(candidate.id, "PENDING", {
      status: "APPROVED",
      approvedAt: NOW.toISOString(),
      approvedByUserId: "user-1",
    });

    const broker = makeMockBroker([]);
    // The broker's own completedTrades is EMPTY — if dailyTradeCount were still (incorrectly)
    // sourced from broker.getCompletedTrades().length, this candidate would wrongly be permitted.
    expect(broker.getCompletedTrades()).toEqual([]);

    const { runtime, clock, auditTrail } = makeRuntime({
      broker,
      tradeCandidateRepository,
      lifecycleStore,
      portfolioRiskConfig: { ...PERMISSIVE_RISK_CONFIG, maxDailyTrades: 1 },
    });

    await runtime.start();
    await clock.advance(0);

    // Blocked: the durable ETH OPEN record already spent today's ONE allowed entry for this
    // strategy — never permitted just because the broker's own completedTrades is empty.
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
    const stored = await tradeCandidateRepository.getById(candidate.id);
    expect(stored?.status).toBe("FAILED");
    expect(stored?.failureReason).toMatch(/trade\(s\) today already at the configured maximum of 1/);

    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toContain("TRADE_CANDIDATE_EXECUTION_FAILED");

    await runtime.stop();
  });
});
