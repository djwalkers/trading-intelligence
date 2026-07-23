import type { DecisionStrategyMetadata, MarketDecisionContext } from "../market-decision-engine";
import type { Decision, Strategy, StrategyConditionResult } from "./strategy";

// Phase 3 — Strategy-Driven Decision Engine. DEMO-0001's own trading rules, moved verbatim out of
// MarketDecisionEngine (which used to contain them directly, as its one fixed ruleset) into this
// standalone Strategy implementation. Every constant, formula, and reasoning string below is
// byte-for-byte identical to the pre-Phase-3 engine's own — this refactor separates strategy from
// engine, it does not change trading frequency or improve the strategy (see
// market-decision-engine.test.ts's own "same decisions for identical inputs" coverage, carried
// forward to demo-0001-strategy.test.ts, for the proof). Named to match InternalStrategy.
// strategyId ("DEMO-0001", demo-strategy.ts) and MarketDecisionContext.strategy.strategyId — a
// StrategyRegistry looks this up by that exact string (see strategy-registry.ts).

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

function strategyRef(strategy: DecisionStrategyMetadata): string {
  return `${strategy.strategyId} v${strategy.version} (${strategy.sourceType})`;
}

/**
 * DEMO_ONLY — deterministic fixture strategy for exercising the execution pipeline (see
 * demo-strategy.ts's own doc comment). Not evidence-backed, never eligible for live trading.
 *
 * Rule summary (unchanged from the pre-Phase-3 engine):
 * - SELL: a position is already open AND the trend has turned Bearish.
 * - BUY: no position is open, EMA20 is above EMA50, RSI14 sits within the 45-65 "healthy" band,
 *   and the trend is classified Bullish. All four conditions are required.
 * - HOLD: otherwise.
 */
export class Demo0001Strategy implements Strategy {
  readonly id = "DEMO-0001";
  readonly version = 1;

  checkEntryConditions(context: MarketDecisionContext): StrategyConditionResult {
    const { ema20, ema50, rsi14, trend } = context;
    const reasons: string[] = [];
    if (!(ema20 > ema50)) reasons.push(`EMA20 (${ema20.toFixed(2)}) is not above EMA50 (${ema50.toFixed(2)})`);
    if (!(rsi14 >= RSI_ENTRY_MIN && rsi14 <= RSI_ENTRY_MAX)) {
      reasons.push(`RSI ${rsi14.toFixed(1)} is outside the ${RSI_ENTRY_MIN}-${RSI_ENTRY_MAX} entry band`);
    }
    if (trend !== "Bullish") reasons.push(`Trend is ${trend}, not Bullish`);
    return { met: reasons.length === 0, reasons };
  }

  checkExitConditions(context: MarketDecisionContext): StrategyConditionResult {
    const { trend } = context;
    if (trend === "Bearish") return { met: true, reasons: ["Trend has turned Bearish"] };
    return { met: false, reasons: [`Trend is ${trend}, not Bearish`] };
  }

  /** DEMO-0001 has no additional filters beyond entry/exit conditions — always passes. A genuine
   * no-op, never a new rejection path, so this can never change trading frequency. */
  applyFilters(_context: MarketDecisionContext): StrategyConditionResult {
    return { met: true, reasons: [] };
  }

  calculateEntryConfidence(context: MarketDecisionContext): number {
    const { ema20, ema50, rsi14 } = context;
    const rsiScore = 1 - Math.min(1, Math.abs(rsi14 - RSI_CENTER) / RSI_HALF_BAND);
    const emaScore = clamp01(emaGapRatio(ema20, ema50) / EMA_GAP_SATURATION_RATIO);
    return round2(0.6 + 0.25 * rsiScore + 0.15 * emaScore);
  }

  calculateExitConfidence(context: MarketDecisionContext): number {
    const { ema20, ema50 } = context;
    const emaScore = clamp01(-emaGapRatio(ema20, ema50) / EMA_GAP_SATURATION_RATIO);
    return round2(0.75 + 0.2 * emaScore);
  }

  explainHold(context: MarketDecisionContext): string[] {
    const { positionOpen, trend } = context;
    if (positionOpen) {
      return ["Position already open", `Trend is ${trend}, not Bearish`, "Holding the existing position rather than closing it"];
    }
    const entry = this.checkEntryConditions(context);
    return [...entry.reasons, `No entry signal under strategy ${strategyRef(context.strategy)}`];
  }

  evaluate(context: MarketDecisionContext): Decision {
    const { instrument, positionOpen, ema20, ema50, rsi14, volume, dailyHigh, dailyLow } = context;

    if (positionOpen) {
      const exit = this.checkExitConditions(context);
      if (exit.met) {
        return {
          action: "SELL",
          confidence: this.calculateExitConfidence(context),
          reasoning: [
            `Position already open on ${instrument}`,
            ...exit.reasons,
            `EMA20 (${ema20.toFixed(2)}) below EMA50 (${ema50.toFixed(2)})`,
            `Closing under strategy ${strategyRef(context.strategy)}`,
          ],
          entryCriteriaMet: false,
          exitCriteriaMet: true,
          validationNotes: [],
        };
      }
      return {
        action: "HOLD",
        confidence: 0.55,
        reasoning: this.explainHold(context),
        entryCriteriaMet: false,
        exitCriteriaMet: false,
        validationNotes: [],
      };
    }

    const entry = this.checkEntryConditions(context);
    const filters = this.applyFilters(context);
    const validationNotes: string[] = entry.met && !filters.met ? [...filters.reasons] : [];

    if (entry.met && filters.met) {
      return {
        action: "BUY",
        confidence: this.calculateEntryConfidence(context),
        reasoning: [
          "EMA20 above EMA50",
          `RSI healthy (${rsi14.toFixed(1)}, within ${RSI_ENTRY_MIN}-${RSI_ENTRY_MAX} band)`,
          "Bullish trend",
          "No existing position",
          `Volume ${volume.toFixed(1)}, daily range ${dailyLow.toFixed(2)}-${dailyHigh.toFixed(2)}`,
          `Entry authorised under strategy ${strategyRef(context.strategy)}`,
        ],
        entryCriteriaMet: true,
        exitCriteriaMet: false,
        validationNotes: [],
      };
    }

    return {
      action: "HOLD",
      confidence: 0.5,
      reasoning: this.explainHold(context),
      entryCriteriaMet: entry.met,
      exitCriteriaMet: false,
      validationNotes,
    };
  }
}
