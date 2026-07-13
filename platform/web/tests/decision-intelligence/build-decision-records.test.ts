import { describe, expect, it } from "vitest";
import { buildDecisionRecords } from "@/lib/decision-intelligence/build-decision-records";
import type { BotCandidateEvaluation, BotDecision } from "@/lib/bot/types";

function candidate(overrides: Partial<BotCandidateEvaluation> = {}): BotCandidateEvaluation {
  return {
    rank: 1,
    instrumentSymbol: "AAPL",
    instrumentName: "Apple Inc.",
    side: "BUY",
    confidence: 80,
    agreement: "Strong Agreement",
    primaryStrategyName: "Momentum",
    evidenceSummary: "All strategies agree.",
    individualRiskChecks: [],
    individualPassed: true,
    positionEvaluated: true,
    positionChecks: [],
    portfolioRiskEvaluated: true,
    portfolioRiskChecks: [],
    portfolioPassed: true,
    outcome: "Trade Opened",
    ...overrides,
  };
}

function decision(overrides: Partial<BotDecision> = {}): BotDecision {
  return {
    id: "bot-1",
    scanId: "SCAN-000001",
    timestamp: "2026-01-01T00:00:00.000Z",
    triggerType: "Scheduled",
    instrumentsScanned: ["AAPL"],
    candidates: [candidate()],
    portfolioSnapshotBefore: {
      totalOpenTrades: 0,
      totalCapitalDeployed: 0,
      availableCash: 10000,
      startingCapital: 10000,
      capitalByInstrument: {},
      capitalBySide: { BUY: 0, SELL: 0 },
      countBySide: { BUY: 0, SELL: 0 },
      capitalBySector: {},
      countBySector: {},
    },
    selectedInstrument: "AAPL",
    selectedInstrumentName: "Apple Inc.",
    actionTaken: "Trade Opened",
    reason: "Opened a trade.",
    trace: [],
    tradeCreated: true,
    createdTradeId: "trade-1",
    executionTimeMs: 10,
    dataProvenance: "verified_external_data",
    ...overrides,
  };
}

describe("buildDecisionRecords", () => {
  it("forwards the scan's dataProvenance onto every produced record", () => {
    const records = buildDecisionRecords(
      decision({ candidates: [candidate({ rank: 1 }), candidate({ rank: 2, outcome: "Rejected" })] }),
    );
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.dataProvenance).toBe("verified_external_data");
    }
  });

  it("forwards fallback_sample_data just as faithfully as any other value", () => {
    const records = buildDecisionRecords(decision({ dataProvenance: "fallback_sample_data" }));
    expect(records[0]?.dataProvenance).toBe("fallback_sample_data");
  });
});
