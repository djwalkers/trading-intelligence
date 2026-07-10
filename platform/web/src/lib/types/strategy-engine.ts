import type { Instrument } from "./instrument";
import type { MarketRegime, Recommendation } from "./market-intelligence";
import type { SignalType } from "./signal";

// Reused rather than redeclared — a strategy's signal is exactly BUY/SELL/HOLD, same as the
// existing Signal domain type.
export type StrategySignal = SignalType;

// Deterministic inputs for one instrument, handed to every strategy unchanged. As of Mission 9,
// these come from buildStrategyContextFromHistory() (real SMA/EMA/RSI/momentum/volume-ratio
// calculated from 90 days of OHLCV candles) whenever enough historical data is available, or from
// buildStrategyContext() (the original Build 1.3.0 snapshot-derived proxies — price minus a drift
// multiple, percent-change mapped onto the RSI scale, etc.) when it isn't. Either way, same
// instrument (+ same candles, when present) in, same context out, every time — no randomness.
// historicalDataAvailable discloses which path produced this particular context, so evidence text
// and status displays can be honest about where a reading came from.
export interface StrategyContext {
  instrument: Instrument;
  shortMovingAverage: number;
  longMovingAverage: number;
  rsi: number;
  volumeRatio: number;
  trend: MarketRegime;
  // The Momentum strategy's short-window price change — instrument.changePercent (today's single
  // session) in the snapshot fallback, or a real multi-day historical momentum reading when
  // history is available. Kept as its own context field (Mission 9) rather than read directly off
  // `instrument` so the Momentum strategy gets the same "from history when possible" upgrade the
  // other two strategies get through shortMovingAverage/longMovingAverage/rsi.
  momentumPercent: number;
  historicalDataAvailable: boolean;
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
