import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeDatasetHash, loadCandleDataset, MAX_DATASET_CANDLES, toCandles, validateCandleDataset } from "@/lib/hermes-execution/backtest/backtest-dataset";

// Phase 2 — Deterministic Backtesting Foundation. Dataset validation: fixed local JSON only, no
// provider call anywhere in this module (confirmed by its own top-of-file comment and by having no
// broker/provider import at all) — this suite only exercises pure parsing/validation.

const HOUR_MS = 3_600_000;
const START = Date.parse("2026-01-01T00:00:00.000Z");

function makeCandles(count: number, priceStart = 100) {
  const candles = [];
  for (let i = 0; i < count; i++) {
    const price = priceStart + i * 0.1;
    candles.push({
      timestamp: new Date(START + i * HOUR_MS).toISOString(),
      open: price,
      high: price + 1,
      low: price - 1,
      close: price + 0.2,
      volume: 10,
    });
  }
  return candles;
}

function makeDoc(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, instrument: "BTC", timeframe: "1h", source: "test fixture", candles: makeCandles(10), ...overrides };
}

describe("validateCandleDataset — happy path", () => {
  it("accepts a well-formed, contiguous, ordered dataset", () => {
    const result = validateCandleDataset(makeDoc(), "test.json", "2026-01-01T00:00:00.000Z");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataset.document.candles).toHaveLength(10);
      expect(result.dataset.provenance.candleCount).toBe(10);
      expect(result.dataset.provenance.firstTimestamp).toBe(result.dataset.document.candles[0]!.timestamp);
    }
  });

  it("accepts a candle with volume entirely absent", () => {
    const doc = makeDoc();
    const { volume: _v, ...withoutVolume } = doc.candles[0]!;
    doc.candles[0] = withoutVolume as (typeof doc.candles)[number];
    expect(validateCandleDataset(doc, "test.json", "t").ok).toBe(true);
  });
});

describe("validateCandleDataset — explicit rejection of malformed input", () => {
  it("rejects a non-object root", () => {
    const result = validateCandleDataset([1, 2, 3], "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNEXPECTED_SHAPE");
  });

  it("rejects a missing instrument", () => {
    const doc = makeDoc({ instrument: undefined });
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MISSING_REQUIRED_FIELD");
  });

  it("rejects an unsupported timeframe", () => {
    const result = validateCandleDataset(makeDoc({ timeframe: "3h" }), "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_TIMEFRAME");
  });

  it("rejects fewer than 2 candles", () => {
    const result = validateCandleDataset(makeDoc({ candles: makeCandles(1) }), "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INSUFFICIENT_CANDLES");
  });

  it("rejects an unparseable timestamp", () => {
    const doc = makeDoc();
    doc.candles[3]!.timestamp = "not-a-timestamp";
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNPARSEABLE_TIMESTAMP");
  });

  it("rejects a non-finite OHLC value", () => {
    const doc = makeDoc();
    doc.candles[2]!.close = Number.NaN;
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NON_FINITE_VALUE");
  });

  it("rejects a non-positive price", () => {
    const doc = makeDoc();
    doc.candles[2]!.close = 0;
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_OHLC");
  });

  it("rejects high below low", () => {
    const doc = makeDoc();
    doc.candles[2] = { ...doc.candles[2]!, high: 90, low: 95 };
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_OHLC");
  });

  it("rejects open outside the [low, high] range", () => {
    const doc = makeDoc();
    doc.candles[2] = { ...doc.candles[2]!, open: doc.candles[2]!.high + 10 };
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_OHLC");
  });

  it("rejects a negative volume", () => {
    const doc = makeDoc();
    doc.candles[2]!.volume = -1;
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NON_FINITE_VALUE");
  });
});

describe("validateCandleDataset — ordering, duplicates, and gaps", () => {
  it("rejects two candles sharing the same timestamp", () => {
    const doc = makeDoc();
    doc.candles[5]!.timestamp = doc.candles[4]!.timestamp;
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DUPLICATE_TIMESTAMP");
  });

  it("rejects out-of-order timestamps", () => {
    const doc = makeDoc();
    [doc.candles[3], doc.candles[4]] = [doc.candles[4]!, doc.candles[3]!];
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["OUT_OF_ORDER_TIMESTAMP", "GAP_DETECTED"]).toContain(result.reason);
  });

  it("rejects a gap wider than the declared timeframe — no tolerance for a fixed dataset", () => {
    const doc = makeDoc();
    doc.candles.splice(5, 1); // remove one candle, widening the gap to exactly 2x
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
  });

  it("rejects a gap narrower than the declared timeframe (jitter is never tolerated for a fixed dataset)", () => {
    const doc = makeDoc();
    doc.candles[5]!.timestamp = new Date(Date.parse(doc.candles[5]!.timestamp) - 60_000).toISOString();
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
  });
});

describe("computeDatasetHash — content identity", () => {
  it("is identical for byte-for-byte identical content regardless of source text formatting", () => {
    const a = validateCandleDataset(makeDoc(), "a.json", "t1");
    const b = validateCandleDataset(makeDoc(), "b.json", "t2"); // different filePath/loadedAt
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.dataset.datasetHash).toBe(b.dataset.datasetHash);
  });

  it("changes when a single OHLC value changes", () => {
    const a = validateCandleDataset(makeDoc(), "a.json", "t");
    const doc2 = makeDoc();
    doc2.candles[3]!.close += 0.01;
    const b = validateCandleDataset(doc2, "a.json", "t");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.dataset.datasetHash).not.toBe(b.dataset.datasetHash);
  });

  it("never includes filePath or loadedAt in the hash", () => {
    const doc = makeDoc();
    const hash = computeDatasetHash(doc as unknown as Parameters<typeof computeDatasetHash>[0]);
    const result = validateCandleDataset(doc, "some/very/different/path.json", "2099-01-01T00:00:00.000Z");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dataset.datasetHash).toBe(hash);
  });
});

describe("toCandles", () => {
  it("stamps every candle with the dataset's own instrument symbol", () => {
    const result = validateCandleDataset(makeDoc({ instrument: "ETH" }), "test.json", "t");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const candles = toCandles(result.dataset.document);
      expect(candles.every((c) => c.symbol === "ETH")).toBe(true);
    }
  });
});

describe("loadCandleDataset — file I/O", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "backtest-dataset-test-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("loads and validates a real file from disk", async () => {
    const filePath = path.join(dir, "dataset.json");
    await fs.writeFile(filePath, JSON.stringify(makeDoc()), "utf-8");
    const result = await loadCandleDataset(filePath);
    expect(result.ok).toBe(true);
  });

  it("reports READ_ERROR for a missing file, never throwing", async () => {
    const result = await loadCandleDataset(path.join(dir, "does-not-exist.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("READ_ERROR");
  });

  it("reports INVALID_JSON for malformed JSON, never throwing", async () => {
    const filePath = path.join(dir, "bad.json");
    await fs.writeFile(filePath, "{ not json", "utf-8");
    const result = await loadCandleDataset(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_JSON");
  });
});

describe("validateCandleDataset — closed key sets and size bound (pre-commit review)", () => {
  it("rejects an unrecognised top-level field, e.g. a smuggled leverage/positionSize value", () => {
    const doc = { ...makeDoc(), leverage: 10 };
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("PROHIBITED_FIELD");
  });

  it("rejects an unrecognised per-candle field", () => {
    const doc = makeDoc();
    (doc.candles[0] as unknown as Record<string, unknown>).positionSize = 100;
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("PROHIBITED_FIELD");
  });

  it("rejects a dataset exceeding MAX_DATASET_CANDLES", () => {
    const result = validateCandleDataset(makeDoc({ candles: makeCandles(MAX_DATASET_CANDLES + 1) }), "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("TOO_MANY_CANDLES");
  });

  it("accepts a dataset at exactly MAX_DATASET_CANDLES", () => {
    const result = validateCandleDataset(makeDoc({ candles: makeCandles(MAX_DATASET_CANDLES) }), "test.json", "t");
    expect(result.ok).toBe(true);
  });
});

describe("computeDatasetHash — order/instrument/timeframe sensitivity (pre-commit review)", () => {
  it("changes when the candle order changes, even with the exact same set of candles", () => {
    const doc = makeDoc({ candles: makeCandles(10) });
    const a = validateCandleDataset(doc, "a.json", "t");
    const reordered = { ...doc, candles: [doc.candles[1]!, doc.candles[0]!, ...doc.candles.slice(2)] };
    // Reordering breaks strict ordering validation, so hash this shape directly rather than via
    // validateCandleDataset (which would reject it) — computeDatasetHash itself must still be
    // order-sensitive regardless of what validation layer sits in front of it.
    const hashA = a.ok ? a.dataset.datasetHash : "";
    const hashReordered = computeDatasetHash(reordered as unknown as Parameters<typeof computeDatasetHash>[0]);
    expect(a.ok).toBe(true);
    expect(hashReordered).not.toBe(hashA);
  });

  it("changes when the instrument changes, with identical candles", () => {
    const a = validateCandleDataset(makeDoc({ instrument: "BTC" }), "a.json", "t");
    const b = validateCandleDataset(makeDoc({ instrument: "ETH" }), "a.json", "t");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.dataset.datasetHash).not.toBe(b.dataset.datasetHash);
  });

  it("changes when the timeframe changes, with identical candles", () => {
    const a = validateCandleDataset(makeDoc({ timeframe: "1h" }), "a.json", "t");
    const b = validateCandleDataset(makeDoc({ timeframe: "4h", candles: makeCandles(10).map((c, i) => ({ ...c, timestamp: new Date(START + i * 4 * HOUR_MS).toISOString() })) }), "a.json", "t");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.dataset.datasetHash).not.toBe(b.dataset.datasetHash);
  });
});
