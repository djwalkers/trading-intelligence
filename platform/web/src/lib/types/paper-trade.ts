import type { EvidenceRating, Recommendation } from "./market-intelligence";
import type { MarketDataMode, MarketDataSource } from "./market-data";
import type { AgreementLevel } from "./strategy-engine";
import type { PortfolioExposureSnapshot } from "./portfolio-risk";
import type { PositionAction } from "./position-manager";

export type PaperTradeSide = "BUY" | "SELL";
export type PaperTradeStatus = "Open" | "Closed";
export type PaperTradeSource = "Signal" | "Market Intelligence" | "Bot";

export interface PaperTradeIntelligenceContext {
  recommendation: Recommendation;
  evidence: EvidenceRating[];
  evidenceFactors: string[];
  invalidationFactors: string[];
}

// Provenance for a trade's entry price, resolved from MarketDataProvider at the moment a trade
// is placed (Build 1.2.0) — mirrors the shape of a MarketQuote plus the mode it was served under,
// so a trade entered while the external provider had failed can still show that it fell back to
// mock, even after the provider itself has since recovered.
export interface EntryPriceInfo {
  price: number;
  source: MarketDataSource;
  provider: string;
  timestamp: string;
  mode: MarketDataMode;
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
  // Optional, backward compatible — absent on every trade placed before Build 1.2.0 (and on any
  // trade built without an EntryPriceInfo). Never required for P/L math; purely informational.
  entryPriceSource?: MarketDataSource;
  entryPriceProvider?: string;
  entryPriceTimestamp?: string;
  // Optional, backward compatible — populated for Market-Intelligence-sourced trades (Build
  // 1.3.0) and Bot-sourced trades (Mission 1), since both flows run through the Strategy Engine.
  // Signals-page trades use the older, separate mock signal system and never set these.
  // evidenceSummary is the engine's own agreementExplanation for the instrument at trade time.
  primaryStrategy?: string;
  strategyAgreement?: AgreementLevel;
  overallConfidence?: number;
  evidenceSummary?: string;
  // Optional, backward compatible — populated only for Bot-sourced trades (Mission 1).
  // sourceBotDecisionId links back to the BotDecision log entry that created this trade (the
  // decision log itself is a simple, local-browser-only feature — see
  // src/lib/state/bot-decision-log-context.tsx — not persisted in this schema).
  sourceBotDecisionId?: string;
  riskChecksSummary?: string;
  // Optional, backward compatible — populated only for Bot-sourced trades (Mission 1.1).
  // Links back to the specific scan (e.g. "SCAN-000004") that produced this trade, distinct from
  // sourceBotDecisionId: a scan can reject several candidates before one opens a trade, and this
  // is the scan-level id, not a per-candidate one.
  scanId?: string;
  // Optional, backward compatible — populated only for Bot-sourced trades (Mission 2). A trade
  // only ever gets created after the Portfolio Risk Manager's checks pass, so
  // portfolioRiskStatus is always "Passed" in practice today — kept as a status (not a bare
  // boolean) since a future mission could persist a rejected attempt. portfolioExposureSnapshot
  // is the portfolio's exposure immediately *before* this trade was added, for audit purposes only
  // — never read by any P/L calculation.
  portfolioRiskStatus?: "Passed" | "Failed";
  portfolioRiskSummary?: string;
  portfolioExposureSnapshot?: PortfolioExposureSnapshot;
  // Optional, backward compatible — populated only for Bot-sourced trades (Mission 3). Records
  // how the Position Manager classified this trade against any pre-existing position in the same
  // instrument — always "NEW_POSITION" or "ADD_TO_POSITION" in practice, since a trade is only
  // ever created for those two classifications (HOLD_POSITION/BLOCK_POSITION never produce a
  // trade) — kept as the full action type rather than a boolean for a readable audit trail.
  positionAction?: PositionAction;
  existingPositionValue?: number;
  positionValueAfterTrade?: number;
  positionDecisionReason?: string;
}
