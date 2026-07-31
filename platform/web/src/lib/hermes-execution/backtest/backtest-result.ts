import { createHash, randomUUID } from "node:crypto";
import { canonicalStringify, CONTENT_HASH_ALGORITHM, type StrategyDefinitionDocument } from "../strategy-definitions/strategy-definition";
import { toCandles, type CandleDatasetDocument, type ValidatedCandleDataset } from "./backtest-dataset";
import { BACKTEST_ENGINE_VERSION, runBacktestSegment, validateCostConfig, type BacktestConfig, type BacktestSegmentMetrics } from "./backtest-engine";
import type { Candle } from "../types";

// Phase 2 — Deterministic Backtesting Foundation. Orchestrates one full backtest run (optionally
// split into in-sample/out-of-sample segments) and produces the single, self-contained result
// object the CLI prints/persists. No broker/execution/approval/lifecycle/risk import, no network
// call, no randomness. Never wired into any live runtime path or promotion mechanism — see this
// result's own `warnings`/`limitations` fields, always populated with the disclaimers below.

export interface InSampleOutOfSampleSplitConfig {
  /** ISO-8601 timestamp. In-sample = every candle with `timestamp <= splitAt`; out-of-sample =
   * every candle strictly after it. Must fall strictly between the dataset's first and last
   * timestamp, and must leave at least one candle on each side — see `resolveSplit` below for the
   * exact rejection rule. Always a fixed, explicit, chronological boundary — never randomised,
   * never inferred, never used to select or tune strategy parameters (this module has no parameter-
   * fitting step at all to feed).
   */
  splitAt: string;
}

export interface BacktestRunConfig extends BacktestConfig {
  split?: InSampleOutOfSampleSplitConfig;
}

export interface BacktestIdentity {
  strategyId: string;
  strategyVersion: string;
  strategyContentHash: string;
  strategyContentHashAlgorithm: typeof CONTENT_HASH_ALGORITHM;
}

export interface DatasetIdentity {
  datasetHash: string;
  datasetHashAlgorithm: "sha256";
  source: string;
  filePath: string;
}

export interface BacktestResult {
  /** A fresh, random UUID minted for THIS execution alone — an operational identifier, never
   * deterministic and never part of `runFingerprint`. Two separate runs of the identical
   * strategy+dataset+config always get a DIFFERENT `runId` but an IDENTICAL `runFingerprint` — use
   * `runFingerprint`, never `runId`, to detect "these two runs represent the same underlying
   * backtest." */
  runId: string;
  /** UTC ISO-8601 instant this run object was produced — operational provenance only, deliberately
   * EXCLUDED from `runFingerprint` (see `computeRunFingerprint`'s own doc comment) so re-running the
   * identical strategy+dataset+config on a different day still fingerprints identically. */
  generatedAt: string;
  engineVersion: number;
  strategy: BacktestIdentity;
  dataset: DatasetIdentity;
  instrument: string;
  timeframe: string;
  config: BacktestRunConfig;
  /** SHA-256 over every field that materially determines this run's outcome (strategy content
   * hash, dataset hash, instrument, timeframe, config, engine version) — see
   * `computeRunFingerprint`. Two runs with an identical fingerprint are GUARANTEED to have produced
   * byte-for-byte identical `full`/`inSample`/`outOfSample` results; a changed fingerprint means at
   * least one of those inputs changed. */
  runFingerprint: string;
  runFingerprintAlgorithm: typeof CONTENT_HASH_ALGORITHM;
  full: BacktestSegmentMetrics;
  inSample?: BacktestSegmentMetrics;
  outOfSample?: BacktestSegmentMetrics;
  warnings: string[];
  limitations: string[];
}

export type BacktestRunRejectionReason = "INVALID_COST_CONFIG" | "INVALID_STARTING_CAPITAL" | "INVALID_SPLIT" | "INSTRUMENT_MISMATCH" | "UNSUPPORTED_INSTRUMENT" | "INSUFFICIENT_HISTORY";

export type BacktestRunResult = { ok: true; result: BacktestResult } | { ok: false; reason: BacktestRunRejectionReason; detail: string };

const STANDING_LIMITATIONS: readonly string[] = [
  "BACKTEST ONLY — NOT APPROVED FOR DEMO OR LIVE TRADING.",
  "Past performance on this fixed historical dataset never implies future results, profitability, or positive expectancy.",
  "Long-only, one position per instrument, no pyramiding, no leverage — a materially simplified execution model versus any real broker.",
  "Position sizing always fully invests available capital into a single position — no configurable sizing, no partial fills, no capital reserved for fees beyond the deducted amount.",
  "This result is never automatically or implicitly promoted to APPROVED_FOR_DEMO/live status — any such promotion requires a separate, explicit, human-reviewed mechanism that does not exist in this phase.",
];

/**
 * Deterministic SHA-256 over exactly the inputs that can change this run's outcome — strategy
 * content hash, dataset hash, instrument, timeframe, the full cost/capital/split config, and the
 * engine version (bumped whenever `runBacktestSegment`'s own logic changes in a way that could
 * alter results for unchanged inputs). Deliberately EXCLUDES `runId` (a fresh random value every
 * run, by design) and `generatedAt` (wall-clock time) — two runs on different days/machines with
 * identical inputs must fingerprint identically; this is the property `reproducibility.test.ts`
 * asserts directly.
 */
export function computeRunFingerprint(input: {
  strategyContentHash: string;
  datasetHash: string;
  instrument: string;
  timeframe: string;
  config: BacktestRunConfig;
  engineVersion: number;
}): string {
  return createHash(CONTENT_HASH_ALGORITHM).update(canonicalStringify(input)).digest("hex");
}

function resolveSplit(candles: readonly Candle[], split: InSampleOutOfSampleSplitConfig): { ok: true; inSample: Candle[]; outOfSample: Candle[] } | { ok: false; detail: string } {
  const splitMs = Date.parse(split.splitAt);
  if (!Number.isFinite(splitMs)) {
    return { ok: false, detail: `split.splitAt is not a parseable timestamp (got ${JSON.stringify(split.splitAt)})` };
  }
  const inSample = candles.filter((c) => Date.parse(c.timestamp) <= splitMs);
  const outOfSample = candles.filter((c) => Date.parse(c.timestamp) > splitMs);
  if (inSample.length === 0 || outOfSample.length === 0) {
    return {
      ok: false,
      detail: `split.splitAt (${split.splitAt}) must fall strictly between the dataset's first (${candles[0]!.timestamp}) and last (${candles[candles.length - 1]!.timestamp}) timestamps, leaving at least one candle on each side — got ${inSample.length} in-sample / ${outOfSample.length} out-of-sample candle(s)`,
    };
  }
  return { ok: true, inSample, outOfSample };
}

/**
 * Runs a full backtest for `document` against `dataset`, optionally split chronologically into
 * in-sample/out-of-sample segments (see `InSampleOutOfSampleSplitConfig`). Rejects explicitly
 * (never silently clamps or guesses) on an invalid cost config, non-positive starting capital, an
 * instrument mismatch between `document`/`dataset`/the caller's own requested instrument, an
 * unsupported instrument, an invalid split, or a dataset shorter than the strategy's own declared
 * `backtestPolicy.minHistoryBars` (a WARNING for a merely-short-of-ideal history is added to
 * `warnings` instead of a hard rejection — only reaching `INSUFFICIENT_HISTORY` when there isn't
 * even enough data for the declared `warmupBars` to complete, since below that no entry could ever
 * legitimately fire at all).
 */
export function runBacktest(document: StrategyDefinitionDocument, dataset: ValidatedCandleDataset, instrument: string, config: BacktestRunConfig, now: () => string = () => new Date().toISOString()): BacktestRunResult {
  const costCheck = validateCostConfig(config);
  if (!costCheck.ok) return { ok: false, reason: "INVALID_COST_CONFIG", detail: costCheck.detail };
  if (!Number.isFinite(config.startingCapital) || config.startingCapital <= 0) {
    return { ok: false, reason: "INVALID_STARTING_CAPITAL", detail: `startingCapital must be a finite number > 0 (got ${JSON.stringify(config.startingCapital)})` };
  }
  if (instrument !== dataset.document.instrument) {
    return { ok: false, reason: "INSTRUMENT_MISMATCH", detail: `requested instrument "${instrument}" does not match the dataset's own instrument "${dataset.document.instrument}"` };
  }
  if (!document.supportedInstruments.includes(instrument)) {
    return { ok: false, reason: "UNSUPPORTED_INSTRUMENT", detail: `strategy "${document.strategyId}" does not declare "${instrument}" in supportedInstruments` };
  }
  if (document.timeframe !== dataset.document.timeframe) {
    return { ok: false, reason: "INSTRUMENT_MISMATCH", detail: `strategy timeframe "${document.timeframe}" does not match the dataset's own timeframe "${dataset.document.timeframe}"` };
  }

  const candles = toCandles(dataset.document);
  if (candles.length <= document.backtestPolicy.warmupBars) {
    return {
      ok: false,
      reason: "INSUFFICIENT_HISTORY",
      detail: `dataset has ${candles.length} candle(s), which does not exceed the strategy's own declared warmupBars (${document.backtestPolicy.warmupBars}) — no entry could ever legitimately fire`,
    };
  }

  const warnings: string[] = [];
  if (candles.length < document.backtestPolicy.minHistoryBars) {
    warnings.push(`Dataset has ${candles.length} candle(s), short of the strategy's own declared minHistoryBars (${document.backtestPolicy.minHistoryBars}) — results may reflect too small a sample to be meaningful.`);
  }

  const strategyContentHash = createHash(CONTENT_HASH_ALGORITHM).update(canonicalStringify(document)).digest("hex");
  const runFingerprint = computeRunFingerprint({
    strategyContentHash,
    datasetHash: dataset.datasetHash,
    instrument,
    timeframe: document.timeframe,
    config,
    engineVersion: BACKTEST_ENGINE_VERSION,
  });

  const full = runBacktestSegment(document, candles, config);
  let inSample: BacktestSegmentMetrics | undefined;
  let outOfSample: BacktestSegmentMetrics | undefined;

  if (config.split) {
    const splitResult = resolveSplit(candles, config.split);
    if (!splitResult.ok) return { ok: false, reason: "INVALID_SPLIT", detail: splitResult.detail };
    if (splitResult.inSample.length <= document.backtestPolicy.warmupBars) {
      warnings.push(`In-sample segment has only ${splitResult.inSample.length} candle(s), at or below warmupBars (${document.backtestPolicy.warmupBars}) — no in-sample entry could ever legitimately fire.`);
    }
    if (splitResult.outOfSample.length <= document.backtestPolicy.warmupBars) {
      warnings.push(`Out-of-sample segment has only ${splitResult.outOfSample.length} candle(s), at or below warmupBars (${document.backtestPolicy.warmupBars}) — no out-of-sample entry could ever legitimately fire.`);
    }
    // Two fully independent segment runs, each with its own fresh warmup and no shared position
    // state — out-of-sample never inherits an open position, a partially-warmed indicator series,
    // or any other state from in-sample. Neither segment is used to select or tune any parameter of
    // `document` — this module has no parameter-fitting step at all. EXPLICIT capital policy: both
    // segments start from the SAME `config.startingCapital` — out-of-sample's own starting capital
    // is never carried over from in-sample's ending capital. This is deliberate, not an oversight:
    // carrying IS's ending capital into OOS would make OOS's own totalReturn/maxDrawdown depend on
    // how IS happened to perform, defeating the purpose of reporting the two as independent segments.
    inSample = runBacktestSegment(document, splitResult.inSample, config);
    outOfSample = runBacktestSegment(document, splitResult.outOfSample, config);
  }

  for (const [label, segment] of [
    ["full", full],
    ["in-sample", inSample],
    ["out-of-sample", outOfSample],
  ] as const) {
    const endOfDataTrades = segment?.trades.filter((t) => t.exitReason === "END_OF_DATA").length ?? 0;
    if (endOfDataTrades > 0) {
      warnings.push(
        `${endOfDataTrades} trade(s) in the ${label} segment closed via END_OF_DATA — a RESEARCH CONVENTION (closing at the dataset's last available price so metrics are computable), never a signal the strategy itself generated. Do not read these as evidence the strategy would have exited there in reality.`,
      );
    }
  }

  return {
    ok: true,
    result: {
      runId: randomUUID(),
      generatedAt: now(),
      engineVersion: BACKTEST_ENGINE_VERSION,
      strategy: { strategyId: document.strategyId, strategyVersion: document.strategyVersion, strategyContentHash, strategyContentHashAlgorithm: CONTENT_HASH_ALGORITHM },
      dataset: { datasetHash: dataset.datasetHash, datasetHashAlgorithm: dataset.datasetHashAlgorithm, source: dataset.document.source, filePath: dataset.provenance.filePath },
      instrument,
      timeframe: document.timeframe,
      config,
      runFingerprint,
      runFingerprintAlgorithm: CONTENT_HASH_ALGORITHM,
      full,
      inSample,
      outOfSample,
      warnings,
      limitations: [...STANDING_LIMITATIONS, ...document.limitations],
    },
  };
}

export type { CandleDatasetDocument };
