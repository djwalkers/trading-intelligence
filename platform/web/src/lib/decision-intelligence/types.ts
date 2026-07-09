import type { AgreementLevel, PaperTradeSide, PositionAction } from "@/lib/types";
import type { ScanTriggerType } from "@/lib/bot/types";

// Mission 7 — Decision Intelligence. Bumped whenever a field is added, removed, or reinterpreted,
// so a future Hermes build can tell which shape an older stored record is in before reading it —
// see docs/product/MISSION-7-DECISION-INTELLIGENCE.md, "Future-proofing". Not enforced by any
// migration logic yet (there is only one version so far); this is the seam that lets one exist
// later without a breaking rewrite of every stored record.
export const DECISION_RECORD_SCHEMA_VERSION = 1;

// Deliberately just "Pending" today — Mission 7 is about recording enough evidence for a future
// mission to judge outcomes, not judging them itself. "Win"/"Loss"/"Neutral" are declared now so
// the type is stable once outcome analysis exists, but nothing in this mission ever produces them.
export type DecisionOutcome = "Pending" | "Win" | "Loss" | "Neutral";

// Whether, and how far, portfolio risk was actually evaluated for this candidate — mirrors
// BotCandidateEvaluation.portfolioRiskEvaluated/portfolioPassed as a single readable value, since a
// DecisionRecord is a flat analytical row, not a nested trace.
export type DecisionPortfolioRiskResult = "Passed" | "Failed" | "Not evaluated";

// One completed trading decision — an analytical snapshot of exactly one ranked candidate from one
// bot scan, whether it went on to open a trade or was rejected. This is NOT a duplicate of
// PaperTrade: a PaperTrade only ever exists for the single candidate (if any) that actually opened
// a position in a scan; a DecisionRecord exists for every candidate considered, rejected ones
// included, because a future Hermes needs to learn from what didn't happen, not only what did (see
// "Decision History" in the mission doc). One BotDecision (one scan) therefore produces one
// DecisionRecord per candidate in decision.candidates, via buildDecisionRecords().
export interface DecisionRecord {
  version: number;

  id: string;
  scanId: string;
  // The BotDecision.id this record was derived from — several DecisionRecords (one per candidate)
  // share one sourceDecisionId when they come from the same scan.
  sourceDecisionId: string;
  timestamp: string;
  triggerType: ScanTriggerType;
  // Where this candidate ranked among the scan's tradeable candidates (1 = highest confidence).
  rank: number;

  // Opportunity
  symbol: string;
  instrumentName: string;
  sector: string;
  side: PaperTradeSide;
  // Null only for the structurally-unreachable case where no instrument data could be found for
  // this candidate (see bot-runner.ts) — every other candidate has a real quoted price, whether or
  // not it went on to pass any risk check.
  entryPrice: number | null;

  // Strategy
  strategyUsed: string;
  agreement: AgreementLevel;
  confidence: number;
  evidenceSummary: string;

  // Portfolio state — the scan's baseline snapshot (identical for every candidate in the same
  // scan, since at most one trade can ever open per scan), not a per-candidate recomputation.
  deployedCapital: number;
  availableCash: number;
  sectorExposure: number;
  totalOpenTrades: number;

  // Decision
  actionTaken: "Trade Opened" | "Rejected";
  rejectionReason?: string;
  positionAction?: PositionAction;
  portfolioRiskResult: DecisionPortfolioRiskResult;

  // Outcome — see DecisionOutcome above.
  outcome: DecisionOutcome;

  // Only set for the one candidate (per scan, at most) that actually opened a position — lets a
  // future mission join a DecisionRecord back to its PaperTrade without guessing.
  createdTradeId?: string;
}
