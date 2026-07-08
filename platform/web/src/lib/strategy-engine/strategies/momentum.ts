import type { StrategyContext, StrategyResult } from "@/lib/types";
import { clamp } from "../build-context";
import type { Strategy } from "../strategy";

const STRATEGY_ID = "momentum";
const STRATEGY_NAME = "Momentum";

const CHANGE_THRESHOLD_PERCENT = 1;
const VOLUME_RATIO_THRESHOLD = 1.2;

// A confirmed move needs two things agreeing, not just price on its own: a change big enough to
// matter, and volume running above a typical session to confirm real participation rather than a
// thin drift. Trend acts as a simple guardrail — a price pop against an already-opposing trend
// isn't treated as confirmed momentum.
export const momentumStrategy: Strategy = {
  id: STRATEGY_ID,
  name: STRATEGY_NAME,
  evaluate(context: StrategyContext): StrategyResult {
    const { instrument, volumeRatio, trend } = context;
    const changePercent = instrument.changePercent;
    const confidence = Math.round(
      clamp(50 + Math.abs(changePercent) * 8 + (volumeRatio - 1) * 10, 50, 95),
    );

    if (
      changePercent > CHANGE_THRESHOLD_PERCENT &&
      volumeRatio > VOLUME_RATIO_THRESHOLD &&
      trend !== "Bearish"
    ) {
      return {
        strategyId: STRATEGY_ID,
        strategyName: STRATEGY_NAME,
        signal: "BUY",
        confidence,
        evidence: [
          `Price is up ${changePercent.toFixed(2)}% on volume running at ${volumeRatio.toFixed(2)}x a typical session, confirming the move.`,
          `Trend reading is ${trend}, not working against the signal.`,
        ],
      };
    }

    if (
      changePercent < -CHANGE_THRESHOLD_PERCENT &&
      volumeRatio > VOLUME_RATIO_THRESHOLD &&
      trend !== "Bullish"
    ) {
      return {
        strategyId: STRATEGY_ID,
        strategyName: STRATEGY_NAME,
        signal: "SELL",
        confidence,
        evidence: [
          `Price is down ${Math.abs(changePercent).toFixed(2)}% on volume running at ${volumeRatio.toFixed(2)}x a typical session, confirming the move.`,
          `Trend reading is ${trend}, not working against the signal.`,
        ],
      };
    }

    return {
      strategyId: STRATEGY_ID,
      strategyName: STRATEGY_NAME,
      signal: "HOLD",
      confidence: Math.round(clamp(50 + Math.abs(changePercent) * 4, 50, 65)),
      evidence: [
        `Price change of ${changePercent.toFixed(2)}% and volume of ${volumeRatio.toFixed(2)}x a typical session don't both clear the threshold for a confirmed momentum signal.`,
      ],
    };
  },
};
