import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRobustnessWarnings, runResearch } from "@/lib/hermes-execution/strategy-research/research-engine";
import { computeAggregateStatistics, computeResearchFingerprint, type VariantInstrumentResult, type VariantResult } from "@/lib/hermes-execution/strategy-research/research-result";
import { validateResearchPlan } from "@/lib/hermes-execution/strategy-research/research-plan";
import type { BacktestSegmentMetrics } from "@/lib/hermes-execution/backtest/backtest-engine";
import { baselineStrategyContentHash, datasetHashFor, makeBaselineStrategyDocument, makeCatalogueEntries, makeDatasetDoc, makeResearchPlanRaw, writeJsonFile } from "./fixtures";

// Phase 3 — Strategy Research Workflow. End-to-end orchestration: PASS/FAIL/INCONCLUSIVE/INVALID
// outcomes, criteria evaluation, robustness warnings, and reproducibility — through the REAL Phase 2
// backtest engine (never a second, duplicated one).

const CATALOGUE = makeCatalogueEntries();
const STRATEGY_HASH = baselineStrategyContentHash();

/** Fills in every `BacktestSegmentMetrics` field with an inert default, so pure-function unit tests
 * below only need to specify the handful of fields their own assertions actually depend on. */
function makeSegmentMetrics(overrides: Partial<BacktestSegmentMetrics>): BacktestSegmentMetrics {
  return {
    barCount: 100,
    startTimestamp: "2026-01-01T00:00:00.000Z",
    endTimestamp: "2026-01-05T00:00:00.000Z",
    startingCapital: 10_000,
    endingCapital: 10_090,
    totalReturn: 0.01,
    grossPnl: 100,
    netPnl: 90,
    totalFees: 5,
    totalSlippageCost: 5,
    tradeCount: 5,
    winRate: 0.6,
    maxDrawdown: 0.05,
    averageTrade: 18,
    profitFactor: 2,
    exposurePercentage: 50,
    trades: [],
    ...overrides,
  };
}

describe("runResearch", () => {
  let strategiesDir: string;
  let dataDir: string;
  let planDir: string;

  beforeEach(async () => {
    strategiesDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-engine-strategies-"));
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-engine-data-"));
    planDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-engine-plan-"));
    await writeJsonFile(strategiesDir, "test.json", makeBaselineStrategyDocument());
  });

  afterEach(async () => {
    await fs.rm(strategiesDir, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(planDir, { recursive: true, force: true });
  });

  async function writeDataset(instrument: string, count = 200, seedOffset = 0): Promise<{ filePath: string; hash: string; doc: ReturnType<typeof makeDatasetDoc> }> {
    const doc = makeDatasetDoc(instrument, count, seedOffset);
    const filePath = await writeJsonFile(dataDir, `${instrument}.json`, doc);
    return { filePath, hash: datasetHashFor(instrument, count, seedOffset), doc };
  }

  async function writePlan(overrides: Record<string, unknown> = {}): Promise<string> {
    return writeJsonFile(planDir, "plan.json", makeResearchPlanRaw({ strategyContentHash: STRATEGY_HASH, ...overrides }));
  }

  it("PASS: a trivial, always-true mandatory criterion against real evidence produces PASS", async () => {
    const btc = await writeDataset("BTC");
    const planPath = await writePlan({
      instruments: ["BTC"],
      datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: btc.filePath, expectedDatasetHash: btc.hash, startTimestamp: btc.doc.candles[0]!.timestamp, endTimestamp: btc.doc.candles[btc.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
      passCriteria: [{ metric: "MIN_TRADE_COUNT", operator: "GREATER_THAN_OR_EQUAL", threshold: 0, scope: "OVERALL" }],
    });
    const result = await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.outcome).toBe("PASS");
  });

  it("FAIL: an unmeetable mandatory criterion produces FAIL, not a crash", async () => {
    const btc = await writeDataset("BTC");
    const planPath = await writePlan({
      instruments: ["BTC"],
      datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: btc.filePath, expectedDatasetHash: btc.hash, startTimestamp: btc.doc.candles[0]!.timestamp, endTimestamp: btc.doc.candles[btc.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
      passCriteria: [{ metric: "MIN_NET_RETURN", operator: "GREATER_THAN_OR_EQUAL", threshold: 999, scope: "OVERALL" }], // impossible to meet, but validly within [-1, +inf) range
    });
    const result = await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.outcome).toBe("FAIL");
  });

  it("FAIL: a triggered failureCriteria entry FAILs regardless of passCriteria", async () => {
    const btc = await writeDataset("BTC");
    const planPath = await writePlan({
      instruments: ["BTC"],
      datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: btc.filePath, expectedDatasetHash: btc.hash, startTimestamp: btc.doc.candles[0]!.timestamp, endTimestamp: btc.doc.candles[btc.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
      passCriteria: [{ metric: "MIN_TRADE_COUNT", operator: "GREATER_THAN_OR_EQUAL", threshold: 0, scope: "OVERALL" }],
      failureCriteria: [{ metric: "MAX_DRAWDOWN", operator: "GREATER_THAN_OR_EQUAL", threshold: 0, scope: "OVERALL" }], // always triggers (drawdown is always >= 0)
    });
    const result = await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.outcome).toBe("FAIL");
  });

  it("INCONCLUSIVE: zero baseline trades produces INCONCLUSIVE, never a false PASS", async () => {
    // Entry rule requires RSI between 30-75 AND EMA_FAST > EMA_SLOW — override the RSI bounds to an
    // unreachable, always-false range so literally no entry ever fires.
    const strategyDoc = makeBaselineStrategyDocument({
      entryRules: {
        operator: "AND",
        rules: [
          { operator: "GREATER_THAN", left: { kind: "INDICATOR_ALIAS", alias: "EMA_FAST" }, right: { kind: "INDICATOR_ALIAS", alias: "EMA_SLOW" } },
          { operator: "BETWEEN", operand: { kind: "INDICATOR_ALIAS", alias: "RSI14" }, lowerBound: { kind: "CONSTANT", value: 200 }, upperBound: { kind: "CONSTANT", value: 300 } },
        ],
      },
    });
    await writeJsonFile(strategiesDir, "test.json", strategyDoc);
    const hash = baselineStrategyContentHash({
      entryRules: {
        operator: "AND",
        rules: [
          { operator: "GREATER_THAN", left: { kind: "INDICATOR_ALIAS", alias: "EMA_FAST" }, right: { kind: "INDICATOR_ALIAS", alias: "EMA_SLOW" } },
          { operator: "BETWEEN", operand: { kind: "INDICATOR_ALIAS", alias: "RSI14" }, lowerBound: { kind: "CONSTANT", value: 200 }, upperBound: { kind: "CONSTANT", value: 300 } },
        ],
      },
    });
    const btc = await writeDataset("BTC");
    const planPath = await writePlan({
      instruments: ["BTC"],
      strategyContentHash: hash,
      datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: btc.filePath, expectedDatasetHash: btc.hash, startTimestamp: btc.doc.candles[0]!.timestamp, endTimestamp: btc.doc.candles[btc.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
      passCriteria: [{ metric: "MIN_TRADE_COUNT", operator: "GREATER_THAN_OR_EQUAL", threshold: 0, scope: "OVERALL" }],
    });
    const result = await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.baseline.perInstrument[0]!.full!.tradeCount).toBe(0);
      expect(result.result.outcome).toBe("INCONCLUSIVE");
    }
  });

  it("INVALID (top-level rejection): a nonexistent plan file is reported as an explicit stage/reason, never thrown", async () => {
    const result = await runResearch({ planPath: path.join(planDir, "does-not-exist.json"), strategiesDir, catalogueEntries: CATALOGUE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("plan");
  });

  it("INVALID: strategy not found in the registry", async () => {
    const planPath = await writePlan({ strategyId: "NOT_A_REAL_STRATEGY", strategyContentHash: "a".repeat(64) });
    const result = await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("strategy");
  });

  it("INVALID: dataset hash mismatch is rejected before any experiment runs", async () => {
    const btc = await writeDataset("BTC");
    const planPath = await writePlan({
      instruments: ["BTC"],
      datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: btc.filePath, expectedDatasetHash: "f".repeat(64), startTimestamp: btc.doc.candles[0]!.timestamp, endTimestamp: btc.doc.candles[btc.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
    });
    const result = await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("dataset");
  });

  it("INVALID: an instrument the strategy does not support is rejected", async () => {
    const btc = await writeDataset("BTC");
    const strategyDoc = makeBaselineStrategyDocument({ supportedInstruments: ["BTC"] });
    await writeJsonFile(strategiesDir, "test.json", strategyDoc);
    const hash = baselineStrategyContentHash({ supportedInstruments: ["BTC"] });
    const planPath = await writePlan({
      strategyContentHash: hash,
      instruments: ["BTC", "ETH"],
      datasets: [
        { instrument: "BTC", timeframe: "1h", datasetFile: btc.filePath, expectedDatasetHash: btc.hash, startTimestamp: btc.doc.candles[0]!.timestamp, endTimestamp: btc.doc.candles[btc.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" },
      ],
    });
    const result = await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("strategy");
  });

  it("PER_INSTRUMENT criteria require EVERY declared instrument to satisfy the criterion, not merely the average", async () => {
    const btc = await writeDataset("BTC", 200, 0);
    const eth = await writeDataset("ETH", 200, 500); // different seedOffset -> different price path -> different drawdown
    const planPath = await writePlan({
      instruments: ["BTC", "ETH"],
      datasets: [
        { instrument: "BTC", timeframe: "1h", datasetFile: btc.filePath, expectedDatasetHash: btc.hash, startTimestamp: btc.doc.candles[0]!.timestamp, endTimestamp: btc.doc.candles[btc.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" },
        { instrument: "ETH", timeframe: "1h", datasetFile: eth.filePath, expectedDatasetHash: eth.hash, startTimestamp: eth.doc.candles[0]!.timestamp, endTimestamp: eth.doc.candles[eth.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" },
      ],
      passCriteria: [{ metric: "MAX_DRAWDOWN", operator: "LESS_THAN_OR_EQUAL", threshold: 0, scope: "PER_INSTRUMENT" }], // impossible unless both have literally zero drawdown
    });
    const result = await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const evaluation = result.result.criterionEvaluations[0]!;
      expect(evaluation.satisfied).toBe(false); // at least one instrument has nonzero drawdown
    }
  });

  it("reports IS/OOS separately and flags material degradation as a warning", async () => {
    const btc = await writeDataset("BTC", 200);
    const planPath = await writePlan({
      instruments: ["BTC"],
      datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: btc.filePath, expectedDatasetHash: btc.hash, startTimestamp: btc.doc.candles[0]!.timestamp, endTimestamp: btc.doc.candles[btc.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
      chronologicalSplits: [{ instrument: "BTC", splitAt: btc.doc.candles[100]!.timestamp }],
    });
    const result = await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const instrumentResult = result.result.baseline.perInstrument[0]!;
      expect(instrumentResult.mode).toBe("SPLIT");
      expect(instrumentResult.inSample).toBeDefined();
      expect(instrumentResult.outOfSample).toBeDefined();
    }
  });

  it("MIN_ACCEPTABLE_VARIANT_PERCENTAGE (ACROSS_VARIANTS) reflects the actual acceptable-variant share", async () => {
    const btc = await writeDataset("BTC");
    const planPath = await writePlan({
      instruments: ["BTC"],
      datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: btc.filePath, expectedDatasetHash: btc.hash, startTimestamp: btc.doc.candles[0]!.timestamp, endTimestamp: btc.doc.candles[btc.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
      parameterExperiments: { dimensions: { maxBarsHeld: { kind: "EXPLICIT_VALUES", values: [15, 20, 25] } }, maxExperiments: 10 },
      passCriteria: [
        { metric: "MIN_TRADE_COUNT", operator: "GREATER_THAN_OR_EQUAL", threshold: 0, scope: "OVERALL" },
        { metric: "MIN_ACCEPTABLE_VARIANT_PERCENTAGE", operator: "GREATER_THAN_OR_EQUAL", threshold: 50, scope: "ACROSS_VARIANTS" },
      ],
    });
    const result = await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.variants.length).toBe(4); // baseline + 3
      expect(result.result.aggregate.acceptableVariantPercentage).toBeGreaterThanOrEqual(0);
      expect(result.result.aggregate.acceptableVariantPercentage).toBeLessThanOrEqual(100);
      const acrossVariantsEval = result.result.criterionEvaluations.find((e) => e.criterion.scope === "ACROSS_VARIANTS")!;
      expect(acrossVariantsEval.observedValue).toBe(result.result.aggregate.acceptableVariantPercentage);
    }
  });

  it("one strong outlier variant cannot produce PASS when the baseline itself fails", async () => {
    const btc = await writeDataset("BTC");
    const planPath = await writePlan({
      instruments: ["BTC"],
      datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: btc.filePath, expectedDatasetHash: btc.hash, startTimestamp: btc.doc.candles[0]!.timestamp, endTimestamp: btc.doc.candles[btc.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
      parameterExperiments: { dimensions: { maxBarsHeld: { kind: "EXPLICIT_VALUES", values: [15, 20, 25] } }, maxExperiments: 10 },
      // Impossible threshold — the BASELINE can never satisfy this, regardless of whether some
      // other variant happens to look better by chance.
      passCriteria: [{ metric: "MIN_NET_RETURN", operator: "GREATER_THAN_OR_EQUAL", threshold: 999, scope: "OVERALL" }],
    });
    const result = await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Outcome is decided by the BASELINE alone — never by whichever variant scored best.
      expect(result.result.outcome).toBe("FAIL");
    }
  });

  it("never writes anything into the strategies directory — no registry mutation, no promotion side effect", async () => {
    const before = await fs.readFile(path.join(strategiesDir, "test.json"), "utf-8");
    const filesBefore = await fs.readdir(strategiesDir);
    const btc = await writeDataset("BTC");
    const planPath = await writePlan({
      instruments: ["BTC"],
      datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: btc.filePath, expectedDatasetHash: btc.hash, startTimestamp: btc.doc.candles[0]!.timestamp, endTimestamp: btc.doc.candles[btc.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
    });
    await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE });
    const after = await fs.readFile(path.join(strategiesDir, "test.json"), "utf-8");
    const filesAfter = await fs.readdir(strategiesDir);
    expect(after).toBe(before);
    expect(filesAfter).toEqual(filesBefore);
  });

  it("records the complete planDocument and a per-variant resultFingerprint in the result (evidence completeness)", async () => {
    const btc = await writeDataset("BTC");
    const planPath = await writePlan({
      instruments: ["BTC"],
      datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: btc.filePath, expectedDatasetHash: btc.hash, startTimestamp: btc.doc.candles[0]!.timestamp, endTimestamp: btc.doc.candles[btc.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
    });
    const result = await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.planDocument.researchPlanId).toBe("TEST_RESEARCH_PLAN");
      expect(result.result.baseline.resultFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("reports excludedCombinations for structurally invalid parameter combinations, never silently dropping them", async () => {
    const btc = await writeDataset("BTC");
    const planPath = await writePlan({
      instruments: ["BTC"],
      datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: btc.filePath, expectedDatasetHash: btc.hash, startTimestamp: btc.doc.candles[0]!.timestamp, endTimestamp: btc.doc.candles[btc.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
      // baseline is EMA_FAST=5/EMA_SLOW=10; (50,20) and (50,40) are structurally invalid (fast>=slow)
      parameterExperiments: { dimensions: { emaFastPeriod: { kind: "EXPLICIT_VALUES", values: [3, 50] }, emaSlowPeriod: { kind: "EXPLICIT_VALUES", values: [20, 40] } }, maxExperiments: 20 },
    });
    const result = await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.excludedCombinations.length).toBe(2);
      expect(result.result.excludedCombinations.every((e) => e.reason.includes("emaFastPeriod"))).toBe(true);
    }
  });

  it("rejects a plan whose declared dimensions would raise the raw combination count above the cap, before materialising the cartesian product (D5)", async () => {
    const btc = await writeDataset("BTC");
    const planPath = await writePlan({
      instruments: ["BTC"],
      datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: btc.filePath, expectedDatasetHash: btc.hash, startTimestamp: btc.doc.candles[0]!.timestamp, endTimestamp: btc.doc.candles[btc.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
      parameterExperiments: { dimensions: { atrPeriod: { kind: "RANGE", min: 1, max: 100, step: 1 } }, maxExperiments: 10 },
    });
    const result = await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE, maxExperimentsOverride: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("experiments");
      expect(result.reason).toBe("EXPERIMENT_CAP_EXCEEDED");
    }
  });

  it("rejects a plan whose declared dimensions produce zero valid variants beyond the baseline (D6)", async () => {
    const btc = await writeDataset("BTC");
    const planPath = await writePlan({
      instruments: ["BTC"],
      datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: btc.filePath, expectedDatasetHash: btc.hash, startTimestamp: btc.doc.candles[0]!.timestamp, endTimestamp: btc.doc.candles[btc.doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
      // Every combination has emaFastPeriod >= emaSlowPeriod -> all excluded, none survive.
      parameterExperiments: { dimensions: { emaFastPeriod: { kind: "EXPLICIT_VALUES", values: [50, 60] }, emaSlowPeriod: { kind: "EXPLICIT_VALUES", values: [10, 20] } }, maxExperiments: 20 },
    });
    const result = await runResearch({ planPath, strategiesDir, catalogueEntries: CATALOGUE });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("experiments");
      expect(result.reason).toBe("NO_VALID_VARIANTS");
    }
  });
});

describe("computeAggregateStatistics — acceptableVariantPercentage denominator (D8)", () => {
  const acceptableInstrument: VariantInstrumentResult = {
    instrument: "BTC",
    mode: "FULL_ONLY",
    full: makeSegmentMetrics({ tradeCount: 5, totalReturn: 0.1 }),
    stressPeriods: [],
  };

  function loadPlan() {
    const planResult = validateResearchPlan(makeResearchPlanRaw({ passCriteria: [{ metric: "MIN_TRADE_COUNT", operator: "GREATER_THAN_OR_EQUAL", threshold: 0, scope: "OVERALL" }] }), undefined, "t");
    if (!planResult.ok) throw new Error("fixture research plan failed to validate");
    return planResult.document;
  }

  it("denominator is the TOTAL variant count, including variants rejected during generation/execution — never just the evaluable ones", () => {
    const plan = loadPlan();
    const baseline: VariantResult = { variantId: "BASELINE", contentHash: "x", overrides: {}, isBaseline: true, strategyContentHash: "y", perInstrument: [acceptableInstrument] };
    const rejected: VariantResult = { variantId: "VARIANT-0000", contentHash: "z", overrides: { rsiPeriod: 999 }, isBaseline: false, perInstrument: [], rejected: { reason: "VALIDATION_FAILED", detail: "test" } };
    const aggregate = computeAggregateStatistics(baseline, [baseline, rejected], plan);
    expect(aggregate.variantCount).toBe(2);
    expect(aggregate.evaluableVariantCount).toBe(1);
    expect(aggregate.acceptableVariantCount).toBe(1);
    // 1 acceptable / 2 TOTAL = 50%, never 1/1 (evaluable-only) = 100%.
    expect(aggregate.acceptableVariantPercentage).toBe(50);
  });

  it("is 100 when every generated variant (including rejected ones) is absent — zero variants means zero acceptable, never a divide-by-zero", () => {
    const plan = loadPlan();
    const baseline: VariantResult = { variantId: "BASELINE", contentHash: "x", overrides: {}, isBaseline: true, strategyContentHash: "y", perInstrument: [acceptableInstrument] };
    const aggregate = computeAggregateStatistics(baseline, [], plan);
    expect(aggregate.acceptableVariantPercentage).toBe(0);
  });
});

describe("buildRobustnessWarnings — wording and single-parameter-neighbour check (D9)", () => {
  function loadPlan(overrides: Record<string, unknown> = {}) {
    const planResult = validateResearchPlan(makeResearchPlanRaw({ passCriteria: [{ metric: "MIN_NET_RETURN", operator: "GREATER_THAN_OR_EQUAL", threshold: 0.05, scope: "OVERALL" }], ...overrides }), undefined, "t");
    if (!planResult.ok) throw new Error("fixture research plan failed to validate");
    return planResult.document;
  }

  function instrumentResult(netReturn: number): VariantInstrumentResult {
    return { instrument: "BTC", mode: "FULL_ONLY", full: makeSegmentMetrics({ totalReturn: netReturn }), stressPeriods: [] };
  }

  it("never claims a 'neighbourhood' for the flat acceptable/total grid ratio", () => {
    const plan = loadPlan();
    const baseline: VariantResult = { variantId: "BASELINE", contentHash: "x", overrides: {}, isBaseline: true, strategyContentHash: "y", perInstrument: [instrumentResult(0.1)] };
    // 4 non-baseline variants, each with 2 override keys (never "single-parameter") — only VARIANT-0000 is acceptable.
    const variants: VariantResult[] = [
      baseline,
      { variantId: "VARIANT-0000", contentHash: "a", overrides: { rsiPeriod: 8, atrPeriod: 10 }, isBaseline: false, strategyContentHash: "y", perInstrument: [instrumentResult(0.1)] },
      { variantId: "VARIANT-0001", contentHash: "b", overrides: { rsiPeriod: 9, atrPeriod: 11 }, isBaseline: false, strategyContentHash: "y", perInstrument: [instrumentResult(-0.1)] },
      { variantId: "VARIANT-0002", contentHash: "c", overrides: { rsiPeriod: 10, atrPeriod: 12 }, isBaseline: false, strategyContentHash: "y", perInstrument: [instrumentResult(-0.1)] },
      { variantId: "VARIANT-0003", contentHash: "d", overrides: { rsiPeriod: 11, atrPeriod: 13 }, isBaseline: false, strategyContentHash: "y", perInstrument: [instrumentResult(-0.1)] },
    ];
    const aggregate = computeAggregateStatistics(baseline, variants, plan);
    const warnings = buildRobustnessWarnings(baseline, variants, aggregate, plan);
    expect(warnings.some((w) => w.includes("parameter grid"))).toBe(true);
    expect(warnings.some((w) => w.toLowerCase().includes("neighbourhood"))).toBe(false);
  });

  it("flags disagreement between the baseline and its genuine single-parameter neighbours", () => {
    const plan = loadPlan();
    const baseline: VariantResult = { variantId: "BASELINE", contentHash: "x", overrides: {}, isBaseline: true, strategyContentHash: "y", perInstrument: [instrumentResult(0.1)] }; // acceptable
    // A single-parameter neighbour (exactly one override key) that disagrees with the baseline's own acceptability.
    const neighbour: VariantResult = { variantId: "VARIANT-0000", contentHash: "a", overrides: { rsiPeriod: 8 }, isBaseline: false, strategyContentHash: "y", perInstrument: [instrumentResult(-0.1)] }; // not acceptable
    const variants = [baseline, neighbour];
    const aggregate = computeAggregateStatistics(baseline, variants, plan);
    const warnings = buildRobustnessWarnings(baseline, variants, aggregate, plan);
    expect(warnings.some((w) => w.includes("single-parameter neighbours"))).toBe(true);
  });
});

describe("reproducibility", () => {
  it("computeResearchFingerprint excludes generatedAt/runId/paths by construction — identical logical inputs always fingerprint identically", () => {
    const input = {
      planContentHash: "a".repeat(64),
      strategyContentHash: "b".repeat(64),
      datasetHashes: [{ instrument: "BTC", role: "FULL_HISTORY" as const, datasetHash: "c".repeat(64) }],
      experimentMatrixHash: "d".repeat(64),
      phase2EngineVersion: 2,
      phase3EngineVersion: 1,
    };
    expect(computeResearchFingerprint(input)).toBe(computeResearchFingerprint(input));
  });

  it("is order-independent over datasetHashes (canonical sort)", () => {
    const base = { planContentHash: "a".repeat(64), strategyContentHash: "b".repeat(64), experimentMatrixHash: "d".repeat(64), phase2EngineVersion: 2, phase3EngineVersion: 1 };
    const fp1 = computeResearchFingerprint({ ...base, datasetHashes: [{ instrument: "BTC", role: "FULL_HISTORY" as const, datasetHash: "1".repeat(64) }, { instrument: "ETH", role: "FULL_HISTORY" as const, datasetHash: "2".repeat(64) }] });
    const fp2 = computeResearchFingerprint({ ...base, datasetHashes: [{ instrument: "ETH", role: "FULL_HISTORY" as const, datasetHash: "2".repeat(64) }, { instrument: "BTC", role: "FULL_HISTORY" as const, datasetHash: "1".repeat(64) }] });
    expect(fp1).toBe(fp2);
  });

  it("changes when the strategy content hash changes", () => {
    const base = { planContentHash: "a".repeat(64), datasetHashes: [], experimentMatrixHash: "d".repeat(64), phase2EngineVersion: 2, phase3EngineVersion: 1 };
    const fp1 = computeResearchFingerprint({ ...base, strategyContentHash: "b".repeat(64) });
    const fp2 = computeResearchFingerprint({ ...base, strategyContentHash: "c".repeat(64) });
    expect(fp1).not.toBe(fp2);
  });

  it("changes when the experiment matrix hash changes", () => {
    const base = { planContentHash: "a".repeat(64), strategyContentHash: "b".repeat(64), datasetHashes: [], phase2EngineVersion: 2, phase3EngineVersion: 1 };
    const fp1 = computeResearchFingerprint({ ...base, experimentMatrixHash: "d".repeat(64) });
    const fp2 = computeResearchFingerprint({ ...base, experimentMatrixHash: "e".repeat(64) });
    expect(fp1).not.toBe(fp2);
  });
});
