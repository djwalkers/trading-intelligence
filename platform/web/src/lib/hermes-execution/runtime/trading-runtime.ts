import { buildMarketDecisionContext } from "../build-market-decision-context";
import type { AuditTrail } from "../audit-trail";
import type { AuditEventType, InternalStrategy } from "../types";
import type { MarketDataProvider } from "../market-data/market-data-provider";
import type { MarketDecisionCycleResult } from "../market-decision-runner";
import { runMarketDecisionCycleWithLifecycle } from "../trade-lifecycle/trade-lifecycle-runner";
import type { TradeLifecycleService } from "../trade-lifecycle/trade-lifecycle-service";
import type { PaperBroker } from "../paper-broker";
import type { PortfolioRiskConfig } from "../portfolio-risk-engine";
import type { SchedulerClock } from "./scheduler-clock";
import type { MarketHoursPolicy } from "./market-hours-policy";
import { TradingScheduler } from "./trading-scheduler";
import { assertValidRuntimeTransition, type TradingErrorSummary, type TradingRuntimeState, type TradingRuntimeStatus } from "./types";

// Milestone 7 — 24/7 Scheduler & Runtime Control. The one place "Scheduler tick -> Runtime
// controller -> runMarketDecisionCycleWithLifecycle() -> existing pipeline" (this milestone's own
// architectural diagram) is wired up. TradingRuntime owns the state machine, counters, and overlap/
// pause/market-hours gating; TradingScheduler (a plain internal collaborator, not touched here
// beyond construction) owns only "when does the next tick fire." Neither one reimplements anything
// from build-market-decision-context.ts, trade-lifecycle-runner.ts, or below — every pipeline call
// here is a call to an existing, unmodified function.

export type TradingCycleOutcome =
  | { kind: "completed"; result: MarketDecisionCycleResult }
  | { kind: "failed"; error: unknown }
  | { kind: "skipped-paused" }
  | { kind: "skipped-overlap" }
  | { kind: "skipped-market-closed" };

export interface TradingRuntimeDeps {
  broker: PaperBroker;
  marketDataProvider: MarketDataProvider;
  strategy: InternalStrategy;
  instrument: string;
  amount: number;
  portfolioRiskConfig: PortfolioRiskConfig;
  lifecycleService: TradeLifecycleService;
  auditTrail: AuditTrail;
  marketHoursPolicy: MarketHoursPolicy;
  clock: SchedulerClock;
  intervalMs: number;
  immediateFirstRun: boolean;
  /** Prototype V1 — Reliability Fix. Upper bound (ms) stop() will ever wait for an in-flight cycle
   * before proceeding to STOPPED regardless — confirmed via live testing that an unbounded wait
   * here can hang indefinitely if a single broker HTTP call stalls (see EtoroClient's own,
   * independent httpTimeoutMs bound — the two work together: this is a backstop for anything else
   * that might be slow, not a replacement for bounding the HTTP call itself). Defaults to 30000. */
  shutdownTimeoutMs?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TradingRuntime {
  private state: TradingRuntimeState = "STOPPED";
  private startedAt: string | null = null;
  private pausedAt: string | null = null;
  private stoppedAt: string | null = null;
  private isCycleRunning = false;
  private lastRunStartedAt: string | null = null;
  private lastRunCompletedAt: string | null = null;
  private successfulRunCount = 0;
  private failedRunCount = 0;
  private skippedOverlapCount = 0;
  private skippedPausedCount = 0;
  private skippedMarketClosedCount = 0;
  private lastResult: TradingRuntimeStatus["lastResult"] = null;
  private lastError: TradingErrorSummary | null = null;

  private scheduler: TradingScheduler | null = null;
  private executionRunId: string | null = null;
  /** Resolves once the currently-active cycle (if any) finishes — stop() awaits this so a graceful
   * shutdown never abandons an in-flight cycle mid-way. Never rejects (see attemptCycle). */
  private activeCyclePromise: Promise<void> | null = null;

  constructor(private readonly deps: TradingRuntimeDeps) {}

  async start(): Promise<void> {
    assertValidRuntimeTransition(this.state, "RUNNING");
    this.state = "RUNNING";
    const now = this.deps.clock.now();
    this.startedAt = now.toISOString();
    this.stoppedAt = null;
    this.executionRunId = `trading-runtime-${now.getTime()}`;

    this.scheduler = new TradingScheduler({
      clock: this.deps.clock,
      intervalMs: this.deps.intervalMs,
      immediateFirstRun: this.deps.immediateFirstRun,
      onTick: () => {
        void this.attemptCycle("scheduled");
      },
    });
    this.scheduler.start();

    await this.recordAudit("TRADING_RUNTIME_STARTED", {
      intervalMs: this.deps.intervalMs,
      immediateFirstRun: this.deps.immediateFirstRun,
    });
  }

  async pause(): Promise<void> {
    assertValidRuntimeTransition(this.state, "PAUSED");
    this.state = "PAUSED";
    this.pausedAt = this.deps.clock.now().toISOString();
    await this.recordAudit("TRADING_RUNTIME_PAUSED", {});
  }

  /** Resumes scheduling without replaying any tick that occurred while paused — each paused tick
   * was already recorded as skipped (see attemptCycle) and is never queued or re-run; only future
   * ticks, on the same ongoing schedule, run cycles again. */
  async resume(): Promise<void> {
    assertValidRuntimeTransition(this.state, "RUNNING");
    this.state = "RUNNING";
    await this.recordAudit("TRADING_RUNTIME_RESUMED", {});
  }

  /** Stops scheduling new cycles immediately, then waits for any currently-active cycle to finish
   * before resolving — a graceful shutdown never abandons an in-flight cycle *as long as it
   * finishes within shutdownTimeoutMs* (default 30s; see TradingRuntimeDeps' own doc comment).
   * Confirmed via live testing that an unbounded wait here can hang forever if a single broker HTTP
   * call stalls — past that bound, this proceeds to STOPPED anyway rather than hanging the process,
   * recording `details.timedOut: true` on the TRADING_RUNTIME_STOPPED audit event so an abandoned
   * cycle is visible, never silent. Safe to call from RUNNING or PAUSED; invalid (throws) from
   * STOPPED or STOPPING (including a second concurrent stop() call — see the CLI's own signal-
   * handler de-duplication for why that should never happen via SIGINT/SIGTERM in practice). */
  async stop(): Promise<void> {
    assertValidRuntimeTransition(this.state, "STOPPING");
    this.state = "STOPPING";
    this.scheduler?.stop();
    this.scheduler = null;

    const timedOut = await this.awaitActiveCycleWithTimeout(this.deps.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);

    this.state = "STOPPED";
    this.stoppedAt = this.deps.clock.now().toISOString();
    await this.recordAudit("TRADING_RUNTIME_STOPPED", { timedOut });
  }

  /** Races the currently-active cycle (if any) against a bound, using the same SchedulerClock
   * already used for ticks — so tests can simulate "time passes without the cycle resolving"
   * deterministically via a fake clock, with no real waiting. Returns true only if the bound was
   * reached before the cycle finished; the cycle itself is never cancelled or aborted here (it may
   * still complete later, updating counters/lastResult/lastError as normal — see attemptCycle's own
   * finally block) — this only bounds how long *stop()* waits for it. */
  private awaitActiveCycleWithTimeout(timeoutMs: number): Promise<boolean> {
    const activeCyclePromise = this.activeCyclePromise;
    if (!activeCyclePromise) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = this.deps.clock.scheduleOnce(() => {
        if (settled) return;
        settled = true;
        resolve(true);
      }, timeoutMs);

      activeCyclePromise.then(() => {
        if (settled) return;
        settled = true;
        timer.cancel();
        resolve(false);
      });
    });
  }

  /**
   * Runs one cycle immediately, outside the regular schedule. Two distinct failure shapes,
   * deliberately: a *usage* error (the runtime isn't RUNNING/PAUSED, it's PAUSED without
   * `overridePause`, or a cycle is already active) rejects the returned promise immediately,
   * synchronously reflecting a caller mistake — never confused with a real trading outcome. A
   * cycle that actually ran but whose pipeline call failed (e.g. a broker error) instead *resolves*
   * with `{ kind: "failed", error }` — a legitimate, expected outcome of asking the pipeline to do
   * something, not a misuse of this method.
   *
   * Convention: rejected while PAUSED unless `overridePause: true` is explicitly supplied.
   */
  async runNow(options: { overridePause?: boolean } = {}): Promise<TradingCycleOutcome> {
    if (this.state === "STOPPED" || this.state === "STOPPING") {
      throw new Error(`TradingRuntime.runNow() requires the runtime to be RUNNING or PAUSED, but it is ${this.state}.`);
    }
    return this.attemptCycle("manual", options.overridePause ?? false);
  }

  getStatus(): TradingRuntimeStatus {
    return {
      state: this.state,
      startedAt: this.startedAt,
      pausedAt: this.pausedAt,
      stoppedAt: this.stoppedAt,
      intervalMs: this.deps.intervalMs,
      isCycleRunning: this.isCycleRunning,
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunCompletedAt: this.lastRunCompletedAt,
      nextRunAt: this.scheduler?.getNextRunAt()?.toISOString() ?? null,
      successfulRunCount: this.successfulRunCount,
      failedRunCount: this.failedRunCount,
      skippedOverlapCount: this.skippedOverlapCount,
      skippedPausedCount: this.skippedPausedCount,
      skippedMarketClosedCount: this.skippedMarketClosedCount,
      lastResult: this.lastResult,
      lastError: this.lastError,
    };
  }

  /** The single entry point for both a scheduled tick and a manual runNow() call — same gating
   * (paused / overlap / market-hours), same counters, same audit events, so the two triggers can
   * never drift into inconsistent behaviour. `trigger === "scheduled"` never throws (the scheduler
   * fires this fire-and-forget — see TradingScheduler's own doc comment); `trigger === "manual"`
   * throws for the two usage-error cases per runNow()'s own doc comment. */
  private async attemptCycle(trigger: "scheduled" | "manual", overridePause = false): Promise<TradingCycleOutcome> {
    if (this.state === "PAUSED" && !(trigger === "manual" && overridePause)) {
      this.skippedPausedCount += 1;
      await this.recordAudit("TRADING_CYCLE_SKIPPED_PAUSED", { trigger });
      if (trigger === "manual") {
        throw new Error(
          "TradingRuntime.runNow() was rejected: the runtime is PAUSED. Pass { overridePause: true } to run anyway.",
        );
      }
      return { kind: "skipped-paused" };
    }

    if (this.isCycleRunning) {
      this.skippedOverlapCount += 1;
      await this.recordAudit("TRADING_CYCLE_SKIPPED_OVERLAP", { trigger });
      if (trigger === "manual") {
        throw new Error("TradingRuntime.runNow() was rejected: a trading cycle is already running.");
      }
      return { kind: "skipped-overlap" };
    }

    const now = this.deps.clock.now();
    if (!this.deps.marketHoursPolicy.isMarketOpen(now)) {
      this.skippedMarketClosedCount += 1;
      await this.recordAudit("TRADING_CYCLE_SKIPPED_MARKET_CLOSED", { trigger });
      return { kind: "skipped-market-closed" };
    }

    this.isCycleRunning = true;
    this.lastRunStartedAt = now.toISOString();
    const cyclePromise = this.runCycleBody(trigger);
    // Never rejects — runCycleBody catches everything itself — so stop() can safely await this
    // without its own try/catch.
    this.activeCyclePromise = cyclePromise.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await cyclePromise;
    } finally {
      this.isCycleRunning = false;
      this.activeCyclePromise = null;
    }
  }

  private async runCycleBody(trigger: "scheduled" | "manual"): Promise<TradingCycleOutcome> {
    await this.recordAudit("TRADING_CYCLE_STARTED", { trigger });
    try {
      const { snapshot, context } = await buildMarketDecisionContext(
        this.deps.marketDataProvider,
        this.deps.broker,
        this.deps.instrument,
        this.deps.strategy,
      );
      const result = await runMarketDecisionCycleWithLifecycle({
        broker: this.deps.broker,
        auditTrail: this.deps.auditTrail,
        executionRunId: this.executionRunId ?? "trading-runtime-unstarted",
        marketContext: context,
        amount: this.deps.amount,
        portfolioRisk: {
          config: this.deps.portfolioRiskConfig,
          dailyTradeCount: this.deps.broker.getCompletedTrades().length,
          // The broker was already connected before this runtime was constructed (the CLI's own
          // responsibility, mirroring market-decide.ts's identical assumption) — true here reflects
          // that, not a fresh connectivity probe every cycle.
          brokerAvailable: true,
        },
        lifecycleService: this.deps.lifecycleService,
        marketDataSnapshot: snapshot,
      });

      this.successfulRunCount += 1;
      this.lastResult = {
        decision: result.decision.action,
        executed: result.executed,
        instrument: this.deps.instrument,
        lifecycleRecordId: result.lifecycleRecord?.id,
        lifecycleStatus: result.lifecycleRecord?.status,
      };
      this.lastRunCompletedAt = this.deps.clock.now().toISOString();
      await this.recordAudit("TRADING_CYCLE_COMPLETED", {
        decision: result.decision.action,
        executed: result.executed,
      });
      return { kind: "completed", result };
    } catch (error) {
      this.failedRunCount += 1;
      const message = toErrorMessage(error);
      this.lastError = { message, occurredAt: this.deps.clock.now().toISOString() };
      this.lastRunCompletedAt = this.deps.clock.now().toISOString();
      await this.recordAudit("TRADING_CYCLE_FAILED", { message });
      return { kind: "failed", error };
    }
  }

  private async recordAudit(eventType: AuditEventType, details: Record<string, unknown>): Promise<void> {
    await this.deps.auditTrail.record({
      timestamp: this.deps.clock.now().toISOString(),
      eventType,
      executionRunId: this.executionRunId ?? "trading-runtime-unstarted",
      instrument: this.deps.instrument,
      details,
    });
  }
}
