import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeDatasetHash, loadCandleDataset, MAX_DATASET_CANDLES, toCandles, validateCandleDataset, type DatasetKnownClosure } from "@/lib/hermes-execution/backtest/backtest-dataset";

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

describe("validateCandleDataset — known market closures (explained gaps)", () => {
  const MISSING_OPEN_TIME = "2023-03-24T15:00:00.000Z";

  function makeCandlesAt(timestamps: string[]) {
    return timestamps.map((timestamp, i) => {
      const price = 100 + i;
      return { timestamp, open: price, high: price + 1, low: price - 1, close: price + 0.2, volume: 10 };
    });
  }

  function makeClosure(overrides: Partial<DatasetKnownClosure> = {}): DatasetKnownClosure {
    return {
      provider: "BINANCE",
      market: "SPOT",
      symbol: "BTC",
      timeframe: "1h",
      missingOpenTime: MISSING_OPEN_TIME,
      reasonCode: "EXCHANGE_SYSTEM_OUTAGE",
      description: "Binance spot trading suspension during temporary system maintenance",
      sourceReference: "test citation",
      status: "VERIFIED_EXCEPTION",
      registryVersion: 1,
      closureId: "test-closure-id",
      ...overrides,
    };
  }

  function makeGapDoc(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      instrument: "BTC",
      timeframe: "1h",
      source: "test fixture",
      candles: makeCandlesAt(["2023-03-24T13:00:00.000Z", "2023-03-24T14:00:00.000Z", "2023-03-24T16:00:00.000Z", "2023-03-24T17:00:00.000Z"]),
      ...overrides,
    };
  }

  it("accepts the exact 2023-03-24T15:00:00Z gap when covered by a matching knownClosures entry, and never synthesizes a candle for it", () => {
    const result = validateCandleDataset(makeGapDoc({ knownClosures: [makeClosure()] }), "test.json", "t");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataset.document.candles.map((c) => c.timestamp)).toEqual(["2023-03-24T13:00:00.000Z", "2023-03-24T14:00:00.000Z", "2023-03-24T16:00:00.000Z", "2023-03-24T17:00:00.000Z"]);
      expect(result.dataset.document.candles.some((c) => c.timestamp === MISSING_OPEN_TIME)).toBe(false);
      expect(result.dataset.provenance.appliedKnownClosures).toHaveLength(1);
      expect(result.dataset.provenance.appliedKnownClosures[0]!.missingOpenTime).toBe(MISSING_OPEN_TIME);
    }
  });

  it("BTC, ETH, and SOL all accept the same missing hour when each carries its own matching closure entry", () => {
    for (const instrument of ["BTC", "ETH", "SOL"]) {
      const result = validateCandleDataset(makeGapDoc({ instrument, knownClosures: [makeClosure({ symbol: instrument })] }), "test.json", "t");
      expect(result.ok).toBe(true);
    }
  });

  it("rejects an unknown gap even with an unrelated knownClosures entry present", () => {
    const result = validateCandleDataset(makeGapDoc({ knownClosures: [makeClosure({ missingOpenTime: "2023-06-01T00:00:00.000Z" })] }), "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
  });

  it("rejects an extra, unexplained adjacent missing hour", () => {
    const doc = makeGapDoc({
      candles: makeCandlesAt(["2023-03-24T13:00:00.000Z", "2023-03-24T14:00:00.000Z", "2023-03-24T17:00:00.000Z"]), // 15:00 AND 16:00 both missing
      knownClosures: [makeClosure()], // only 15:00 declared
    });
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
  });

  it("rejects partial coverage of a two-hour gap (only one of the two missing hours declared)", () => {
    const doc = makeGapDoc({
      candles: makeCandlesAt(["2023-03-24T13:00:00.000Z", "2023-03-24T14:00:00.000Z", "2023-03-24T17:00:00.000Z"]), // 15:00 and 16:00 both missing
      knownClosures: [makeClosure()], // only 15:00 declared
    });
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
  });

  it("accepts a two-hour gap once BOTH missing hours have their own declared closure entry", () => {
    const doc = makeGapDoc({
      candles: makeCandlesAt(["2023-03-24T13:00:00.000Z", "2023-03-24T14:00:00.000Z", "2023-03-24T17:00:00.000Z"]),
      knownClosures: [makeClosure(), makeClosure({ missingOpenTime: "2023-03-24T16:00:00.000Z", closureId: "other" })],
    });
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(true);
  });

  it("one closure entry cannot be stretched to also cover a second, separate unrelated gap (pre-commit review)", () => {
    const doc = {
      schemaVersion: 1,
      instrument: "BTC",
      timeframe: "1h",
      source: "test fixture",
      // Two SEPARATE single-hour gaps: 15:00 (declared, real) and 18:00 (real, but never declared).
      candles: makeCandlesAt([
        "2023-03-24T13:00:00.000Z",
        "2023-03-24T14:00:00.000Z",
        "2023-03-24T16:00:00.000Z",
        "2023-03-24T17:00:00.000Z",
        "2023-03-24T19:00:00.000Z",
        "2023-03-24T20:00:00.000Z",
      ]),
      knownClosures: [makeClosure()], // only 15:00 declared
    };
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false); // the 18:00 gap is never explained by the 15:00 closure entry
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
  });

  it("a closure entry for a different symbol never excuses a gap on this dataset", () => {
    const result = validateCandleDataset(makeGapDoc({ knownClosures: [makeClosure({ symbol: "ETH" })] }), "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MALFORMED_CLOSURE_ENTRY");
  });

  it("a closure entry for a different timeframe never excuses a gap on this dataset", () => {
    const result = validateCandleDataset(makeGapDoc({ knownClosures: [makeClosure({ timeframe: "4h" })] }), "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MALFORMED_CLOSURE_ENTRY");
  });

  it("rejects duplicate/overlapping closure entries outright", () => {
    const result = validateCandleDataset(makeGapDoc({ knownClosures: [makeClosure(), makeClosure({ closureId: "different-id-same-hour" })] }), "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DUPLICATE_CLOSURE_ENTRY");
  });

  it("rejects a malformed (non-hour-aligned) closure timestamp", () => {
    const result = validateCandleDataset(makeGapDoc({ knownClosures: [makeClosure({ missingOpenTime: "2023-03-24T15:30:00.000Z" })] }), "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MALFORMED_CLOSURE_ENTRY");
  });

  it("rejects an unsupported closure status", () => {
    const badClosure = { ...makeClosure(), status: "PROPOSED" } as unknown as DatasetKnownClosure;
    const result = validateCandleDataset(makeGapDoc({ knownClosures: [badClosure] }), "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MALFORMED_CLOSURE_ENTRY");
  });

  it("rejects an unrecognised field on a closure entry", () => {
    const doc = makeGapDoc({ knownClosures: [{ ...makeClosure(), extra: "nope" }] });
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("PROHIBITED_FIELD");
  });

  it("rejects a declared closure that never explains any actual gap (pre-commit review)", () => {
    const doc = {
      schemaVersion: 1,
      instrument: "BTC",
      timeframe: "1h",
      source: "test fixture",
      candles: makeCandlesAt(["2023-03-24T13:00:00.000Z", "2023-03-24T14:00:00.000Z"]), // perfectly contiguous, no gap at all
      knownClosures: [makeClosure()], // declares the 15:00 outage anyway
    };
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNAPPLIED_CLOSURE_ENTRY");
  });

  it("rejects a closure whose missingOpenTime lies outside the dataset's own candle range (pre-commit review)", () => {
    const result = validateCandleDataset(makeGapDoc({ knownClosures: [makeClosure(), makeClosure({ missingOpenTime: "2023-03-24T16:00:00.000Z", closureId: "unused" })] }), "test.json", "t");
    // The 15:00 entry explains the real gap; the 16:00 entry does not correspond to any missing hour
    // at all (16:00 candle IS present in makeGapDoc) — it's a declared-but-unused/out-of-range entry.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNAPPLIED_CLOSURE_ENTRY");
  });

  it("dataset hash changes when closure metadata changes, with identical candles", () => {
    const withClosure = validateCandleDataset(makeGapDoc({ knownClosures: [makeClosure()] }), "test.json", "t");
    const withDifferentReason = validateCandleDataset(makeGapDoc({ knownClosures: [makeClosure({ reasonCode: "OTHER_REASON" })] }), "test.json", "t");
    expect(withClosure.ok && withDifferentReason.ok).toBe(true);
    if (withClosure.ok && withDifferentReason.ok) {
      expect(withClosure.dataset.datasetHash).not.toBe(withDifferentReason.dataset.datasetHash);
    }
  });

  it("an ordinary dataset without knownClosures hashes identically to before this field existed", () => {
    const doc = makeDoc();
    const hash = computeDatasetHash(doc as unknown as Parameters<typeof computeDatasetHash>[0]);
    const result = validateCandleDataset(doc, "test.json", "t");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dataset.datasetHash).toBe(hash);
  });

  it("an ordinary dataset (no knownClosures field at all) still rejects any gap outright", () => {
    const result = validateCandleDataset(makeGapDoc(), "test.json", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
  });

  it("toCandles never produces a candle at the missing hour — no signal/trade can ever be generated for it", () => {
    const result = validateCandleDataset(makeGapDoc({ knownClosures: [makeClosure()] }), "test.json", "t");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const candles = toCandles(result.dataset.document);
      expect(candles).toHaveLength(4);
      expect(candles.some((c) => c.timestamp === MISSING_OPEN_TIME)).toBe(false);
      // The backtest engine iterates this array positionally — 14:00 is immediately followed by
      // 16:00 (a real 2-hour jump), never an inserted/interpolated 15:00 bar a strategy could react to.
      expect(candles.map((c) => c.timestamp)).toEqual(["2023-03-24T13:00:00.000Z", "2023-03-24T14:00:00.000Z", "2023-03-24T16:00:00.000Z", "2023-03-24T17:00:00.000Z"]);
    }
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
