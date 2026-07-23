import type { MarketDataSnapshot } from "../market-data/market-data-provider";
import type { MarketDecisionContext } from "../market-decision-engine";
import type { OrderSide } from "../types";

// Phase 3.5 — Trade Review & Approval. New flow: Analyse -> Decision -> Trade Candidate -> Persist
// -> Review UI -> Approved? -> Broker. A TradeCandidate is a BUY/SELL decision MarketDecisionEngine
// already made (unmodified), frozen at the moment of decision, awaiting a human's yes/no before the
// existing, unmodified risk-check + broker pipeline (runMarketDecisionCycleWithLifecycle) is ever
// allowed to run against it. HOLD decisions never produce one — there is nothing to review.
//
// Deliberately its own top-level concept, not a new TradeLifecycleStatus value: TradeLifecycleRecord
// (trade-lifecycle/types.ts) already has a status literally named "APPROVED", meaning "the
// automatic PortfolioRiskEngine check passed" — nothing to do with a human. Reusing that name or
// enum here would silently collide with an unrelated, already-shipped meaning. A TradeCandidate
// exists entirely upstream of TradeLifecycleRecord: it is reviewed and approved (or rejected) BEFORE
// any TradeLifecycleRecord/risk-check/broker call is ever made for it.

export type TradeCandidateStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "EXECUTED" | "FAILED";

/** Every valid outgoing transition — same enforcement style as trade-lifecycle/types.ts's own
 * VALID_TRANSITIONS. PENDING is the only state a human or the expiry sweep can leave via more than
 * one path; every other state is terminal except APPROVED, which leads to exactly one of the two
 * execution outcomes. */
export const VALID_CANDIDATE_TRANSITIONS: Record<TradeCandidateStatus, readonly TradeCandidateStatus[]> = {
  PENDING: ["APPROVED", "REJECTED", "EXPIRED"],
  APPROVED: ["EXECUTED", "FAILED", "EXPIRED"],
  REJECTED: [],
  EXPIRED: [],
  EXECUTED: [],
  FAILED: [],
};

export class InvalidTradeCandidateTransitionError extends Error {
  constructor(
    public readonly from: TradeCandidateStatus,
    public readonly to: TradeCandidateStatus,
  ) {
    super(
      `Invalid trade candidate transition: ${from} -> ${to}. Valid transitions from ${from}: ${
        VALID_CANDIDATE_TRANSITIONS[from].length > 0 ? VALID_CANDIDATE_TRANSITIONS[from].join(", ") : "(none — terminal state)"
      }.`,
    );
    this.name = "InvalidTradeCandidateTransitionError";
  }
}

export function assertValidCandidateTransition(from: TradeCandidateStatus, to: TradeCandidateStatus): void {
  if (!VALID_CANDIDATE_TRANSITIONS[from].includes(to)) {
    throw new InvalidTradeCandidateTransitionError(from, to);
  }
}

/**
 * The frozen inputs needed to actually execute this candidate later, exactly as it was reviewed —
 * never re-fetched or re-derived at approval time. `marketContext`/`marketDataSnapshot` are reused
 * verbatim by executeApprovedTradeCandidate (trade-candidate-service.ts) as the input to the
 * existing, unmodified runMarketDecisionCycleWithLifecycle — the same "reuse the raw provider read
 * verbatim, never re-derive" convention TradeLifecycleRecord.marketDataSnapshot already established.
 */
export interface TradeCandidateExecutionSnapshot {
  marketContext: MarketDecisionContext;
  marketDataSnapshot: MarketDataSnapshot;
  amount: number;
}

export interface TradeCandidateInput {
  /** Cross-reference to market_analysis_runs.id (Phase 2B) for the same cycle, when analysis
   * persistence is configured and that write succeeded. That layer is documented best-effort and
   * can be silently missing (see analysis-repository.ts) — undefined here does not mean "no
   * analysis happened," only that no durable analysis row exists to cross-reference. The
   * TradeCandidate row itself is the durable record of "what analysis produced this candidate"
   * regardless: reasoning/confidence/indicators/context are captured directly on the candidate,
   * never solely behind this optional pointer. */
  analysisRunId: string | undefined;
  strategyId: string;
  strategyVersion: number;
  instrument: string;
  direction: OrderSide;
  confidence: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** (takeProfit - entryPrice) / (entryPrice - stopLoss) in reward:risk terms, always positive —
   * informational only (see build-trade-candidate.ts). Never enforced as a bracket order and never
   * fed back into MarketDecisionEngine/strategy logic. */
  riskReward: number;
  reasoning: string[];
  validationNotes: string[];
  expiresAt: string;
  execution: TradeCandidateExecutionSnapshot;
}

export interface TradeCandidate extends TradeCandidateInput {
  id: string;
  status: TradeCandidateStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedByUserId?: string;
  rejectedAt?: string;
  rejectedByUserId?: string;
  rejectionReason?: string;
  executedAt?: string;
  /** Set once execution succeeds — the resulting TradeLifecycleRecord's own id (see
   * trade-candidate-service.ts's executeApprovedTradeCandidate), for cross-referencing P/L and
   * position tracking. Undefined until EXECUTED. */
  lifecycleRecordId?: string;
  brokerOrderId?: string;
  failureReason?: string;
}
