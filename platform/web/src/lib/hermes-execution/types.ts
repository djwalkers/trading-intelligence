// Hermes Execution MVP Phase 1 — shared types for the isolated Strategy Registry -> paper
// trading pipeline. Deliberately separate from src/lib/types/strategy.ts and
// src/lib/strategy-engine/strategy.ts (two unrelated existing "Strategy" concepts) — nothing here
// is wired into either of them.

/**
 * HERMES_APPROVED strategies originate from the Hermes Strategy Registry (a strategy the registry
 * itself marked ELIGIBLE, per its own promotion framework). DEMO_ONLY strategies exist purely to
 * exercise this execution pipeline and must never be mistaken for research-backed evidence — see
 * demo-strategy.ts.
 */
export type StrategySourceType = "HERMES_APPROVED" | "DEMO_ONLY";

// The smallest closed rule vocabulary this phase supports. Anything a registry strategy asks for
// outside this set is a clear, logged rejection (internal-strategy-mapper.ts) — never silently
// ignored or approximated.
export type EntryRule = { type: "CROSSES_ABOVE_MA"; period: number };

export type ExitRule =
  | { type: "TAKE_PROFIT"; percent: number }
  | { type: "STOP_LOSS"; percent: number }
  | { type: "CROSSES_BELOW_MA"; period: number };

export interface RiskRules {
  /** Per-strategy notional cap for a single position, enforced by the risk engine. */
  maxPositionValue: number;
}

/** The execution engine's own strategy representation — registry documents are translated into
 * this shape once, at load time, so nothing downstream needs to know the Hermes JSON schema. */
export interface InternalStrategy {
  strategyId: string;
  version: number;
  sourceType: StrategySourceType;
  enabled: boolean;
  instrument: string;
  timeframe: string;
  entryRules: EntryRule[];
  exitRules: ExitRule[];
  riskRules: RiskRules;
  /** Set only for DEMO_ONLY strategies — an unmissable label, never present on a real strategy. */
  demoLabel?: string;
}

export interface Candle {
  symbol: string;
  timestamp: string; // ISO 8601
  open: number;
  high: number;
  low: number;
  close: number;
  /** Phase 2A follow-up — Volume Nullability. Optional: CONFIRMED live (via a real
   * `npm run market:diagnostics` run against eToro) that a real historical-candle response can
   * return `null` for volume despite eToro's own documented schema declaring it required/numeric
   * with no nullable flag — a genuine documentation/live-response discrepancy. `undefined` here
   * means "volume genuinely unknown," never fabricated as 0 (see
   * EtoroDemoBroker.getHistoricalCandles's own null->undefined normalization). No indicator in
   * technical-indicators.ts reads this field — EMA/RSI/ATR/trend are all price-only — so an absent
   * volume never affects a trading decision. */
  volume?: number;
}

export type SignalAction = "NO_ACTION" | "ENTER_LONG" | "ENTER_SHORT" | "EXIT_POSITION";

export interface SignalDecision {
  strategyId: string;
  strategyVersion: number;
  instrument: string;
  timestamp: string;
  action: SignalAction;
  reason: string;
  evaluatedValues: Record<string, number | string | boolean>;
}

export type OrderSide = "BUY" | "SELL";

/**
 * How a broker's `OrderRequest.quantity` (and the resulting `PaperPosition.quantity`) must be
 * interpreted to get a notional/exposure value out of it — see order-sizing.ts's own
 * `calculateNotional`, THE single place this interpretation happens. Every broker declares exactly
 * one of these in runtime-config/broker-capabilities.ts; nothing here ever infers it from a broker
 * name or instrument string.
 *
 * - "UNITS": `quantity` is an asset/share/contract count — notional = quantity x price. Trading212,
 *   Hyperliquid, and the generic LocalPaperBroker all use this (their own `closePosition` P/L
 *   formulas already assume it).
 * - "NOTIONAL": `quantity` IS the notional/invested amount already, in account currency — notional =
 *   quantity, full stop; price is never multiplied in. eToro's CFD adapter uses this — see
 *   etoro-demo-broker.ts's own top-of-class doc comment.
 */
export type OrderSizingMode = "UNITS" | "NOTIONAL";

export interface OrderRequest {
  strategyId: string;
  strategyVersion: number;
  sourceType: StrategySourceType;
  instrument: string;
  side: OrderSide;
  quantity: number;
  price: number;
  timestamp: string;
  takeProfitPercent?: number;
  stopLossPercent?: number;
}

export interface RiskCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export type RiskDecision =
  | { decision: "APPROVED"; checks: RiskCheck[] }
  | { decision: "REJECTED"; checks: RiskCheck[]; reasons: string[] };

export interface Account {
  cashBalance: number;
  startingCashBalance: number;
}

export interface PaperPosition {
  positionId: string;
  strategyId: string;
  strategyVersion: number;
  sourceType: StrategySourceType;
  instrument: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  entryTimestamp: string;
  entryOrderId: string;
  takeProfitPercent?: number;
  stopLossPercent?: number;
  /** Restart-Resilient Autonomy Phase. The broker's OWN durable position identifier (e.g. eToro's
   * numeric `positionID`, stringified) — distinct from `positionId` above, which is this pipeline's
   * own internally-assigned label (e.g. "etoro-position-3") and is never guaranteed stable across a
   * process restart. Only `EtoroDemoBroker` populates this today; every other broker leaves it
   * undefined (out of this phase's scope) — see position-reconciliation.ts, which requires a
   * genuine broker-native identifier to correlate a live broker position back to a durable
   * TradeLifecycleRecord, never `instrument` alone. */
  brokerPositionId?: string;
}

export interface CompletedTrade {
  tradeId: string;
  positionId: string;
  strategyId: string;
  strategyVersion: number;
  sourceType: StrategySourceType;
  instrument: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  entryTimestamp: string;
  entryOrderId: string;
  exitPrice: number;
  exitTimestamp: string;
  exitOrderId: string;
  realisedPnl: number;
  closeReason: string;
}

export type AuditEventType =
  | "STRATEGY_LOADED"
  | "STRATEGY_REJECTED"
  | "CANDLE_PROCESSED"
  | "SIGNAL_GENERATED"
  | "RISK_APPROVED"
  | "RISK_REJECTED"
  | "ORDER_SUBMITTED"
  | "POSITION_OPENED"
  | "POSITION_CLOSED"
  | "REALISED_PNL"
  // Hyperliquid Testnet Adapter Phase 1 — broker/order lifecycle events. ORDER_SUBMITTED and
  // POSITION_CLOSED above are reused as-is (their meaning is identical here); only genuinely new
  // concepts get a new event type.
  | "BROKER_CONNECTION_ATTEMPTED"
  | "BROKER_CONNECTION_SUCCEEDED"
  | "BROKER_CONNECTION_FAILED"
  | "ORDER_ACKNOWLEDGED"
  | "ORDER_FILLED"
  | "ORDER_CANCELLED"
  | "SMOKE_TEST_COMPLETED"
  | "SMOKE_TEST_FAILED"
  // Distinct from SMOKE_TEST_FAILED: an order stuck in NEW because the market is closed
  // (Trading212 queues market orders until the exchange reopens — documented, expected behaviour)
  // is not a broker/adapter failure, so it gets its own event type rather than being conflated
  // with a genuine failure.
  | "SMOKE_TEST_INCONCLUSIVE"
  // eToro Demo Adapter Phase 1 — genuinely new concepts only; everything reusable (ORDER_SUBMITTED,
  // ORDER_ACKNOWLEDGED, ORDER_FILLED, POSITION_OPENED, POSITION_CLOSED, ORDER_CANCELLED,
  // BROKER_CONNECTION_*, SMOKE_TEST_*) is reused as-is, same convention as the Hyperliquid/
  // Trading212 phases above.
  //
  // POSITION_CONFIRMED: eToro's API gives no single authoritative "this order became this
  // position" response — the adapter re-fetches the demo portfolio and matches the new position
  // by the order response's own identifier. This event marks that independent confirmation,
  // distinct from POSITION_OPENED (which fires as soon as the broker maps the order response,
  // before that confirmation happens).
  | "POSITION_CONFIRMED"
  // POSITION_CLOSE_SUBMITTED: distinct from POSITION_CLOSED (which means the close was confirmed)
  // — eToro's close call and its confirmation are two separate steps (submit, then re-fetch the
  // portfolio to confirm), unlike Hyperliquid/Trading212 where a single call's response is the
  // fill.
  | "POSITION_CLOSE_SUBMITTED"
  // Distinct from SMOKE_TEST_FAILED/SMOKE_TEST_INCONCLUSIVE: an order or position may still be
  // active and the script could not safely confirm cleanup — this demands manual follow-up, not
  // just "the test didn't pass."
  | "SMOKE_TEST_CLEANUP_REQUIRED"
  // eToro order reconciliation — confirmed live that a plain market order's response never
  // includes positionId, only { orderId, token }, so reconciling it into a concrete position means
  // polling the demo portfolio for a position whose own orderID matches. POSITION_CONFIRMED
  // (above) already covers "reconciliation succeeded" — these three cover the other observable
  // states of that polling process, not duplicated elsewhere.
  | "RECONCILIATION_STARTED"
  | "RECONCILIATION_PENDING"
  | "RECONCILIATION_TIMED_OUT"
  // eToro close verification — confirmed live that a position can still appear open on the very
  // first portfolio read right after closeDemoPosition() resolves, then disappear a few seconds
  // later (the same eventual-consistency behaviour as order reconciliation, applied symmetrically
  // to closing). POSITION_CLOSED (existing) already covers "close verified" once this polling
  // succeeds — not duplicated here.
  | "CLOSE_VERIFICATION_STARTED"
  | "CLOSE_VERIFICATION_PENDING"
  | "CLOSE_VERIFICATION_TIMED_OUT"
  // Milestone 2 — Market Decision Integration. Genuinely new concepts only: the decision itself
  // (action/confidence/reasoning) and whether it led to execution. Everything the resulting
  // BUY/SELL order or close actually does is still recorded by the existing ORDER_SUBMITTED /
  // POSITION_OPENED / POSITION_CLOSED / etc. events emitted by the broker methods this pipeline
  // calls — not duplicated here. Named MARKET_DECISION_RECEIVED, not HERMES_* — "Hermes" is
  // reserved for the external Nous Hermes Agent; this event records an internal deterministic
  // engine's own decision, not anything Hermes Agent decided.
  | "MARKET_DECISION_RECEIVED"
  | "EXECUTION_TRIGGERED"
  | "EXECUTION_SKIPPED"
  // Milestone 4 — Portfolio & Risk Engine. Fired by market-decision-runner.ts around a
  // PortfolioRiskEngine evaluation, always between MARKET_DECISION_RECEIVED and either
  // EXECUTION_TRIGGERED (approved) or EXECUTION_SKIPPED (blocked) for a BUY decision. Never fired
  // for SELL/HOLD — SELL is always permitted, HOLD never reaches the risk engine.
  | "RISK_CHECK_STARTED"
  | "RISK_CHECK_PASSED"
  | "RISK_CHECK_FAILED"
  // Milestone 6 — Trade Lifecycle & Performance Tracking. One event per TradeLifecycleService
  // transition/mutation (trade-lifecycle/trade-lifecycle-service.ts) — a parallel, complementary
  // record to MARKET_DECISION_RECEIVED/RISK_CHECK_*/EXECUTION_*/POSITION_* above, never a
  // replacement for them; this pipeline's own audit events still fire exactly as before.
  // TRADE_EXCURSION_UPDATED is the one event here that isn't a status transition — it's emitted
  // only when a live trade's MFE/MAE actually changes, not on every price observation.
  | "TRADE_LIFECYCLE_CREATED"
  | "TRADE_RISK_REJECTED"
  | "TRADE_APPROVED"
  | "TRADE_EXECUTION_SUBMITTED"
  | "TRADE_OPENED"
  | "TRADE_CLOSE_REQUESTED"
  | "TRADE_CLOSED"
  | "TRADE_EXECUTION_FAILED"
  | "TRADE_CLOSE_FAILED"
  | "TRADE_EXCURSION_UPDATED"
  // Milestone 7 — 24/7 Scheduler & Runtime Control. TradingRuntime's own lifecycle (start/stop/
  // pause/resume) and each scheduled cycle's outcome (started/completed/failed/skipped-for-one-of-
  // three-reasons) — a third, parallel audit layer alongside Milestone 6's TRADE_* events (which
  // still fire exactly as before, from inside the same runMarketDecisionCycleWithLifecycle call a
  // TRADING_CYCLE_STARTED/COMPLETED/FAILED pair wraps). No "TRADING_RUNTIME_STOPPING" event —
  // TRADING_RUNTIME_STOPPED fires once shutdown is actually complete (any in-flight cycle has
  // finished), not when it merely begins.
  | "TRADING_RUNTIME_STARTED"
  | "TRADING_RUNTIME_STOPPED"
  | "TRADING_RUNTIME_PAUSED"
  | "TRADING_RUNTIME_RESUMED"
  | "TRADING_CYCLE_STARTED"
  | "TRADING_CYCLE_COMPLETED"
  | "TRADING_CYCLE_FAILED"
  | "TRADING_CYCLE_SKIPPED_OVERLAP"
  | "TRADING_CYCLE_SKIPPED_PAUSED"
  | "TRADING_CYCLE_SKIPPED_MARKET_CLOSED"
  // Phase 3.5 — Trade Review & Approval. A new, parallel audit layer for the TradeCandidate
  // lifecycle (trade-approval/trade-candidate-service.ts) — deliberately distinct names from the
  // existing TRADE_APPROVED (Milestone 6, meaning "PortfolioRiskEngine's automatic check passed",
  // nothing to do with a human) to avoid colliding with that already-shipped meaning. Fired instead
  // of, never alongside, an automatic EXECUTION_TRIGGERED/broker call for a BUY/SELL decision — see
  // trading-runtime.ts's own runCycleBody, which no longer calls runMarketDecisionCycleWithLifecycle
  // automatically at all.
  | "TRADE_CANDIDATE_CREATED"
  | "TRADE_CANDIDATE_APPROVED"
  | "TRADE_CANDIDATE_REJECTED"
  | "TRADE_CANDIDATE_EXPIRED"
  | "TRADE_CANDIDATE_EXECUTED"
  | "TRADE_CANDIDATE_EXECUTION_FAILED"
  // Restart-Resilient Autonomy Phase — position-reconciliation.ts. Fired once per cycle (and at
  // startup) for the configured instrument, always in this relative order when applicable:
  // BROKER_POSITION_DISCOVERED (a real, live broker position for this instrument was found at all)
  // -> either BROKER_POSITION_RECONCILED (it matches an existing durable TradeLifecycleRecord) or
  // BROKER_POSITION_ORPHANED (no durable record referenced it — the exact "PM2 restarted and lost
  // context" / "position exists at eToro but no lifecycle record exists locally" scenario; a new
  // lifecycle record is adopted from the broker's own genuinely-reported fields only, never a
  // guessed/fabricated one). BROKER_RECONCILIATION_FAILED fires instead of any of the above whenever
  // the broker's portfolio could not be read at all, or reported an ambiguous state (e.g. more than
  // one live position for the configured instrument) — this cycle's fresh entry decision is skipped
  // entirely (fail closed) whenever this fires.
  | "BROKER_POSITION_DISCOVERED"
  | "BROKER_POSITION_RECONCILED"
  | "BROKER_POSITION_ORPHANED"
  | "BROKER_RECONCILIATION_FAILED"
  // Restart-Resilient Autonomy Phase — runtime/exit-monitor.ts. Fired the moment any automatic exit
  // trigger (stop loss / take profit / opposing strategy signal / max holding duration / strategy
  // disabled / kill switch) is detected for a reconciled open position, BEFORE the broker close call
  // is attempted — so the trigger itself is always recorded even if the close subsequently fails.
  // POSITION_CLOSED/REALISED_PNL (existing, unchanged) still fire from inside the broker's own
  // closePosition — never duplicated here.
  | "AUTOMATIC_EXIT_TRIGGERED"
  // Restart-Resilient Autonomy Phase — trade-approval/trade-candidate-service.ts. Fired ONLY for an
  // AUTO_DEMO auto-approval, always in addition to (never instead of) the existing
  // TRADE_CANDIDATE_APPROVED event approveTradeCandidate() itself already emits for every approval,
  // human or automatic — this is what makes the two kinds of approval distinguishable in the audit
  // trail (`approvedByUserId` alone is also a marker, but never the only one).
  | "TRADE_CANDIDATE_AUTO_APPROVED"
  // Restart-Resilient Autonomy Phase — duplicate-prevention.ts. Fired when a fresh BUY decision is
  // deliberately NOT turned into a new TradeCandidate because an equivalent one (broker position,
  // durable OPEN/in-flight lifecycle record, PENDING or APPROVED candidate) already exists for the
  // same strategy + instrument.
  | "DUPLICATE_ENTRY_SUPPRESSED"
  // Restart-Resilient Autonomy Phase — reconciliation/kill-switch hardening. Fired at every point
  // entry activity (fresh BUY candidate creation, AUTO_DEMO auto-approval, or execution of a
  // previously-APPROVED BUY candidate) is skipped specifically because killSwitchEnabled is true —
  // distinct from DUPLICATE_ENTRY_SUPPRESSED (a different reason for the same "no new BUY this
  // cycle" outcome) so an operator can tell "the kill switch is doing its job" apart from ordinary
  // duplicate suppression. `details.context` names which of the three call sites fired it.
  | "KILL_SWITCH_ENTRY_BLOCKED"
  // Restart-Resilient Autonomy Phase — reconciliation/cycle-ordering hardening. Fired when a
  // previously-APPROVED BUY candidate's execution is deferred (left APPROVED, untouched, to be
  // reconsidered next cycle) because reconciliation already shows a broker position or an
  // unresolved lifecycle record active for this strategy+instrument — never because of the kill
  // switch (that gets its own KILL_SWITCH_ENTRY_BLOCKED event above).
  | "APPROVED_CANDIDATE_EXECUTION_DEFERRED"
  // Restart-Resilient Autonomy Phase — reconciliation hardening. Fired when reconciliation finds a
  // local record still in an active status (OPEN/CLOSE_REQUESTED/CLOSE_FAILED) for this
  // strategy+instrument, but a clean, successful broker read reports no matching position at all —
  // `details.resolution` says what happened next: "reconciled-closed-unreconciled" (the mismatch was
  // safely resolved to CLOSED_UNRECONCILED, broker evidence being authoritative for that record's
  // status) or "failed-closed" (the mismatch could not be safely resolved automatically).
  | "BROKER_RECONCILIATION_MISMATCH"
  // Restart-Resilient Autonomy Phase — reconciliation hardening. Fired instead of adopting a
  // "new" orphaned broker position whenever more than one local lifecycle record is found that
  // could plausibly already represent it (same brokerPositionId across several records, or more
  // than one locally-active record for the same strategy+instrument) — reconciliation refuses to
  // guess which one is authoritative and fails closed rather than ever risking a second record for
  // one real position. Also fired when the DATABASE's own uniqueness constraint (migration 0026's
  // two partial unique indexes) rejects an insert/update that this process's own pre-check missed
  // (e.g. a genuine cross-process race) — `details.detectedBy` distinguishes
  // "local-pre-check"/"database-constraint".
  | "DUPLICATE_LIFECYCLE_RECORD_DETECTED"
  // Restart-Resilient Autonomy Phase — reconciliation hardening. Fired when reconciliation finds a
  // CLOSE_FAILED record whose broker position is STILL live — the prior close attempt failed, but
  // the position itself is confirmed unchanged, so the record is safely reverted to OPEN (a real,
  // validated state-machine transition — see trade-lifecycle/types.ts's own VALID_TRANSITIONS) to
  // be re-evaluated fresh by the normal automatic-exit path next.
  | "TRADE_LIFECYCLE_REOPENED_FOR_RETRY"
  // Restart-Resilient Autonomy Phase — crash-window recovery (deployment safety review,
  // runtime/lifecycle-recovery.ts). Fired whenever the recovery sweep transitions a stale
  // DECISION_CREATED/APPROVED/EXECUTION_SUBMITTED/EXECUTION_RECONCILIATION_REQUIRED record to the
  // terminal EXECUTION_ABANDONED status, having proven (or, for DECISION_CREATED/APPROVED, having
  // relied on the structural guarantee that no broker call could yet have occurred) that no real
  // broker order/position exists for it. Recorded BEFORE the store transition itself (deliberately
  // reversing this codebase's usual "store first, audit second" order) — see that module's own doc
  // comment for why a durability failure here must block the transition rather than silently
  // succeed with an incomplete trail.
  | "LIFECYCLE_RECOVERY_ABANDONED"
  // Restart-Resilient Autonomy Phase — crash-window recovery. Fired when the recovery sweep
  // correlates a stale EXECUTION_SUBMITTED record against the broker's own authoritative portfolio
  // read and finds exactly one matching, previously-unassociated real position — the EXISTING
  // record is transitioned to OPEN and attached to it (never a second, new record).
  | "LIFECYCLE_RECOVERY_CORRELATED"
  // Restart-Resilient Autonomy Phase — crash-window recovery. Fired when the recovery sweep cannot
  // determine a stale EXECUTION_SUBMITTED record's fate from the broker's own state (a read
  // failure, more than one plausible match, or a broker that cannot make an authoritative claim
  // either way) — the record is transitioned to (or left at) EXECUTION_RECONCILIATION_REQUIRED,
  // remaining active and blocking a fresh entry until a later sweep resolves it.
  | "LIFECYCLE_RECOVERY_AMBIGUOUS"
  // Restart-Resilient Autonomy Phase — candidate/lifecycle repair (deployment safety review). Fired
  // when a TradeCandidate stuck APPROVED (its own execution attempt crashed after the underlying
  // TradeLifecycleRecord reached OPEN, or after that record later resolved to CLOSED_UNRECONCILED)
  // is repaired to EXECUTED, tying the two records' bookkeeping back together — never calls the
  // broker and never re-runs risk checks; the position's existence is already proven by the
  // lifecycle record itself.
  | "CANDIDATE_EXECUTION_RECONCILED"
  // Restart-Resilient Autonomy Phase — candidate/lifecycle repair. Fired (never silently) whenever a
  // TradeCandidate already marked FAILED is found to have a confirmed, real broker position open
  // against its own originating lifecycle record — deliberately NOT a status change (the candidate
  // state machine has no FAILED -> EXECUTED transition, and rewriting FAILED to EXECUTED would erase
  // a real, historically-accurate signal that the execution flow itself reported failure) — this is
  // the "documented repair transition" alternative: a clear, durable, actionable record for an
  // operator that the two stores disagree and manual review is warranted.
  | "CANDIDATE_FAILED_WITH_CONFIRMED_BROKER_POSITION"
  // Prototype 1.0 — official Hermes Agent decision integration. Genuinely new concepts: these are
  // the first AuditEventType values ever named HERMES_* — every earlier event in this pipeline
  // (MARKET_DECISION_RECEIVED, etc.) deliberately avoided that prefix because "Hermes" meant the
  // external Nous Hermes Agent, not this deterministic pipeline (see MARKET_DECISION_RECEIVED's own
  // comment above). Now that the official Hermes Agent genuinely is the decision brain for this
  // strategy, these events record its own scan/proposal/rejection outcomes specifically.
  | "UNIVERSE_SCAN_COMPLETED"
  | "HERMES_PROPOSAL_SELECTED"
  | "HERMES_RESPONSE_REJECTED"
  | "DAILY_PORTFOLIO_SUMMARY"
  // Prototype 1.0 — Telegram observability. Recorded whenever an outbound notification (through
  // either AlertSender implementation — the direct Telegram bot transport or the Hermes gateway
  // bridge) fails to deliver. Never throws into the caller (delivery is always best-effort — see
  // TelegramAlertingAuditTrail's own doc comment); this is the "log or audit a redacted
  // notification failure" record that replaces a silent, invisible swallow.
  | "TELEGRAM_NOTIFICATION_FAILED"
  // Hardening pass — opposing-signal exit stability. Fired instead of (never alongside) an
  // automatic exit whenever evaluateExitTrigger's own raw OPPOSING_SIGNAL result is deferred by
  // runtime/opposing-signal-stability.ts's own minimum-hold-period/consecutive-confirmation gate —
  // stop-loss/take-profit/kill-switch/strategy-disabled/max-holding are never gated this way and
  // never emit this event. `details.reason` names which gate blocked it
  // ("min-hold-not-reached" | "insufficient-confirmations"); `details.consecutiveCount`/
  // `details.requiredConsecutiveSignals` are always included so an operator can see exactly how
  // close the position is to actually closing.
  | "OPPOSING_SIGNAL_EXIT_DEFERRED"
  // Remediation pass (senior review finding C2) — fired ONCE per eligible instrument, every
  // universe scan, for BUY, SELL, *and* HOLD alike — the explicit decision-visibility event
  // HERMES_PROPOSAL_SELECTED could never provide on its own (that event is fired only for
  // SELECTED BUY/SELL proposals; an instrument Hermes decided to hold has no proposal at all, and
  // therefore previously left no audit trace whatsoever — see universe-scanner.ts's own
  // runUniverseScan). audit-derivations.ts's own listDecisions now treats this as the authoritative
  // per-instrument decision stream (falling back to HERMES_PROPOSAL_SELECTED only for an audit log
  // that predates this event entirely — see its own doc comment). `details.action` is always
  // "BUY" | "SELL" | "HOLD"; `details.confidence`/`details.reasoning` are only ever Hermes's own
  // validated proposal fields for BUY/SELL — never fabricated for HOLD (both are omitted, not
  // defaulted to a guessed value, in that case).
  | "HERMES_INSTRUMENT_DECISION_RECORDED";

export interface AuditEvent {
  timestamp: string;
  eventType: AuditEventType;
  executionRunId: string;
  strategyId?: string;
  strategyVersion?: number;
  sourceType?: StrategySourceType;
  instrument?: string;
  details: Record<string, unknown>;
}

// --- Registry consumer types -------------------------------------------------------------------

/** The Hermes strategy-registry document shape this phase understands (schemaVersion "1.0.0").
 * Deliberately a partial, defensive view — only the fields this pipeline actually reads. */
export interface RawRegistryStrategy {
  schemaVersion: string;
  strategyId: string;
  version: number;
  status: string;
  sourceHypothesisId: string;
  supportingResearchRuns: string[];
  promotionStatus: {
    decision: string;
    evaluatedAt: string;
    reasoning: string;
    evaluatedAgainstGovernanceVersion: string;
  };
  supportedMarkets: string[];
  timeframe: string;
  entryDefinition: { rule: string; parameters?: Record<string, unknown> };
  exitDefinition: { rule: string; parameters?: Record<string, unknown> };
  riskDefinition: {
    maxPositionSize: number | null;
    maxDrawdownHalt: number | null;
    notes?: string;
  };
  confidence: { level: string; reasoning: string };
  createdAt: string;
  lastReviewedAt: string;
}

export interface RegistryRejection {
  /** The file path or identifier of the offending document, for diagnostics. */
  source: string;
  reason: string;
}

export interface RegistryLoadResult {
  strategies: RawRegistryStrategy[];
  rejected: RegistryRejection[];
}

export interface MappingRejection {
  strategyId: string;
  reason: string;
}
