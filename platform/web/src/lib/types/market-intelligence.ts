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
}
