import type { Opportunity, StrategyScore } from "@/lib/types";

// Turns the engine's aggregate output into the same narrative/evidence shape Market
// Intelligence has always rendered, so RecommendationPanel, EvidenceBulletList, etc. need no
// changes of their own — only what feeds them changes, from a hand-authored mock string to a
// value derived transparently from the strategies' own results. Rule-based and deterministic,
// same as explainIntelligenceScore (Build 0.8.0) — templated sentences over real numbers, not a
// model.

export function buildNarrativeFromScore(score: StrategyScore): string {
  const agreeing = score.results.filter((result) => result.signal === score.overallSignal);
  const dissenting = score.results.filter((result) => result.signal !== score.overallSignal);
  const agreeingNames = agreeing.map((result) => result.strategyName).join(" and ");
  const primary = score.results.find((result) => result.strategyName === score.primaryStrategyName);

  let text = `${agreeing.length} of ${score.results.length} strategies (${agreeingNames}) point to ${score.overallSignal}. The strongest individual signal comes from ${score.primaryStrategyName}${
    primary ? ` at ${primary.confidence}% confidence` : ""
  }, and overall confidence across the ${score.overallSignal} strategies is ${score.overallConfidence}%, reflecting ${score.agreement.toLowerCase()}.`;

  if (dissenting.length > 0) {
    text += ` ${dissenting
      .map((result) => `${result.strategyName} disagrees, signalling ${result.signal}`)
      .join("; ")}.`;
  }

  return text;
}

export function buildWhyEvidence(score: StrategyScore): string[] {
  const agreeing = score.results.filter((result) => result.signal === score.overallSignal);
  return agreeing.flatMap((result) => result.evidence);
}

export function buildInvalidationFactors(score: StrategyScore): string[] {
  const dissenting = score.results.filter((result) => result.signal !== score.overallSignal);
  if (dissenting.length === 0) {
    return [
      "No strategy currently disagrees with this call — a shift in any of the underlying indicators (moving averages, RSI, or momentum/volume) would be the first sign to revisit it.",
    ];
  }
  return dissenting.flatMap((result) => result.evidence);
}

// Overlays the engine's computed recommendation/confidence/narrative/evidence onto an existing
// Opportunity, leaving its Decision Breakdown (evidence stars) and Intelligence Score
// (intelligenceFactors) — separate, pre-existing systems from Builds 0.3.0/0.8.0 — untouched.
export function applyStrategyEngineToOpportunity(
  opportunity: Opportunity,
  score: StrategyScore,
): Opportunity {
  return {
    ...opportunity,
    signalType: score.overallSignal,
    confidencePercent: score.overallConfidence,
    recommendation: score.overallRecommendation,
    narrative: buildNarrativeFromScore(score),
    whyEvidence: buildWhyEvidence(score),
    invalidationFactors: buildInvalidationFactors(score),
  };
}
