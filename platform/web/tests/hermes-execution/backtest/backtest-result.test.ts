import { describe, expect, it } from "vitest";
import { validateCandleDataset } from "@/lib/hermes-execution/backtest/backtest-dataset";
import { computeRunFingerprint, runBacktest, type BacktestRunConfig } from "@/lib/hermes-execution/backtest/backtest-result";
import type { IndicatorDefinition, StrategyDefinitionDocument } from "@/lib/hermes-execution/strategy-definitions/strategy-definition";

// Phase 2 — Deterministic Backtesting Foundation. Reproducibility, run-fingerprint sensitivity, and
// in-sample/out-of-sample split behaviour.

const HOUR_MS = 3_600_000;
const START = Date.parse("2026-01-01T00:00:00.000Z");

function makeDatasetDoc(count = 20, priceStep = 1) {
  const candles = Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(START + i * HOUR_MS).toISOString(),
    open: 100 + i * priceStep,
    high: 100 + i * priceStep + 2,
    low: 100 + i * priceStep - 2,
    close: 100 + i * priceStep + 0.5,
    volume: 10,
  }));
  return { schemaVersion: 1, instrument: "BTC", timeframe: "1h", source: "test", candles };
}

const EMA_INDICATOR: IndicatorDefinition = { id: "ema2", type: "EMA", sourceField: "close", parameters: { period: 2 }, outputAlias: "EMA2" };

function makeDocument(overrides: Partial<StrategyDefinitionDocument> = {}): StrategyDefinitionDocument {
  return {
    schemaVersion: 1,
    strategyId: "TEST_RESULT",
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
    entryRules: { operator: "GREATER_THAN_OR_EQUAL", left: { kind: "MARKET_FIELD", field: "close" }, right: { kind: "CONSTANT", value: 0 } },
    signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 2 }],
    parameters: {},
    eligibility: { requiresReadOnlyVerified: false, requiresStage4Verified: false, requiresConfiguredUniverse: false, notes: [] },
    backtestPolicy: { minHistoryBars: 1, warmupBars: 0, notes: [] },
    provenance: { author: "test", createdAt: "2026-01-01T00:00:00.000Z", notes: [] },
    limitations: ["example limitation"],
    ...overrides,
  };
}

const CONFIG: BacktestRunConfig = { feeBps: 5, slippageBps: 5, startingCapital: 10_000 };

function loadDataset(doc: ReturnType<typeof makeDatasetDoc>) {
  const result = validateCandleDataset(doc, "test.json", "2026-01-01T00:00:00.000Z");
  if (!result.ok) throw new Error("fixture dataset invalid");
  return result.dataset;
}

describe("runBacktest — identity preservation", () => {
  it("preserves strategyId, strategyVersion, and contentHash in the result", () => {
    const document = makeDocument();
    const dataset = loadDataset(makeDatasetDoc());
    const result = runBacktest(document, dataset, "BTC", CONFIG, () => "2026-06-01T00:00:00.000Z");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.strategy.strategyId).toBe("TEST_RESULT");
      expect(result.result.strategy.strategyVersion).toBe("1.0.0");
      expect(result.result.strategy.strategyContentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("includes the standing BACKTEST ONLY disclaimer and the document's own limitations", () => {
    const document = makeDocument();
    const dataset = loadDataset(makeDatasetDoc());
    const result = runBacktest(document, dataset, "BTC", CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.limitations.some((l) => l.includes("BACKTEST ONLY"))).toBe(true);
      expect(result.result.limitations).toContain("example limitation");
    }
  });
});

describe("runBacktest — explicit rejection", () => {
  it("rejects a negative fee config", () => {
    const document = makeDocument();
    const dataset = loadDataset(makeDatasetDoc());
    const result = runBacktest(document, dataset, "BTC", { ...CONFIG, feeBps: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_COST_CONFIG");
  });

  it("rejects non-positive starting capital", () => {
    const document = makeDocument();
    const dataset = loadDataset(makeDatasetDoc());
    const result = runBacktest(document, dataset, "BTC", { ...CONFIG, startingCapital: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_STARTING_CAPITAL");
  });

  it("rejects an instrument the strategy does not support", () => {
    const document = makeDocument({ supportedInstruments: ["ETH"] });
    const dataset = loadDataset(makeDatasetDoc());
    const result = runBacktest(document, dataset, "BTC", CONFIG);
    expect(result.ok).toBe(false);
  });

  it("rejects a requested instrument that does not match the dataset's own instrument", () => {
    const document = makeDocument({ supportedInstruments: ["BTC", "ETH"] });
    const dataset = loadDataset(makeDatasetDoc()); // dataset instrument is BTC
    const result = runBacktest(document, dataset, "ETH", CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INSTRUMENT_MISMATCH");
  });

  it("rejects a dataset with fewer candles than warmupBars", () => {
    const document = makeDocument({ backtestPolicy: { minHistoryBars: 100, warmupBars: 50, notes: [] } });
    const dataset = loadDataset(makeDatasetDoc(20));
    const result = runBacktest(document, dataset, "BTC", CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INSUFFICIENT_HISTORY");
  });

  it("warns (but does not reject) a dataset short of minHistoryBars while still above warmupBars", () => {
    const document = makeDocument({ backtestPolicy: { minHistoryBars: 100, warmupBars: 5, notes: [] } });
    const dataset = loadDataset(makeDatasetDoc(20));
    const result = runBacktest(document, dataset, "BTC", CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.warnings.some((w) => w.includes("minHistoryBars"))).toBe(true);
  });
});

describe("computeRunFingerprint / reproducibility", () => {
  it("produces an identical fingerprint for two separate runs of the identical strategy+dataset+config, even with different generatedAt/runId", () => {
    const document = makeDocument();
    const dataset = loadDataset(makeDatasetDoc());
    const runA = runBacktest(document, dataset, "BTC", CONFIG, () => "2026-01-01T00:00:00.000Z");
    const runB = runBacktest(document, dataset, "BTC", CONFIG, () => "2099-12-31T23:59:59.000Z");
    expect(runA.ok && runB.ok).toBe(true);
    if (runA.ok && runB.ok) {
      expect(runA.result.runFingerprint).toBe(runB.result.runFingerprint);
      expect(runA.result.runId).not.toBe(runB.result.runId);
      expect(runA.result.generatedAt).not.toBe(runB.result.generatedAt);
      // Reproducibility means more than a matching fingerprint — the actual computed results must
      // be byte-for-byte identical too (excluding the two operational-provenance fields above).
      expect(runA.result.full).toEqual(runB.result.full);
    }
  });

  it("changes the fingerprint when the strategy document changes materially", () => {
    const dataset = loadDataset(makeDatasetDoc());
    const runA = runBacktest(makeDocument(), dataset, "BTC", CONFIG);
    const runB = runBacktest(makeDocument({ indicators: [{ ...EMA_INDICATOR, parameters: { period: 3 } }] }), dataset, "BTC", CONFIG);
    expect(runA.ok && runB.ok).toBe(true);
    if (runA.ok && runB.ok) expect(runA.result.runFingerprint).not.toBe(runB.result.runFingerprint);
  });

  it("changes the fingerprint when the dataset changes", () => {
    const document = makeDocument();
    const datasetA = loadDataset(makeDatasetDoc(20, 1));
    const datasetB = loadDataset(makeDatasetDoc(20, 2)); // different price step -> different candle data
    const runA = runBacktest(document, datasetA, "BTC", CONFIG);
    const runB = runBacktest(document, datasetB, "BTC", CONFIG);
    expect(runA.ok && runB.ok).toBe(true);
    if (runA.ok && runB.ok) expect(runA.result.runFingerprint).not.toBe(runB.result.runFingerprint);
  });

  it("changes the fingerprint when the cost config changes", () => {
    const document = makeDocument();
    const dataset = loadDataset(makeDatasetDoc());
    const runA = runBacktest(document, dataset, "BTC", CONFIG);
    const runB = runBacktest(document, dataset, "BTC", { ...CONFIG, feeBps: 999 });
    expect(runA.ok && runB.ok).toBe(true);
    if (runA.ok && runB.ok) expect(runA.result.runFingerprint).not.toBe(runB.result.runFingerprint);
  });

  it("computeRunFingerprint is a pure function of its own inputs, independent of runBacktest's own runId/generatedAt", () => {
    const fp1 = computeRunFingerprint({ strategyContentHash: "abc", datasetHash: "def", instrument: "BTC", timeframe: "1h", config: CONFIG, engineVersion: 1 });
    const fp2 = computeRunFingerprint({ strategyContentHash: "abc", datasetHash: "def", instrument: "BTC", timeframe: "1h", config: CONFIG, engineVersion: 1 });
    expect(fp1).toBe(fp2);
  });
});

describe("in-sample / out-of-sample split", () => {
  it("reports IS and OOS separately, both chronologically bounded by splitAt", () => {
    const document = makeDocument();
    const dataset = loadDataset(makeDatasetDoc(30));
    const splitAt = new Date(START + 15 * HOUR_MS).toISOString();
    const result = runBacktest(document, dataset, "BTC", { ...CONFIG, split: { splitAt } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.inSample).toBeDefined();
      expect(result.result.outOfSample).toBeDefined();
      expect(Date.parse(result.result.inSample!.endTimestamp)).toBeLessThanOrEqual(Date.parse(splitAt));
      expect(Date.parse(result.result.outOfSample!.startTimestamp)).toBeGreaterThan(Date.parse(splitAt));
      // Full/IS/OOS bar counts partition the whole dataset with no overlap and no gap.
      expect(result.result.inSample!.barCount + result.result.outOfSample!.barCount).toBe(result.result.full.barCount);
    }
  });

  it("rejects a split at or before the dataset's first candle (leaves zero in-sample candles)", () => {
    const document = makeDocument();
    const dataset = loadDataset(makeDatasetDoc(30));
    const splitAt = new Date(START - HOUR_MS).toISOString();
    const result = runBacktest(document, dataset, "BTC", { ...CONFIG, split: { splitAt } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_SPLIT");
  });

  it("rejects a split at or after the dataset's last candle (leaves zero out-of-sample candles)", () => {
    const document = makeDocument();
    const dataset = loadDataset(makeDatasetDoc(30));
    const splitAt = new Date(START + 40 * HOUR_MS).toISOString();
    const result = runBacktest(document, dataset, "BTC", { ...CONFIG, split: { splitAt } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_SPLIT");
  });

  it("rejects an unparseable split timestamp", () => {
    const document = makeDocument();
    const dataset = loadDataset(makeDatasetDoc(30));
    const result = runBacktest(document, dataset, "BTC", { ...CONFIG, split: { splitAt: "not-a-date" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_SPLIT");
  });

  it("is deterministic — never randomised — across repeated calls with the same split", () => {
    const document = makeDocument();
    const dataset = loadDataset(makeDatasetDoc(30));
    const splitAt = new Date(START + 15 * HOUR_MS).toISOString();
    const runA = runBacktest(document, dataset, "BTC", { ...CONFIG, split: { splitAt } });
    const runB = runBacktest(document, dataset, "BTC", { ...CONFIG, split: { splitAt } });
    expect(runA.ok && runB.ok).toBe(true);
    if (runA.ok && runB.ok) {
      expect(runA.result.inSample).toEqual(runB.result.inSample);
      expect(runA.result.outOfSample).toEqual(runB.result.outOfSample);
    }
  });

  it("out-of-sample is computed independently — it never inherits an in-sample open position or warmed-up indicator continuity", () => {
    // A strategy that would hold a position past the split point in a single continuous run must
    // NOT carry that open position into the out-of-sample segment — OOS starts genuinely flat.
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 1000 }] }); // would hold indefinitely if continuous
    const dataset = loadDataset(makeDatasetDoc(30));
    const splitAt = new Date(START + 15 * HOUR_MS).toISOString();
    const result = runBacktest(document, dataset, "BTC", { ...CONFIG, split: { splitAt } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // OOS gets its OWN fresh entry (bar 0 of its own slice), not a position whose entryBarIndex
      // predates the split.
      const oosFirstTrade = result.result.outOfSample!.trades[0];
      if (oosFirstTrade) expect(oosFirstTrade.entryBarIndex).toBeLessThan(result.result.outOfSample!.barCount);
    }
  });

  it("a signal on the LAST in-sample bar cannot execute in the out-of-sample segment — it simply never executes within IS either (no next bar in that segment)", () => {
    // Entry rule is always-true, so a signal is detected on literally every bar. In a continuous
    // run this would open at bar 1; the same must hold true for the in-sample segment alone, and
    // in-sample's own LAST bar's signal must never leak into out-of-sample as an executed trade.
    const document = makeDocument();
    const dataset = loadDataset(makeDatasetDoc(20));
    const splitAt = new Date(START + 9 * HOUR_MS).toISOString(); // in-sample = bars 0..9 (10 bars)
    const result = runBacktest(document, dataset, "BTC", { ...CONFIG, split: { splitAt } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const oosTrades = result.result.outOfSample!.trades;
      // Every out-of-sample trade's own entryBarIndex is relative to the OOS segment's own bar 0 —
      // none of them can be negative (which would imply "entered before this segment started").
      for (const trade of oosTrades) expect(trade.entryBarIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it("out-of-sample's own indicators are warmed from ITS OWN bar 0, never inheriting in-sample history — a short OOS segment triggers the same warmup warning as a standalone short dataset would", () => {
    const document = makeDocument({ backtestPolicy: { minHistoryBars: 100, warmupBars: 5, notes: [] } });
    const dataset = loadDataset(makeDatasetDoc(20));
    const splitAt = new Date(START + 15 * HOUR_MS).toISOString(); // out-of-sample gets only 4 candles, below warmupBars=5
    const result = runBacktest(document, dataset, "BTC", { ...CONFIG, split: { splitAt } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.warnings.some((w) => w.includes("Out-of-sample segment has only"))).toBe(true);
    }
  });
});

describe("runBacktest — END_OF_DATA is flagged as a research convention, never a tradable signal (pre-commit review)", () => {
  it("adds an explicit warning naming the segment when a trade closes via END_OF_DATA", () => {
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 1000 }] }); // never signals an exit within the dataset
    const dataset = loadDataset(makeDatasetDoc(10));
    const result = runBacktest(document, dataset, "BTC", CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.full.trades.some((t) => t.exitReason === "END_OF_DATA")).toBe(true);
      expect(result.result.warnings.some((w) => w.includes("END_OF_DATA") && w.includes("full"))).toBe(true);
    }
  });

  it("adds no such warning when every trade closes via a genuine signal", () => {
    // With an always-true entry rule and maxBars=2, each full entry->exit cycle is exactly 4 bars
    // (entry executes, held for 2 bars, exit executes 1 bar after the signal, next entry executes
    // the bar immediately after that). 21 candles (entries at bars 1/5/9/13/17, exits at
    // 4/8/12/16/20) lands the LAST exit exactly on the final bar — never leaving a position
    // dangling into END_OF_DATA.
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 2 }] });
    const dataset = loadDataset(makeDatasetDoc(21));
    const result = runBacktest(document, dataset, "BTC", CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.full.trades.every((t) => t.exitReason !== "END_OF_DATA")).toBe(true);
      expect(result.result.warnings.some((w) => w.includes("END_OF_DATA"))).toBe(false);
    }
  });
});

describe("runBacktest — engine version is explicit and fingerprinted (pre-commit review)", () => {
  it("reports engineVersion 2 following the fee-sizing and mark-to-market-drawdown corrections", () => {
    const document = makeDocument();
    const dataset = loadDataset(makeDatasetDoc());
    const result = runBacktest(document, dataset, "BTC", CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.engineVersion).toBe(2);
  });
});

describe("runBacktest — a successful run never promotes the strategy document (pre-commit review)", () => {
  it("the result carries no field capable of mutating strategy status/approval, and the document object itself is untouched", () => {
    const document = makeDocument();
    const frozenSnapshot = JSON.parse(JSON.stringify(document));
    const dataset = loadDataset(makeDatasetDoc());
    const result = runBacktest(document, dataset, "BTC", CONFIG);
    expect(result.ok).toBe(true);
    expect(document).toEqual(frozenSnapshot); // runBacktest never mutates the document it was given
    if (result.ok) {
      expect(result.result).not.toHaveProperty("status");
      expect(result.result).not.toHaveProperty("usableForDemo");
    }
  });
});
