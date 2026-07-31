import { describe, expect, it } from "vitest";
import { computeIndicatorSeries, evaluateRuleNode } from "@/lib/hermes-execution/backtest/rule-evaluator";
import { runBacktestSegment } from "@/lib/hermes-execution/backtest/backtest-engine";
import type { IndicatorDefinition, RuleNode, StrategyDefinitionDocument } from "@/lib/hermes-execution/strategy-definitions/strategy-definition";
import type { Candle } from "@/lib/hermes-execution/types";

// Phase 2 — Deterministic Backtesting Foundation. Explicit no-look-ahead regression tests
// (requirement 2's own "add explicit regression tests proving future bars cannot affect earlier
// decisions") — dedicated, standalone from the general engine test suite so this specific guarantee
// is never accidentally weakened by an unrelated future change without an obvious, named test
// failure pointing straight at it.

const HOUR_MS = 3_600_000;
const START = Date.parse("2026-01-01T00:00:00.000Z");

function candle(i: number, close: number): Candle {
  return { symbol: "BTC", timestamp: new Date(START + i * HOUR_MS).toISOString(), open: close, high: close + 1, low: close - 1, close, volume: 10 };
}

const EMA_INDICATOR: IndicatorDefinition = { id: "ema5", type: "EMA", sourceField: "close", parameters: { period: 5 }, outputAlias: "EMA5" };

describe("computeIndicatorSeries — no look-ahead", () => {
  it("bar i's indicator value is identical whether or not any bar after i exists in the array", () => {
    const baseCandles = Array.from({ length: 20 }, (_, i) => candle(i, 100 + i));
    const truncated = baseCandles.slice(0, 10);
    const extended = [...baseCandles]; // same first 10, plus 10 MORE bars with very different prices

    const seriesTruncated = computeIndicatorSeries(truncated, [EMA_INDICATOR]);
    const seriesExtended = computeIndicatorSeries(extended, [EMA_INDICATOR]);

    for (let i = 0; i < 10; i++) {
      expect(seriesExtended.get("EMA5")![i]).toBe(seriesTruncated.get("EMA5")![i]);
    }
  });

  it("changing a future bar's price never changes an earlier bar's already-computed indicator value", () => {
    const candles = Array.from({ length: 15 }, (_, i) => candle(i, 100 + i));
    const seriesA = computeIndicatorSeries(candles, [EMA_INDICATOR]);

    const mutated = candles.map((c, i) => (i >= 10 ? { ...c, close: c.close + 1_000_000 } : c)); // wildly different future
    const seriesB = computeIndicatorSeries(mutated, [EMA_INDICATOR]);

    for (let i = 0; i < 10; i++) {
      expect(seriesB.get("EMA5")![i]).toBe(seriesA.get("EMA5")![i]);
    }
    // Sanity: the future bars themselves DID change, proving this isn't a no-op mutation.
    expect(seriesB.get("EMA5")![14]).not.toBe(seriesA.get("EMA5")![14]);
  });
});

describe("evaluateRuleNode — no look-ahead", () => {
  const crossRule: RuleNode = { operator: "CROSSES_ABOVE", left: { kind: "INDICATOR_ALIAS", alias: "EMA5" }, right: { kind: "CONSTANT", value: 102 } };

  it("a rule's outcome at bar i is unaffected by appending arbitrary future bars", () => {
    const candles = Array.from({ length: 12 }, (_, i) => candle(i, 100 + i));
    const series = computeIndicatorSeries(candles, [EMA_INDICATOR]);
    const resultsShort = candles.map((_, i) => evaluateRuleNode(crossRule, candles, series, i));

    const withFuture = [...candles, candle(12, -9999), candle(13, 9999)];
    const seriesWithFuture = computeIndicatorSeries(withFuture, [EMA_INDICATOR]);
    const resultsLong = candles.map((_, i) => evaluateRuleNode(crossRule, withFuture, seriesWithFuture, i));

    expect(resultsLong).toEqual(resultsShort);
  });

  it("CROSSES_ABOVE/CROSSES_BELOW at bar 0 is always false — there is no prior bar to look back to (never treated as vacuously true)", () => {
    const candles = [candle(0, 200)]; // starts already "above" 102 — would wrongly fire if bar -1 defaulted to below
    const series = computeIndicatorSeries(candles, [EMA_INDICATOR]);
    expect(evaluateRuleNode(crossRule, candles, series, 0)).toBe(false);
  });
});

describe("runBacktestSegment — no look-ahead end-to-end", () => {
  function makeDocument(entryRules: RuleNode): StrategyDefinitionDocument {
    return {
      schemaVersion: 1,
      strategyId: "TEST_NO_LOOKAHEAD",
      strategyVersion: "1.0.0",
      name: "test",
      description: "test",
      status: "APPROVED_FOR_BACKTEST",
      strategyFamily: "OTHER",
      assetClass: "crypto",
      supportedInstruments: ["BTC"],
      timeframe: "1h",
      dataRequirements: ["close"],
      indicators: [EMA_INDICATOR],
      entryRules,
      signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 3 }],
      parameters: {},
      eligibility: { requiresReadOnlyVerified: false, requiresStage4Verified: false, requiresConfiguredUniverse: false, notes: [] },
      backtestPolicy: { minHistoryBars: 1, warmupBars: 0, notes: [] },
      provenance: { author: "test", createdAt: "2026-01-01T00:00:00.000Z", notes: [] },
      limitations: [],
    };
  }

  it("a trade that fully resolves (entry AND signal-driven exit) within the shorter dataset is byte-for-byte identical once arbitrary future bars are appended afterward", () => {
    // Entry (CROSSES_ABOVE 102) fires at bar 6; MAX_BARS_HELD(3) then signals exit once 3 bars have
    // elapsed (bar 9), executed at bar 10's open — 12 bars is enough for this ENTIRE trade to
    // resolve via its own signal, never via the end-of-data fallback, so appending more bars
    // afterward must never change anything about it.
    const entryRules: RuleNode = { operator: "CROSSES_ABOVE", left: { kind: "INDICATOR_ALIAS", alias: "EMA5" }, right: { kind: "CONSTANT", value: 102 } };
    const document = makeDocument(entryRules);
    const candles = Array.from({ length: 12 }, (_, i) => candle(i, 100 + i));
    const config = { feeBps: 0, slippageBps: 0, startingCapital: 10_000 };

    const shortResult = runBacktestSegment(document, candles, config);
    const firstTradeShort = shortResult.trades[0];
    expect(firstTradeShort).toBeDefined();
    expect(firstTradeShort!.exitReason).not.toBe("END_OF_DATA"); // proves this trade genuinely resolved via its own signal, not merely because the array ended

    const withWildFuture = [...candles, candle(12, -50000), candle(13, 99999), candle(14, 1)];
    const longResult = runBacktestSegment(document, withWildFuture, config);
    const firstTradeLong = longResult.trades[0];

    expect(firstTradeLong).toEqual(firstTradeShort);
  });
});
