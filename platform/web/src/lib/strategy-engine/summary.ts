import type { AgreementLevel, StrategyScore } from "@/lib/types";

export interface StrategyEngineSummary {
  // Total individual strategy evaluations run (instruments × strategies per instrument) —
  // distinct from System Health's "Strategies Loaded" (the number of registered strategies).
  strategiesEvaluated: number;
  averageConfidence: number;
  agreementDistribution: Record<AgreementLevel, number>;
  highestConfidenceStrategy: {
    strategyName: string;
    instrumentSymbol: string;
    confidence: number;
  } | null;
}

const EMPTY_DISTRIBUTION: Record<AgreementLevel, number> = {
  "Strong Agreement": 0,
  "Moderate Agreement": 0,
  "Mixed Signals": 0,
  Conflict: 0,
};

// Shared by the Dashboard's Strategy Summary card — one calculation over every instrument's
// StrategyScore, not re-derived per widget.
export function summarizeStrategyScores(scores: StrategyScore[]): StrategyEngineSummary {
  if (scores.length === 0) {
    return {
      strategiesEvaluated: 0,
      averageConfidence: 0,
      agreementDistribution: { ...EMPTY_DISTRIBUTION },
      highestConfidenceStrategy: null,
    };
  }

  const agreementDistribution = { ...EMPTY_DISTRIBUTION };
  let strategiesEvaluated = 0;
  let confidenceTotal = 0;
  let highestConfidenceStrategy: StrategyEngineSummary["highestConfidenceStrategy"] = null;

  for (const score of scores) {
    agreementDistribution[score.agreement] += 1;
    confidenceTotal += score.overallConfidence;

    for (const result of score.results) {
      strategiesEvaluated += 1;
      if (!highestConfidenceStrategy || result.confidence > highestConfidenceStrategy.confidence) {
        highestConfidenceStrategy = {
          strategyName: result.strategyName,
          instrumentSymbol: score.instrumentSymbol,
          confidence: result.confidence,
        };
      }
    }
  }

  return {
    strategiesEvaluated,
    averageConfidence: Math.round(confidenceTotal / scores.length),
    agreementDistribution,
    highestConfidenceStrategy,
  };
}
