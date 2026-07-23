import type { TradeLifecycleRecord } from "../trade-lifecycle/types";
import type { TradeCandidate } from "../trade-approval/types";
import type { TradePerformanceInput, WinLoss } from "./types";

// Phase 4 — Trade Performance Engine. Pure, side-effect-free — no clock, no I/O, no randomness —
// same discipline trade-lifecycle/calculations.ts already established for exactly this reason: PnL/
// risk math should be directly unit-testable without a store, service, or repository in play.
// Never re-evaluates a decision, never re-runs risk, never talks to a broker; every input here was
// already computed by unmodified, existing code (TradeLifecycleService, MarketDecisionEngine via
// the originating TradeCandidate).

/** Matches DecisionIntelligenceView's own established Win/Loss/Neutral threshold (see
 * OutcomeBadge's doc comment) — a trade closing within 1 cent of break-even reads as BREAKEVEN,
 * never an arbitrary WIN or LOSS. */
const BREAKEVEN_THRESHOLD = 0.01;

export function classifyWinLoss(netPnl: number): WinLoss {
  if (netPnl > BREAKEVEN_THRESHOLD) return "WIN";
  if (netPnl < -BREAKEVEN_THRESHOLD) return "LOSS";
  return "BREAKEVEN";
}

/**
 * net_pnl / initial dollar risk, where initial dollar risk is |entryPrice - stopLoss| x quantity
 * on the ORIGINATING (opening) TradeCandidate — never the closing candidate's own stopLoss, which
 * describes a hypothetical fresh entry at close time, not the risk actually taken when this
 * position was opened. Undefined when no opening candidate (and therefore no stop-loss) could be
 * resolved, or when the resolved stop-loss implies zero risk (never returns Infinity/NaN).
 */
export function calculateRiskMultiple(
  netPnl: number,
  openingCandidate: Pick<TradeCandidate, "entryPrice" | "stopLoss" | "execution"> | undefined,
): number | undefined {
  if (!openingCandidate) return undefined;
  const riskPerUnit = Math.abs(openingCandidate.entryPrice - openingCandidate.stopLoss);
  const dollarRisk = riskPerUnit * openingCandidate.execution.amount;
  if (!Number.isFinite(dollarRisk) || dollarRisk <= 0) return undefined;
  return netPnl / dollarRisk;
}

/** peak_profit is simply maximumFavourableExcursion (already guaranteed >= 0 by
 * updateExcursionValues' own convention — see calculations.ts) under a dashboard-friendlier name.
 * maximum_drawdown is how much of that peak was given back before the trade closed — an
 * approximation from entry/exit/MFE/MAE snapshots only (this pipeline retains no full intra-trade
 * price path), floored at 0 so it is never negative. */
export function calculatePeakProfitAndDrawdown(
  maxFavourableExcursion: number,
  netPnl: number,
): { peakProfit: number; maximumDrawdown: number } {
  const peakProfit = Math.max(0, maxFavourableExcursion);
  const maximumDrawdown = Math.max(0, peakProfit - netPnl);
  return { peakProfit, maximumDrawdown };
}

export interface BuildTradePerformanceInputOptions {
  /** A CLOSED TradeLifecycleRecord only — callers must check record.status themselves (this
   * function trusts entryPrice/exitPrice/openedAt/closedAt/realisedPnl/holdingDurationMs are all
   * already populated, which is only true once CLOSED). */
  record: TradeLifecycleRecord;
  /** The SELL TradeCandidate whose execution closed this record — supplies candidateId and
   * analysisRunId. */
  closingCandidate: Pick<TradeCandidate, "id" | "analysisRunId">;
  /** The BUY TradeCandidate that originally opened this position, if it could be resolved — supplies
   * the stop-loss risk_multiple is computed against. Undefined is a legitimate, expected case (not
   * every open position can be traced back to the candidate that opened it — see
   * trade-performance-service.ts's own findOpeningCandidate). */
  openingCandidate: Pick<TradeCandidate, "entryPrice" | "stopLoss" | "execution"> | undefined;
  /** No fee modelling exists anywhere in this paper-trading pipeline today — defaults to 0,
   * accepted as an explicit parameter (not hard-coded inline) so a future live-fee integration has
   * an obvious single seam to fill in, without this function's own formulas changing. */
  fees?: number;
}

export function buildTradePerformanceInput(options: BuildTradePerformanceInputOptions): TradePerformanceInput {
  const { record, closingCandidate, openingCandidate, fees = 0 } = options;

  if (record.status !== "CLOSED") {
    throw new Error(`buildTradePerformanceInput requires a CLOSED TradeLifecycleRecord, got "${record.status}".`);
  }
  if (
    record.entryPrice === undefined ||
    record.exitPrice === undefined ||
    record.openedAt === undefined ||
    record.closedAt === undefined ||
    record.realisedPnl === undefined ||
    record.holdingDurationMs === undefined
  ) {
    throw new Error(`TradeLifecycleRecord "${record.id}" is CLOSED but missing required close fields.`);
  }

  const grossPnl = record.realisedPnl;
  const netPnl = grossPnl - fees;
  const entryNotional = record.entryPrice * record.quantity;
  const returnPercent = entryNotional > 0 ? (netPnl / entryNotional) * 100 : 0;
  const maxFavourableExcursion = record.maximumFavourableExcursion ?? 0;
  const maxAdverseExcursion = record.maximumAdverseExcursion ?? 0;
  const { peakProfit, maximumDrawdown } = calculatePeakProfitAndDrawdown(maxFavourableExcursion, netPnl);

  return {
    tradeId: record.id,
    analysisRunId: closingCandidate.analysisRunId,
    candidateId: closingCandidate.id,
    strategyId: record.strategyId,
    strategyVersion: record.intelligenceSummary.strategy.version,
    instrument: record.symbol,
    side: record.side,
    entryTime: record.openedAt,
    entryPrice: record.entryPrice,
    exitTime: record.closedAt,
    exitPrice: record.exitPrice,
    holdingTimeMs: record.holdingDurationMs,
    grossPnl,
    fees,
    netPnl,
    returnPercent,
    riskMultiple: calculateRiskMultiple(netPnl, openingCandidate),
    maxFavourableExcursion,
    maxAdverseExcursion,
    peakProfit,
    maximumDrawdown,
    winLoss: classifyWinLoss(netPnl),
    exitReason: record.exitReason,
  };
}
