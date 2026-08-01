import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkNoDuplicateManifestEntries, checkNoInSampleOutOfSampleOverlap, loadAndVerifyManifest, validateDatasetManifestEntry, type DatasetManifestEntry } from "@/lib/hermes-execution/strategy-research/dataset-manifest";
import { datasetHashFor, makeDatasetDoc, writeJsonFile } from "./fixtures";

// Phase 3 — Strategy Research Workflow. Dataset manifest: hash verification, instrument/timeframe
// cross-checks, and IS/OOS non-overlap for the "separate files" mode. No provider call anywhere —
// the only I/O is a local file read via Phase 2's own loadCandleDataset.

describe("validateDatasetManifestEntry — schema", () => {
  it("accepts a well-formed entry", () => {
    const entry = { instrument: "BTC", timeframe: "1h", datasetFile: "x.json", expectedDatasetHash: "a".repeat(64), startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-02T00:00:00.000Z", role: "FULL_HISTORY" };
    expect(validateDatasetManifestEntry(entry, "datasets[0]")).toEqual([]);
  });

  it("rejects an unrecognised field", () => {
    const entry = { instrument: "BTC", timeframe: "1h", datasetFile: "x.json", expectedDatasetHash: "a".repeat(64), startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-02T00:00:00.000Z", role: "FULL_HISTORY", leverage: 10 };
    expect(validateDatasetManifestEntry(entry, "datasets[0]").length).toBeGreaterThan(0);
  });

  it("rejects a malformed expectedDatasetHash", () => {
    const entry = { instrument: "BTC", timeframe: "1h", datasetFile: "x.json", expectedDatasetHash: "short", startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-02T00:00:00.000Z", role: "FULL_HISTORY" };
    expect(validateDatasetManifestEntry(entry, "datasets[0]").length).toBeGreaterThan(0);
  });

  it("rejects startTimestamp not before endTimestamp", () => {
    const entry = { instrument: "BTC", timeframe: "1h", datasetFile: "x.json", expectedDatasetHash: "a".repeat(64), startTimestamp: "2026-01-02T00:00:00.000Z", endTimestamp: "2026-01-01T00:00:00.000Z", role: "FULL_HISTORY" };
    expect(validateDatasetManifestEntry(entry, "datasets[0]").length).toBeGreaterThan(0);
  });

  it("rejects an unrecognised role", () => {
    const entry = { instrument: "BTC", timeframe: "1h", datasetFile: "x.json", expectedDatasetHash: "a".repeat(64), startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-02T00:00:00.000Z", role: "SOMETHING_ELSE" };
    expect(validateDatasetManifestEntry(entry, "datasets[0]").length).toBeGreaterThan(0);
  });
});

describe("checkNoDuplicateManifestEntries", () => {
  it("accepts entries with distinct (instrument, role) pairs", () => {
    const entries: DatasetManifestEntry[] = [
      { instrument: "BTC", timeframe: "1h", datasetFile: "a", expectedDatasetHash: "a".repeat(64), startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-02T00:00:00.000Z", role: "FULL_HISTORY" },
      { instrument: "ETH", timeframe: "1h", datasetFile: "b", expectedDatasetHash: "b".repeat(64), startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-02T00:00:00.000Z", role: "FULL_HISTORY" },
      { instrument: "BTC", timeframe: "1h", datasetFile: "c", expectedDatasetHash: "c".repeat(64), startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-02T00:00:00.000Z", role: "STRESS_PERIOD" },
    ];
    expect(checkNoDuplicateManifestEntries(entries).ok).toBe(true);
  });

  it("rejects two entries sharing the same (instrument, role) pair — never silently picks a 'first wins' winner", () => {
    const entries: DatasetManifestEntry[] = [
      { instrument: "BTC", timeframe: "1h", datasetFile: "a", expectedDatasetHash: "a".repeat(64), startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-02T00:00:00.000Z", role: "FULL_HISTORY" },
      { instrument: "BTC", timeframe: "1h", datasetFile: "b", expectedDatasetHash: "b".repeat(64), startTimestamp: "2026-01-03T00:00:00.000Z", endTimestamp: "2026-01-04T00:00:00.000Z", role: "FULL_HISTORY" },
    ];
    const result = checkNoDuplicateManifestEntries(entries);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("duplicate manifest entry");
  });
});

describe("loadAndVerifyManifest — duplicate rejection", () => {
  it("rejects a manifest with a duplicate (instrument, role) pair before reading any file", async () => {
    const entries: DatasetManifestEntry[] = [
      { instrument: "BTC", timeframe: "1h", datasetFile: "/does/not/exist-a.json", expectedDatasetHash: "a".repeat(64), startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-02T00:00:00.000Z", role: "FULL_HISTORY" },
      { instrument: "BTC", timeframe: "1h", datasetFile: "/does/not/exist-b.json", expectedDatasetHash: "b".repeat(64), startTimestamp: "2026-01-03T00:00:00.000Z", endTimestamp: "2026-01-04T00:00:00.000Z", role: "FULL_HISTORY" },
    ];
    const result = await loadAndVerifyManifest(entries);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DUPLICATE_MANIFEST_ENTRY");
  });
});

describe("checkNoInSampleOutOfSampleOverlap", () => {
  it("accepts a chronological, non-overlapping IN_SAMPLE/OUT_OF_SAMPLE pair", () => {
    const entries: DatasetManifestEntry[] = [
      { instrument: "BTC", timeframe: "1h", datasetFile: "a", expectedDatasetHash: "a".repeat(64), startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-10T00:00:00.000Z", role: "IN_SAMPLE" },
      { instrument: "BTC", timeframe: "1h", datasetFile: "b", expectedDatasetHash: "b".repeat(64), startTimestamp: "2026-01-10T00:00:00.000Z", endTimestamp: "2026-01-20T00:00:00.000Z", role: "OUT_OF_SAMPLE" },
    ];
    expect(checkNoInSampleOutOfSampleOverlap(entries).ok).toBe(true);
  });

  it("rejects an overlapping IN_SAMPLE/OUT_OF_SAMPLE pair", () => {
    const entries: DatasetManifestEntry[] = [
      { instrument: "BTC", timeframe: "1h", datasetFile: "a", expectedDatasetHash: "a".repeat(64), startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-15T00:00:00.000Z", role: "IN_SAMPLE" },
      { instrument: "BTC", timeframe: "1h", datasetFile: "b", expectedDatasetHash: "b".repeat(64), startTimestamp: "2026-01-10T00:00:00.000Z", endTimestamp: "2026-01-20T00:00:00.000Z", role: "OUT_OF_SAMPLE" },
    ];
    const result = checkNoInSampleOutOfSampleOverlap(entries);
    expect(result.ok).toBe(false);
  });

  it("ignores instruments with only one of the two roles", () => {
    const entries: DatasetManifestEntry[] = [{ instrument: "BTC", timeframe: "1h", datasetFile: "a", expectedDatasetHash: "a".repeat(64), startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-15T00:00:00.000Z", role: "IN_SAMPLE" }];
    expect(checkNoInSampleOutOfSampleOverlap(entries).ok).toBe(true);
  });
});

describe("loadAndVerifyManifest", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "research-manifest-test-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("verifies a matching manifest entry successfully", async () => {
    const doc = makeDatasetDoc("BTC", 30);
    const filePath = await writeJsonFile(dir, "btc.json", doc);
    const hash = datasetHashFor("BTC", 30);
    const entry: DatasetManifestEntry = { instrument: "BTC", timeframe: "1h", datasetFile: filePath, expectedDatasetHash: hash, startTimestamp: doc.candles[0]!.timestamp, endTimestamp: doc.candles[doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" };
    const result = await loadAndVerifyManifest([entry]);
    expect(result.ok).toBe(true);
  });

  it("rejects a dataset hash mismatch", async () => {
    const doc = makeDatasetDoc("BTC", 30);
    const filePath = await writeJsonFile(dir, "btc.json", doc);
    const entry: DatasetManifestEntry = { instrument: "BTC", timeframe: "1h", datasetFile: filePath, expectedDatasetHash: "f".repeat(64), startTimestamp: doc.candles[0]!.timestamp, endTimestamp: doc.candles[doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" };
    const result = await loadAndVerifyManifest([entry]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DATASET_HASH_MISMATCH");
  });

  it("rejects an instrument mismatch between the manifest and the dataset's own declared instrument", async () => {
    const doc = makeDatasetDoc("BTC", 30);
    const filePath = await writeJsonFile(dir, "btc.json", doc);
    const hash = datasetHashFor("BTC", 30);
    const entry: DatasetManifestEntry = { instrument: "ETH", timeframe: "1h", datasetFile: filePath, expectedDatasetHash: hash, startTimestamp: doc.candles[0]!.timestamp, endTimestamp: doc.candles[doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" };
    const result = await loadAndVerifyManifest([entry]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INSTRUMENT_MISMATCH");
  });

  it("rejects a declared date range that does not contain the dataset's actual range", async () => {
    const doc = makeDatasetDoc("BTC", 30);
    const filePath = await writeJsonFile(dir, "btc.json", doc);
    const hash = datasetHashFor("BTC", 30);
    const entry: DatasetManifestEntry = { instrument: "BTC", timeframe: "1h", datasetFile: filePath, expectedDatasetHash: hash, startTimestamp: "2027-01-01T00:00:00.000Z", endTimestamp: "2027-01-02T00:00:00.000Z", role: "FULL_HISTORY" };
    const result = await loadAndVerifyManifest([entry]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DATE_RANGE_MISMATCH");
  });

  it("rejects a missing dataset file, never throwing", async () => {
    const entry: DatasetManifestEntry = { instrument: "BTC", timeframe: "1h", datasetFile: path.join(dir, "missing.json"), expectedDatasetHash: "a".repeat(64), startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-02T00:00:00.000Z", role: "FULL_HISTORY" };
    const result = await loadAndVerifyManifest([entry]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DATASET_LOAD_FAILED");
  });
});
