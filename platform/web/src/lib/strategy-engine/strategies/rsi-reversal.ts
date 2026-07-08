import type { StrategyContext, StrategyResult } from "@/lib/types";
import { clamp } from "../build-context";
import type { Strategy } from "../strategy";

const STRATEGY_ID = "rsi-reversal";
const STRATEGY_NAME = "RSI Reversal";

// Textbook RSI thresholds — not tuned per instrument, disclosed here rather than buried as
// inline magic numbers.
const RSI_OVERBOUGHT_THRESHOLD = 70;
const RSI_OVERSOLD_THRESHOLD = 30;
const RSI_NEUTRAL_MIDPOINT = 50;

// Overbought (RSI >= 70) suggests the recent up-move is stretched and due to reverse — a SELL
// signal on an otherwise-strong instrument. Oversold (RSI <= 30) is the mirror case, a BUY
// signal on an otherwise-weak one. This is deliberately a *reversal* read, which is why it can
// disagree with trend/momentum-following strategies on the same instrument — that disagreement
// is meaningful, not a bug (see AgreementLevel).
export const rsiReversalStrategy: Strategy = {
  id: STRATEGY_ID,
  name: STRATEGY_NAME,
  evaluate(context: StrategyContext): StrategyResult {
    const { rsi } = context;

    if (rsi >= RSI_OVERBOUGHT_THRESHOLD) {
      return {
        strategyId: STRATEGY_ID,
        strategyName: STRATEGY_NAME,
        signal: "SELL",
        confidence: Math.round(clamp(50 + (rsi - RSI_NEUTRAL_MIDPOINT), 50, 95)),
        evidence: [
          `RSI is ${rsi.toFixed(1)}, above the overbought threshold of ${RSI_OVERBOUGHT_THRESHOLD} — historically a point where an upward move loses steam and reverses.`,
        ],
      };
    }

    if (rsi <= RSI_OVERSOLD_THRESHOLD) {
      return {
        strategyId: STRATEGY_ID,
        strategyName: STRATEGY_NAME,
        signal: "BUY",
        confidence: Math.round(clamp(50 + (RSI_NEUTRAL_MIDPOINT - rsi), 50, 95)),
        evidence: [
          `RSI is ${rsi.toFixed(1)}, below the oversold threshold of ${RSI_OVERSOLD_THRESHOLD} — historically a point where a downward move loses steam and reverses.`,
        ],
      };
    }

    return {
      strategyId: STRATEGY_ID,
      strategyName: STRATEGY_NAME,
      signal: "HOLD",
      confidence: Math.round(clamp(50 + Math.abs(rsi - RSI_NEUTRAL_MIDPOINT) * 0.5, 50, 70)),
      evidence: [
        `RSI is ${rsi.toFixed(1)}, within the neutral ${RSI_OVERSOLD_THRESHOLD}-${RSI_OVERBOUGHT_THRESHOLD} range — no reversal signal in either direction.`,
      ],
    };
  },
};
