import type { DecisionStrategyMetadata, MarketDecisionContext } from "../market-decision-engine";
import type { Decision, Strategy, StrategyConditionResult } from "../strategies/strategy";

// Phase 5 — Strategy Research Laboratory. RESEARCH-0001: a deliberately different second strategy,
// so "Run Strategy A / Run Strategy B / Compare" has something genuine to compare DEMO-0001
// against. Never registered in trade-approval/default-strategy-registry.ts (the LIVE registry) —
// only ever reachable via research-strategy-registry.ts, this module's own, separate registry. It
// cannot place a trade: nothing in the research pipeline (run-strategy-research.ts) ever calls a
// broker, PortfolioRiskEngine, or TradeCandidateRepository — see that file's own doc comment.
//
// Same overall shape as Demo0001Strategy (an EMA-trend-with-RSI-band entry, Bearish-trend exit) —
// deliberately structured for a fair, apples-to-apples comparison — but a materially TIGHTER entry
// filter: a narrower RSI band (fewer, more selective entries) and a higher EMA-gap-saturation
// threshold (confidence only reaches its ceiling on a stronger trend). This is a genuine second
// ruleset, not a copy — it will make measurably different decisions on the same historical data.

const RSI_ENTRY_MIN = 48;
const RSI_ENTRY_MAX = 58;
const RSI_CENTER = (RSI_ENTRY_MIN + RSI_ENTRY_MAX) / 2; // 53
const RSI_HALF_BAND = (RSI_ENTRY_MAX - RSI_ENTRY_MIN) / 2; // 5
const EMA_GAP_SATURATION_RATIO = 0.035; // requires a stronger EMA gap than DEMO-0001 to reach max confidence

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
 * RESEARCH_ONLY — a comparison fixture for the Strategy Research Laboratory, never eligible for
 * live trading (see this file's own top-of-file comment). Rule summary:
 * - SELL: a position is already open AND the trend has turned Bearish (same as DEMO-0001).
 * - BUY: no position open, EMA20 above EMA50, RSI14 within a NARROWER 48-58 band, Bullish trend.
 * - HOLD: otherwise.
 */
export class ResearchVariantStrategy implements Strategy {
  readonly id = "RESEARCH-0001";
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

  applyFilters(): StrategyConditionResult {
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
    const filters = this.applyFilters();

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
      validationNotes: [],
    };
  }
}
