import type { OrderSide } from "../types";

// Phase 4 — Trade Performance Engine. Purely observational: measures a trade after it closes,
// never influences MarketDecisionEngine, a Strategy, PortfolioRiskEngine, the broker, the runtime
// scheduler, or the trade approval workflow. See trade-performance-service.ts's own top-of-file
// comment for exactly where a TradePerformanceRecord comes from.

export type WinLoss = "WIN" | "LOSS" | "BREAKEVEN";

export interface TradePerformanceInput {
  /** TradeLifecycleRecord.id — see the migration's own column comment for why this, not a uuid,
   * is the natural de-duplication key. */
  tradeId: string;
  analysisRunId: string | undefined;
  candidateId: string | undefined;
  strategyId: string;
  strategyVersion: number;
  instrument: string;
  side: OrderSide;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  holdingTimeMs: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  returnPercent: number;
  /** Null when no originating BUY-side stop-loss could be resolved for this trade — never
   * fabricated as 0 or omitted silently. */
  riskMultiple: number | undefined;
  maxFavourableExcursion: number;
  maxAdverseExcursion: number;
  peakProfit: number;
  maximumDrawdown: number;
  winLoss: WinLoss;
  exitReason: string | undefined;
}

export interface TradePerformanceRecord extends TradePerformanceInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}
