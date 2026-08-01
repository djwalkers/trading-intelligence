import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StrategyDefinitionDocument } from "@/lib/hermes-execution/strategy-definitions/strategy-definition";
import { computeContentHash } from "@/lib/hermes-execution/strategy-definitions/strategy-definition";
import { computeDatasetHash } from "@/lib/hermes-execution/backtest/backtest-dataset";
import { buildBacktestCatalogueStub } from "@/hermes-execution/strategy-backtest-cli";

// Phase 3 test fixtures — shared across strategy-research test files. Never imported by any
// production module. `buildBacktestCatalogueStub` is reused directly from the Phase 2 CLI (never a
// second, parallel catalogue stub) — the exact same honest, fixed BTC/ETH/SOL stub production code
// uses.

export const HOUR_MS = 3_600_000;
export const DATASET_START = Date.parse("2026-01-01T00:00:00.000Z");

export function makeCatalogueEntries() {
  return buildBacktestCatalogueStub();
}

export function makeBaselineStrategyDocument(overrides: Partial<StrategyDefinitionDocument> = {}): StrategyDefinitionDocument {
  return {
    schemaVersion: 1,
    strategyId: "TEST_RESEARCH_STRATEGY",
    strategyVersion: "1.0.0",
    name: "Test research strategy",
    description: "Fixture strategy for Phase 3 tests.",
    status: "APPROVED_FOR_BACKTEST",
    strategyFamily: "TREND_FOLLOWING",
    assetClass: "crypto",
    supportedInstruments: ["BTC", "ETH", "SOL"],
    timeframe: "1h",
    dataRequirements: ["close"],
    indicators: [
      { id: "ema-fast", type: "EMA", sourceField: "close", parameters: { period: 5 }, outputAlias: "EMA_FAST" },
      { id: "ema-slow", type: "EMA", sourceField: "close", parameters: { period: 10 }, outputAlias: "EMA_SLOW" },
      { id: "rsi", type: "RSI", sourceField: "close", parameters: { period: 14 }, outputAlias: "RSI14" },
      { id: "atr", type: "ATR", sourceField: "close", parameters: { period: 14 }, outputAlias: "ATR14" },
    ],
    entryRules: {
      operator: "AND",
      rules: [
        { operator: "GREATER_THAN", left: { kind: "INDICATOR_ALIAS", alias: "EMA_FAST" }, right: { kind: "INDICATOR_ALIAS", alias: "EMA_SLOW" } },
        { operator: "BETWEEN", operand: { kind: "INDICATOR_ALIAS", alias: "RSI14" }, lowerBound: { kind: "CONSTANT", value: 30 }, upperBound: { kind: "CONSTANT", value: 75 } },
      ],
    },
    signalExitRules: [
      { kind: "CONDITION", rule: { operator: "CROSSES_BELOW", left: { kind: "INDICATOR_ALIAS", alias: "EMA_FAST" }, right: { kind: "INDICATOR_ALIAS", alias: "EMA_SLOW" } } },
      { kind: "MAX_BARS_HELD", maxBars: 20 },
    ],
    parameters: {},
    eligibility: { requiresReadOnlyVerified: false, requiresStage4Verified: false, requiresConfiguredUniverse: false, notes: [] },
    backtestPolicy: { minHistoryBars: 30, warmupBars: 10, notes: [] },
    provenance: { author: "test", createdAt: "2026-01-01T00:00:00.000Z", notes: [] },
    limitations: [],
    ...overrides,
  };
}

export function baselineStrategyContentHash(overrides: Partial<StrategyDefinitionDocument> = {}): string {
  return computeContentHash(makeBaselineStrategyDocument(overrides));
}

/** Deterministic sine-wave-plus-drift price series — reliably produces several EMA
 * cross/RSI-in-range entries and exits within a modest bar count, without any randomness. */
export function makeDatasetDoc(instrument: string, count = 200, seedOffset = 0) {
  const candles = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const wave = Math.sin((i + seedOffset) / 12) * 15;
    price = 100 + wave + i * 0.05;
    const open = price - 0.3;
    const close = price;
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    candles.push({
      timestamp: new Date(DATASET_START + i * HOUR_MS).toISOString(),
      open: Number(open.toFixed(4)),
      high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
      volume: 100,
    });
  }
  return { schemaVersion: 1, instrument, timeframe: "1h" as const, source: "phase3 test fixture", candles };
}

export function datasetHashFor(instrument: string, count = 200, seedOffset = 0): string {
  const doc = makeDatasetDoc(instrument, count, seedOffset);
  return computeDatasetHash(doc);
}

export async function writeJsonFile(dir: string, filename: string, content: unknown): Promise<string> {
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, JSON.stringify(content, null, 2), "utf-8");
  return filePath;
}

export function makePassingCriterion(overrides: Partial<{ metric: string; operator: string; threshold: number; scope: string }> = {}) {
  return { metric: "MIN_TRADE_COUNT", operator: "GREATER_THAN_OR_EQUAL", threshold: 0, scope: "OVERALL", ...overrides };
}

export function makeResearchPlanRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    researchPlanId: "TEST_RESEARCH_PLAN",
    researchPlanVersion: "1.0.0",
    name: "Test plan",
    description: "Fixture plan for Phase 3 tests.",
    strategyId: "TEST_RESEARCH_STRATEGY",
    strategyVersion: "1.0.0",
    strategyContentHash: baselineStrategyContentHash(),
    instruments: ["BTC"],
    timeframe: "1h",
    datasets: [],
    baselineConfig: { feeBps: 5, slippageBps: 5, startingCapital: 10_000 },
    parameterExperiments: { dimensions: {}, maxExperiments: 10 },
    chronologicalSplits: [],
    passCriteria: [makePassingCriterion()],
    failureCriteria: [],
    robustnessChecks: { minTradeCountWarningThreshold: 1, maxInstrumentConcentrationWarningThreshold: 90, notes: [] },
    limitations: [],
    provenance: { author: "test", createdAt: "2026-01-01T00:00:00.000Z", notes: [] },
    ...overrides,
  };
}
