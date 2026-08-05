import { logger } from "@/lib/logger/logger";
import { buildMarketDecisionContext } from "../build-market-decision-context";
import type { AuditTrail } from "../audit-trail";
import type { AuditEventType, InternalStrategy, OrderSizingMode } from "../types";
import type { BrokerProvider, ExecutionApprovalMode, MarketDataProviderType, RuntimeMode } from "../config";
import { MarketDataProviderError, type MarketDataFailureDetail, type MarketDataProvider } from "../market-data/market-data-provider";
import { MarketDecisionEngine, type MarketDecision } from "../market-decision-engine";
import type { TradeLifecycleCycleResult } from "../trade-lifecycle/trade-lifecycle-runner";
import type { TradeLifecycleService } from "../trade-lifecycle/trade-lifecycle-service";
import { utcDayBoundaries } from "../trade-lifecycle/confirmed-entry-count";
import type { TradeLifecycleRecord } from "../trade-lifecycle/types";
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
import { evaluateExitTrigger, executeAutomaticExit, hasRateFetching } from "./exit-monitor";
import { OpposingSignalStabilityTracker } from "./opposing-signal-stability";
import { MarketDataIncidentTracker, type CanonicalIncidentReason, type InstrumentObservation } from "./market-data-incident-tracker";
import type { SchedulerClock } from "./scheduler-clock";
import type { MarketHoursPolicy } from "./market-hours-policy";
import { TradingScheduler } from "./trading-scheduler";
import { assertValidRuntimeTransition, type TradingErrorSummary, type TradingRuntimeState, type TradingRuntimeStatus } from "./types";
import { loadEnabledStrategies } from "../strategy-loader";
import type { RegistryClient } from "../registry-client";
import { runUniverseScan } from "./universe-scanner";
import type { HermesAgentAdapterConfig } from "../hermes-agent/hermes-agent-adapter";
import type { HermesCliRunner } from "../hermes-agent/hermes-cli-runner";
import type { HermesAgentStrategy } from "../hermes-agent/hermes-agent-strategy";
import type { TradingCycleResultSummary } from "./types";
import type { DailyAccountSummaryService } from "../telegram/daily-account-summary-service";

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
      result: {
        decision: Awaited<ReturnType<typeof MarketDecisionEngine.evaluate>>;
        candidateId: string | undefined;
        executedCandidateIds: string[];
      };
    }
  | { kind: "failed"; error: unknown }
  | { kind: "skipped-paused" }
  | { kind: "skipped-overlap" }
  | { kind: "skipped-market-closed" };

/** Prototype 1.0 — official Hermes Agent decision integration. runInstrumentCycle's own return
 * shape — `summary` is exactly what becomes (part of) `lastResult`/the per-instrument audit
 * details; `decision` is the full MarketDecision object callers of runNow()/attemptCycle() see via
 * TradingCycleOutcome's own "completed.result.decision". `reconciliationFailureReason` is set only
 * on the reconciliation-failure path — mirrors the pre-refactor code's own inline audit-only
 * `reason` field (present in the TRADING_CYCLE_COMPLETED audit event, deliberately never part of
 * `lastResult` itself — preserved exactly, including that asymmetry). */
interface InstrumentCycleOutcome {
  summary: TradingCycleResultSummary;
  decision: Awaited<ReturnType<typeof MarketDecisionEngine.evaluate>>;
  reconciliationFailureReason?: string;
}

/** Prototype 1.0 — runtime ordering hardening. The narrow, NEVER-persisted per-instrument state
 * threaded from runInstrumentPhaseA to runInstrumentPhaseB — exists only for the lifetime of a
 * single runCycleBody call, one instance per instrument, held in a plain local Record (never a
 * class field, never written to any repository). `context`/`snapshot` are Phase A's own
 * already-fetched market data, reused as-is in Phase B rather than re-fetched a second time. */
interface InstrumentCycleState {
  instrument: string;
  /** false only when Phase A itself failed for this instrument (a thrown error, or a reconciliation
   * result reporting `ok: false`) — Phase B then skips all real processing and reproduces the exact
   * pre-split reconciliation-failure outcome shape, never touching the broker or a candidate. */
  safeToContinue: boolean;
  reconciliationFailureReason?: string;
  currentPositionOpen: boolean;
  currentRecord: TradeLifecycleRecord | undefined;
  context: MarketDecisionContext | undefined;
  snapshot: MarketDataSnapshot | undefined;
  /** Set only when Phase A itself closed this position (kill switch/stop-loss/take-profit/
   * strategy-disabled/max-holding) — carried through so Phase B's own summary still reports it even
   * though Phase B's own opposing-signal check never runs once the position is already gone. */
  phaseAExitTrigger?: string;
  phaseAExitClosed?: boolean;
  /** Candle-gap production incident fix. Set only when `buildMarketDecisionContext()` itself threw
   * this cycle (e.g. invalid/gapped historical candle history) — `context`/`snapshot` are then
   * undefined and `safeToContinue` remains true regardless (this is deliberately NOT the same
   * failure class as a reconciliation failure — the broker position itself is still trusted; only
   * fresh, candle-based analysis is unavailable). Phase B uses this to skip
   * MarketDecisionEngine.evaluate(), the OPPOSING_SIGNAL re-check, approved-candidate execution,
   * and fresh candidate creation for this instrument this cycle — never silently proceeding with a
   * stale or fabricated context. */
  marketDataUnavailableReason?: string;
  /** Repeated-Telegram-alert fix. The structured MarketDataFailureDetail carried on the
   * MarketDataProviderError caught above, when there is one — undefined for a plain Error (e.g.
   * throwingProvider()-style test doubles, or a MarketDataProvider that doesn't populate it) or
   * whenever marketDataUnavailableReason itself is undefined. This is the ONLY thing
   * recordMarketDataIncidentState fingerprints on; the free-text marketDataUnavailableReason above
   * is never parsed for identity, only ever shown to a human. */
  marketDataFailureDetail?: MarketDataFailureDetail;
  /** Candle-gap production incident fix. Which Hermes-independent exit-protection checks
   * (KILL_SWITCH/STOP_LOSS/TAKE_PROFIT/STRATEGY_DISABLED/MAX_HOLDING_DURATION) were actually
   * evaluated this cycle using an independently-fetched live quote — populated even when
   * `marketDataUnavailableReason` is set, since these checks never depend on candle history at
   * all. Empty when no position was open (nothing to protect). */
  protectionChecksRun: string[];
  /** Candle-gap production incident fix. Which protection checks were genuinely unavailable this
   * cycle and why — e.g. OPPOSING_SIGNAL requires a full, candle-based decision and is reported
   * here (never silently treated as "no opposing signal") whenever candle history is invalid. */
  protectionChecksSkipped: string[];
}

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
  /** Hardening pass — opposing-signal exit stability. Minimum time (ms) a position must have been
   * held before an OPPOSING_SIGNAL exit is even considered — stop-loss/take-profit/kill-switch/
   * strategy-disabled/max-holding are NEVER gated by this (see runtime/opposing-signal-stability.ts
   * and runInstrumentPhaseB's own doc comment). Undefined defaults to 5 minutes, matching config.ts's
   * own default — every existing caller/test that predates this hardening pass keeps that default
   * without needing to be updated. */
  opposingExitMinHoldMs?: number;
  /** Hardening pass — opposing-signal exit stability. How many CONSECUTIVE cycles the raw
   * OPPOSING_SIGNAL trigger must fire before the exit is allowed, once the minimum hold period has
   * also elapsed. Undefined defaults to 2, matching config.ts's own default. */
  opposingExitRequiredConfirmations?: number;
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
  /** Prototype 1.0 — official Hermes Agent decision integration. When set, every instrument here
   * receives the complete existing per-cycle lifecycle sequence (recovery, reconciliation,
   * candidate repair, exit monitoring — stop-loss/take-profit/opposing-signal/max-holding/
   * strategy-disabled/kill-switch — approved-candidate execution, duplicate suppression, and fresh
   * candidate handling), looped once per instrument by runInstrumentCycle. Defaults to
   * `[instrument]` when omitted, which preserves every existing single-instrument caller's
   * behaviour byte-for-byte (the loop simply runs once, for `instrument`). When both are set,
   * `instrument` should equal `instruments[0]` — it remains the value shown on cycle-level (not
   * per-instrument) audit events, and is the "primary" instrument `lastResult`'s own top-level
   * fields describe. */
  instruments?: string[];
  /** Prototype 1.0 — official Hermes Agent decision integration. When set, runCycleBody calls the
   * Hermes-backed universe scanner exactly ONCE per cycle, before the per-instrument loop — never
   * once per instrument (see runtime/universe-scanner.ts). Omitted entirely (the default) means no
   * Hermes call ever happens and every instrument's own MarketDecisionEngine.evaluate() runs
   * exactly as it always has (e.g. DEMO-0001's own deterministic ruleset, completely unaffected). */
  universeScan?: TradingRuntimeUniverseScanDeps;
  /** Telegram alert refinement — requirement 3 (daily account summary). Optional and additive,
   * same "undefined means behave exactly as before this feature existed" convention `analysis`
   * above uses — undefined (whenever gateway alerts are disabled) means this runtime never checks
   * or sends anything, byte-for-byte the same as before this feature existed. Checked once per
   * cycle (see runCycleBody's own call site), never per instrument — this concern is account-wide,
   * not per-instrument. */
  dailyAccountSummary?: DailyAccountSummaryService;
  /** Repeated-Telegram-alert fix. Consecutive HEALTHY validation cycles required before an ACTIVE
   * market-data incident is declared RECOVERED — see market-data-incident-tracker.ts's own
   * DEFAULT_MARKET_DATA_INCIDENT_RECOVERY_THRESHOLD (2). Opening an incident always remains
   * immediate regardless of this value; it only ever gates the RECOVERED transition, so a single
   * anomalous successful fetch can never clear a genuine incident on its own. */
  marketDataIncidentRecoveryThreshold?: number;
  /** Repeated-Telegram-alert fix. Durable persistence path for market-data incident state — when
   * set, the tracker survives a process restart (e.g. a PM2 restart) without re-announcing an
   * already-open, unchanged incident as brand new (see market-data-incident-tracker.ts's own
   * atomic-write persistence). Undefined (the default) keeps the tracker fully in-memory: still
   * correct within one continuous process lifetime, but a restart mid-incident loses the tracker's
   * state and may resend one OPENED alert for a condition that was already known — a documented
   * dedup limitation, never a trading-safety regression. */
  marketDataIncidentStatePath?: string;
}

/** Prototype 1.0 — official Hermes Agent decision integration. Only the Hermes-specific pieces —
 * everything else runUniverseScan needs (broker, marketDataProvider, tradeCandidateRepository,
 * tradePerformance, auditTrail, strategy, orderSizingMode, instrumentUniverse) is already present
 * elsewhere on TradingRuntimeDeps and is reused directly, never duplicated here. */
export interface TradingRuntimeUniverseScanDeps {
  hermesAgentStrategy: HermesAgentStrategy;
  hermesAdapterConfig: HermesAgentAdapterConfig;
  hermesCliRunner: HermesCliRunner;
  maxProposalsPerScan: number;
  maxOpenPositions: number;
  maxOpenPositionsPerInstrument: number;
  equityMarketHoursPolicy: MarketHoursPolicy;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
// Hardening pass — opposing-signal exit stability. Mirrors config.ts's own DEFAULT_OPPOSING_EXIT_*
// constants exactly — used only when deps.opposingExitMinHoldMs/opposingExitRequiredConfirmations
// are omitted (every existing caller/test that predates this hardening pass), so this runtime's
// behaviour for those callers matches what a real, unconfigured deployment would also get.
const DEFAULT_OPPOSING_EXIT_MIN_HOLD_MS = 5 * 60_000;
const DEFAULT_OPPOSING_EXIT_REQUIRED_CONFIRMATIONS = 2;

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

  /** Prototype 1.0 — official Hermes Agent decision integration. The full set of instruments this
   * runtime processes every cycle — `deps.instruments` when configured, else the single
   * `deps.instrument` (preserving every existing caller's exact behaviour: a one-element loop). */
  private get instrumentList(): string[] {
    return this.deps.instruments ?? [this.deps.instrument];
  }

  // Hardening pass — opposing-signal exit stability. Process-local, in-memory only — see
  // OpposingSignalStabilityTracker's own top-of-file comment on why, and on the restart-safety
  // trade-off this implies (a restart can only delay an exit, never skip a real safety check or
  // trigger an unwarranted one).
  private readonly opposingSignalStability = new OpposingSignalStabilityTracker();

  private get opposingExitMinHoldMs(): number {
    return this.deps.opposingExitMinHoldMs ?? DEFAULT_OPPOSING_EXIT_MIN_HOLD_MS;
  }

  private get opposingExitRequiredConfirmations(): number {
    return this.deps.opposingExitRequiredConfirmations ?? DEFAULT_OPPOSING_EXIT_REQUIRED_CONFIRMATIONS;
  }

  // Repeated-Telegram-alert fix. Fingerprint-based, hysteresis-gated incident tracking — see
  // market-data-incident-tracker.ts's own top-of-file comment. Durable only when
  // deps.marketDataIncidentStatePath is configured (start() below loads any persisted state before
  // the scheduler's first tick); otherwise behaves exactly like opposingSignalStability above
  // (process-local, in-memory only — a restart can only re-announce an already-known incident,
  // never skip a real one or fabricate a recovery).
  private readonly marketDataIncident = new MarketDataIncidentTracker({
    recoveryThreshold: this.deps.marketDataIncidentRecoveryThreshold,
    persistencePath: this.deps.marketDataIncidentStatePath,
  });

  async start(): Promise<void> {
    assertValidRuntimeTransition(this.state, "RUNNING");
    this.state = "RUNNING";
    const now = this.deps.clock.now();
    this.startedAt = now.toISOString();
    this.stoppedAt = null;
    this.executionRunId = `trading-runtime-${now.getTime()}`;

    // Repeated-Telegram-alert fix. Loaded BEFORE the scheduler's first tick so a durable, already-
    // open incident is recognised on the very first post-restart cycle — never treated as brand new
    // merely because this process just started. A no-op when marketDataIncidentStatePath was never
    // configured (see MarketDataIncidentTracker.loadPersistedState's own doc comment) — never
    // throws, never delays start() meaningfully long.
    await this.marketDataIncident.loadPersistedState();

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

    // Repeated-Telegram-alert fix. Best-effort durability flush — a normal cycle never awaits this
    // (see market-data-incident-tracker.ts's own `pendingPersist` doc comment), but a graceful stop
    // is a natural point to catch up any still-in-flight write, maximising the odds that the next
    // start() sees fully up-to-date state. Never throws (persist failures are already swallowed
    // internally) and never blocks stop() beyond whatever write was already in flight.
    await this.marketDataIncident.waitForPendingPersistence();

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
   * Prototype 1.0 — runtime ordering hardening. Every cycle now runs in three ordered stages, never
   * two, so a slow, timed-out, or unavailable Hermes call can never delay any instrument's own
   * exposure-reducing safety processing (see runInstrumentPhaseA's own doc comment for exactly why
   * this is safe without duplicating any lifecycle/exit logic):
   *
   * Phase A (runInstrumentPhaseA, looped over every configured instrument, BEFORE any Hermes call):
   * crash-window recovery, broker reconciliation, candidate repair, and every Hermes-INDEPENDENT
   * exit trigger (kill switch, stop-loss, take-profit, strategy-disabled, max-holding). No broker
   * ENTRY order is ever submitted here — only a risk-reducing close, via the existing, unmodified
   * executeAutomaticExit.
   *
   * Hermes universe scan (runUniverseScanStep, exactly once, only after Phase A has run for every
   * instrument): builds its own snapshot from the broker's now-current (post-Phase-A) open-position
   * list. Never lets a scan failure abort the cycle — Phase A's own success is already unaffected by
   * this call, having already completed before it ever starts.
   *
   * Phase B (runInstrumentPhaseB, looped over every configured instrument, after the Hermes scan):
   * the real, Hermes-informed MarketDecisionEngine.evaluate(), the OPPOSING_SIGNAL exit check for any
   * position Phase A left open, approved-candidate execution, and fresh-candidate creation.
   *
   * Failure isolation is preserved at both per-instrument loops, with the same single-instrument
   * "rethrow to this method's own outer catch" semantics the pre-split single runInstrumentCycle
   * always had (see each loop's own inline comment) — a multi-instrument failure in either phase is
   * recorded and isolated, never propagated to another instrument or the other phase.
   */
  private async runCycleBody(trigger: "scheduled" | "manual"): Promise<TradingCycleOutcome> {
    await this.recordAudit("TRADING_CYCLE_STARTED", { trigger });
    const cycleStartedAtMs = this.deps.clock.now().getTime();
    const executionRunId = this.executionRunId ?? "trading-runtime-unstarted";
    try {
      const now = this.deps.clock.now();
      const instruments = this.instrumentList;

      // Phase A — safety and existing exposure, for every instrument, strictly before any Hermes
      // subprocess call this cycle.
      const states: Record<string, InstrumentCycleState> = {};
      for (const instrument of instruments) {
        try {
          states[instrument] = await this.runInstrumentPhaseA(instrument, now, executionRunId);
        } catch (error) {
          // Mirrors the identical single-instrument-vs-isolation semantics the Phase B loop below
          // (and the pre-split runInstrumentCycle before it) has always used.
          if (instruments.length === 1) throw error;
          await this.recordAudit("TRADING_CYCLE_FAILED", { stage: "phase-a", message: toErrorMessage(error) }, instrument);
          states[instrument] = {
            instrument,
            safeToContinue: false,
            reconciliationFailureReason: toErrorMessage(error),
            currentPositionOpen: false,
            currentRecord: undefined,
            context: undefined,
            snapshot: undefined,
            protectionChecksRun: [],
            protectionChecksSkipped: [],
          };
        }
      }

      // Candle-gap production incident fix. One shared, rate-limited incident view across the
      // whole configured universe — computed once, after every instrument's own Phase A outcome is
      // known, never per-instrument. Deliberately AFTER the Phase A loop (so it sees this cycle's
      // final degraded/recovered state for every instrument) and BEFORE the Hermes scan (an
      // incident alert must never be delayed by a slow/unavailable Hermes call).
      await this.recordMarketDataIncidentState(now, states);

      // Prototype 1.0 — official Hermes Agent decision integration. Exactly ONE Hermes call for
      // the whole cycle (never once per instrument), and only now — after every instrument's own
      // safety-critical Phase A has already fully run, regardless of whether Hermes is reachable at
      // all this cycle — see runUniverseScanStep's own doc comment for why this never aborts the
      // cycle even if it fails.
      await this.runUniverseScanStep(now, executionRunId);

      const perInstrument: Record<string, TradingCycleResultSummary> = {};
      let primaryOutcome: InstrumentCycleOutcome | undefined;

      for (const instrument of instruments) {
        try {
          const outcome = await this.runInstrumentPhaseB(states[instrument]!, now, executionRunId, cycleStartedAtMs, trigger);
          perInstrument[instrument] = outcome.summary;
          if (!primaryOutcome) primaryOutcome = outcome;
        } catch (error) {
          // Preserves the EXACT existing single-instrument failure semantics: with only one
          // instrument configured, rethrowing here is indistinguishable from the pre-refactor
          // code's own uncaught exception reaching this method's outer catch below. Isolation
          // (recording and continuing with the remaining instruments) only ever applies once more
          // than one instrument is actually configured — the mission's own explicit requirement
          // that one instrument's failure must never stop safe processing of the others.
          if (instruments.length === 1) throw error;
          await this.recordAudit("TRADING_CYCLE_FAILED", { stage: "phase-b", message: toErrorMessage(error) }, instrument);
          perInstrument[instrument] = { decision: "HOLD", candidateCreated: false, instrument, executedCandidateIds: [], reconciliationFailed: true };
        }
      }

      // Only reachable when every configured instrument failed (multi-instrument only — the
      // single-instrument case above always either returns a real outcome or rethrows).
      if (!primaryOutcome) {
        const fallbackInstrument = instruments[0]!;
        primaryOutcome = {
          summary: perInstrument[fallbackInstrument]!,
          decision: { action: "HOLD", confidence: 0, reasoning: ["Every configured instrument failed this cycle."] },
        };
      }

      this.successfulRunCount += 1;
      this.lastResult = {
        ...primaryOutcome.summary,
        perInstrument: instruments.length > 1 ? perInstrument : undefined,
      };
      this.lastRunCompletedAt = this.deps.clock.now().toISOString();
      await this.recordAudit(
        "TRADING_CYCLE_COMPLETED",
        primaryOutcome.reconciliationFailureReason !== undefined
          ? {
              decision: primaryOutcome.summary.decision,
              candidateCreated: primaryOutcome.summary.candidateCreated,
              executedCandidateIds: primaryOutcome.summary.executedCandidateIds,
              reconciliationFailed: true,
              reason: primaryOutcome.reconciliationFailureReason,
              perInstrument: instruments.length > 1 ? perInstrument : undefined,
            }
          : {
              decision: primaryOutcome.summary.decision,
              candidateCreated: primaryOutcome.summary.candidateCreated,
              executedCandidateIds: primaryOutcome.summary.executedCandidateIds,
              positionOpen: primaryOutcome.summary.positionOpen,
              exitTrigger: primaryOutcome.summary.exitTrigger,
              exitClosed: primaryOutcome.summary.exitClosed,
              duplicateEntrySuppressed: primaryOutcome.summary.duplicateEntrySuppressed,
              autoApproved: primaryOutcome.summary.autoApproved,
              perInstrument: instruments.length > 1 ? perInstrument : undefined,
            },
      );

      // Telegram alert refinement — requirement 3 (daily account summary). Checked once per cycle,
      // strictly after this cycle's own real trading work has already fully completed — a no-op
      // almost every cycle (see DailyAccountSummaryService.maybeSend's own doc comment for exactly
      // when it actually does anything). Never lets a failure here affect this cycle's own outcome:
      // maybeSend() already catches everything itself, but this is wrapped again anyway, matching
      // persistTradePerformance's own "can never fail this cycle" defence-in-depth convention.
      if (this.deps.dailyAccountSummary) {
        try {
          await this.deps.dailyAccountSummary.maybeSend();
        } catch (error) {
          logger.error("Hermes daily account summary check failed unexpectedly", {
            component: "hermes-execution",
            error: toErrorMessage(error),
          });
        }
      }

      return {
        kind: "completed",
        result: {
          decision: primaryOutcome.decision,
          candidateId: primaryOutcome.summary.candidateId,
          executedCandidateIds: primaryOutcome.summary.executedCandidateIds,
        },
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
   * Repeated-Telegram-alert fix. Feeds this cycle's final per-instrument market-data state into the
   * shared, fingerprint-based MarketDataIncidentTracker and records whatever transitions it
   * reports, aggregated into at most one audit event PER TRANSITION KIND per cycle (never one per
   * instrument) — so e.g. ETH and SOL both opening a new incident in the same cycle produces one
   * MARKET_DATA_INCIDENT_OPENED event carrying both, and therefore one Telegram message, not two.
   * MARKET_DATA_INCIDENT_UNCHANGED/RECOVERY_PENDING are recorded the same way for observability but
   * are never wired into Telegram (see telegram-alerting-audit-trail.ts) — this is precisely the
   * transition that used to cause a repeated alert every cycle for an unchanged condition. Also
   * fires the existing per-instrument MARKET_DATA_RECOVERED audit event for each instrument that
   * recovered — the per-instrument MARKET_DATA_DEGRADED counterpart is already fired directly from
   * runInstrumentPhaseA, the moment it's detected, never delayed to here. Never throws — a broken
   * tracker/audit write must never affect trading itself; mirrors persistAnalysis's own "best
   * effort, log and swallow" discipline.
   */
  private async recordMarketDataIncidentState(now: Date, states: Record<string, InstrumentCycleState>): Promise<void> {
    try {
      const observations: InstrumentObservation[] = Object.values(states).map((state) => {
        if (state.marketDataUnavailableReason === undefined) {
          return { instrument: state.instrument, valid: true };
        }
        const detail = state.marketDataFailureDetail;
        const reason: CanonicalIncidentReason = {
          category: detail?.category ?? "unknown",
          timeframe: detail?.timeframe,
          missingIntervalStartMs: detail?.missingIntervalStartMs,
          missingIntervalEndMs: detail?.missingIntervalEndMs,
          summary: state.marketDataUnavailableReason,
        };
        return { instrument: state.instrument, valid: false, reason };
      });

      const outcome = await this.marketDataIncident.recordCycleObservations(now, observations);

      for (const transition of outcome.recovered) {
        await this.recordAudit("MARKET_DATA_RECOVERED", {}, transition.instrument);
      }

      if (outcome.opened.length > 0) {
        await this.recordAudit("MARKET_DATA_INCIDENT_OPENED", {
          instruments: outcome.opened.map((t) => ({
            instrument: t.instrument,
            fingerprint: t.fingerprint,
            category: t.reason.category,
            reason: t.reason.summary,
            timeframe: t.reason.timeframe,
            missingIntervalStartMs: t.reason.missingIntervalStartMs,
            missingIntervalEndMs: t.reason.missingIntervalEndMs,
            openedAt: t.openedAt,
            observationCount: t.observationCount,
          })),
        });
      }

      if (outcome.changed.length > 0) {
        await this.recordAudit("MARKET_DATA_INCIDENT_CHANGED", {
          instruments: outcome.changed.map((t) => ({
            instrument: t.instrument,
            fingerprint: t.fingerprint,
            previousFingerprint: t.previousFingerprint,
            category: t.reason.category,
            reason: t.reason.summary,
            timeframe: t.reason.timeframe,
            missingIntervalStartMs: t.reason.missingIntervalStartMs,
            missingIntervalEndMs: t.reason.missingIntervalEndMs,
            openedAt: t.openedAt,
            observationCount: t.observationCount,
          })),
        });
      }

      if (outcome.recovered.length > 0) {
        await this.recordAudit("MARKET_DATA_INCIDENT_RECOVERED", {
          instruments: outcome.recovered.map((t) => ({
            instrument: t.instrument,
            previousFingerprint: t.previousFingerprint,
            openedAt: t.openedAt,
            recoveredAt: t.recoveredAt,
          })),
        });
      }

      if (outcome.unchanged.length > 0) {
        await this.recordAudit("MARKET_DATA_INCIDENT_UNCHANGED", {
          instruments: outcome.unchanged.map((t) => ({
            instrument: t.instrument,
            fingerprint: t.fingerprint,
            observationCount: t.observationCount,
            openedAt: t.openedAt,
            lastObservedAt: t.lastObservedAt,
          })),
        });
      }

      if (outcome.recoveryPending.length > 0) {
        await this.recordAudit("MARKET_DATA_INCIDENT_RECOVERY_PENDING", {
          instruments: outcome.recoveryPending.map((t) => ({
            instrument: t.instrument,
            fingerprint: t.fingerprint,
            consecutiveHealthyCount: t.consecutiveHealthyCount,
            requiredConsecutiveHealthy: t.requiredConsecutiveHealthy,
          })),
        });
      }
    } catch (error) {
      logger.error("Market-data incident tracking failed — never affects trading itself", {
        component: "trading-runtime",
        reason: toErrorMessage(error),
      });
    }
  }

  /**
   * Prototype 1.0 — official Hermes Agent decision integration. Calls the universe scanner
   * (runtime/universe-scanner.ts) exactly once per cycle when `deps.universeScan` is configured —
   * a no-op otherwise, preserving every non-Hermes caller's behaviour exactly (DEMO-0001 and any
   * other registered Strategy never needed this step and still don't). Never lets a scan failure
   * abort the cycle: the per-instrument maintenance loop that follows (recovery/reconciliation/
   * exit-monitoring for already-open positions) must still run regardless of whether Hermes itself
   * was reachable this cycle. On failure, the shared strategy's own proposal set is explicitly
   * cleared so a stale selection from an earlier successful scan can never be acted on.
   */
  private async runUniverseScanStep(now: Date, executionRunId: string): Promise<void> {
    const universeScan = this.deps.universeScan;
    if (!universeScan) return;

    try {
      await runUniverseScan({
        broker: this.deps.broker,
        marketDataProvider: this.deps.marketDataProvider,
        tradeCandidateRepository: this.deps.tradeCandidateRepository,
        tradePerformance: this.deps.tradePerformance,
        auditTrail: this.deps.auditTrail,
        executionRunId,
        strategy: this.deps.strategy,
        hermesAgentStrategy: universeScan.hermesAgentStrategy,
        hermesAdapterConfig: universeScan.hermesAdapterConfig,
        hermesCliRunner: universeScan.hermesCliRunner,
        instrumentUniverse: this.instrumentList,
        maxProposalsPerScan: universeScan.maxProposalsPerScan,
        maxOpenPositions: universeScan.maxOpenPositions,
        maxOpenPositionsPerInstrument: universeScan.maxOpenPositionsPerInstrument,
        orderSizingMode: this.deps.orderSizingMode,
        equityMarketHoursPolicy: universeScan.equityMarketHoursPolicy,
        now,
      });
    } catch (error) {
      universeScan.hermesAgentStrategy.setScanProposals([]);
      await this.recordAudit("TRADING_CYCLE_FAILED", { stage: "universe-scan", message: toErrorMessage(error) });
    }
  }

  /**
   * Prototype 1.0 — runtime ordering hardening. Phase A of the two-phase per-instrument split (see
   * runCycleBody's own doc comment) — everything that must complete BEFORE any Hermes subprocess
   * call this cycle: crash-window recovery, broker reconciliation (+ candidate repair on a
   * confirmed record), and every Hermes-INDEPENDENT exit trigger. Reuses the exact same existing,
   * frozen functions the pre-split runInstrumentCycle always has (recoverStaleLifecycleRecords,
   * reconcileBrokerPosition, repairCandidateForConfirmedLifecycle, evaluateExitTrigger,
   * executeAutomaticExit) — nothing here reimplements any of them.
   *
   * The neutral placeholder decision passed to evaluateExitTrigger below is safe because of
   * exit-monitor.ts's own priority order: KILL_SWITCH, STOP_LOSS, TAKE_PROFIT, STRATEGY_DISABLED,
   * and MAX_HOLDING_DURATION never read `freshDecision` at all — only the sixth and LOWEST-priority
   * check, OPPOSING_SIGNAL, does, and a HOLD placeholder can never satisfy it. So this call
   * evaluates all five Hermes-independent triggers exactly as a real decision would, while
   * structurally deferring OPPOSING_SIGNAL to Phase B, where the real (Hermes-informed) decision is
   * available. No broker ENTRY order is ever submitted here — only a risk-reducing close, via the
   * existing, unmodified executeAutomaticExit.
   *
   * Candle-gap production incident fix. The five Hermes-independent exit checks above are
   * evaluated using a quote fetched INDEPENDENTLY of `buildMarketDecisionContext()` (which also
   * fetches and validates historical candle history, and throws if that history is invalid/gapped
   * — see candle-validation.ts). Fixed protection must never depend on candle history at all:
   * evaluateExitTrigger only ever reads `record` (already reconciled above) and `freshBid` (a
   * plain live quote). Previously, a single monolithic buildMarketDecisionContext() call meant an
   * invalid candle history threw BEFORE this exit check ever ran, silently skipping stop-loss/
   * take-profit/kill-switch protection for an already-open position — exactly the production
   * incident this fix addresses. buildMarketDecisionContext() is still attempted afterwards, in its
   * own try/catch, purely to build the full context Phase B needs for fresh analysis — its failure
   * no longer has any bearing on whether protection above already ran.
   */
  private async runInstrumentPhaseA(instrument: string, now: Date, executionRunId: string): Promise<InstrumentCycleState> {
    await recoverStaleLifecycleRecords({
      broker: this.deps.broker,
      instrument,
      strategy: this.deps.strategy,
      brokerProvider: this.deps.brokerProvider,
      lifecycleStore: this.deps.lifecycleStore,
      tradeCandidateRepository: this.deps.tradeCandidateRepository,
      auditTrail: this.deps.auditTrail,
      executionRunId,
      now,
      recoveryThresholdMs: this.deps.recoveryThresholdMs,
    });

    const reconciliation = await reconcileBrokerPosition({
      broker: this.deps.broker,
      instrument,
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
      await sweepExpiredCandidates({
        repository: this.deps.tradeCandidateRepository,
        auditTrail: this.deps.auditTrail,
        executionRunId,
        strategyId: this.deps.strategy.strategyId,
        instrument,
        now,
      });
      return {
        instrument,
        safeToContinue: false,
        reconciliationFailureReason: reconciliation.reason,
        currentPositionOpen: false,
        currentRecord: undefined,
        context: undefined,
        snapshot: undefined,
        protectionChecksRun: [],
        protectionChecksSkipped: [],
      };
    }

    let currentPositionOpen = reconciliation.positionOpen;
    let currentRecord = reconciliation.record;

    // Remediation pass (senior review finding C1) — reconciles the opposing-signal stability
    // tracker's own notion of "which position is this instrument's current one" against reality,
    // EVERY cycle, regardless of whether a position is currently open. This is what detects a
    // position closed with no explicit automatic-exit/candidate-execution reset call ever having
    // run for it (e.g. a manual out-of-band closure discovered only via reconciliation), and a
    // position REPLACED by a different one within a single cycle (an adopted-orphan scenario) —
    // both clean up the OLD position's own confirmation count, never letting it leak into
    // whatever this instrument tracks next. See OpposingSignalStabilityTracker.syncPosition's own
    // doc comment for the exact no-op/reset conditions.
    this.opposingSignalStability.syncPosition(instrument, currentRecord?.id);

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
      instrument,
      now,
    });

    let phaseAExitTrigger: string | undefined;
    let phaseAExitClosed: boolean | undefined;
    const protectionChecksRun: string[] = [];
    const protectionChecksSkipped: string[] = [];

    // Candle-gap production incident fix. Attempted FIRST, in its own try/catch that never
    // rethrows — so its failure can no longer prevent the fixed protection checks below from
    // running. Still required for Phase B's own fresh analysis (MarketDecisionEngine.evaluate(),
    // the OPPOSING_SIGNAL re-check, and any new candidate) — all of that remains blocked whenever
    // this throws, exactly as strictly as before this fix, per the mission's own explicit "do not
    // weaken validation for new entries" requirement. In the healthy (non-degraded) case this
    // produces byte-for-byte the same single getRate() call this cycle always made — the exit
    // check below reuses `context.bid` rather than fetching a second, independent quote, so this
    // fix changes NO observable behaviour when candle history is valid.
    let snapshot: MarketDataSnapshot | undefined;
    let context: MarketDecisionContext | undefined;
    let marketDataUnavailableReason: string | undefined;
    // Repeated-Telegram-alert fix. Captured alongside the free-text reason above whenever the
    // thrown error is a MarketDataProviderError with a populated `.detail` — undefined for a plain
    // Error (a test double, or a provider that doesn't populate it), which
    // recordMarketDataIncidentState treats as an "unknown" category rather than crashing.
    let marketDataFailureDetail: MarketDataFailureDetail | undefined;
    try {
      const result = await buildMarketDecisionContext(this.deps.marketDataProvider, this.deps.broker, instrument, this.deps.strategy);
      snapshot = result.snapshot;
      // Overrides buildMarketDecisionContext's own broker.getOpenPositions()-derived positionOpen —
      // reconciliation.positionOpen is the only value this runtime trusts (see above).
      context = { ...result.context, positionOpen: currentPositionOpen };
    } catch (error) {
      marketDataUnavailableReason = toErrorMessage(error);
      if (error instanceof MarketDataProviderError) marketDataFailureDetail = error.detail;
    }

    if (currentPositionOpen && currentRecord) {
      // Candle-gap production incident fix. Prefer the bid `buildMarketDecisionContext()` already
      // fetched (zero extra broker calls in the common, healthy case) — only fall back to an
      // independent quote fetch when that call itself failed, duck-typed the same way
      // executeAutomaticExit's own "fetch fresh price right before closing" step already does (see
      // exit-monitor.ts's hasRateFetching), so this never depends on a new broker capability.
      let freshBid: number | undefined = context?.bid;
      let quoteFetchError: string | undefined;
      if (freshBid === undefined) {
        if (hasRateFetching(this.deps.broker)) {
          try {
            const rate = await this.deps.broker.getRate(instrument);
            freshBid = rate.bid;
          } catch (error) {
            quoteFetchError = toErrorMessage(error);
          }
        } else {
          quoteFetchError = "Broker does not support independent rate fetching.";
        }
      }

      if (freshBid !== undefined) {
        // Restart-Resilient Autonomy Phase — Phase 3. Automatic exits never require human approval
        // in demo mode — closing an already-open position is always a risk-reduction action, never
        // gated by the kill switch (which forces this trigger, never blocks it).
        const strategyStillEnabled = await this.isStrategyStillEnabled(executionRunId);
        const placeholderDecision: MarketDecision = {
          action: "HOLD",
          confidence: 0,
          reasoning: ["Phase A: pre-Hermes safety check — the opposing-signal trigger is evaluated separately in Phase B."],
        };
        const trigger = evaluateExitTrigger({
          record: currentRecord,
          freshBid,
          freshDecision: placeholderDecision,
          killSwitchEnabled: this.deps.killSwitchEnabled,
          maxHoldingDurationMs: this.deps.maxHoldingDurationMs,
          strategyStillEnabled,
          now,
        });
        protectionChecksRun.push("KILL_SWITCH", "STOP_LOSS", "TAKE_PROFIT", "STRATEGY_DISABLED", "MAX_HOLDING_DURATION");

        if (trigger) {
          phaseAExitTrigger = trigger;
          const exitResult = await executeAutomaticExit({
            broker: this.deps.broker,
            record: currentRecord,
            trigger,
            lifecycleService: this.deps.lifecycleService,
            auditTrail: this.deps.auditTrail,
            executionRunId,
            now,
          });
          phaseAExitClosed = exitResult.closed;
          if (phaseAExitClosed) {
            // Hardening pass — opposing-signal exit stability. This trigger can never itself be
            // OPPOSING_SIGNAL (Phase A always evaluates against a neutral HOLD placeholder — see this
            // method's own doc comment), but the position closing here still means any accumulated
            // opposing-signal count for THIS SPECIFIC position (keyed by its own lifecycle record id,
            // never by instrument alone — see finding C1 in opposing-signal-stability.ts) must be
            // cleared, never carried into whatever opens on this instrument next. Captured before
            // `currentRecord` is cleared below.
            this.opposingSignalStability.reset(currentRecord.id);
            currentPositionOpen = false;
            currentRecord = undefined;
          }
        }
      } else {
        // No quote available at all — a more severe condition than a candle-only gap: fixed
        // protection genuinely cannot be evaluated this cycle for this instrument. Never silently
        // treated as "no trigger" — reported plainly (in the single consolidated audit event below)
        // so an operator can see protection itself was skipped, not merely that nothing needed to
        // happen.
        protectionChecksSkipped.push("KILL_SWITCH", "STOP_LOSS", "TAKE_PROFIT", "STRATEGY_DISABLED", "MAX_HOLDING_DURATION");
        if (marketDataUnavailableReason === undefined) marketDataUnavailableReason = `No live quote available for exit-protection checks: ${quoteFetchError}`;
      }

      if (marketDataUnavailableReason !== undefined) {
        // OPPOSING_SIGNAL is the one trigger Phase B alone can evaluate (it needs a fresh,
        // Hermes-informed decision) — Phase B never runs at all this cycle whenever candle history
        // is invalid (see runInstrumentPhaseB's own early return), so this is unconditionally
        // unavailable whenever marketDataUnavailableReason is set, regardless of whether a live
        // quote happened to be available for the fixed checks above.
        protectionChecksSkipped.push("OPPOSING_SIGNAL");
      }
    }

    // Candle-gap production incident fix. Exactly one MARKET_DATA_DEGRADED audit event per
    // instrument per cycle, regardless of which of the two conditions above caused it (invalid
    // candle history, no live quote at all, or both) — consolidated here rather than fired from
    // two separate branches, so an operator never sees a duplicate/conflicting pair of records for
    // the same cycle.
    if (marketDataUnavailableReason !== undefined) {
      await this.recordAudit(
        "MARKET_DATA_DEGRADED",
        {
          reason: marketDataUnavailableReason,
          protectionChecksRun: [...protectionChecksRun],
          protectionChecksSkipped: [...protectionChecksSkipped],
          quoteAvailable: protectionChecksRun.length > 0,
          entryAnalysisBlocked: true,
        },
        instrument,
      );
    }

    return {
      instrument,
      safeToContinue: true,
      currentPositionOpen,
      currentRecord,
      context: context ? { ...context, positionOpen: currentPositionOpen } : undefined,
      snapshot,
      marketDataUnavailableReason,
      marketDataFailureDetail,
      protectionChecksRun,
      protectionChecksSkipped,
      phaseAExitTrigger,
      phaseAExitClosed,
    };
  }

  /**
   * Prototype 1.0 — runtime ordering hardening. Phase B of the two-phase per-instrument split (see
   * runCycleBody's own doc comment) — everything that runs AFTER the one universe-wide Hermes scan:
   * the real, Hermes-informed MarketDecisionEngine.evaluate(), the OPPOSING_SIGNAL exit check for
   * any position Phase A left open, approved-candidate execution, and fresh-candidate creation.
   * Reuses `state`'s own already-fetched context/snapshot from Phase A rather than re-fetching
   * market data a second time this cycle. An instrument Phase A marked unsafe
   * (`!state.safeToContinue`) is skipped entirely here, reproducing the exact pre-split
   * reconciliation-failure outcome shape (same summary/decision fields, same
   * `reconciliationFailureReason`) — never touching the broker or a candidate for it.
   */
  private async runInstrumentPhaseB(
    state: InstrumentCycleState,
    now: Date,
    executionRunId: string,
    cycleStartedAtMs: number,
    trigger: "scheduled" | "manual",
  ): Promise<InstrumentCycleOutcome> {
    const { instrument } = state;

    if (!state.safeToContinue) {
      return {
        summary: { decision: "HOLD", candidateCreated: false, instrument, executedCandidateIds: [], reconciliationFailed: true },
        decision: {
          action: "HOLD",
          confidence: 0,
          reasoning: [state.reconciliationFailureReason ?? "Phase A did not complete safely for this instrument this cycle."],
        },
        reconciliationFailureReason: state.reconciliationFailureReason,
      };
    }

    // Candle-gap production incident fix. Phase A's own fixed protection checks (KILL_SWITCH/
    // STOP_LOSS/TAKE_PROFIT/STRATEGY_DISABLED/MAX_HOLDING_DURATION) already ran independently of
    // this — see runInstrumentPhaseA's own doc comment — and are carried through via
    // state.phaseAExitTrigger/phaseAExitClosed below regardless of this branch. What's blocked here
    // is everything that genuinely NEEDS candle-based analysis: MarketDecisionEngine.evaluate(),
    // the OPPOSING_SIGNAL re-check (the one exit trigger that reads a fresh decision), approved-
    // candidate execution, and fresh candidate creation — deliberately ALL deferred to a future,
    // healthy cycle rather than proceeding on stale/fabricated context. This never weakens
    // validation for a new entry: no candidate can be created here at all this cycle.
    if (state.marketDataUnavailableReason !== undefined) {
      return {
        summary: {
          decision: "HOLD",
          candidateCreated: false,
          instrument,
          executedCandidateIds: [],
          positionOpen: state.currentPositionOpen,
          exitTrigger: state.phaseAExitTrigger,
          exitClosed: state.phaseAExitClosed,
          marketDataUnavailableReason: state.marketDataUnavailableReason,
          protectionChecksRun: state.protectionChecksRun,
          protectionChecksSkipped: state.protectionChecksSkipped,
        },
        decision: {
          action: "HOLD",
          confidence: 0,
          reasoning: [
            `Invalid historical candle history — fresh entry/strategy analysis blocked: ${state.marketDataUnavailableReason}`,
            state.currentPositionOpen
              ? state.protectionChecksRun.length > 0
                ? `Fixed exit protection (${state.protectionChecksRun.join(", ")}) still ran using a live quote; opposing-signal exit is unavailable this cycle.`
                : `No live quote available either — fixed exit protection (${state.protectionChecksSkipped.join(", ")}) could not run this cycle.`
              : "No open position to protect this cycle.",
          ],
        },
      };
    }

    let currentPositionOpen = state.currentPositionOpen;
    let currentRecord = state.currentRecord;
    const snapshot = state.snapshot!;
    // Re-applies the latest positionOpen truth (which may have changed if Phase A closed this
    // position) onto Phase A's own already-fetched context — never a second market-data fetch.
    const context: MarketDecisionContext = { ...state.context!, positionOpen: currentPositionOpen };
    const decision = await MarketDecisionEngine.evaluate(context);

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

    let exitTrigger: string | undefined = state.phaseAExitTrigger;
    let exitClosed: boolean | undefined = state.phaseAExitClosed;

    if (currentPositionOpen && currentRecord) {
      // Phase A already ruled out KILL_SWITCH/STOP_LOSS/TAKE_PROFIT/STRATEGY_DISABLED/
      // MAX_HOLDING_DURATION for this exact record/bid (identical inputs, re-evaluated here) — the
      // only way this call's result can differ from Phase A's own is OPPOSING_SIGNAL, the one
      // check that reads `freshDecision`, now the real, Hermes-informed decision rather than Phase
      // A's neutral placeholder.
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

      // Hardening pass — opposing-signal exit stability. Every OTHER trigger (undefined, or one of
      // the five Hermes-independent ones) means this cycle's own raw signal is definitively NOT
      // opposing (undefined is the LAST-checked, lowest-priority outcome — see evaluateExitTrigger's
      // own priority order) or the position is about to close by some other means entirely — either
      // way, the consecutive-confirmation counter for THIS POSITION (keyed by its own lifecycle
      // record id — see finding C1) is reset. Only OPPOSING_SIGNAL itself is ever gated; stop-loss/
      // take-profit/kill-switch/strategy-disabled/max-holding remain exactly as immediate as they
      // always were (this branch never delays or blocks them).
      if (trigger2 === "OPPOSING_SIGNAL") {
        const gate = this.opposingSignalStability.evaluate({
          positionId: currentRecord.id,
          isOpposingSignalTriggered: true,
          openedAt: currentRecord.openedAt,
          now,
          config: { minHoldMs: this.opposingExitMinHoldMs, requiredConsecutiveSignals: this.opposingExitRequiredConfirmations },
        })!;

        if (!gate.allow) {
          await this.recordAudit(
            "OPPOSING_SIGNAL_EXIT_DEFERRED",
            {
              reason: gate.reason,
              consecutiveCount: gate.consecutiveCount,
              requiredConsecutiveSignals: gate.requiredConsecutiveSignals,
              heldMs: gate.heldMs,
              minHoldMs: gate.minHoldMs,
            },
            instrument,
          );
        } else {
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
            this.opposingSignalStability.reset(currentRecord.id);
            currentPositionOpen = false;
            currentRecord = undefined;
          }
        }
      } else {
        this.opposingSignalStability.reset(currentRecord.id);

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
      instrument,
    });
    const executedCandidateIds: string[] = [];
    for (const candidate of approvedCandidates) {
      if (candidate.direction === "BUY") {
        if (this.deps.killSwitchEnabled) {
          await this.recordAudit(
            "KILL_SWITCH_ENTRY_BLOCKED",
            { context: "approved-candidate-execution", candidateId: candidate.id },
            instrument,
          );
          continue;
        }
        if (currentPositionOpen) {
          await this.recordAudit(
            "APPROVED_CANDIDATE_EXECUTION_DEFERRED",
            {
              candidateId: candidate.id,
              reason: "A broker position or unresolved lifecycle record is already active for this strategy+instrument.",
            },
            instrument,
          );
          continue;
        }
      }

      // Max-daily-trades risk counter fix. Recomputed fresh on every iteration (never hoisted above
      // this loop) from the durable TradeLifecycleStore — never `broker.getCompletedTrades().length`
      // (an unscoped, unbounded, in-memory, process-restart-resetting history, not a UTC-day count).
      // Freshness matters here exactly like the original code's own per-iteration
      // `getCompletedTrades().length` did: a position this SAME loop already opened for an earlier
      // candidate this cycle must count toward a later candidate's own check.
      //
      // Egress-containment fix (production incident: Supabase egress ~800% over the Free-plan
      // quota): this used to be countConfirmedEntriesForUtcDay(await lifecycleStore.list(), now,
      // scope) — a full-table select("*"), JSONB `detail` blob included, downloaded fresh on every
      // approved-candidate iteration. The store now performs the filtering AND the counting
      // server-side (count: "exact", head: true) — no rows are ever transferred.
      const { startInclusive, endExclusive } = utcDayBoundaries(now);
      const dailyTradeCount = await this.deps.lifecycleStore.countConfirmedEntriesForUtcDay({
        strategyId: this.deps.strategy.strategyId,
        startInclusive,
        endExclusive,
      });
      const outcome = await executeApprovedTradeCandidate({
        repository: this.deps.tradeCandidateRepository,
        broker: this.deps.broker,
        auditTrail: this.deps.auditTrail,
        executionRunId,
        lifecycleService: this.deps.lifecycleService,
        portfolioRisk: {
          config: this.deps.portfolioRiskConfig,
          dailyTradeCount,
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
          // Hardening pass — opposing-signal exit stability. A human-approved SELL candidate
          // closes the position too — reset (by the closed record's own id — see finding C1) so a
          // later, genuinely new position on this instrument never inherits a stale opposing-signal
          // count. Guarded: a broker/record combination with no reconciled TradeLifecycleRecord at
          // all (see this method's own fallback-path comment above) never had anything tracked by
          // this tracker in the first place — nothing to reset in that case.
          if (currentRecord) this.opposingSignalStability.reset(currentRecord.id);
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
      await this.persistTradePerformance(candidateId, instrument);
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
        await this.recordAudit("KILL_SWITCH_ENTRY_BLOCKED", { context: "fresh-candidate-creation" }, instrument);
      } else {
        const duplicateCheck = await checkForDuplicateEntry({
          tradeCandidateRepository: this.deps.tradeCandidateRepository,
          lifecycleStore: this.deps.lifecycleStore,
          strategyId: this.deps.strategy.strategyId,
          instrument,
        });

        if (duplicateCheck.duplicate) {
          duplicateEntrySuppressed = true;
          await this.recordAudit("DUPLICATE_ENTRY_SUPPRESSED", { reason: duplicateCheck.reason }, instrument);
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

    return {
      summary: {
        decision: decision.action,
        candidateCreated: candidate !== undefined,
        candidateId: candidate?.id,
        instrument,
        executedCandidateIds,
        positionOpen: currentPositionOpen,
        exitTrigger,
        exitClosed,
        duplicateEntrySuppressed,
        autoApproved,
      },
      decision,
    };
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
              // Prototype 1.0 — multi-instrument correctness fix. The instrument this SPECIFIC
              // analysis run concerns — read from the per-instrument context the caller already
              // built for this cycle (outcome.context.instrument, set from runInstrumentPhaseB's
              // own loop variable via buildMarketDecisionContext), never `this.deps.instrument`
              // (the single, original configured instrument, which is only ever correct when
              // exactly one instrument is configured — see this.deps.instruments's own doc
              // comment). Ensures a BTC/ETH/SOL/AAPL/MSFT/NVDA cycle persists each instrument's own
              // analysis row under its own symbol, never all mislabelled as `deps.instrument`.
              instrument: outcome.context.instrument,
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
              // This "failure" branch is only ever reached from runCycleBody's own OUTER catch —
              // a whole-cycle failure that occurred outside any specific instrument's own
              // processing (e.g. before the per-instrument loops ever ran) — so there is no
              // "current per-instrument" value to use here; `deps.instrument` (the same "primary
              // instrument" recordAudit's own cycle-level events already show) is the correct,
              // deliberate choice for this specific branch only.
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
        // Same per-instrument correctness fix as the buildAnalysisRecord call above — the success
        // branch reports the actual instrument this run concerned, never the single configured
        // `deps.instrument`, which the failure branch alone still legitimately uses (see that
        // branch's own comment above).
        instrument: outcome.kind === "success" ? outcome.context.instrument : this.deps.instrument,
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
  private async persistTradePerformance(candidateId: string, instrument: string): Promise<void> {
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
        // Prototype 1.0 — multi-instrument correctness fix. The caller's own current per-instrument
        // loop value, not `this.deps.instrument` — the underlying TradePerformance record itself was
        // always correctly labelled (recordTradePerformanceForExecutedCandidate derives it from the
        // candidate/lifecycle record, never from this runtime's deps), so only this diagnostic log
        // line was ever at risk of mislabelling in multi-instrument mode.
        instrument,
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
  /** Prototype 1.0 — official Hermes Agent decision integration. `instrumentOverride` lets a
   * per-instrument event (inside runInstrumentCycle, looping over N instruments) record the
   * SPECIFIC instrument it actually concerns, rather than always showing `deps.instrument` (the
   * bug this override fixes: without it, every audit event for e.g. "ETH" would otherwise be
   * mislabelled with whatever the single, original `deps.instrument` happened to be). Cycle-level
   * events (STARTED/COMPLETED/etc.) never pass this, preserving their exact existing behaviour. */
  private async recordAudit(eventType: AuditEventType, details: Record<string, unknown>, instrumentOverride?: string): Promise<void> {
    const instrument = instrumentOverride ?? this.deps.instrument;
    try {
      await this.deps.auditTrail.record({
        timestamp: this.deps.clock.now().toISOString(),
        eventType,
        executionRunId: this.executionRunId ?? "trading-runtime-unstarted",
        instrument,
        details,
      });
    } catch (error) {
      logger.error("Failed to persist a trading-runtime audit event — the cycle's own outcome was unaffected", {
        component: "hermes-execution",
        executionRunId: this.executionRunId ?? "trading-runtime-unstarted",
        instrument,
        eventType,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
