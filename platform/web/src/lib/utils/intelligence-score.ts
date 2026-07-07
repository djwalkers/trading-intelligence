import type { IntelligenceFactorScores, Opportunity, ScoreBand } from "@/lib/types";

// Weights sum to 1. Trend and momentum (the core technical signal) carry the most weight,
// reward and market context next, with volume/volatility/risk contributing smaller amounts.
// This is a fixed, disclosed formula — not a model, not AI, not live data.
const FACTOR_WEIGHTS: Record<keyof IntelligenceFactorScores, number> = {
  trend: 0.2,
  momentum: 0.2,
  volume: 0.1,
  volatility: 0.1,
  marketContext: 0.15,
  risk: 0.1,
  reward: 0.15,
};

export const FACTOR_LABELS: Record<keyof IntelligenceFactorScores, string> = {
  trend: "Trend",
  momentum: "Momentum",
  volume: "Volume",
  volatility: "Volatility",
  marketContext: "Market Context",
  risk: "Risk",
  reward: "Reward",
};

export const FACTOR_ORDER = Object.keys(FACTOR_LABELS) as (keyof IntelligenceFactorScores)[];

export function calculateOverallIntelligenceScore(factors: IntelligenceFactorScores): number {
  const weightedSum = FACTOR_ORDER.reduce(
    (sum, key) => sum + factors[key] * FACTOR_WEIGHTS[key],
    0,
  );
  return Math.round(weightedSum);
}

export function getScoreBand(overall: number): ScoreBand {
  if (overall >= 80) return "Excellent";
  if (overall >= 65) return "Good";
  if (overall >= 50) return "Weak";
  return "Avoid";
}

const STRENGTH_THRESHOLD = 70;
const WEAKNESS_THRESHOLD = 50;

export interface ScoreExplanation {
  summary: string;
  strengths: string[];
  weaknesses: string[];
}

// Purely rule-based (thresholds + templated sentences) — not AI, not a model, deterministic
// given the same factor scores every time.
export function explainIntelligenceScore(
  factors: IntelligenceFactorScores,
  overall: number,
): ScoreExplanation {
  const entries = FACTOR_ORDER.map((key) => ({ label: FACTOR_LABELS[key], score: factors[key] }));

  const strengths = entries
    .filter((entry) => entry.score >= STRENGTH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.label);

  const weaknesses = entries
    .filter((entry) => entry.score < WEAKNESS_THRESHOLD)
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.label);

  const band = getScoreBand(overall);
  let summary: string;

  switch (band) {
    case "Excellent":
      summary = strengths.length
        ? `This is a high-conviction score. ${strengths.join(", ")} are all running strong, with no significant factor working against it.`
        : "This is a high-conviction score, with every factor contributing evenly rather than any single one standing out.";
      break;
    case "Good":
      summary = weaknesses.length
        ? `This is a solid score. ${strengths.join(", ") || "Several factors"} support the case, while ${weaknesses.join(", ")} keep it out of the highest tier.`
        : `This is a solid score, supported broadly by ${strengths.join(", ") || "several factors"} without a standout weakness.`;
      break;
    case "Weak":
      summary = `This is a weak score. No factor is strongly working in its favour${
        weaknesses.length ? `, and ${weaknesses.join(", ")} are actively holding it back` : ""
      }.`;
      break;
    case "Avoid":
      summary = weaknesses.length
        ? `This is a low score. ${weaknesses.join(", ")} are working against this opportunity, with little offsetting strength.`
        : "This is a low score, with no factor providing meaningful support.";
      break;
  }

  return { summary, strengths, weaknesses };
}

export interface IntelligenceScoreSummary {
  averageScore: number;
  excellentCount: number;
  goodCount: number;
  weakCount: number;
  avoidCount: number;
  highest: { instrumentSymbol: string; instrumentName: string; overall: number } | null;
}

type ScorableOpportunity = Pick<
  Opportunity,
  "instrumentSymbol" | "instrumentName" | "intelligenceFactors"
>;

// Shared by the Watchlist Health summary (bucket counts) and the Dashboard Intelligence
// Summary (highest/average/excellent/avoid) — one calculation, two presentations.
export function summarizeIntelligenceScores(
  opportunities: ScorableOpportunity[],
): IntelligenceScoreSummary {
  if (opportunities.length === 0) {
    return {
      averageScore: 0,
      excellentCount: 0,
      goodCount: 0,
      weakCount: 0,
      avoidCount: 0,
      highest: null,
    };
  }

  let total = 0;
  let excellentCount = 0;
  let goodCount = 0;
  let weakCount = 0;
  let avoidCount = 0;
  let highest: IntelligenceScoreSummary["highest"] = null;

  for (const opportunity of opportunities) {
    const overall = calculateOverallIntelligenceScore(opportunity.intelligenceFactors);
    total += overall;

    switch (getScoreBand(overall)) {
      case "Excellent":
        excellentCount += 1;
        break;
      case "Good":
        goodCount += 1;
        break;
      case "Weak":
        weakCount += 1;
        break;
      case "Avoid":
        avoidCount += 1;
        break;
    }

    if (!highest || overall > highest.overall) {
      highest = {
        instrumentSymbol: opportunity.instrumentSymbol,
        instrumentName: opportunity.instrumentName,
        overall,
      };
    }
  }

  return {
    averageScore: Math.round(total / opportunities.length),
    excellentCount,
    goodCount,
    weakCount,
    avoidCount,
    highest,
  };
}
