import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 1 declarative strategy catalogue CLI — never calls eToro, never runs a broker/probe/smoke
// command, never touches PM2 or the real repo-root strategies/ directory (isolated temp
// directories via the CLI's own test-only override env vars).

vi.mock("@/lib/hermes-execution/config", () => ({
  getHermesExecutionConfig: () => ({
    hermesAgent: { instrumentUniverse: ["BTC", "ETH", "SOL"] },
  }),
}));

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

describe("strategy-catalogue-cli", () => {
  let strategiesDir: string;
  let evidenceDir: string;
  let stage4Dir: string;

  beforeEach(async () => {
    strategiesDir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-catalogue-cli-test-"));
    evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-catalogue-cli-evidence-test-"));
    stage4Dir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-catalogue-cli-stage4-test-"));
    process.env.HERMES_STRATEGY_DEFINITIONS_DIR_FOR_TESTS_ONLY = strategiesDir;
    process.env.HERMES_INSTRUMENT_CATALOGUE_EVIDENCE_DIR_FOR_TESTS_ONLY = evidenceDir;
    process.env.HERMES_INSTRUMENT_CATALOGUE_STAGE4_EVIDENCE_DIR_FOR_TESTS_ONLY = stage4Dir;
  });

  afterEach(async () => {
    delete process.env.HERMES_STRATEGY_DEFINITIONS_DIR_FOR_TESTS_ONLY;
    delete process.env.HERMES_INSTRUMENT_CATALOGUE_EVIDENCE_DIR_FOR_TESTS_ONLY;
    delete process.env.HERMES_INSTRUMENT_CATALOGUE_STAGE4_EVIDENCE_DIR_FOR_TESTS_ONLY;
    await fs.rm(strategiesDir, { recursive: true, force: true });
    await fs.rm(evidenceDir, { recursive: true, force: true });
    await fs.rm(stage4Dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("never imports a broker/execution/risk/lifecycle/approval module, and never invokes the smoke tool", async () => {
    const source = await fs.readFile("src/hermes-execution/strategy-catalogue-cli.ts", "utf-8");
    expect(source).not.toMatch(/broker-factory|paper-broker|etoro-demo-broker|risk-engine|trade-lifecycle|trade-candidate|placeMarketOrder|closePosition|broker-etoro-smoke/);
  });

  it("prints a row per latest strategy version, safely handling a missing strategies directory", async () => {
    await fs.rm(strategiesDir, { recursive: true, force: true });
    process.argv = ["node", "strategy-catalogue-cli.ts"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let lines: string[];
    try {
      const { main } = await import("@/hermes-execution/strategy-catalogue-cli");
      await main();
    } finally {
      lines = logSpy.mock.calls.map((call) => String(call[0]));
      logSpy.mockRestore();
    }
    expect(lines.some((l) => l.includes("No provider calls made"))).toBe(true);
    expect(lines.some((l) => l.includes("no valid strategy definitions found"))).toBe(true);
  });

  it("shows usableForBacktest/usableForDemo and instrument compatibility for an accepted strategy", async () => {
    await fs.writeFile(path.join(strategiesDir, "test.json"), JSON.stringify(strategyDoc()), "utf-8");
    process.argv = ["node", "strategy-catalogue-cli.ts"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let lines: string[];
    try {
      const { main } = await import("@/hermes-execution/strategy-catalogue-cli");
      await main();
    } finally {
      lines = logSpy.mock.calls.map((call) => String(call[0]));
      logSpy.mockRestore();
    }
    const row = lines.find((l) => l.startsWith("TEST_STRATEGY_V1"));
    expect(row).toBeTruthy();
    expect(row).toMatch(/usableForDemo=no/);
    expect(row).toMatch(/instruments=BTC/);
  });

  it("human output includes a concise content-hash prefix, not the full 64-hex-char digest", async () => {
    await fs.writeFile(path.join(strategiesDir, "test.json"), JSON.stringify(strategyDoc()), "utf-8");
    process.argv = ["node", "strategy-catalogue-cli.ts"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let lines: string[];
    try {
      const { main } = await import("@/hermes-execution/strategy-catalogue-cli");
      await main();
    } finally {
      lines = logSpy.mock.calls.map((call) => String(call[0]));
      logSpy.mockRestore();
    }
    const row = lines.find((l) => l.startsWith("TEST_STRATEGY_V1"))!;
    expect(row).toMatch(/hash=sha256:[0-9a-f]{8}…/);
    expect(row).not.toMatch(/[0-9a-f]{64}/); // the full digest itself must never appear in human output
  });

  it("supports --json output with full curated strategy/rejection data, including the full content hash", async () => {
    await fs.writeFile(path.join(strategiesDir, "test.json"), JSON.stringify(strategyDoc()), "utf-8");
    await fs.writeFile(path.join(strategiesDir, "broken.json"), "{ not valid json", "utf-8");
    process.argv = ["node", "strategy-catalogue-cli.ts", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let output: string;
    try {
      const { main } = await import("@/hermes-execution/strategy-catalogue-cli");
      await main();
    } finally {
      output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      logSpy.mockRestore();
    }
    const parsed = JSON.parse(output);
    expect(parsed.providerCallsMade).toBe(0);
    expect(parsed.strategies).toHaveLength(1);
    expect(parsed.strategies[0].document.strategyId).toBe("TEST_STRATEGY_V1");
    expect(parsed.strategies[0].result.usableForDemo).toBe(false);
    expect(parsed.strategies[0].result.provenance.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.strategies[0].result.provenance.contentHashAlgorithm).toBe("sha256");
    expect(parsed.strategies[0].result.provenance.loadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(parsed.strategies[0].history[0].contentHash).toBe(parsed.strategies[0].result.provenance.contentHash);
    expect(parsed.strategies[0].history[0].loadedAt).toBe(parsed.strategies[0].result.provenance.loadedAt);
    expect(parsed.strategies[0].result.provenance.loadedAt).toBe(parsed.generatedAt); // one shared clock read for the whole CLI run
    expect(parsed.rejectedCount).toBe(1);
  });

  it("only ever shows the latest version per strategyId in the default row output, while --json exposes full history", async () => {
    await fs.writeFile(path.join(strategiesDir, "v1.json"), JSON.stringify(strategyDoc({ strategyVersion: "1.0.0" })), "utf-8");
    await fs.writeFile(path.join(strategiesDir, "v2.json"), JSON.stringify(strategyDoc({ strategyVersion: "2.0.0" })), "utf-8");

    process.argv = ["node", "strategy-catalogue-cli.ts"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let lines: string[];
    try {
      const { main } = await import("@/hermes-execution/strategy-catalogue-cli");
      await main();
    } finally {
      lines = logSpy.mock.calls.map((call) => String(call[0]));
      logSpy.mockRestore();
    }
    const rows = lines.filter((l) => l.startsWith("TEST_STRATEGY_V1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/v2\.0\.0/);
    expect(rows[0]).toMatch(/versions=2/);

    vi.resetModules();
    process.argv = ["node", "strategy-catalogue-cli.ts", "--json"];
    const jsonLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let output: string;
    try {
      const { main } = await import("@/hermes-execution/strategy-catalogue-cli");
      await main();
    } finally {
      output = jsonLogSpy.mock.calls.map((call) => String(call[0])).join("\n");
      jsonLogSpy.mockRestore();
    }
    const parsed = JSON.parse(output);
    expect(parsed.strategies[0].history).toHaveLength(2);
  });
});
