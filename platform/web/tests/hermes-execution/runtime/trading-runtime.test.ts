import { describe, expect, it, vi } from "vitest";
import { TradingRuntime } from "@/lib/hermes-execution/runtime/trading-runtime";
import { AlwaysOpenMarketHoursPolicy, type MarketHoursPolicy } from "@/lib/hermes-execution/runtime/market-hours-policy";
import { InvalidTradingRuntimeTransitionError } from "@/lib/hermes-execution/runtime/types";
import { MockMarketDataProvider } from "@/lib/hermes-execution/market-data/mock-market-data-provider";
import type { MarketDataProvider, MarketDataSnapshot } from "@/lib/hermes-execution/market-data/market-data-provider";
import { TradeLifecycleService } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-service";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";
import type { PaperBroker } from "@/lib/hermes-execution/paper-broker";
import type { Account, CompletedTrade, InternalStrategy, OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";
import { ManualSchedulerClock, flushMicrotasks } from "./support/manual-scheduler-clock";

const NOW = new Date("2026-01-01T12:00:00.000Z");

const STRATEGY: InternalStrategy = {
  strategyId: "STRAT-0001",
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
}

function makeRuntime(
  overrides: {
    openPositions?: PaperPosition[];
    marketDataProvider?: MarketDataProvider;
    marketHoursPolicy?: MarketHoursPolicy;
    intervalMs?: number;
    immediateFirstRun?: boolean;
    shutdownTimeoutMs?: number;
  } = {},
): RuntimeHarness {
  const broker = makeMockBroker(overrides.openPositions ?? []);
  const clock = new ManualSchedulerClock(NOW);
  const auditTrail = new InMemoryAuditTrail();
  const lifecycleService = new TradeLifecycleService({
    store: new InMemoryTradeLifecycleStore(),
    auditTrail,
    executionRunId: "test-run",
    now: () => clock.now(),
  });
  const marketDataProvider =
    overrides.marketDataProvider ?? new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });

  const runtime = new TradingRuntime({
    broker,
    marketDataProvider,
    strategy: STRATEGY,
    instrument: "BTC",
    amount: 10,
    portfolioRiskConfig: PERMISSIVE_RISK_CONFIG,
    lifecycleService,
    auditTrail,
    marketHoursPolicy: overrides.marketHoursPolicy ?? new AlwaysOpenMarketHoursPolicy(),
    clock,
    intervalMs: overrides.intervalMs ?? 10_000,
    immediateFirstRun: overrides.immediateFirstRun ?? true,
    shutdownTimeoutMs: overrides.shutdownTimeoutMs,
  });

  return { runtime, broker, clock, lifecycleService, auditTrail };
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
  it("actually calls through the real lifecycle-aware pipeline — a genuine OPEN lifecycle record with the broker's real entry price", async () => {
    const { runtime, broker, lifecycleService, clock } = makeRuntime();
    await runtime.start();
    await clock.advance(0);

    expect(broker.placeMarketOrder).toHaveBeenCalledOnce();
    const status = runtime.getStatus();
    expect(status.successfulRunCount).toBe(1);
    expect(status.lastResult).toMatchObject({ decision: "BUY", executed: true, instrument: "BTC" });
    expect(status.lastRunStartedAt).toBeDefined();
    expect(status.lastRunCompletedAt).toBeDefined();

    const openRecord = await lifecycleService.findOpenRecord("STRAT-0001", "BTC");
    expect(openRecord?.status).toBe("OPEN");
    expect(openRecord?.entryPrice).toBe(broker.getOpenPositions()[0]?.entryPrice);
  });
});

describe("TradingRuntime — failed cycle", () => {
  it("records failedRunCount/lastError without throwing, and the scheduler continues afterward", async () => {
    const { runtime, broker, clock } = makeRuntime({ intervalMs: 10_000 });
    broker.placeMarketOrder.mockRejectedValueOnce(new Error("broker unreachable"));

    await runtime.start();
    await clock.advance(0);

    let status = runtime.getStatus();
    expect(status.failedRunCount).toBe(1);
    expect(status.successfulRunCount).toBe(0);
    expect(status.lastError).toEqual({ message: "broker unreachable", occurredAt: NOW.toISOString() });
    expect(status.state).toBe("RUNNING"); // a failure never stops the runtime

    // Next scheduled tick succeeds normally — proves scheduling continued after the failure.
    await clock.advance(10_000);
    status = runtime.getStatus();
    expect(status.successfulRunCount).toBe(1);
    expect(status.failedRunCount).toBe(1); // untouched by the later success
  });

  it("lastError is a plain serialisable object, never a raw Error instance", async () => {
    const { runtime, broker, clock } = makeRuntime();
    broker.placeMarketOrder.mockRejectedValueOnce(new Error("boom"));
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
    const { runtime, clock, broker } = makeRuntime({
      marketDataProvider: new GatedMarketDataProvider(inner, gate.promise),
      intervalMs: 10_000,
    });

    await runtime.start();
    await clock.advance(0); // cycle 1 starts and blocks on the gate
    expect(runtime.getStatus().isCycleRunning).toBe(true);

    await clock.advance(10_000); // cycle 2's scheduled tick fires while cycle 1 is still active
    expect(runtime.getStatus().skippedOverlapCount).toBe(1);
    expect(runtime.getStatus().isCycleRunning).toBe(true); // still cycle 1, not replaced
    expect(broker.placeMarketOrder).not.toHaveBeenCalled(); // cycle 1 hasn't reached the broker yet

    gate.resolve();
    await flushMicrotasks();

    const status = runtime.getStatus();
    expect(status.isCycleRunning).toBe(false);
    expect(status.successfulRunCount).toBe(1); // only cycle 1 ever actually ran
    expect(broker.placeMarketOrder).toHaveBeenCalledOnce();
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
    const { runtime, clock, broker } = makeRuntime({ intervalMs: 10_000, immediateFirstRun: false });
    await runtime.start();
    await runtime.pause();

    await clock.advance(10_000);
    const status = runtime.getStatus();
    expect(status.skippedPausedCount).toBe(1);
    expect(status.successfulRunCount).toBe(0);
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
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
    const { runtime, broker, clock } = makeRuntime({ marketHoursPolicy: closedPolicy });

    await runtime.start();
    await clock.advance(0);

    const status = runtime.getStatus();
    expect(status.skippedMarketClosedCount).toBe(1);
    expect(status.failedRunCount).toBe(0);
    expect(status.successfulRunCount).toBe(0);
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();
  });
});

describe("TradingRuntime — graceful shutdown while a cycle is active", () => {
  it("stop() transitions to STOPPING immediately, then STOPPED only once the active cycle finishes", async () => {
    const inner = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
    const gate = makeGate();
    const { runtime, broker, clock } = makeRuntime({ marketDataProvider: new GatedMarketDataProvider(inner, gate.promise) });

    await runtime.start();
    await clock.advance(0);
    expect(runtime.getStatus().isCycleRunning).toBe(true);

    const stopPromise = runtime.stop();
    await flushMicrotasks();
    // stop() has begun but the cycle is still gated — must not have abandoned it.
    expect(runtime.getStatus().state).toBe("STOPPING");
    expect(broker.placeMarketOrder).not.toHaveBeenCalled();

    gate.resolve();
    await stopPromise;

    expect(runtime.getStatus().state).toBe("STOPPED");
    expect(broker.placeMarketOrder).toHaveBeenCalledOnce(); // the in-flight cycle ran to completion
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
