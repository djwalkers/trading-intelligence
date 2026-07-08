import type { StrategyContext, StrategyResult } from "@/lib/types";
import { clamp } from "../build-context";
import type { Strategy } from "../strategy";
import { formatCurrencyUSD } from "@/lib/utils/format";

const STRATEGY_ID = "moving-average-crossover";
const STRATEGY_NAME = "Moving Average Crossover";
const CONFIDENCE_GAP_MULTIPLIER = 5;

function confidenceFromGap(shortMovingAverage: number, longMovingAverage: number): number {
  const gapPercent = Math.abs((shortMovingAverage - longMovingAverage) / longMovingAverage) * 100;
  return Math.round(clamp(50 + gapPercent * CONFIDENCE_GAP_MULTIPLIER, 50, 95));
}

// A bullish crossover: the short-term average sits above the long-term average, and price is
// confirming it by trading above the short-term average too. A bearish crossover is the mirror
// image. Anything else (the two conditions don't line up — e.g. price has crossed back below a
// still-rising short average) is HOLD: no confirmed crossover yet.
export const movingAverageCrossoverStrategy: Strategy = {
  id: STRATEGY_ID,
  name: STRATEGY_NAME,
  evaluate(context: StrategyContext): StrategyResult {
    const { instrument, shortMovingAverage, longMovingAverage } = context;
    const confidence = confidenceFromGap(shortMovingAverage, longMovingAverage);

    if (shortMovingAverage > longMovingAverage && instrument.price > shortMovingAverage) {
      return {
        strategyId: STRATEGY_ID,
        strategyName: STRATEGY_NAME,
        signal: "BUY",
        confidence,
        evidence: [
          `Short-term average (${formatCurrencyUSD(shortMovingAverage)}) is above the long-term average (${formatCurrencyUSD(longMovingAverage)}), a bullish crossover.`,
          `Price (${formatCurrencyUSD(instrument.price)}) is trading above the short-term average, confirming the trend.`,
        ],
      };
    }

    if (shortMovingAverage < longMovingAverage && instrument.price < shortMovingAverage) {
      return {
        strategyId: STRATEGY_ID,
        strategyName: STRATEGY_NAME,
        signal: "SELL",
        confidence,
        evidence: [
          `Short-term average (${formatCurrencyUSD(shortMovingAverage)}) is below the long-term average (${formatCurrencyUSD(longMovingAverage)}), a bearish crossover.`,
          `Price (${formatCurrencyUSD(instrument.price)}) is trading below the short-term average, confirming the trend.`,
        ],
      };
    }

    return {
      strategyId: STRATEGY_ID,
      strategyName: STRATEGY_NAME,
      signal: "HOLD",
      confidence: 50,
      evidence: [
        `Short-term (${formatCurrencyUSD(shortMovingAverage)}) and long-term (${formatCurrencyUSD(longMovingAverage)}) averages and price are not clearly aligned, so no crossover is confirmed either way.`,
      ],
    };
  },
};
