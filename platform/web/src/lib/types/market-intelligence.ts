import type { SignalType } from "./signal";

export type MarketRegime = "Bullish" | "Neutral" | "Bearish";
export type VolatilityLevel = "Low" | "Medium" | "High";
export type RiskLevel = "Low" | "Moderate" | "Elevated";
export type Recommendation = "Strong Buy" | "Buy" | "Hold" | "Avoid" | "Strong Sell";

export interface MarketOverview {
  regime: MarketRegime;
  confidencePercent: number;
  volatility: VolatilityLevel;
  riskLevel: RiskLevel;
}

export interface EvidenceRating {
  label: string;
  score: number;
}

// Seven 0-100 factors feeding the Intelligence Score. All seven are "higher is better" on the
// same scale — including risk and volatility, which represent favourability (low actual risk /
// low actual volatility scores high), not raw exposure — so they can be averaged and compared
// directly without sign-flipping logic scattered through the UI.
export interface IntelligenceFactorScores {
  trend: number;
  momentum: number;
  volume: number;
  volatility: number;
  marketContext: number;
  risk: number;
  reward: number;
}

export type ScoreBand = "Excellent" | "Good" | "Weak" | "Avoid";

export interface Opportunity {
  id: string;
  instrumentSymbol: string;
  instrumentName: string;
  signalType: SignalType;
  confidencePercent: number;
  reasons: string[];
  recommendation: Recommendation;
  narrative: string;
  evidence: EvidenceRating[];
  whyEvidence: string[];
  invalidationFactors: string[];
  intelligenceFactors: IntelligenceFactorScores;
}
