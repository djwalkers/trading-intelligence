import type { EvidenceRating, Recommendation } from "./market-intelligence";

export type PaperTradeSide = "BUY" | "SELL";
export type PaperTradeStatus = "Open" | "Closed";
export type PaperTradeSource = "Signal" | "Market Intelligence";

export interface PaperTradeIntelligenceContext {
  recommendation: Recommendation;
  evidence: EvidenceRating[];
  evidenceFactors: string[];
  invalidationFactors: string[];
}

export interface PaperTrade {
  id: string;
  instrumentSymbol: string;
  instrumentName: string;
  side: PaperTradeSide;
  quantity: number;
  entryPrice: number;
  timestamp: string;
  signalConfidence: number;
  strategyName: string;
  status: PaperTradeStatus;
  reason: string;
  source: PaperTradeSource;
  sourceSignalId?: string;
  sourceOpportunityId?: string;
  intelligence?: PaperTradeIntelligenceContext;
  exitPrice?: number;
  closedAt?: string;
  realisedPnl?: number;
  realisedPnlPercent?: number;
}
