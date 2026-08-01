import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendManifestEntry, parseManifestFile } from "@/lib/hermes-execution/dataset-intake/manifest-writer";
import type { DatasetManifestEntry } from "@/lib/hermes-execution/strategy-research/dataset-manifest";

// Phase 4 — Historical Dataset Intake. Manifest merge/append — atomic (temp + rename), validated
// (reuses Phase 3's own validator/duplicate-check directly), and never silently overwrites a
// conflicting entry.

function makeEntry(overrides: Partial<DatasetManifestEntry> = {}): DatasetManifestEntry {
  return {
    instrument: "BTC",
    timeframe: "1h",
    datasetFile: "btc.json",
    expectedDatasetHash: "a".repeat(64),
    startTimestamp: "2026-01-01T00:00:00.000Z",
    endTimestamp: "2026-01-02T00:00:00.000Z",
    role: "FULL_HISTORY",
    ...overrides,
  };
}

describe("parseManifestFile", () => {
  it("accepts an empty array", () => {
    expect(parseManifestFile([]).ok).toBe(true);
  });

  it("rejects a non-array", () => {
    const result = parseManifestFile({ not: "an array" });
    expect(result.ok).toBe(false);
  });

  it("rejects an array containing a malformed entry", () => {
    const result = parseManifestFile([{ instrument: "BTC" }]);
    expect(result.ok).toBe(false);
  });

  it("rejects an array with a duplicate (instrument, role) pair", () => {
    const result = parseManifestFile([makeEntry(), makeEntry({ datasetFile: "other.json" })]);
    expect(result.ok).toBe(false);
  });
});

describe("appendManifestEntry", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-writer-test-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates a fresh manifest file when none exists", async () => {
    const manifestPath = path.join(dir, "manifest.json");
    const result = await appendManifestEntry(manifestPath, makeEntry(), false);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toHaveLength(1);
    const written = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    expect(written).toHaveLength(1);
  });

  it("appends to an existing, valid manifest file without disturbing existing entries", async () => {
    const manifestPath = path.join(dir, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify([makeEntry({ instrument: "ETH" })]), "utf-8");
    const result = await appendManifestEntry(manifestPath, makeEntry({ instrument: "BTC" }), false);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries.map((e) => e.instrument).sort()).toEqual(["BTC", "ETH"]);
  });

  it("rejects appending a duplicate (instrument, role) pair, never silently overwriting", async () => {
    const manifestPath = path.join(dir, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify([makeEntry()]), "utf-8");
    const before = await fs.readFile(manifestPath, "utf-8");
    const result = await appendManifestEntry(manifestPath, makeEntry({ datasetFile: "different.json" }), false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DUPLICATE_MANIFEST_ENTRY");
    expect(await fs.readFile(manifestPath, "utf-8")).toBe(before);
  });

  it("rejects appending to an existing but invalid manifest file, never overwriting it", async () => {
    const manifestPath = path.join(dir, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify([{ instrument: "BTC" }]), "utf-8");
    const before = await fs.readFile(manifestPath, "utf-8");
    const result = await appendManifestEntry(manifestPath, makeEntry(), false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MANIFEST_INVALID");
    expect(await fs.readFile(manifestPath, "utf-8")).toBe(before);
  });

  it("dry-run never writes to disk but still returns the would-be merged entry list", async () => {
    const manifestPath = path.join(dir, "manifest.json");
    const result = await appendManifestEntry(manifestPath, makeEntry(), true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toHaveLength(1);
    await expect(fs.readFile(manifestPath, "utf-8")).rejects.toThrow();
  });

  it("no leftover temp file remains after a successful write", async () => {
    const manifestPath = path.join(dir, "manifest.json");
    await appendManifestEntry(manifestPath, makeEntry(), false);
    const files = await fs.readdir(dir);
    expect(files).toEqual(["manifest.json"]);
  });
});
