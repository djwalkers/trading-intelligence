import { logger } from "@/lib/logger/logger";
import { buildMarketDecisionContext } from "../build-market-decision-context";
import type { AuditTrail } from "../audit-trail";
import type { AuditEventType, InternalStrategy, OrderSizingMode } from "../types";
import type { BrokerProvider, ExecutionApprovalMode, MarketDataProviderType, RuntimeMode } from "../config";
import type { MarketDataProvider } from "../market-data/market-data-provider";
import { MarketDecisionEngine } from "../market-decision-engine";
import type { TradeLifecycleCycleResult } from "../trade-lifecycle/trade-lifecycle-runner";
import type { TradeLifecycleService } from "../trade-lifecycle/trade-lifecycle-service";
import type { PaperBroker } from "../paper-broker";
import type { PortfolioRiskConfig } from "../portfolio-risk-engine";
import type { MarketDataSnapshot } from "../market-data/market-data-provider";
import type { MarketDecisionContext } from "../market-decision-engine";
import { buildAnalysisRecord } from "../analysis/build-analysis-record";
import { categorizeAnalysisPersistenceError, type AnalysisRepository } from "../analysis/analysis-repository";
import {
  autoApproveTradeCandidate,
  createTradeCandidateForDecision,
  executeApprovedTradeCandidate,
  sweepExpiredCandidates,
} from "../trade-approval/trade-candidate-service";
import { checkForDuplicateEntry } from "../trade-approval/duplicate-prevention";
import { repairCandidateForConfirmedLifecycle } from "../trade-approval/candidate-lifecycle-repair";
import type { TradeCandidateRepository } from "../trade-approval/trade-candidate-repository";
import type { TradeLifecycleStore } from "../trade-lifecycle/trade-lifecycle-store";
import { recordTradePerformanceForExecutedCandidate } from "../trade-performance/trade-performance-service";
import type { TradePerformanceRepository } from "../trade-performance/trade-performance-repository";
import { reconcileBrokerPosition } from "./position-reconciliation";
import { recoverStaleLifecycleRecords } from "./lifecycle-recovery";
import { evaluateExitTrigger, executeAutomaticExit } from "./exit-monitor";
import type { SchedulerClock } from "./scheduler-clock";
import type { MarketHoursPolicy } from "./market-hours-policy";
import { TradingScheduler } from "./trading-scheduler";
import { assertValidRuntimeTransition, type TradingErrorSummary, type TradingRuntimeState, type TradingRuntimeStatus } from "./types";
import { loadEnabledStrategies } from "../strategy-loader";
import type { RegistryClient } from "../registry-client";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. AnalysisIntegrationDeps is
// entirely optional and additive: when `deps.analysis` is undefined (the default for every
// existing caller/test that predates this phase), TradingRuntime's behaviour is byte-for-byte
// identical to before this phase existed — no new timing, no new gating, nothing that can affect
// which decision gets made or whether execution happens. persistAnalysis() (below) is the only
// new code path, called strictly after a cycle's real work has already fully completed (success
// or failure), and it can never itself fail the cycle — see its own doc comment.
export interface AnalysisIntegrationDeps {
  repository: AnalysisRepository;
  runtimeMode: RuntimeMode;
  brokerProvider: BrokerProvider;
  marketProvider: MarketDataProviderType;
  timeframe: string;
}

// Milestone 7 — 24/7 Scheduler & Runtime Control. The one place "Scheduler tick -> Runtime
// controller -> runMarketDecisionCycleWithLifecycle() -> existing pipeline" (this milestone's own
// architectural diagram) is wired up. TradingRuntime owns the state machine, counters, and overlap/
// pause/market-hours gating; TradingScheduler (a plain internal collaborator, not touched here
// beyond construction) owns only "when does the next tick fire." Neither one reimplements anything
// from build-market-decision-context.ts, trade-lifecycle-runner.ts, or below — every pipeline call
// here is a call to an existing, unmodified function.

/**
 * Phase 3.5 — Trade Review & Approval. `result` on "completed" no longer nests a
 * MarketDecisionCycleResult (position/trade/broker order) — a cycle's own fresh decision never
 * calls the broker any more, it only ever creates a PENDING TradeCandidate (or nothing, for HOLD).
 * `executedCandidateIds` instead reports any PRIOR-approved candidates this cycle executed via the
 * broker (see runCycleBody, which does that before evaluating a new decision at all).
 */
export type TradingCycleOutcome =
  | {
      kind: "completed";
      result: { decision: ReturnType<typeof MarketDecisionEngine.evaluate>; candidateId: string | undefined; executedCandidateIds: string[] };
    }
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
  /** Broker Sizing Semantic Fix. How `amount` must be interpreted to get a notional value — NOT
   * optional, same "no silent default" convention `tradeCandidateRepository` below already
   * establishes: the caller (market-runtime.ts) sources this from
   * runtime-config/broker-capabilities.ts's own BROKER_CAPABILITIES[provider].orderSizingMode, this
   * runtime never infers it from `broker` itself. Frozen onto every TradeCandidate this runtime
   * creates (see runCycleBody's own createTradeCandidateForDecision call) and forwarded to
   * PortfolioRiskEngine for every candidate it later executes. */
  orderSizingMode: OrderSizingMode;
  /** Restart-Resilient Autonomy Phase. This broker's own provider name (e.g. "etoro-demo") —
   * frozen onto every TradeLifecycleRecord this runtime creates/adopts. */
  brokerProvider: string;
  portfolioRiskConfig: PortfolioRiskConfig;
  lifecycleService: TradeLifecycleService;
  /** Restart-Resilient Autonomy Phase. The SAME store instance `lifecycleService` was constructed
   * with, exposed directly here — required (not optional) since position-reconciliation.ts and
   * duplicate-prevention.ts both need direct, service-transition-bypassing access (adopting an
   * orphaned position inserts a record already at status OPEN, which TradeLifecycleService's own
   * API has no path for — see position-reconciliation.ts's own doc comment). Mirrors
   * RuntimeDependencies' own established "lifecycleStore alongside lifecycleService" precedent
   * (runtime-config/runtime-dependency-factory.ts). */
  lifecycleStore: TradeLifecycleStore;
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
  /** Phase 2B — Decision Intelligence: Historical Analysis Persistence. Undefined (the default)
   * means this feature is entirely off — see AnalysisIntegrationDeps's own doc comment above. */
  analysis?: AnalysisIntegrationDeps;
  /** Phase 3.5 — Trade Review & Approval. NOT optional, unlike `analysis` above: automatic
   * execution must remain off unconditionally (this phase's own explicit requirement), so there is
   * no "undefined means behave exactly as before" escape hatch here the way Phase 2B's analysis
   * persistence has one — every BUY/SELL decision this runtime ever makes becomes a TradeCandidate
   * in this repository, with no way to configure the runtime back into auto-executing. */
  tradeCandidateRepository: TradeCandidateRepository;
  /** How long a candidate stays valid before the next cycle's sweep marks it EXPIRED instead of
   * executing it — see trade-approval/config.ts's own TradeApprovalConfig.expiryMs. */
  tradeCandidateExpiryMs: number;
  /** Phase 4 — Trade Performance Engine. Optional and additive, same "undefined means behave
   * exactly as before this phase existed" convention `analysis` above uses — a missing/failed
   * performance measurement can never affect a cycle's own decision, risk, execution, or approval
   * outcome (see persistTradePerformance's own doc comment). The SAME TradeLifecycleStore instance
   * `lifecycleService` was constructed with — exposed directly here for read-only use, mirroring
   * RuntimeDependencies' own established "lifecycleStore alongside lifecycleService, for a concern
   * TradeLifecycleService itself doesn't expose a pass-through for" precedent (runtime-dependency-
   * factory.ts). Never written to by this runtime — only ever read from. */
  tradePerformance?: { lifecycleStore: TradeLifecycleStore; repository: TradePerformanceRepository };
  /** Restart-Resilient Autonomy Phase — Phase 5 (AUTO_DEMO). Defaults' worth of behaviour lives in
   * config.ts, not here — this runtime simply acts on whatever it's given, never re-deriving or
   * defaulting it itself. "MANUAL" preserves this runtime's pre-existing behaviour exactly (every
   * fresh BUY decision only ever creates a PENDING candidate). */
  approvalMode: ExecutionApprovalMode;
  /** Only consulted when approvalMode is "AUTO_DEMO". */
  autoDemoMinConfidence: number;
  /** Restart-Resilient Autonomy Phase — Phase 3 (emergency kill switch), hardened by a later safety
   * review: when true, every reconciled open position is closed on this cycle regardless of any
   * other exit condition, AND no exposure-increasing entry activity happens at all — no fresh BUY
   * candidate is created, no candidate is AUTO_DEMO auto-approved, and no previously-APPROVED BUY
   * candidate is executed (see runCycleBody's own doc comment for exactly where each of these three
   * gates lives). Risk-reducing exits and closing SELL actions are never blocked by this flag. */
  killSwitchEnabled: boolean;
  /** Restart-Resilient Autonomy Phase — Phase 3 (optional max-holding-duration exit trigger).
   * Undefined means "no ceiling configured" (this runtime's pre-existing behaviour: a position is
   * held indefinitely absent another exit trigger). */
  maxHoldingDurationMs?: number;
  /** Restart-Resilient Autonomy Phase — Phase 3 (strategy-disabled exit trigger). Optional: when
   * provided, re-checked fresh every cycle (never cached) to see whether `strategy` is still among
   * the currently enabled set — undefined skips this specific check entirely (treated as "still
   * enabled"), preserving every existing caller's behaviour that doesn't wire this up. */
  registryClient?: RegistryClient;
  /** Only consulted alongside `registryClient` above, mirroring HermesExecutionConfig's own
   * demoExecutionModeEnabled semantics for the SAME strategy-loading call. */
  demoExecutionModeEnabled?: boolean;
  /** Restart-Resilient Autonomy Phase — crash-window recovery (deployment safety review). How long
   * (ms), measured from a lifecycle record's own updatedAt, it may sit at DECISION_CREATED/
   * APPROVED/EXECUTION_SUBMITTED/EXECUTION_RECONCILIATION_REQUIRED before the recovery sweep
   * (runtime/lifecycle-recovery.ts, run at the top of every cycle — see runCycleBody) acts on it.
   * See config.ts's own HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS for the production default. */
  recoveryThresholdMs: number;
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

  /**
   * Restart-Resilient Autonomy Phase, reordered by a later safety review (the original sequence ran
   * approved-candidate execution BEFORE reconciliation, which meant a BUY candidate approved before
   * a restart could re-execute before this cycle ever asked the broker whether a position already
   * existed — see position-reconciliation.ts's own top-of-file comment for the restart scenario
   * this closes). Every cycle now does, in this order:
   *
   * 0. Recover (crash-window recovery, deployment safety review): before reconciliation even runs,
   *    sweep any DECISION_CREATED/APPROVED/EXECUTION_SUBMITTED/EXECUTION_RECONCILIATION_REQUIRED
   *    lifecycle record left behind by a crash mid-execution — see runtime/lifecycle-recovery.ts's
   *    own top-of-file comment for exactly why this cannot be deferred to reconciliation itself.
   *    Runs on the very first cycle after a restart too — there is no separate "startup-only" path.
   * 1. Reconcile (Phase 1): ask the broker's own live portfolio, never trust its in-memory
   *    trackedPositions map alone, for whether the configured instrument already has an open
   *    position. `currentPositionOpen`/`currentRecord` below are this cycle's own single, mutable
   *    view of that truth — updated in place as exits/approved-candidate execution act on it, so
   *    every later step in the SAME cycle sees the latest state without a second broker round-trip.
   *    Immediately after a successful reconciliation, repair any TradeCandidate whose own status
   *    fell out of sync with a now-confirmed-OPEN lifecycle record (candidate-lifecycle-repair.ts) —
   *    never calls the broker, never re-runs risk checks.
   * 2. Fail closed: any broker/ambiguity/duplicate-record failure from step 1 skips every remaining
   *    step this cycle entirely (already-approved execution work is simply retried next cycle).
   * 3. Evaluate the fresh decision once (buildMarketDecisionContext + MarketDecisionEngine.evaluate)
   *    — needed immediately below for automatic-exit's own opposing-signal check, and reused again
   *    later for new-entry gating; never recomputed a second time mid-cycle.
   * 4. Automatic exit (Phase 3): if reconciliation shows an open position, evaluate stop-loss/
   *    take-profit/opposing-signal/strategy-disabled/max-holding/kill-switch against FRESH data and
   *    close immediately if triggered — never gated behind human approval, regardless of
   *    approvalMode (closing is always a risk-reduction action, never blocked by the kill switch).
   * 5. Execute previously-approved candidates (via the existing, unmodified
   *    executeApprovedTradeCandidate): a SELL/close candidate always proceeds (risk reduction); a
   *    BUY candidate only proceeds when `currentPositionOpen` is false AND killSwitchEnabled is
   *    false — otherwise it is deliberately left APPROVED, untouched, for a later cycle (see
   *    KILL_SWITCH_ENTRY_BLOCKED/APPROVED_CANDIDATE_EXECUTION_DEFERRED below).
   * 6. Decide-and-propose: only when `currentPositionOpen` is false and the kill switch is off, a
   *    fresh BUY decision is turned into a new PENDING TradeCandidate unless an equivalent one
   *    already exists (Phase 6), then auto-approved immediately when approvalMode is AUTO_DEMO and
   *    confidence clears the configured threshold (Phase 5) — through the EXACT SAME approve/
   *    execute path a human uses, never a shortcut around risk/portfolio/audit stages. Gating
   *    candidate creation itself behind the kill switch transitively blocks auto-approval too — a
   *    candidate that is never created can never be auto-approved.
   */
  private async runCycleBody(trigger: "scheduled" | "manual"): Promise<TradingCycleOutcome> {
    await this.recordAudit("TRADING_CYCLE_STARTED", { trigger });
    const cycleStartedAtMs = this.deps.clock.now().getTime();
    const executionRunId = this.executionRunId ?? "trading-runtime-unstarted";
    try {
      const now = this.deps.clock.now();

      // Restart-Resilient Autonomy Phase — crash-window recovery (deployment safety review).
      // Strictly before reconciliation: a stale pre-OPEN record left by a crash must be resolved
      // (abandoned, correlated to a real position, or flagged ambiguous) before reconciliation's own
      // duplicate/orphan-adoption checks ever run against it — see lifecycle-recovery.ts's own
      // top-of-file comment.
      await recoverStaleLifecycleRecords({
        broker: this.deps.broker,
        instrument: this.deps.instrument,
        strategy: this.deps.strategy,
        brokerProvider: this.deps.brokerProvider,
        lifecycleStore: this.deps.lifecycleStore,
        tradeCandidateRepository: this.deps.tradeCandidateRepository,
        auditTrail: this.deps.auditTrail,
        executionRunId,
        now,
        recoveryThresholdMs: this.deps.recoveryThresholdMs,
      });

      // Restart-Resilient Autonomy Phase — Phase 1, reordered ahead of approved-candidate
      // execution. THE truth this cycle uses for whether the configured instrument already has an
      // open position — never buildMarketDecisionContext's own broker.getOpenPositions()-derived
      // positionOpen alone (see position-reconciliation.ts's own top-of-file comment for why that
      // can be wrong after a restart).
      const reconciliation = await reconcileBrokerPosition({
        broker: this.deps.broker,
        instrument: this.deps.instrument,
        strategy: this.deps.strategy,
        brokerProvider: this.deps.brokerProvider,
        sizingMode: this.deps.orderSizingMode,
        lifecycleStore: this.deps.lifecycleStore,
        tradeCandidateRepository: this.deps.tradeCandidateRepository,
        auditTrail: this.deps.auditTrail,
        executionRunId,
        now,
      });

      if (!reconciliation.ok) {
        // Fail closed: BROKER_RECONCILIATION_FAILED (or a more specific reconciliation-failure
        // event) was already emitted by reconcileBrokerPosition itself. Nothing else this cycle —
        // not exits, not approved-candidate execution, not a fresh entry — is safe to evaluate
        // without knowing the broker's own true state.
        await sweepExpiredCandidates({
          repository: this.deps.tradeCandidateRepository,
          auditTrail: this.deps.auditTrail,
          executionRunId,
          strategyId: this.deps.strategy.strategyId,
          instrument: this.deps.instrument,
          now,
        });
        this.successfulRunCount += 1;
        this.lastResult = {
          decision: "HOLD",
          candidateCreated: false,
          instrument: this.deps.instrument,
          executedCandidateIds: [],
          reconciliationFailed: true,
        };
        this.lastRunCompletedAt = this.deps.clock.now().toISOString();
        await this.recordAudit("TRADING_CYCLE_COMPLETED", {
          decision: "HOLD",
          candidateCreated: false,
          executedCandidateIds: [],
          reconciliationFailed: true,
          reason: reconciliation.reason,
        });
        return {
          kind: "completed",
          result: {
            decision: { action: "HOLD", confidence: 0, reasoning: [reconciliation.reason] },
            candidateId: undefined,
            executedCandidateIds: [],
          },
        };
      }

      // This cycle's own single, mutable view of "is a broker position (or an unresolved local
      // record standing in for one) currently active" — seeded from reconciliation, then kept
      // current as exits/approved-candidate execution act on it below, so every later gate in this
      // same cycle sees the latest state without re-querying the broker.
      let currentPositionOpen = reconciliation.positionOpen;
      let currentRecord = reconciliation.record;

      // Restart-Resilient Autonomy Phase — candidate/lifecycle repair (deployment safety review).
      // Whenever reconciliation confirms an OPEN record (a fresh match, a CLOSE_FAILED retry-reopen,
      // or a record the recovery sweep above just correlated), repair its own originating
      // TradeCandidate if it fell out of sync (still APPROVED, or FAILED despite a confirmed
      // position) — see candidate-lifecycle-repair.ts's own doc comment. A no-op when `currentRecord`
      // has no candidateId (an orphan-adopted position) or its candidate is already consistent.
      if (currentRecord) {
        await repairCandidateForConfirmedLifecycle({
          lifecycleRecord: currentRecord,
          tradeCandidateRepository: this.deps.tradeCandidateRepository,
          auditTrail: this.deps.auditTrail,
          executionRunId,
          now,
        });
      }

      await sweepExpiredCandidates({
        repository: this.deps.tradeCandidateRepository,
        auditTrail: this.deps.auditTrail,
        executionRunId,
        strategyId: this.deps.strategy.strategyId,
        instrument: this.deps.instrument,
        now,
      });

      const { snapshot, context: rawContext } = await buildMarketDecisionContext(
        this.deps.marketDataProvider,
        this.deps.broker,
        this.deps.instrument,
        this.deps.strategy,
      );
      // Overrides buildMarketDecisionContext's own broker.getOpenPositions()-derived positionOpen —
      // reconciliation.positionOpen is the only value this runtime trusts (see above).
      const context: MarketDecisionContext = { ...rawContext, positionOpen: currentPositionOpen };
      const decision = MarketDecisionEngine.evaluate(context);

      // Phase 2B — Decision Intelligence: Historical Analysis Persistence. Unconditional, exactly
      // as before this phase — best-effort/never-throws (see persistAnalysis's own doc comment).
      const analysisRunId = await this.persistAnalysis({
        kind: "success",
        trigger,
        snapshot,
        context,
        result: { decision, executed: false } as TradeLifecycleCycleResult,
        runtimeDurationMs: this.deps.clock.now().getTime() - cycleStartedAtMs,
      });

      let exitTrigger: string | undefined;
      let exitClosed: boolean | undefined;

      if (currentPositionOpen && currentRecord) {
        // Restart-Resilient Autonomy Phase — Phase 3. Automatic exits never require human approval
        // in demo mode — closing an already-open position is always a risk-reduction action, never
        // gated by the kill switch (which forces this trigger, never blocks it).
        const strategyStillEnabled = await this.isStrategyStillEnabled(executionRunId);
        const trigger2 = evaluateExitTrigger({
          record: currentRecord,
          freshBid: context.bid,
          freshDecision: decision,
          killSwitchEnabled: this.deps.killSwitchEnabled,
          maxHoldingDurationMs: this.deps.maxHoldingDurationMs,
          strategyStillEnabled,
          now,
        });

        if (trigger2) {
          exitTrigger = trigger2;
          const exitResult = await executeAutomaticExit({
            broker: this.deps.broker,
            record: currentRecord,
            trigger: trigger2,
            lifecycleService: this.deps.lifecycleService,
            auditTrail: this.deps.auditTrail,
            executionRunId,
            now,
          });
          exitClosed = exitResult.closed;
          if (exitClosed) {
            currentPositionOpen = false;
            currentRecord = undefined;
          }
        }
      }

      // Restart-Resilient Autonomy Phase — reordered ahead of a fresh decision's own entry gating
      // (see this method's own top-of-file comment for why this now runs after reconciliation/exits
      // rather than before them). A SELL/close candidate always proceeds — closing is always a
      // risk-reduction action. A BUY candidate proceeds only when no broker position or unresolved
      // lifecycle is currently active AND the kill switch is off; otherwise it is deliberately left
      // APPROVED, untouched, to be reconsidered next cycle.
      const approvedCandidates = await this.deps.tradeCandidateRepository.list({
        status: "APPROVED",
        strategyId: this.deps.strategy.strategyId,
        instrument: this.deps.instrument,
      });
      const executedCandidateIds: string[] = [];
      for (const candidate of approvedCandidates) {
        if (candidate.direction === "BUY") {
          if (this.deps.killSwitchEnabled) {
            await this.recordAudit("KILL_SWITCH_ENTRY_BLOCKED", {
              context: "approved-candidate-execution",
              candidateId: candidate.id,
            });
            continue;
          }
          if (currentPositionOpen) {
            await this.recordAudit("APPROVED_CANDIDATE_EXECUTION_DEFERRED", {
              candidateId: candidate.id,
              reason: "A broker position or unresolved lifecycle record is already active for this strategy+instrument.",
            });
            continue;
          }
        }

        const outcome = await executeApprovedTradeCandidate({
          repository: this.deps.tradeCandidateRepository,
          broker: this.deps.broker,
          auditTrail: this.deps.auditTrail,
          executionRunId,
          lifecycleService: this.deps.lifecycleService,
          portfolioRisk: {
            config: this.deps.portfolioRiskConfig,
            dailyTradeCount: this.deps.broker.getCompletedTrades().length,
            // The broker was already connected before this runtime was constructed (the CLI's own
            // responsibility, mirroring market-decide.ts's identical assumption) — true here
            // reflects that, not a fresh connectivity probe every cycle.
            brokerAvailable: true,
          },
          candidate,
          now,
          brokerProvider: this.deps.brokerProvider,
        });
        if (outcome.outcome === "executed") {
          executedCandidateIds.push(candidate.id);
          // Keep this cycle's own position-state view current for any later iteration/step.
          if (candidate.direction === "BUY") {
            currentPositionOpen = true;
          } else {
            currentPositionOpen = false;
            currentRecord = undefined;
          }
        }
      }

      // Phase 4 — Trade Performance Engine. Strictly after execution work above has already fully
      // completed — read-only against TradeCandidateRepository/TradeLifecycleStore (never writes
      // to either), can never change which candidates were executed or how, and can never fail
      // this cycle (see persistTradePerformance's own doc comment).
      for (const candidateId of executedCandidateIds) {
        await this.persistTradePerformance(candidateId);
      }

      let candidate: Awaited<ReturnType<typeof createTradeCandidateForDecision>>;
      let duplicateEntrySuppressed = false;
      let autoApproved = false;

      // Fresh entries are only ever considered when no position/unresolved lifecycle is currently
      // active AND the kill switch is off — even immediately after an exit fired above, this same
      // cycle never opens a new one; the NEXT cycle's own reconciliation will correctly see the
      // position closed and permit an entry then.
      if (decision.action === "BUY" && !currentPositionOpen) {
        if (this.deps.killSwitchEnabled) {
          await this.recordAudit("KILL_SWITCH_ENTRY_BLOCKED", { context: "fresh-candidate-creation" });
        } else {
          const duplicateCheck = await checkForDuplicateEntry({
            tradeCandidateRepository: this.deps.tradeCandidateRepository,
            lifecycleStore: this.deps.lifecycleStore,
            strategyId: this.deps.strategy.strategyId,
            instrument: this.deps.instrument,
          });

          if (duplicateCheck.duplicate) {
            duplicateEntrySuppressed = true;
            await this.recordAudit("DUPLICATE_ENTRY_SUPPRESSED", { reason: duplicateCheck.reason });
          } else {
            candidate = await createTradeCandidateForDecision({
              repository: this.deps.tradeCandidateRepository,
              auditTrail: this.deps.auditTrail,
              executionRunId,
              decision,
              context,
              marketDataSnapshot: snapshot,
              amount: this.deps.amount,
              sizingMode: this.deps.orderSizingMode,
              analysisRunId,
              now,
              expiryMs: this.deps.tradeCandidateExpiryMs,
            });

            // Restart-Resilient Autonomy Phase — Phase 5 (AUTO_DEMO). The candidate is ALREADY
            // durably persisted as PENDING above before this ever runs — never the other way
            // around. Never reached while the kill switch is on: the outer guard above already
            // skips candidate creation entirely in that case, which transitively blocks
            // auto-approval too (a candidate that was never created can never be auto-approved).
            if (candidate && this.deps.approvalMode === "AUTO_DEMO" && candidate.confidence >= this.deps.autoDemoMinConfidence) {
              const approvalOutcome = await autoApproveTradeCandidate({
                repository: this.deps.tradeCandidateRepository,
                auditTrail: this.deps.auditTrail,
                executionRunId,
                candidateId: candidate.id,
                now,
              });
              autoApproved = approvalOutcome.outcome === "approved";
            }
          }
        }
      } else if (decision.action === "SELL" && currentPositionOpen) {
        // Restart-Resilient Autonomy Phase — fallback preserving pre-existing behaviour for any
        // broker/record combination Phase 3's automatic exit monitor could not act on this cycle:
        // no reconciled TradeLifecycleRecord was available to evaluate at all (every broker besides
        // eToro today — LocalPaperBroker/Trading212/Hyperliquid, and any test double built only
        // against the plain PaperBroker interface), or an automatic close was attempted and failed
        // (`exitClosed === false`, a fallback safety net for human review rather than leaving the
        // position silently unmanaged). Never reached once nothing is left open (an automatic exit
        // or an approved-candidate SELL already closed it this same cycle) — no candidate is
        // created for a position that no longer exists.
        candidate = await createTradeCandidateForDecision({
          repository: this.deps.tradeCandidateRepository,
          auditTrail: this.deps.auditTrail,
          executionRunId,
          decision,
          context,
          marketDataSnapshot: snapshot,
          amount: this.deps.amount,
          sizingMode: this.deps.orderSizingMode,
          analysisRunId,
          now,
          expiryMs: this.deps.tradeCandidateExpiryMs,
        });
      }

      this.successfulRunCount += 1;
      this.lastResult = {
        decision: decision.action,
        candidateCreated: candidate !== undefined,
        candidateId: candidate?.id,
        instrument: this.deps.instrument,
        executedCandidateIds,
        positionOpen: currentPositionOpen,
        exitTrigger,
        exitClosed,
        duplicateEntrySuppressed,
        autoApproved,
      };
      this.lastRunCompletedAt = this.deps.clock.now().toISOString();
      await this.recordAudit("TRADING_CYCLE_COMPLETED", {
        decision: decision.action,
        candidateCreated: candidate !== undefined,
        executedCandidateIds,
        positionOpen: currentPositionOpen,
        exitTrigger,
        exitClosed,
        duplicateEntrySuppressed,
        autoApproved,
      });

      return {
        kind: "completed",
        result: { decision, candidateId: candidate?.id, executedCandidateIds },
      };
    } catch (error) {
      this.failedRunCount += 1;
      const message = toErrorMessage(error);
      this.lastError = { message, occurredAt: this.deps.clock.now().toISOString() };
      this.lastRunCompletedAt = this.deps.clock.now().toISOString();
      await this.recordAudit("TRADING_CYCLE_FAILED", { message });

      await this.persistAnalysis({
        kind: "failure",
        trigger,
        error,
        runtimeDurationMs: this.deps.clock.now().getTime() - cycleStartedAtMs,
      });

      return { kind: "failed", error };
    }
  }

  /**
   * Phase 2B — Decision Intelligence: Historical Analysis Persistence. The runtime ATTEMPTS
   * exactly one persistence operation (one saveAnalysis() + one saveEvents() batch) per cycle —
   * this is best-effort, not a guarantee: builds one AnalysisRunInput (+ timeline events) via the
   * pure, side-effect-free buildAnalysisRecord (never re-evaluates or second-guesses the
   * decision), then writes it through AnalysisRepository. Never throws — a Supabase outage, RLS
   * misconfiguration, or any other persistence failure is logged (see the structured fields below)
   * and swallowed here, exactly like JsonFileAuditTrail.persist()'s own established "catch
   * internally, log, never propagate" discipline, so a broken analysis-persistence layer can never
   * crash, block, or alter a single trading cycle's decision or execution outcome. The direct
   * consequence, stated plainly: a database outage during this window means that cycle's analysis
   * record may simply be MISSING from market_analysis_runs — a gap in the history, not a corrupted
   * or delayed one. There is no durable retry queue in this phase; a failed write is not retried,
   * queued, or replayed later (see docs/decision-intelligence-architecture-phase-2b.md's own
   * "Persistence guarantees & limitations" section). A no-op entirely when `deps.analysis` is
   * undefined (the default).
   *
   * Phase 3.5 — now returns the new row's id (or undefined whenever nothing was written, for any
   * reason) so runCycleBody can pass it through as TradeCandidate.analysisRunId — a best-effort
   * cross-reference only; see trade-approval/types.ts's own doc comment on why a candidate's
   * durability never depends on this succeeding.
   */
  /**
   * Restart-Resilient Autonomy Phase — Phase 3 (strategy-disabled exit trigger). A fresh re-check
   * against the strategy registry every cycle (never cached from startup) — `this.deps.strategy`
   * itself is captured once, at construction, and never mutated, so relying on its own `.enabled`
   * field alone would never notice a strategy disabled mid-run. A no-op (returns true) when
   * `registryClient` isn't configured — every existing caller that doesn't wire this up keeps its
   * exact current behaviour. A registry read failure fails OPEN for this specific check only
   * (conservatively assumes still-enabled) rather than force-closing a position on a transient
   * local filesystem error — every other exit trigger (stop-loss, take-profit, kill switch) remains
   * fully active regardless.
   */
  private async isStrategyStillEnabled(executionRunId: string): Promise<boolean> {
    if (!this.deps.registryClient) return true;
    try {
      const summary = await loadEnabledStrategies({
        registryClient: this.deps.registryClient,
        demoExecutionModeEnabled: this.deps.demoExecutionModeEnabled ?? false,
        executionRunId,
      });
      return summary.strategies.some((s) => s.strategyId === this.deps.strategy.strategyId);
    } catch (error) {
      logger.error("Failed to re-check strategy enablement during exit monitoring — assuming still enabled", {
        component: "hermes-execution",
        strategyId: this.deps.strategy.strategyId,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  private async persistAnalysis(
    outcome:
      | {
          kind: "success";
          trigger: "scheduled" | "manual";
          snapshot: MarketDataSnapshot;
          context: MarketDecisionContext;
          result: TradeLifecycleCycleResult;
          runtimeDurationMs: number;
        }
      | { kind: "failure"; trigger: "scheduled" | "manual"; error: unknown; runtimeDurationMs: number },
  ): Promise<string | undefined> {
    const analysis = this.deps.analysis;
    if (!analysis) return undefined;

    try {
      const { run, events } =
        outcome.kind === "success"
          ? buildAnalysisRecord({
              kind: "success",
              trigger: outcome.trigger,
              runtimeMode: analysis.runtimeMode,
              brokerProvider: analysis.brokerProvider,
              marketProvider: analysis.marketProvider,
              timeframe: analysis.timeframe,
              strategyId: this.deps.strategy.strategyId,
              strategyVersion: this.deps.strategy.version,
              instrument: this.deps.instrument,
              snapshot: outcome.snapshot,
              context: outcome.context,
              result: outcome.result,
              runtimeDurationMs: outcome.runtimeDurationMs,
            })
          : buildAnalysisRecord({
              kind: "failure",
              trigger: outcome.trigger,
              runtimeMode: analysis.runtimeMode,
              brokerProvider: analysis.brokerProvider,
              marketProvider: analysis.marketProvider,
              timeframe: analysis.timeframe,
              strategyId: this.deps.strategy.strategyId,
              strategyVersion: this.deps.strategy.version,
              instrument: this.deps.instrument,
              error: outcome.error,
              runtimeDurationMs: outcome.runtimeDurationMs,
            });

      const analysisRunId = await analysis.repository.saveAnalysis(run);
      await analysis.repository.saveEvents(analysisRunId, events);
      return analysisRunId;
    } catch (error) {
      // Structured, credential-safe: executionRunId (the cycle id), instrument, strategyId, a
      // short errorCategory (never the raw Supabase error object/.details/.hint — see
      // categorizeAnalysisPersistenceError's own doc comment), and persistenceEnabled so a log
      // reader never has to guess whether this feature was even on. Never includes Supabase keys,
      // tokens, headers, or a full database response — only `.message` and a short category code.
      logger.error("Failed to persist market analysis record — the trading cycle's own decision/execution outcome was unaffected", {
        component: "hermes-analysis-persistence",
        executionRunId: this.executionRunId ?? "trading-runtime-unstarted",
        instrument: this.deps.instrument,
        strategyId: this.deps.strategy.strategyId,
        errorCategory: categorizeAnalysisPersistenceError(error),
        persistenceEnabled: true,
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Phase 4 — Trade Performance Engine. ATTEMPTS to measure one executed candidate — a no-op
   * (returns immediately) when `deps.tradePerformance` is undefined (the default), or when
   * `candidateId` did not represent a closing (SELL) execution with a resolvable CLOSED lifecycle
   * record (recordTradePerformanceForExecutedCandidate's own, expected "nothing to record" case,
   * not an error). Never throws: any genuine failure (a Supabase outage, an unresolvable opening
   * candidate, ...) is logged and swallowed here, the same "catch internally, log, never propagate"
   * discipline persistAnalysis above already established — a broken performance-measurement layer
   * can never crash, block, or alter a single trading cycle's own decision, risk, execution, or
   * approval outcome. Only ever calls existing, unmodified read methods on TradeCandidateRepository
   * (getById/list) and TradeLifecycleStore (getById) — never writes to either.
   */
  private async persistTradePerformance(candidateId: string): Promise<void> {
    const tradePerformance = this.deps.tradePerformance;
    if (!tradePerformance) return;

    try {
      await recordTradePerformanceForExecutedCandidate({
        candidateRepository: this.deps.tradeCandidateRepository,
        lifecycleStore: tradePerformance.lifecycleStore,
        performanceRepository: tradePerformance.repository,
        candidateId,
      });
    } catch (error) {
      logger.error("Failed to record trade performance — the trading cycle's own execution outcome was unaffected", {
        component: "hermes-trade-performance",
        executionRunId: this.executionRunId ?? "trading-runtime-unstarted",
        instrument: this.deps.instrument,
        strategyId: this.deps.strategy.strategyId,
        candidateId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Restart-Resilient Autonomy Phase — audit-durability hardening. JsonFileAuditTrail.record() can
   * now throw on a genuine persistence failure (write failures must be observable — see that
   * class's own doc comment) — deliberately caught and logged here, never left to propagate,
   * because runCycleBody/attemptCycle's own documented contract ("runCycleBody never rejects" — see
   * activeCyclePromise's own comment) depends on routine audit calls never crashing the scheduler
   * loop. This is a DIFFERENT discipline from autoApproveTradeCandidate's own handling of its
   * TRADE_CANDIDATE_AUTO_APPROVED write specifically: that one write is safety-critical enough that
   * a durability failure must abort the approval (see that function's own doc comment) — every other
   * audit event in this runtime is best-effort, matching persistAnalysis/persistTradePerformance's
   * own "never propagate" convention.
   */
  private async recordAudit(eventType: AuditEventType, details: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.auditTrail.record({
        timestamp: this.deps.clock.now().toISOString(),
        eventType,
        executionRunId: this.executionRunId ?? "trading-runtime-unstarted",
        instrument: this.deps.instrument,
        details,
      });
    } catch (error) {
      logger.error("Failed to persist a trading-runtime audit event — the cycle's own outcome was unaffected", {
        component: "hermes-execution",
        executionRunId: this.executionRunId ?? "trading-runtime-unstarted",
        instrument: this.deps.instrument,
        eventType,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
