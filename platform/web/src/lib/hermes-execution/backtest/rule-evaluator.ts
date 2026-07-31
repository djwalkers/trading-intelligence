import { calculateAtr, calculateEma, calculateRsi } from "../technical-indicators";
import type { IndicatorDefinition, RuleNode, RuleOperand } from "../strategy-definitions/strategy-definition";
import type { Candle } from "../types";

// Phase 2 — Deterministic Backtesting Foundation. The ONE place a declarative RuleNode (Phase 1's
// own strategy-definitions/strategy-definition.ts schema) is ever evaluated against real bar data —
// still never evaluated as code: every RuleNode/RuleOperand shape was already validated (closed
// operator/operand set) by validateStrategyDefinition before this module ever sees it, and this
// module itself does nothing but pure arithmetic comparisons over pre-typed, pre-checked structures.
// No broker/execution/approval/lifecycle/risk import.
//
// No-look-ahead, by construction: `computeIndicatorSeries` computes bar i's value from
// `candles.slice(0, i + 1)` alone — bar i's own indicator value can never be influenced by any bar
// after it. `evaluateRuleNode` only ever reads `series[i]`/`series[i - 1]` (for CROSSES_ABOVE/
// CROSSES_BELOW) or `candles[i]` — never `i + 1` or later. See
// tests/hermes-execution/backtest/no-look-ahead.test.ts for the regression tests proving this.

/** One fully-computed, causal per-bar series for a single declared indicator — `values[i]` is that
 * indicator's value using only `candles[0..i]`, exactly mirroring what a live cycle would have
 * known at that bar and no more. */
export type IndicatorSeriesMap = ReadonlyMap<string, readonly number[]>;

/**
 * Computes every declared indicator's own causal series once, up front, over the WHOLE candle
 * array — still no look-ahead: each `values[i]` is independently derived from a `slice(0, i + 1)`
 * of the same source field, reusing technical-indicators.ts's own calculateEma/calculateRsi/
 * calculateAtr functions unmodified (this module invents no new indicator maths). Indexed by
 * `outputAlias`, matching how entry/exit RuleNodes reference them (INDICATOR_ALIAS operands).
 */
export function computeIndicatorSeries(candles: readonly Candle[], indicators: readonly IndicatorDefinition[]): IndicatorSeriesMap {
  const series = new Map<string, number[]>();
  for (const indicator of indicators) {
    // `?? 0` only ever applies to a genuinely absent `volume` — every other SafeMarketField
    // (open/high/low/close) is always a finite number on a validated Candle. Documented limitation:
    // an indicator sourced from volume on a candle with no volume data is computed as if it were 0,
    // never crashes, never silently drops the bar.
    const sourceValues = candles.map((c) => c[indicator.sourceField] ?? 0);
    const values: number[] = new Array(candles.length);
    for (let i = 0; i < candles.length; i++) {
      const causalCandles = candles.slice(0, i + 1);
      const causalValues = sourceValues.slice(0, i + 1);
      if (indicator.type === "EMA") {
        values[i] = calculateEma(causalValues, indicator.parameters.period);
      } else if (indicator.type === "RSI") {
        values[i] = calculateRsi(causalValues, indicator.parameters.period);
      } else {
        values[i] = calculateAtr(causalCandles as Candle[], indicator.parameters.period);
      }
    }
    series.set(indicator.outputAlias, values);
  }
  return series;
}

/** Resolves one RuleOperand to a plain number at bar `i` — undefined only for a MARKET_FIELD
 * referencing `volume` on a candle where volume is genuinely absent (never fabricated as 0; see
 * `evaluateRuleNode`'s own handling of an unresolved operand, which is to treat the containing
 * comparison as false rather than crash or guess). */
function resolveOperand(operand: RuleOperand, candles: readonly Candle[], series: IndicatorSeriesMap, i: number): number | undefined {
  if (operand.kind === "CONSTANT") return operand.value;
  if (operand.kind === "MARKET_FIELD") return candles[i]![operand.field];
  const values = series.get(operand.alias);
  return values?.[i];
}

/**
 * Evaluates one rule (sub)tree at bar `i`, given every candle up to and including `i` and each
 * indicator's own precomputed causal series. `CROSSES_ABOVE`/`CROSSES_BELOW` explicitly compare bar
 * `i - 1` (prior completed bar) against bar `i` (current completed bar) — false at `i === 0` (no
 * prior bar exists yet, never treated as a vacuous true). Every other operator only ever reads bar
 * `i`. An operand that fails to resolve (see `resolveOperand`) makes its containing comparison
 * false, never throws — a strategy can never crash a backtest run merely by being evaluated too
 * early (before an indicator has any real history) or against a candle missing optional volume.
 */
export function evaluateRuleNode(node: RuleNode, candles: readonly Candle[], series: IndicatorSeriesMap, i: number): boolean {
  switch (node.operator) {
    case "AND":
      return node.rules.every((child) => evaluateRuleNode(child, candles, series, i));
    case "OR":
      return node.rules.some((child) => evaluateRuleNode(child, candles, series, i));

    case "BETWEEN": {
      const value = resolveOperand(node.operand, candles, series, i);
      const lower = resolveOperand(node.lowerBound, candles, series, i);
      const upper = resolveOperand(node.upperBound, candles, series, i);
      if (value === undefined || lower === undefined || upper === undefined) return false;
      return value >= lower && value <= upper;
    }

    case "CROSSES_ABOVE":
    case "CROSSES_BELOW": {
      if (i === 0) return false; // no prior completed bar to compare against — never a look-ahead substitute.
      const leftPrev = resolveOperand(node.left, candles, series, i - 1);
      const rightPrev = resolveOperand(node.right, candles, series, i - 1);
      const leftCurr = resolveOperand(node.left, candles, series, i);
      const rightCurr = resolveOperand(node.right, candles, series, i);
      if (leftPrev === undefined || rightPrev === undefined || leftCurr === undefined || rightCurr === undefined) return false;
      return node.operator === "CROSSES_ABOVE" ? leftPrev <= rightPrev && leftCurr > rightCurr : leftPrev >= rightPrev && leftCurr < rightCurr;
    }

    // Remaining case: plain comparison operators (GREATER_THAN / LESS_THAN / GREATER_THAN_OR_EQUAL /
    // LESS_THAN_OR_EQUAL) — validateStrategyDefinition's own closed operator set guarantees no other
    // shape ever reaches here.
    default: {
      const left = resolveOperand(node.left, candles, series, i);
      const right = resolveOperand(node.right, candles, series, i);
      if (left === undefined || right === undefined) return false;
      switch (node.operator) {
        case "GREATER_THAN":
          return left > right;
        case "LESS_THAN":
          return left < right;
        case "GREATER_THAN_OR_EQUAL":
          return left >= right;
        case "LESS_THAN_OR_EQUAL":
          return left <= right;
      }
    }
  }
}
