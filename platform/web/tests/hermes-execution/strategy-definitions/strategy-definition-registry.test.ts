import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInstrumentCatalogue, type InstrumentCatalogueEntry } from "@/lib/hermes-execution/instrument-catalogue/instrument-catalogue";
import { loadStrategyDefinitions, selectLatestVersions, versionHistory } from "@/lib/hermes-execution/strategy-definitions/strategy-definition-registry";

// Phase 1 declarative strategy registry — filesystem, fixture-only tests. Never calls eToro, never
// runs a broker/probe/smoke command, never touches the real .data/hermes-execution directory or the
// real repo-root strategies/ directory (an isolated temp directory is used for every test).

const VERIFIED_CATALOGUE: InstrumentCatalogueEntry[] = buildInstrumentCatalogue({
  seedSymbols: ["BTC", "ETH", "SOL"],
  configuredUniverse: ["BTC", "ETH", "SOL"],
  evidence: { sourceDirectory: "", accepted: [], rejected: [] },
}).map((e) => ({ ...e, readOnlyCapabilityStatus: "READ_ONLY_VERIFIED" as const }));

function strategyDoc(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    strategyId: "TEST_STRATEGY_V1",
    strategyVersion: "1.0.0",
    name: "Test Strategy",
    description: "A test fixture strategy.",
    status: "APPROVED_FOR_BACKTEST",
    strategyFamily: "TREND_FOLLOWING",
    assetClass: "crypto",
    supportedInstruments: ["BTC"],
    timeframe: "1h",
    dataRequirements: ["close"],
    indicators: [{ id: "ema20", type: "EMA", sourceField: "close", parameters: { period: 20 }, outputAlias: "EMA20" }],
    entryRules: { operator: "GREATER_THAN", left: { kind: "INDICATOR_ALIAS", alias: "EMA20" }, right: { kind: "MARKET_FIELD", field: "close" } },
    signalExitRules: [],
    parameters: {},
    eligibility: { requiresReadOnlyVerified: true, requiresStage4Verified: false, requiresConfiguredUniverse: true, notes: [] },
    backtestPolicy: { minHistoryBars: 100, warmupBars: 50, notes: [] },
    provenance: { author: "test", createdAt: "2026-07-31T00:00:00.000Z", notes: [] },
    limitations: [],
    ...overrides,
  };
}

describe("the real hand-authored example strategy (strategies/CRYPTO_EMA_TREND_V1__1.0.0.json)", () => {
  it("loads and validates against a fully-verified catalogue, is usable for backtest, and never usable for demo", async () => {
    const result = await loadStrategyDefinitions(path.join(process.cwd(), "strategies"), VERIFIED_CATALOGUE);
    expect(result.rejected).toEqual([]);
    const record = result.accepted.find((r) => r.document.strategyId === "CRYPTO_EMA_TREND_V1");
    expect(record).toBeTruthy();
    expect(record!.document.strategyVersion).toBe("1.0.0");
    expect(record!.document.status).not.toBe("APPROVED_FOR_DEMO");
    expect(record!.result.usableForDemo).toBe(false);
    expect(record!.result.supportedCatalogueInstruments).toEqual(["BTC", "ETH", "SOL"]);
    expect(record!.document.indicators.map((i) => i.type).sort()).toEqual(["ATR", "EMA", "EMA", "RSI"]);
  });

  it("never defines any prohibited field (sizing, leverage, stop-loss, take-profit, kill-switch, broker/account/approval/execution/lifecycle control)", async () => {
    const text = await fs.readFile(path.join(process.cwd(), "strategies", "CRYPTO_EMA_TREND_V1__1.0.0.json"), "utf-8");
    const { findProhibitedFields } = await import("@/lib/hermes-execution/strategy-definitions/strategy-definition");
    expect(findProhibitedFields(JSON.parse(text))).toEqual([]);
  });
});

describe("loadStrategyDefinitions (filesystem)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-registry-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function write(fileName: string, content: unknown): Promise<void> {
    await fs.writeFile(path.join(dir, fileName), typeof content === "string" ? content : JSON.stringify(content), "utf-8");
  }

  it("returns empty accepted/rejected when the directory does not exist, never throwing", async () => {
    const result = await loadStrategyDefinitions(path.join(dir, "does-not-exist"), VERIFIED_CATALOGUE);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("ingests a valid strategy document", async () => {
    await write("test.json", strategyDoc());
    const result = await loadStrategyDefinitions(dir, VERIFIED_CATALOGUE);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.document.strategyId).toBe("TEST_STRATEGY_V1");
  });

  it("rejects one malformed file without stopping ingestion of the rest", async () => {
    await write("broken.json", "{ not valid json");
    await write("test.json", strategyDoc());
    const result = await loadStrategyDefinitions(dir, VERIFIED_CATALOGUE);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toBe("INVALID_JSON");
  });

  it("never trusts the filename over the document's own strategyId/strategyVersion", async () => {
    await write("totally-unrelated-name.json", strategyDoc());
    const result = await loadStrategyDefinitions(dir, VERIFIED_CATALOGUE);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.document.strategyId).toBe("TEST_STRATEGY_V1");
  });

  it("deterministic file ordering — repeated runs against the same directory produce identical results", async () => {
    await write("b.json", strategyDoc({ strategyVersion: "1.0.0" }));
    await write("a.json", strategyDoc({ strategyVersion: "2.0.0" }));
    const first = await loadStrategyDefinitions(dir, VERIFIED_CATALOGUE);
    const second = await loadStrategyDefinitions(dir, VERIFIED_CATALOGUE);
    expect(first).toEqual(second);
  });

  it("identical duplicate strategyId+strategyVersion contributes once", async () => {
    await write("a.json", strategyDoc());
    await write("b.json", strategyDoc());
    const result = await loadStrategyDefinitions(dir, VERIFIED_CATALOGUE);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("identical duplicates are still deduplicated even when the source JSON text has different key order", async () => {
    // Same semantic document, but with the top-level keys written in reverse order — a plain
    // JSON.stringify comparison would (incorrectly) see these as different objects, since JS
    // preserves object key insertion order from the parsed source text.
    const doc = strategyDoc() as Record<string, unknown>;
    const forward = JSON.stringify(doc);
    const reversedKeys = Object.keys(doc).reverse();
    const reversed = `{${reversedKeys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(doc[k])}`).join(",")}}`;
    expect(JSON.parse(reversed)).toEqual(JSON.parse(forward)); // sanity: same semantic content
    await write("a.json", forward);
    await write("b.json", reversed);
    const result = await loadStrategyDefinitions(dir, VERIFIED_CATALOGUE);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("conflicting duplicate strategyId+strategyVersion is rejected, never silently tie-broken", async () => {
    await write("a.json", strategyDoc({ name: "Version A" }));
    await write("b.json", strategyDoc({ name: "Version B" }));
    const result = await loadStrategyDefinitions(dir, VERIFIED_CATALOGUE);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.every((r) => r.reason === "CONFLICTING_DUPLICATE_VERSION")).toBe(true);
  });

  it("no duplicate strategyId+strategyVersion pair survives — two DIFFERENT versions of the same id both accepted", async () => {
    await write("v1.json", strategyDoc({ strategyVersion: "1.0.0" }));
    await write("v2.json", strategyDoc({ strategyVersion: "2.0.0" }));
    const result = await loadStrategyDefinitions(dir, VERIFIED_CATALOGUE);
    expect(result.accepted).toHaveLength(2);
  });

  it("rejects evidence read through a symlink pointing outside the strategy directory", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-registry-outside-"));
    try {
      const outsideFile = path.join(outsideDir, "external.json");
      await fs.writeFile(outsideFile, JSON.stringify(strategyDoc()), "utf-8");
      await fs.symlink(outsideFile, path.join(dir, "link.json"));
      const result = await loadStrategyDefinitions(dir, VERIFIED_CATALOGUE);
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]!.reason).toBe("SYMLINK_REJECTED");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("this module has no broker dependency", async () => {
    const source = await fs.readFile("src/lib/hermes-execution/strategy-definitions/strategy-definition-registry.ts", "utf-8");
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    for (const line of importLines) {
      expect(line).not.toMatch(/broker-factory|paper-broker|etoro-demo-broker|risk-engine|trade-lifecycle|trade-candidate|registry-client/);
    }
    expect(source).not.toMatch(/placeMarketOrder|closePosition/);
  });
});

describe("selectLatestVersions / versionHistory", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-registry-versions-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function write(fileName: string, content: unknown): Promise<void> {
    await fs.writeFile(path.join(dir, fileName), JSON.stringify(content), "utf-8");
  }

  it("selects the highest semver, never the most-recently-written file, as latest", async () => {
    await write("v2.json", strategyDoc({ strategyVersion: "2.0.0" })); // written "later" alphabetically/mtime, but lower semver
    await write("v10.json", strategyDoc({ strategyVersion: "10.0.0" }));
    const result = await loadStrategyDefinitions(dir, VERIFIED_CATALOGUE);
    const latest = selectLatestVersions(result.accepted);
    expect(latest.get("TEST_STRATEGY_V1")!.document.strategyVersion).toBe("10.0.0");
  });

  it("retains full version history, oldest first", async () => {
    await write("v1.json", strategyDoc({ strategyVersion: "1.0.0" }));
    await write("v2.json", strategyDoc({ strategyVersion: "2.0.0" }));
    await write("v1_5.json", strategyDoc({ strategyVersion: "1.5.0" }));
    const result = await loadStrategyDefinitions(dir, VERIFIED_CATALOGUE);
    const history = versionHistory(result.accepted, "TEST_STRATEGY_V1");
    expect(history.map((r) => r.document.strategyVersion)).toEqual(["1.0.0", "1.5.0", "2.0.0"]);
  });

  it("a newer version does not inherit approval/status from an older version", async () => {
    await write("v1.json", strategyDoc({ strategyVersion: "1.0.0", status: "APPROVED_FOR_BACKTEST" }));
    await write("v2.json", strategyDoc({ strategyVersion: "2.0.0", status: "DRAFT" }));
    const result = await loadStrategyDefinitions(dir, VERIFIED_CATALOGUE);
    const latest = selectLatestVersions(result.accepted);
    const record = latest.get("TEST_STRATEGY_V1")!;
    expect(record.document.strategyVersion).toBe("2.0.0");
    expect(record.document.status).toBe("DRAFT");
    expect(record.result.usableForBacktest).toBe(false); // never inherited from v1.0.0's own APPROVED_FOR_BACKTEST
  });

  it("older versions are never overwritten — both remain independently readable after loading", async () => {
    await write("v1.json", strategyDoc({ strategyVersion: "1.0.0" }));
    await write("v2.json", strategyDoc({ strategyVersion: "2.0.0" }));
    const result = await loadStrategyDefinitions(dir, VERIFIED_CATALOGUE);
    expect(result.accepted).toHaveLength(2);
    expect(result.accepted.map((r) => r.document.strategyVersion).sort()).toEqual(["1.0.0", "2.0.0"]);
  });
});
