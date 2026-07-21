import type { MarketDataSnapshot } from "../market-data/market-data-provider";
import type { MarketDecisionAction, MarketDecisionContext } from "../market-decision-engine";
import type { PortfolioRiskDecision } from "../portfolio-risk-engine";
import type { OrderSide } from "../types";

// Milestone 6 — Trade Lifecycle & Performance Tracking. Reuses existing domain types wherever one
// already fits (OrderSide, MarketDecisionAction, MarketDecisionContext, MarketDataSnapshot,
// PortfolioRiskDecision) rather than re-declaring parallel shapes — see each field's own comment
// for which existing type it's drawn from.

/** The nine required lifecycle states, exactly as specified. A plain string-literal union (the
 * same modeling convention AuditEventType already uses in ../types.ts) — transition *validity* is
 * enforced separately by VALID_TRANSITIONS/assertValidTransition below, not encoded into the type
 * itself; see that table for the actual discriminated state graph. */
export type TradeLifecycleStatus =
  | "DECISION_CREATED"
  | "RISK_REJECTED"
  | "APPROVED"
  | "EXECUTION_SUBMITTED"
  | "OPEN"
  | "CLOSE_REQUESTED"
  | "CLOSED"
  | "EXECUTION_FAILED"
  | "CLOSE_FAILED";

/** Every valid outgoing transition for each status — a `Record` over the full
 * `TradeLifecycleStatus` union, so TypeScript itself enforces every status is accounted for (add a
 * tenth status later and this object literal fails to compile until it's added here too). An empty
 * array means terminal: RISK_REJECTED, CLOSED, EXECUTION_FAILED, and CLOSE_FAILED never transition
 * again in this milestone — no retry-from-failure path exists yet (see the mission report's
 * Limitations section). */
export const VALID_TRANSITIONS: Record<TradeLifecycleStatus, readonly TradeLifecycleStatus[]> = {
  DECISION_CREATED: ["RISK_REJECTED", "APPROVED"],
  RISK_REJECTED: [],
  APPROVED: ["EXECUTION_SUBMITTED"],
  EXECUTION_SUBMITTED: ["OPEN", "EXECUTION_FAILED"],
  OPEN: ["CLOSE_REQUESTED"],
  CLOSE_REQUESTED: ["CLOSED", "CLOSE_FAILED"],
  CLOSED: [],
  EXECUTION_FAILED: [],
  CLOSE_FAILED: [],
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
  /** Named `symbol` per the mission spec — the same concept `instrument` names everywhere else in
   * this pipeline (OrderRequest.instrument, MarketDecisionContext.instrument, ...) and that
   * `Candle.symbol` already names identically. Sourced from whichever of those the caller has. */
  symbol: string;
  side: OrderSide;
  quantity: number;
  /** The entry decision's action — reuses MarketDecisionEngine's own MarketDecisionAction rather
   * than a narrower literal, even though only "BUY" ever creates a record today (see
   * trade-lifecycle-runner.ts) — keeps this type honest if a future decision engine change ever
   * originates a lifecycle record from a different action. */
  decision: MarketDecisionAction;
  confidence: number;
  decisionReasons: string[];
  /** The raw provider read that fed MarketIntelligenceBuilder for this decision — reused verbatim,
   * never re-derived. */
  marketDataSnapshot: MarketDataSnapshot;
  /** The full built MarketDecisionContext (EMA/RSI/trend/session/... — everything
   * MarketIntelligenceBuilder produced) — reused verbatim as "the intelligence summary" rather than
   * inventing a second, overlapping summary type. */
  intelligenceSummary: MarketDecisionContext;
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
  exitPrice?: number;
  brokerOrderId?: string;
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
