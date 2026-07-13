import { getSectorForSymbol } from "@/lib/mock/sectors";
import type { BotDecision } from "@/lib/bot/types";
import { DECISION_RECORD_SCHEMA_VERSION, type DecisionPortfolioRiskResult, type DecisionRecord } from "./types";

// Derives one DecisionRecord per candidate a scan evaluated — accepted or rejected alike — from a
// completed BotDecision. Pure and synchronous: every field it needs (opportunity, strategy,
// portfolio baseline, decision outcome) already exists on BotDecision/BotCandidateEvaluation by the
// time a scan finishes; this only reshapes it into the flatter, analytical DecisionRecord shape
// described in docs/product/MISSION-7-DECISION-INTELLIGENCE.md. Called from executeBotScan()
// (src/lib/bot/bot-execution-context.ts) immediately after a scan completes, for both the browser
// and a future worker.
export function buildDecisionRecords(decision: BotDecision): DecisionRecord[] {
  return decision.candidates.map((candidate) => {
    const portfolioRiskResult: DecisionPortfolioRiskResult = !candidate.portfolioRiskEvaluated
      ? "Not evaluated"
      : candidate.portfolioPassed
        ? "Passed"
        : "Failed";

    const sector = getSectorForSymbol(candidate.instrumentSymbol);

    return {
      version: DECISION_RECORD_SCHEMA_VERSION,

      id: `decision-record-${decision.id}-${candidate.instrumentSymbol}-${candidate.rank}`,
      scanId: decision.scanId,
      sourceDecisionId: decision.id,
      timestamp: decision.timestamp,
      triggerType: decision.triggerType,
      rank: candidate.rank,

      symbol: candidate.instrumentSymbol,
      instrumentName: candidate.instrumentName,
      sector,
      side: candidate.side,
      entryPrice: candidate.price ?? null,

      strategyUsed: candidate.primaryStrategyName,
      agreement: candidate.agreement,
      confidence: candidate.confidence,
      evidenceSummary: candidate.evidenceSummary,

      deployedCapital: decision.portfolioSnapshotBefore.totalCapitalDeployed,
      availableCash: decision.portfolioSnapshotBefore.availableCash,
      sectorExposure: decision.portfolioSnapshotBefore.capitalBySector[sector] ?? 0,
      totalOpenTrades: decision.portfolioSnapshotBefore.totalOpenTrades,

      actionTaken: candidate.outcome,
      rejectionReason: candidate.rejectionReason,
      positionAction: candidate.positionAction,
      portfolioRiskResult,

      outcome: "Pending",

      createdTradeId: candidate.outcome === "Trade Opened" ? decision.createdTradeId : undefined,

      dataProvenance: decision.dataProvenance,
    };
  });
}
