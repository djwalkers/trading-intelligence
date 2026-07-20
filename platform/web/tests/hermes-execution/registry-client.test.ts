import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileSystemRegistryClient, validateRawStrategy } from "@/lib/hermes-execution/registry-client";

// ESM module namespaces aren't configurable, so `vi.spyOn(fs, "writeFile")` can't work here (see
// https://vitest.dev/guide/browser/#limitations) — mock the write/delete-shaped exports directly
// instead, while leaving readFile/readdir/access as the real implementation every other test in
// this file relies on.
const writeFileMock = vi.fn();
const unlinkMock = vi.fn();
const rmMock = vi.fn();
const renameMock = vi.fn();
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: (...args: unknown[]) => writeFileMock(...args),
    unlink: (...args: unknown[]) => unlinkMock(...args),
    rm: (...args: unknown[]) => rmMock(...args),
    rename: (...args: unknown[]) => renameMock(...args),
  };
});

const FIXTURES_DIR = path.join(process.cwd(), "tests", "hermes-execution", "fixtures");
const VALID_REGISTRY = path.join(FIXTURES_DIR, "registry-valid");
const MALFORMED_REGISTRY = path.join(FIXTURES_DIR, "registry-malformed");
const EMPTY_REGISTRY = path.join(FIXTURES_DIR, "registry-empty");
const EMPTY_BUT_CONNECTED_REGISTRY = path.join(FIXTURES_DIR, "registry-empty-but-connected");
const NONEXISTENT_REGISTRY = path.join(FIXTURES_DIR, "does-not-exist");

describe("FileSystemRegistryClient — empty registry", () => {
  it("treats a registry with no strategies/ directory as connected: false, strategies: []", async () => {
    const client = new FileSystemRegistryClient(EMPTY_REGISTRY);
    expect(await client.isConnected()).toBe(false);
    const result = await client.listActiveStrategies();
    expect(result.strategies).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("treats a completely nonexistent registry path the same way — never throws", async () => {
    const client = new FileSystemRegistryClient(NONEXISTENT_REGISTRY);
    expect(await client.isConnected()).toBe(false);
    const result = await client.listActiveStrategies();
    expect(result.strategies).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("reports connected: true with zero strategies when strategies/ exists but is empty", async () => {
    const client = new FileSystemRegistryClient(EMPTY_BUT_CONNECTED_REGISTRY);
    expect(await client.isConnected()).toBe(true);
    const result = await client.listActiveStrategies();
    expect(result.strategies).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

describe("FileSystemRegistryClient — valid registry", () => {
  it("connects and loads a well-formed active strategy", async () => {
    const client = new FileSystemRegistryClient(VALID_REGISTRY);
    expect(await client.isConnected()).toBe(true);
    const result = await client.listActiveStrategies();
    expect(result.rejected).toEqual([]);
    expect(result.strategies).toHaveLength(1);
    expect(result.strategies[0]?.strategyId).toBe("STRAT-0001");
  });
});

describe("FileSystemRegistryClient — malformed documents", () => {
  it("rejects a document missing required fields, without throwing", async () => {
    const client = new FileSystemRegistryClient(MALFORMED_REGISTRY);
    const result = await client.listActiveStrategies();
    const rejection = result.rejected.find((r) => r.source === "c-strat-0005-missing-fields.json");
    expect(rejection).toBeDefined();
    expect(rejection?.reason).toMatch(/missing required field/i);
  });

  it("rejects a document with an unsupported schemaVersion", async () => {
    const client = new FileSystemRegistryClient(MALFORMED_REGISTRY);
    const result = await client.listActiveStrategies();
    const rejection = result.rejected.find((r) => r.source === "d-strat-0006-bad-schema-version.json");
    expect(rejection).toBeDefined();
    expect(rejection?.reason).toMatch(/unsupported schemaVersion/i);
  });

  it("accepts the first of two documents sharing a strategyId and rejects the second as a duplicate", async () => {
    const client = new FileSystemRegistryClient(MALFORMED_REGISTRY);
    const result = await client.listActiveStrategies();
    const accepted = result.strategies.filter((s) => s.strategyId === "STRAT-0004");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.version).toBe(1); // from a-strat-0004.json, loaded first alphabetically

    const duplicateRejection = result.rejected.find((r) => r.source === "b-strat-0004-duplicate.json");
    expect(duplicateRejection).toBeDefined();
    expect(duplicateRejection?.reason).toMatch(/duplicate strategyId/i);
  });

  it("loads a valid but non-active (retired) strategy without rejecting it, but excludes it from the active list", async () => {
    const client = new FileSystemRegistryClient(MALFORMED_REGISTRY);
    const result = await client.listActiveStrategies();
    expect(result.strategies.some((s) => s.strategyId === "STRAT-0007")).toBe(false);
    expect(result.rejected.some((r) => r.source === "e-strat-0007-retired.json")).toBe(false);
  });
});

describe("validateRawStrategy", () => {
  it("rejects non-object input", () => {
    expect(validateRawStrategy(null)).toMatch(/not a JSON object/i);
    expect(validateRawStrategy("a string")).toMatch(/not a JSON object/i);
    expect(validateRawStrategy([1, 2, 3])).toMatch(/not a JSON object/i);
  });

  it("rejects a strategyId that doesn't match the required pattern", () => {
    const doc = {
      schemaVersion: "1.0.0",
      strategyId: "not-valid",
      version: 1,
      status: "active",
      sourceHypothesisId: "h1",
      supportingResearchRuns: [],
      promotionStatus: { decision: "ELIGIBLE" },
      supportedMarkets: ["X"],
      timeframe: "1m",
      entryDefinition: { rule: "x" },
      exitDefinition: { rule: "x" },
      riskDefinition: {},
      confidence: { level: "low" },
      createdAt: "2026-01-01T00:00:00Z",
      lastReviewedAt: "2026-01-01T00:00:00Z",
    };
    expect(validateRawStrategy(doc)).toMatch(/strategyId must match/i);
  });
});

describe("no Hermes file is modified", () => {
  it("never calls a filesystem write/delete function while reading the registry", async () => {
    const client = new FileSystemRegistryClient(VALID_REGISTRY);
    await client.isConnected();
    await client.listActiveStrategies();

    expect(writeFileMock).not.toHaveBeenCalled();
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(rmMock).not.toHaveBeenCalled();
    expect(renameMock).not.toHaveBeenCalled();
  });

  it("leaves the real Hermes Lab strategy-registry directory byte-for-byte unchanged, if present", async () => {
    const hermesRegistryPath = path.resolve(
      process.cwd(),
      "..",
      "..",
      "..",
      "Hermes Lab",
      "strategy-registry",
    );

    let exists = true;
    try {
      await fs.access(hermesRegistryPath);
    } catch {
      exists = false;
    }
    if (!exists) {
      // Not every environment (e.g. CI) has the sibling Hermes Lab repo checked out — the
      // fs-spy test above already proves this client can never write, independent of this.
      return;
    }

    async function snapshot(dir: string): Promise<Map<string, string>> {
      const result = new Map<string, string>();
      async function walk(current: string): Promise<void> {
        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) await walk(full);
          else result.set(full, await fs.readFile(full, "utf-8"));
        }
      }
      await walk(dir);
      return result;
    }

    const before = await snapshot(hermesRegistryPath);

    const client = new FileSystemRegistryClient(hermesRegistryPath);
    await client.isConnected();
    await client.listActiveStrategies();

    const after = await snapshot(hermesRegistryPath);
    expect(after).toEqual(before);
  });
});
