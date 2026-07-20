import { at } from "./array-utils";
import type { Candle, InternalStrategy, PaperPosition, SignalDecision } from "./types";

/** Simple moving average of closes over `period` candles ending at `endIndex` (inclusive).
 * Returns null when there isn't yet enough history — never a fabricated/partial average. */
function movingAverage(candles: Candle[], period: number, endIndex: number): number | null {
  if (endIndex < period - 1) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += at(candles, i).close;
  return sum / period;
}

/**
 * Deterministic signal evaluation — no LLM, no arbitrary strategy code execution. `candlesUpToNow`
 * must be the full chronological history for the strategy's instrument up to and including the
 * candle being evaluated; `openPosition` is this strategy's currently open position for this
 * instrument, if any (null when flat).
 *
 * Only the rule types defined in InternalStrategy's EntryRule/ExitRule unions are understood.
 * There is currently exactly one entry rule (CROSSES_ABOVE_MA) so ENTER_SHORT is never produced —
 * it exists in SignalAction only because it's a genuinely supportable future rule shape, not
 * because this engine fabricates short signals today.
 */
export function evaluateSignal(
  strategy: InternalStrategy,
  candlesUpToNow: Candle[],
  openPosition: PaperPosition | null,
): SignalDecision {
  const currentIndex = candlesUpToNow.length - 1;
  const current = at(candlesUpToNow, currentIndex);

  const base = {
    strategyId: strategy.strategyId,
    strategyVersion: strategy.version,
    instrument: strategy.instrument,
    timestamp: current.timestamp,
  };

  if (openPosition) {
    return evaluateExit(strategy, candlesUpToNow, currentIndex, openPosition, base);
  }
  return evaluateEntry(strategy, candlesUpToNow, currentIndex, base);
}

function evaluateEntry(
  strategy: InternalStrategy,
  candles: Candle[],
  currentIndex: number,
  base: Pick<SignalDecision, "strategyId" | "strategyVersion" | "instrument" | "timestamp">,
): SignalDecision {
  const current = at(candles, currentIndex);

  for (const rule of strategy.entryRules) {
    if (rule.type !== "CROSSES_ABOVE_MA") continue; // exhaustive today; see EntryRule

    const ma = movingAverage(candles, rule.period, currentIndex);
    const prevMa = movingAverage(candles, rule.period, currentIndex - 1);

    if (ma === null || prevMa === null) {
      return {
        ...base,
        action: "NO_ACTION",
        reason: `Not enough history yet for a ${rule.period}-period moving average.`,
        evaluatedValues: { close: current.close, period: rule.period },
      };
    }

    const previousClose = at(candles, currentIndex - 1).close;
    const crossedAbove = current.close > ma && previousClose <= prevMa;

    if (crossedAbove) {
      return {
        ...base,
        action: "ENTER_LONG",
        reason: `Close ${current.close} crossed above the ${rule.period}-period moving average (${ma.toFixed(4)}); previous close ${previousClose} was at or below its own moving average (${prevMa.toFixed(4)}).`,
        evaluatedValues: { close: current.close, movingAverage: ma, previousClose, previousMovingAverage: prevMa },
      };
    }

    return {
      ...base,
      action: "NO_ACTION",
      reason: `Close ${current.close} has not crossed above the ${rule.period}-period moving average (${ma.toFixed(4)}).`,
      evaluatedValues: { close: current.close, movingAverage: ma, previousClose, previousMovingAverage: prevMa },
    };
  }

  return {
    ...base,
    action: "NO_ACTION",
    reason: "Strategy has no supported entry rules.",
    evaluatedValues: { close: current.close },
  };
}

function evaluateExit(
  strategy: InternalStrategy,
  candles: Candle[],
  currentIndex: number,
  position: PaperPosition,
  base: Pick<SignalDecision, "strategyId" | "strategyVersion" | "instrument" | "timestamp">,
): SignalDecision {
  const current = at(candles, currentIndex);
  const evaluatedValues: Record<string, number | string | boolean> = {
    close: current.close,
    entryPrice: position.entryPrice,
  };

  for (const rule of strategy.exitRules) {
    if (rule.type === "TAKE_PROFIT") {
      const takeProfitPrice = position.entryPrice * (1 + rule.percent / 100);
      evaluatedValues.takeProfitPrice = takeProfitPrice;
      if (current.close >= takeProfitPrice) {
        return {
          ...base,
          action: "EXIT_POSITION",
          reason: `Close ${current.close} reached the take-profit level ${takeProfitPrice.toFixed(4)} (+${rule.percent}% from entry ${position.entryPrice}).`,
          evaluatedValues,
        };
      }
    } else if (rule.type === "STOP_LOSS") {
      const stopLossPrice = position.entryPrice * (1 - rule.percent / 100);
      evaluatedValues.stopLossPrice = stopLossPrice;
      if (current.close <= stopLossPrice) {
        return {
          ...base,
          action: "EXIT_POSITION",
          reason: `Close ${current.close} reached the stop-loss level ${stopLossPrice.toFixed(4)} (-${rule.percent}% from entry ${position.entryPrice}).`,
          evaluatedValues,
        };
      }
    } else if (rule.type === "CROSSES_BELOW_MA") {
      const ma = movingAverage(candles, rule.period, currentIndex);
      const prevMa = movingAverage(candles, rule.period, currentIndex - 1);
      if (ma !== null && prevMa !== null && currentIndex > 0) {
        const previousClose = at(candles, currentIndex - 1).close;
        const crossedBelow = current.close < ma && previousClose >= prevMa;
        evaluatedValues.movingAverage = ma;
        if (crossedBelow) {
          return {
            ...base,
            action: "EXIT_POSITION",
            reason: `Close ${current.close} crossed below the ${rule.period}-period moving average (${ma.toFixed(4)}).`,
            evaluatedValues,
          };
        }
      }
    }
  }

  return {
    ...base,
    action: "NO_ACTION",
    reason: "Holding — no exit condition met.",
    evaluatedValues,
  };
}
