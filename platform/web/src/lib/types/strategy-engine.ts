import type { Instrument } from "./instrument";
import type { MarketRegime, Recommendation } from "./market-intelligence";
import type { SignalType } from "./signal";

// Reused rather than redeclared — a strategy's signal is exactly BUY/SELL/HOLD, same as the
// existing Signal domain type.
export type StrategySignal = SignalType;

// Deterministic inputs for one instrument, handed to every strategy unchanged. The four derived
// fields (everything but `instrument` itself) come from buildStrategyContext, a pure function of
// the instrument's existing mock snapshot — there is no historical price series in this
// prototype, so short/long moving averages, RSI, and volume ratio are proxies computed from
// price/changeAbsolute/changePercent/volume, not a new synthetic time series. Same instrument in,
// same context out, every time.
export interface StrategyContext {
  instrument: Instrument;
  shortMovingAverage: number;
  longMovingAverage: number;
  rsi: number;
  volumeRatio: number;
  trend: MarketRegime;
}

// One strategy's verdict on one instrument.
export interface StrategyResult {
  strategyId: string;
  strategyName: string;
  signal: StrategySignal;
  confidence: number;
  evidence: string[];
}

// How much the strategies agree with each other, from unanimous down to a genuine three-way
// split. See StrategyEngine.evaluateInstrument for exactly how each level is decided.
export type AgreementLevel =
  | "Strong Agreement"
  | "Moderate Agreement"
  | "Mixed Signals"
  | "Conflict";

// The engine's aggregate output for one instrument — every registered strategy's individual
// result, plus the combined call derived from them.
export interface StrategyScore {
  instrumentSymbol: string;
  instrumentName: string;
  results: StrategyResult[];
  overallSignal: StrategySignal;
  overallRecommendation: Recommendation;
  overallConfidence: number;
  agreement: AgreementLevel;
  agreementExplanation: string;
  primaryStrategyName: string;
  evaluatedAt: string;
}
