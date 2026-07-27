import type { MarketDataSnapshot } from "../market-data/market-data-provider";
import type { MarketDecisionAction, MarketDecisionContext } from "../market-decision-engine";
import type { PortfolioRiskDecision } from "../portfolio-risk-engine";
import type { OrderSide, OrderSizingMode } from "../types";

// Milestone 6 — Trade Lifecycle & Performance Tracking. Reuses existing domain types wherever one
// already fits (OrderSide, MarketDecisionAction, MarketDecisionContext, MarketDataSnapshot,
// PortfolioRiskDecision) rather than re-declaring parallel shapes — see each field's own comment
// for which existing type it's drawn from.

/** The nine originally-specified lifecycle states, plus CLOSED_UNRECONCILED (Restart-Resilient
 * Autonomy Phase — reconciliation hardening). A plain string-literal union (the same modeling
 * convention AuditEventType already uses in ../types.ts) — transition *validity* is enforced
 * separately by VALID_TRANSITIONS/assertValidTransition below, not encoded into the type itself;
 * see that table for the actual discriminated state graph. */
export type TradeLifecycleStatus =
  | "DECISION_CREATED"
  | "RISK_REJECTED"
  | "APPROVED"
  | "EXECUTION_SUBMITTED"
  | "OPEN"
  | "CLOSE_REQUESTED"
  | "CLOSED"
  | "EXECUTION_FAILED"
  | "CLOSE_FAILED"
  /** Restart-Resilient Autonomy Phase — reconciliation hardening. A terminal outcome distinct from
   * CLOSED: reached when reconciliation confirms (a clean, successful broker read reporting no
   * matching position) that a position this runtime once tracked as OPEN/CLOSE_REQUESTED/
   * CLOSE_FAILED is genuinely gone, but this runtime never obtained a confirmed exit price/P&L for
   * it (the close attempt failed, or no close was ever attempted before the position disappeared —
   * e.g. closed manually against the same demo account). exitPrice/realisedPnl are deliberately
   * left null forever on such a record — see position-reconciliation.ts's own "never fabricate
   * exit price or realised P&L" discipline — closedAt/exitReason are still recorded so the record
   * is genuinely terminal (frees its strategy+instrument slot for a new entry) rather than stuck
   * demanding a retry that can never succeed. */
  | "CLOSED_UNRECONCILED"
  /** Restart-Resilient Autonomy Phase — crash-window recovery (deployment safety review). Terminal:
   * a lifecycle-recovery sweep (runtime/lifecycle-recovery.ts) proved, against the broker's own
   * authoritative state, that a record abandoned mid-execution (crashed while DECISION_CREATED/
   * APPROVED/EXECUTION_SUBMITTED) never became — or is no longer — a real broker position/order.
   * Releases the strategy+instrument uniqueness slot, same as CLOSED_UNRECONCILED, since nothing
   * real is left to track. Distinct from CLOSED_UNRECONCILED: that status means a position DID open
   * and this runtime lost track of its close; this one means the entry itself never (or no longer)
   * exists at the broker at all. */
  | "EXECUTION_ABANDONED"
  /** Restart-Resilient Autonomy Phase — crash-window recovery. A lifecycle-recovery sweep found a
   * stale EXECUTION_SUBMITTED record (the one genuinely ambiguous pre-OPEN status — the broker may
   * have accepted the order before this process crashed) whose fate could not be determined from
   * the broker's own state (a read failure, or more than one plausible matching position) — fails
   * closed rather than guessing either "it opened" or "it never happened". Deliberately NOT
   * terminal and deliberately still counted as active (see trade-lifecycle-store.ts's own
   * ACTIVE_STRATEGY_INSTRUMENT_STATUSES/ACTIVE_BROKER_POSITION_STATUSES and duplicate-prevention.ts's
   * IN_FLIGHT_STATUSES) — a later sweep may still resolve it once the ambiguity clears, and no new
   * entry may be proposed for this strategy+instrument while it remains unresolved. */
  | "EXECUTION_RECONCILIATION_REQUIRED";

/** Every valid outgoing transition for each status — a `Record` over the full
 * `TradeLifecycleStatus` union, so TypeScript itself enforces every status is accounted for (add a
 * tenth status later and this object literal fails to compile until it's added here too). An empty
 * array means terminal: RISK_REJECTED, CLOSED, EXECUTION_FAILED, and CLOSED_UNRECONCILED never
 * transition again. CLOSE_FAILED is no longer unconditionally terminal (Restart-Resilient Autonomy
 * Phase — reconciliation hardening): reconciliation may revert it to OPEN (the broker still shows
 * the position live — a safe retry, re-evaluated fresh next cycle through the normal automatic-exit
 * path) or resolve it to CLOSED_UNRECONCILED (the broker confirms the position is gone, but this
 * runtime has no confirmed exit economics for it) — see position-reconciliation.ts. Both of those
 * transitions are performed by position-reconciliation.ts directly against the store (the same
 * established "bypasses TradeLifecycleService's own API for a case it has no method for" pattern
 * orphan adoption already uses), validated through assertValidTransition here, never by mutating
 * `status` without going through this table. */
export const VALID_TRANSITIONS: Record<TradeLifecycleStatus, readonly TradeLifecycleStatus[]> = {
  DECISION_CREATED: ["RISK_REJECTED", "APPROVED", "EXECUTION_ABANDONED", "EXECUTION_RECONCILIATION_REQUIRED"],
  RISK_REJECTED: [],
  APPROVED: ["EXECUTION_SUBMITTED", "EXECUTION_ABANDONED", "EXECUTION_RECONCILIATION_REQUIRED"],
  EXECUTION_SUBMITTED: ["OPEN", "EXECUTION_FAILED", "EXECUTION_ABANDONED", "EXECUTION_RECONCILIATION_REQUIRED"],
  OPEN: ["CLOSE_REQUESTED", "CLOSED_UNRECONCILED"],
  CLOSE_REQUESTED: ["CLOSED", "CLOSE_FAILED", "CLOSED_UNRECONCILED"],
  CLOSED: [],
  EXECUTION_FAILED: [],
  CLOSE_FAILED: ["OPEN", "CLOSED_UNRECONCILED"],
  CLOSED_UNRECONCILED: [],
  EXECUTION_ABANDONED: [],
  // Resolved once a later sweep gets a definitive broker read: either it opened after all (OPEN)
  // or it's now provably gone/never happened (EXECUTION_ABANDONED).
  EXECUTION_RECONCILIATION_REQUIRED: ["OPEN", "EXECUTION_ABANDONED"],
};

/** Thrown by TradeLifecycleService whenever a caller attempts a transition not present in
 * VALID_TRANSITIONS — always thrown, never silently ignored or coerced to the nearest valid state. */
export class InvalidTradeLifecycleTransitionError extends Error {
  constructor(
    public readonly from: TradeLifecycleStatus,
    public readonly to: TradeLifecycleStatus,
  ) {
    super(
      `Invalid trade lifecycle transition: ${from} -> ${to}. Valid transitions from ${from}: ${
        VALID_TRANSITIONS[from].length > 0 ? VALID_TRANSITIONS[from].join(", ") : "(none — terminal state)"
      }.`,
    );
    this.name = "InvalidTradeLifecycleTransitionError";
  }
}

export function assertValidTransition(from: TradeLifecycleStatus, to: TradeLifecycleStatus): void {
  if (!VALID_TRANSITIONS[from].includes(to)) {
    throw new InvalidTradeLifecycleTransitionError(from, to);
  }
}

/** Populated on EXECUTION_FAILED/CLOSE_FAILED — the "error details" the mission's field list asks
 * for, kept as its own small type rather than loose optional strings on TradeLifecycleRecord. */
export interface TradeLifecycleError {
  message: string;
  occurredAt: string;
  context?: Record<string, unknown>;
}

/**
 * The full lifecycle record. `decision`/`confidence`/`decisionReasons` describe the ENTRY decision
 * only and are never overwritten by the later exit — "what decision was made, and why" always
 * answers about the original BUY that opened the trade; the exit's own rationale lives in
 * `exitReason` (a short string, matching the existing `CompletedTrade.closeReason`/
 * `PaperBroker.closePosition` convention — not a second full MarketDecision).
 *
 * `side` is the trade's entry side (matches `PaperPosition.side`) and never flips at close, even
 * though the order that closes a long position is itself a SELL — same convention `PaperPosition`
 * already uses.
 */
export interface TradeLifecycleRecord {
  id: string;
  strategyId: string;
  /** Restart-Resilient Autonomy Phase. Always known and populated (from the originating
   * InternalStrategy, whether via an executed candidate or an adopted orphaned position) — moved
   * to a top-level field so P/L reporting (calculate-trade-performance.ts) never has to reach
   * through the optional `intelligenceSummary` below, which an adopted record genuinely lacks. */
  strategyVersion: number;
  /** Restart-Resilient Autonomy Phase. Undefined for a record adopted from an orphaned broker
   * position (position-reconciliation.ts) — there is genuinely no originating TradeCandidate to
   * reference in that case, never a guessed one. Set for every record created the normal way (via
   * an executed candidate). */
  candidateId?: string;
  /** Restart-Resilient Autonomy Phase. The broker provider this record's position lives under (e.g.
   * "etoro-demo") — always known at creation time from runtime configuration, never inferred later.
   * Persisted so a durable store can distinguish/report across broker providers without needing to
   * join back to any other table. */
  brokerProvider: string;
  /** Named `symbol` per the mission spec — the same concept `instrument` names everywhere else in
   * this pipeline (OrderRequest.instrument, MarketDecisionContext.instrument, ...) and that
   * `Candle.symbol` already names identically. Sourced from whichever of those the caller has. */
  symbol: string;
  side: OrderSide;
  quantity: number;
  /** Broker Sizing Semantic Fix. How `quantity` must be interpreted to get a notional value —
   * frozen at creation time (the broker's own declared mode at the moment this record was opened)
   * and never re-derived later, so every P/L, MFE/MAE, and risk-multiple calculation against this
   * record uses the exact semantics the record was actually opened under. See order-sizing.ts's
   * own `calculateNotional`. */
  sizingMode: OrderSizingMode;
  /** The entry decision's action — reuses MarketDecisionEngine's own MarketDecisionAction rather
   * than a narrower literal, even though only "BUY" ever creates a record today (see
   * trade-lifecycle-runner.ts) — keeps this type honest if a future decision engine change ever
   * originates a lifecycle record from a different action. */
  decision: MarketDecisionAction;
  confidence: number;
  decisionReasons: string[];
  /** The raw provider read that fed MarketIntelligenceBuilder for this decision — reused verbatim,
   * never re-derived. Restart-Resilient Autonomy Phase: optional — a record adopted from an
   * orphaned broker position (position-reconciliation.ts) has no originating decision cycle, so
   * genuinely has none of this to reuse; never fabricated. */
  marketDataSnapshot?: MarketDataSnapshot;
  /** The full built MarketDecisionContext (EMA/RSI/trend/session/... — everything
   * MarketIntelligenceBuilder produced) — reused verbatim as "the intelligence summary" rather than
   * inventing a second, overlapping summary type. Restart-Resilient Autonomy Phase: optional, same
   * reason as `marketDataSnapshot` above. */
  intelligenceSummary?: MarketDecisionContext;
  /** Undefined until the risk engine has evaluated this trade (never set for a record that's still
   * only DECISION_CREATED). */
  portfolioRiskDecision?: PortfolioRiskDecision;
  status: TradeLifecycleStatus;
  createdAt: string;
  updatedAt: string;

  submittedAt?: string;
  openedAt?: string;
  closedAt?: string;
  entryPrice?: number;
  /** Restart-Resilient Autonomy Phase. Frozen at creation from the originating TradeCandidate, when
   * one exists — the level runtime/exit-monitor.ts's stop-loss/take-profit checks evaluate against.
   * Undefined for a record adopted from an orphaned broker position: genuinely unknown (no
   * candidate to trace it from), never guessed — exit-monitor.ts simply cannot evaluate that
   * specific trigger for such a record, and treats its absence as "not applicable," never as 0. */
  stopLoss?: number;
  takeProfit?: number;
  exitPrice?: number;
  brokerOrderId?: string;
  /** Restart-Resilient Autonomy Phase. The broker's OWN durable position identifier (see
   * PaperPosition.brokerPositionId's own doc comment) — set once the position is confirmed OPEN.
   * The one field position-reconciliation.ts actually matches a live broker position against,
   * never `symbol`/`strategyId` alone once this is available. */
  brokerPositionId?: string;
  exitReason?: string;
  realisedPnl?: number;
  realisedPnlPercent?: number;
  holdingDurationMs?: number;
  /** See calculations.ts's doc comment for the exact MFE/MAE convention (absolute currency, same
   * units/sign as realisedPnl — not percentage). */
  maximumFavourableExcursion?: number;
  maximumAdverseExcursion?: number;
  error?: TradeLifecycleError;
}
