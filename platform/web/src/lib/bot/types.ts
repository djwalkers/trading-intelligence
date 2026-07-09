import type {
  AgreementLevel,
  PaperTrade,
  PaperTradeSide,
  PortfolioExposureSnapshot,
  PositionAction,
} from "@/lib/types";

export interface BotRiskCheck {
  name: string;
  passed: boolean;
  detail: string;
}

// Whether a scan was triggered by a human clicking "Run Bot Scan" or by the scheduler (Mission 4)
// ticking on its own. Purely descriptive — every rule (individual, Position Manager, portfolio
// risk) applies identically regardless of trigger.
export type ScanTriggerType = "Manual" | "Scheduled";

// One ranked candidate's full evaluation — whether it was the one that opened a trade, was
// rejected in favour of trying the next-ranked candidate, or (last in the list) rejected with
// nothing left to fall back to. Every risk check for a candidate always runs and is always
// recorded, whether it passed or not.
//
// Three tiers, evaluated in order (Mission 3 adds the middle one): individual checks (Mission 1 —
// confidence, agreement, notional) run first; the Position Manager only runs — positionEvaluated /
// positionAction / positionChecks — once individualPassed is true; portfolio risk only runs —
// portfolioRiskEvaluated / portfolioRiskChecks / portfolioPassed — once the Position Manager
// returns NEW_POSITION or ADD_TO_POSITION (HOLD_POSITION/BLOCK_POSITION mean no trade for this
// candidate, so there's no point checking portfolio risk for it). If portfolio risk then fails,
// positionAction is overridden to BLOCK_POSITION so the final recorded action stays accurate.
export interface BotCandidateEvaluation {
  rank: number;
  instrumentSymbol: string;
  instrumentName: string;
  side: PaperTradeSide;
  confidence: number;
  agreement: AgreementLevel;
  // The individual strategy that drove this candidate's overall call (StrategyScore.
  // primaryStrategyName) and the plain-language agreement explanation
  // (StrategyScore.agreementExplanation) — carried onto every candidate, not just the one that
  // opens a trade, so Mission 7's Decision Intelligence history has strategy attribution for
  // rejected candidates too, not only accepted ones.
  primaryStrategyName: string;
  evidenceSummary: string;
  // The price a position size was evaluated against (Mission 1's live quote fetch inside
  // evaluateCandidateRisk) — undefined only for the structurally-unreachable "instrument not
  // found" branch, where no price was ever fetched. Added in Mission 7 so a rejected candidate's
  // DecisionRecord still has an entry price to reason about, not just the one that opened a trade.
  price?: number;
  individualRiskChecks: BotRiskCheck[];
  individualPassed: boolean;
  positionEvaluated: boolean;
  positionAction?: PositionAction;
  positionChecks: BotRiskCheck[];
  existingPositionValue?: number;
  positionValueAfterTrade?: number;
  positionDecisionReason?: string;
  portfolioRiskEvaluated: boolean;
  portfolioRiskChecks: BotRiskCheck[];
  portfolioPassed: boolean;
  outcome: "Trade Opened" | "Rejected";
  rejectionReason?: string;
}

// One line of the scan's step-by-step trace (scan started → instruments scanned → candidates
// ranked → each candidate evaluated/rejected, including position and portfolio risk → trade
// opened or not → scan completed).
export interface BotTraceStep {
  step: string;
  detail: string;
}

// Not barrel-exported through @/lib/types — this is a self-contained Mission 1 feature, not a
// core domain concept the rest of the app needs to reference broadly (unlike PaperTrade or
// StrategyScore). Components that need it import directly from src/lib/bot/.
export interface BotDecision {
  id: string;
  scanId: string;
  timestamp: string;
  triggerType: ScanTriggerType;
  instrumentsScanned: string[];
  // Every candidate walked during the fallback loop, in ranked order — not just the winner.
  candidates: BotCandidateEvaluation[];
  // The portfolio's exposure immediately before this scan considered any candidate (Mission 2) —
  // one snapshot per scan, not per candidate, since every candidate in a scan shares the same
  // baseline (at most one trade ever opens per scan).
  portfolioSnapshotBefore: PortfolioExposureSnapshot;
  selectedInstrument: string | null;
  selectedInstrumentName: string | null;
  actionTaken: "Trade Opened" | "No Trade";
  reason: string;
  trace: BotTraceStep[];
  tradeCreated: boolean;
  createdTradeId?: string;
  executionTimeMs: number;
}

export interface BotScanResult {
  decision: BotDecision;
  // Non-null only when some candidate passed every individual, position, AND portfolio risk check
  // — the caller (a React client component) is responsible for actually calling addTrade();
  // runBotScan itself never touches persistence.
  trade: PaperTrade | null;
}
