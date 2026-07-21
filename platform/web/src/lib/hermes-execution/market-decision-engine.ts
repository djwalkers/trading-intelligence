import type { Candle, StrategySourceType } from "./types";
import type { MarketSession } from "./market-session";
import type { TrendClassification } from "./technical-indicators";

// Milestone 3 — Rich Market Context for the Market Decision Engine. MarketDecisionEngine remains a
// pure function: it only ever reads the MarketDecisionContext it's given and returns a decision —
// it never fetches candles, rates, or strategy documents itself (that's MarketIntelligenceBuilder's
// job, and the CLI/runner's job to invoke it beforehand). This is deliberately still not
// self-learning, not optimisation, and not AI reasoning — a simple, deterministic ruleset over the
// richer context. Named "Market Decision Engine", not "Hermes" — "Hermes" is reserved for the
// external Nous Hermes Agent (see the project constitution's naming resolution); this engine only
// ever applies its own fixed, internal ruleset and never claims to be Hermes deciding anything.

export type MarketDecisionAction = "BUY" | "SELL" | "HOLD";

/** A trimmed view of the approved strategy authorising this evaluation — identity only (no
 * entry/exit rules — those are still never evaluated here; this engine only ever applies its own
 * fixed EMA/RSI/trend ruleset below, referencing the strategy for identity and reasoning only). */
export interface DecisionStrategyMetadata {
  strategyId: string;
  version: number;
  sourceType: StrategySourceType;
}

/** Everything the Market Decision Engine can consider for a decision. Assembled entirely by
 * MarketIntelligenceBuilder before this engine ever sees it — every field here is a plain,
 * already-computed value, never a function or a promise. */
export interface MarketDecisionContext {
  instrument: string;
  bid: number;
  ask: number;
  spread: number;
  midPrice: number;
  timestamp: string;
  positionOpen: boolean;
  strategy: DecisionStrategyMetadata;

  /** The candle window the derived metrics below were computed from (most recent last) — carried
   * through for display/audit, not re-computed or re-read here. */
  recentCandles: Candle[];
  ema20: number;
  ema50: number;
  rsi14: number;
  atr14: number;
  volume: number;
  dailyHigh: number;
  dailyLow: number;
  /** Undefined when there wasn't enough candle history to compute a return series — see
   * calculateVolatility24h's own doc comment. */
  volatility24h: number | undefined;
  marketSession: MarketSession;
  trend: TrendClassification;
}

/** The decision itself — a strongly typed object, never free-form text. `reasoning` is a short
 * list of distinct factor statements (structured, not one prose paragraph) for the audit trail and
 * CLI display; nothing branches on its contents. */
export interface MarketDecision {
  action: MarketDecisionAction;
  confidence: number;
  reasoning: string[];
}

const RSI_ENTRY_MIN = 45;
const RSI_ENTRY_MAX = 65;
const RSI_CENTER = (RSI_ENTRY_MIN + RSI_ENTRY_MAX) / 2; // 55
const RSI_HALF_BAND = (RSI_ENTRY_MAX - RSI_ENTRY_MIN) / 2; // 10
const EMA_GAP_SATURATION_RATIO = 0.02; // a 2%+ EMA gap is treated as "as confident as this gets"

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function emaGapRatio(ema20: number, ema50: number): number {
  return ema50 !== 0 ? (ema20 - ema50) / ema50 : 0;
}

function buyConfidence(ema20: number, ema50: number, rsi14: number): number {
  const rsiScore = 1 - Math.min(1, Math.abs(rsi14 - RSI_CENTER) / RSI_HALF_BAND);
  const emaScore = clamp01(emaGapRatio(ema20, ema50) / EMA_GAP_SATURATION_RATIO);
  return round2(0.6 + 0.25 * rsiScore + 0.15 * emaScore);
}

function sellConfidence(ema20: number, ema50: number): number {
  const emaScore = clamp01(-emaGapRatio(ema20, ema50) / EMA_GAP_SATURATION_RATIO);
  return round2(0.75 + 0.2 * emaScore);
}

function strategyRef(strategy: DecisionStrategyMetadata): string {
  return `${strategy.strategyId} v${strategy.version} (${strategy.sourceType})`;
}

function holdReasoning(context: MarketDecisionContext): string[] {
  const { positionOpen, trend, ema20, ema50, rsi14 } = context;

  if (positionOpen) {
    return [
      "Position already open",
      `Trend is ${trend}, not Bearish`,
      "Holding the existing position rather than closing it",
    ];
  }

  const reasons: string[] = [];
  if (!(ema20 > ema50)) reasons.push(`EMA20 (${ema20.toFixed(2)}) is not above EMA50 (${ema50.toFixed(2)})`);
  if (!(rsi14 >= RSI_ENTRY_MIN && rsi14 <= RSI_ENTRY_MAX)) {
    reasons.push(`RSI ${rsi14.toFixed(1)} is outside the ${RSI_ENTRY_MIN}-${RSI_ENTRY_MAX} entry band`);
  }
  if (trend !== "Bullish") reasons.push(`Trend is ${trend}, not Bullish`);
  reasons.push(`No entry signal under strategy ${strategyRef(context.strategy)}`);
  return reasons;
}

export const MarketDecisionEngine = {
  /**
   * SELL: a position is already open AND the trend has turned Bearish — close it. Checked first:
   * an open position in a non-Bearish trend is deliberately held (see holdReasoning), not sold.
   *
   * BUY: no position is open, EMA20 is above EMA50, RSI14 sits within the 45-65 "healthy" band,
   * and the trend is classified Bullish. All four conditions are required — the EMA and trend
   * checks are not fully redundant with each other, since classifyTrend applies its own tolerance
   * band around a raw EMA20/EMA50 comparison.
   *
   * HOLD: otherwise.
   */
  evaluate(context: MarketDecisionContext): MarketDecision {
    const { instrument, ema20, ema50, rsi14, trend, positionOpen, volume, dailyHigh, dailyLow } = context;

    if (positionOpen && trend === "Bearish") {
      return {
        action: "SELL",
        confidence: sellConfidence(ema20, ema50),
        reasoning: [
          `Position already open on ${instrument}`,
          "Trend has turned Bearish",
          `EMA20 (${ema20.toFixed(2)}) below EMA50 (${ema50.toFixed(2)})`,
          `Closing under strategy ${strategyRef(context.strategy)}`,
        ],
      };
    }

    if (!positionOpen && ema20 > ema50 && rsi14 >= RSI_ENTRY_MIN && rsi14 <= RSI_ENTRY_MAX && trend === "Bullish") {
      return {
        action: "BUY",
        confidence: buyConfidence(ema20, ema50, rsi14),
        reasoning: [
          "EMA20 above EMA50",
          `RSI healthy (${rsi14.toFixed(1)}, within ${RSI_ENTRY_MIN}-${RSI_ENTRY_MAX} band)`,
          "Bullish trend",
          "No existing position",
          `Volume ${volume.toFixed(1)}, daily range ${dailyLow.toFixed(2)}-${dailyHigh.toFixed(2)}`,
          `Entry authorised under strategy ${strategyRef(context.strategy)}`,
        ],
      };
    }

    return {
      action: "HOLD",
      confidence: positionOpen ? 0.55 : 0.5,
      reasoning: holdReasoning(context),
    };
  },
};
