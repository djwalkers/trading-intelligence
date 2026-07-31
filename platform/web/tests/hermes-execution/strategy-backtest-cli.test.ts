import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 2 — Deterministic Backtesting Foundation CLI. Never calls eToro, never runs a broker/probe/
// smoke command, never touches PM2, never wires a result into live execution, never auto-promotes a
// strategy — isolated temp directories via the CLI's own test-only override env var, plus a static
// source scan proving no provider/broker/runtime import exists at all.

function strategyDoc(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    strategyId: "TEST_BACKTEST_STRATEGY",
    strategyVersion: "1.0.0",
    name: "Test Backtest Strategy",
    description: "fixture",
    status: "APPROVED_FOR_BACKTEST",
    strategyFamily: "TREND_FOLLOWING",
    assetClass: "crypto",
    supportedInstruments: ["BTC"],
    timeframe: "1h",
    dataRequirements: ["close"],
    indicators: [{ id: "ema2", type: "EMA", sourceField: "close", parameters: { period: 2 }, outputAlias: "EMA2" }],
    entryRules: { operator: "GREATER_THAN_OR_EQUAL", left: { kind: "MARKET_FIELD", field: "close" }, right: { kind: "CONSTANT", value: 0 } },
    signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 2 }],
    parameters: {},
    eligibility: { requiresReadOnlyVerified: true, requiresStage4Verified: false, requiresConfiguredUniverse: true, notes: [] },
    backtestPolicy: { minHistoryBars: 5, warmupBars: 0, notes: [] },
    provenance: { author: "test", createdAt: "2026-07-31T00:00:00.000Z", notes: [] },
    limitations: [],
    ...overrides,
  };
}

const HOUR_MS = 3_600_000;
const START = Date.parse("2026-01-01T00:00:00.000Z");

function datasetDoc(count = 20) {
  const candles = Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(START + i * HOUR_MS).toISOString(),
    open: 100 + i,
    high: 100 + i + 2,
    low: 100 + i - 2,
    close: 100 + i + 0.5,
    volume: 10,
  }));
  return { schemaVersion: 1, instrument: "BTC", timeframe: "1h", source: "test fixture", candles };
}

describe("strategy-backtest-cli", () => {
  let strategiesDir: string;
  let dataDir: string;
  let dataPath: string;

  beforeEach(async () => {
    strategiesDir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-backtest-cli-strategies-"));
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-backtest-cli-data-"));
    dataPath = path.join(dataDir, "btc.json");
    await fs.writeFile(path.join(strategiesDir, "test.json"), JSON.stringify(strategyDoc()), "utf-8");
    await fs.writeFile(dataPath, JSON.stringify(datasetDoc()), "utf-8");
    process.env.HERMES_STRATEGY_DEFINITIONS_DIR_FOR_TESTS_ONLY = strategiesDir;
  });

  afterEach(async () => {
    delete process.env.HERMES_STRATEGY_DEFINITIONS_DIR_FOR_TESTS_ONLY;
    await fs.rm(strategiesDir, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("never imports a broker/execution/risk/lifecycle/approval/reconciliation/telegram module, and never invokes a smoke/probe tool", async () => {
    const source = await fs.readFile("src/hermes-execution/strategy-backtest-cli.ts", "utf-8");
    expect(source).not.toMatch(/broker-factory|paper-broker|etoro-demo-broker|risk-engine|trade-lifecycle|trade-candidate|placeMarketOrder|closePosition|broker-etoro-smoke|telegram|trading-runtime|market-runtime/i);
  });

  it("--json produces pure, parseable JSON on stdout with no extra human-readable text", async () => {
    process.argv = ["node", "strategy-backtest-cli.ts", "--strategy", "TEST_BACKTEST_STRATEGY", "--version", "1.0.0", "--data", dataPath, "--instrument", "BTC", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-backtest-cli");
      await main();
    } finally {
      expect(logSpy).toHaveBeenCalledOnce(); // exactly one console.log call — nothing else printed
      const output = String(logSpy.mock.calls[0]![0]);
      const parsed = JSON.parse(output);
      expect(parsed.strategy.strategyId).toBe("TEST_BACKTEST_STRATEGY");
      expect(parsed.runFingerprint).toMatch(/^[0-9a-f]{64}$/);
      logSpy.mockRestore();
    }
  });

  it("human-readable output clearly states BACKTEST ONLY — NOT APPROVED FOR DEMO OR LIVE TRADING", async () => {
    process.argv = ["node", "strategy-backtest-cli.ts", "--strategy", "TEST_BACKTEST_STRATEGY", "--version", "1.0.0", "--data", dataPath, "--instrument", "BTC"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let lines: string[];
    try {
      const { main } = await import("@/hermes-execution/strategy-backtest-cli");
      await main();
    } finally {
      lines = logSpy.mock.calls.map((c) => String(c[0]));
      logSpy.mockRestore();
    }
    expect(lines.some((l) => l.includes("BACKTEST ONLY — NOT APPROVED FOR DEMO OR LIVE TRADING"))).toBe(true);
  });

  it("rejects a malformed dataset explicitly, exits non-zero, never crashes uncaught", async () => {
    await fs.writeFile(dataPath, JSON.stringify({ schemaVersion: 1, instrument: "BTC", timeframe: "1h", source: "x", candles: [{ timestamp: "bad" }] }), "utf-8");
    process.argv = ["node", "strategy-backtest-cli.ts", "--strategy", "TEST_BACKTEST_STRATEGY", "--version", "1.0.0", "--data", dataPath, "--instrument", "BTC"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-backtest-cli");
      await main();
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("reports a clear error and exits non-zero when the requested strategy/version is not found", async () => {
    process.argv = ["node", "strategy-backtest-cli.ts", "--strategy", "NOT_A_REAL_STRATEGY", "--version", "9.9.9", "--data", dataPath, "--instrument", "BTC"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-backtest-cli");
      await main();
      expect(process.exitCode).toBe(1);
    } finally {
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("writes an immutable evidence file only when --output-dir is explicitly supplied, and never overwrites on a repeat run", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-backtest-cli-output-"));
    try {
      process.argv = ["node", "strategy-backtest-cli.ts", "--strategy", "TEST_BACKTEST_STRATEGY", "--version", "1.0.0", "--data", dataPath, "--instrument", "BTC", "--output-dir", outputDir, "--json"];
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      let firstOutput: string;
      try {
        const { main } = await import("@/hermes-execution/strategy-backtest-cli");
        await main();
      } finally {
        firstOutput = String(logSpy.mock.calls[0]![0]);
        logSpy.mockRestore();
      }
      const firstParsed = JSON.parse(firstOutput);
      expect(firstParsed.evidence.outcome).toBe("written");
      const filesAfterFirst = await fs.readdir(outputDir);
      expect(filesAfterFirst).toHaveLength(1);
      const contentAfterFirst = await fs.readFile(path.join(outputDir, filesAfterFirst[0]!), "utf-8");

      // Repeat run, identical inputs — must report "already-exists", never silently overwrite.
      vi.resetModules();
      const logSpy2 = vi.spyOn(console, "log").mockImplementation(() => {});
      let secondOutput: string;
      try {
        const { main } = await import("@/hermes-execution/strategy-backtest-cli");
        await main();
      } finally {
        secondOutput = String(logSpy2.mock.calls[0]![0]);
        logSpy2.mockRestore();
      }
      const secondParsed = JSON.parse(secondOutput);
      expect(secondParsed.evidence.outcome).toBe("already-exists");
      const filesAfterSecond = await fs.readdir(outputDir);
      expect(filesAfterSecond).toHaveLength(1); // still exactly one file — no duplicate, no overwrite
      const contentAfterSecond = await fs.readFile(path.join(outputDir, filesAfterSecond[0]!), "utf-8");
      expect(contentAfterSecond).toBe(contentAfterFirst);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("never writes anything when --output-dir is omitted — no default mutation", async () => {
    const filesBefore = await fs.readdir(strategiesDir);
    process.argv = ["node", "strategy-backtest-cli.ts", "--strategy", "TEST_BACKTEST_STRATEGY", "--version", "1.0.0", "--data", dataPath, "--instrument", "BTC", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-backtest-cli");
      await main();
    } finally {
      logSpy.mockRestore();
    }
    const filesAfter = await fs.readdir(strategiesDir);
    expect(filesAfter).toEqual(filesBefore); // the strategy definitions directory itself is never touched
  });

  it("never modifies the source strategy definition file — no implicit demo/live promotion side effect", async () => {
    const strategyFilePath = path.join(strategiesDir, "test.json");
    const before = await fs.readFile(strategyFilePath, "utf-8");
    process.argv = ["node", "strategy-backtest-cli.ts", "--strategy", "TEST_BACKTEST_STRATEGY", "--version", "1.0.0", "--data", dataPath, "--instrument", "BTC", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-backtest-cli");
      await main();
    } finally {
      logSpy.mockRestore();
    }
    const after = await fs.readFile(strategyFilePath, "utf-8");
    expect(after).toBe(before);
    expect(before).not.toMatch(/APPROVED_FOR_DEMO/); // still exactly the DRAFT-equivalent status this fixture started with
  });

  it("rejects an unrecognised flag explicitly, with pure JSON on stdout when --json is present", async () => {
    process.argv = ["node", "strategy-backtest-cli.ts", "--strategy", "TEST_BACKTEST_STRATEGY", "--version", "1.0.0", "--data", dataPath, "--instrument", "BTC", "--json", "--bogus-flag"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-backtest-cli");
      await main();
      expect(process.exitCode).toBe(1);
      expect(logSpy).toHaveBeenCalledOnce();
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.ok).toBe(false);
      expect(parsed.detail).toContain("--bogus-flag");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("rejects a non-numeric --fee-bps value with a specific, clear message, in pure JSON when requested", async () => {
    process.argv = ["node", "strategy-backtest-cli.ts", "--strategy", "TEST_BACKTEST_STRATEGY", "--version", "1.0.0", "--data", dataPath, "--instrument", "BTC", "--fee-bps", "not-a-number", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-backtest-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.ok).toBe(false);
      expect(parsed.detail).toContain("--fee-bps");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("normalises instrument casing — 'btc' is treated identically to 'BTC'", async () => {
    process.argv = ["node", "strategy-backtest-cli.ts", "--strategy", "TEST_BACKTEST_STRATEGY", "--version", "1.0.0", "--data", dataPath, "--instrument", "btc", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-backtest-cli");
      await main();
      expect(process.exitCode).toBe(0);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.ok).toBe(true);
      expect(parsed.instrument).toBe("BTC");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("rejects an instrument outside the fixed BTC/ETH/SOL catalogue explicitly and immediately, never fabricating catalogue membership for whatever was requested", async () => {
    process.argv = ["node", "strategy-backtest-cli.ts", "--strategy", "TEST_BACKTEST_STRATEGY", "--version", "1.0.0", "--data", dataPath, "--instrument", "DOGE", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-backtest-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe("UNSUPPORTED_INSTRUMENT");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("--json emits a pure, parseable JSON failure payload on stdout for a malformed dataset — not only plain stderr text", async () => {
    await fs.writeFile(dataPath, JSON.stringify({ schemaVersion: 1, instrument: "BTC", timeframe: "1h", source: "x", candles: [{ timestamp: "bad" }] }), "utf-8");
    process.argv = ["node", "strategy-backtest-cli.ts", "--strategy", "TEST_BACKTEST_STRATEGY", "--version", "1.0.0", "--data", dataPath, "--instrument", "BTC", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-backtest-cli");
      await main();
      expect(process.exitCode).toBe(1);
      expect(logSpy).toHaveBeenCalledOnce();
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.ok).toBe(false);
      expect(parsed.stage).toBe("dataset");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("the top-level crash handler uses exit code 2, distinct from every known-rejection path's code 1", async () => {
    // main() itself always resolves (every anticipated failure sets exitCode 1 and returns
    // normally — see the many `fail(...)` call sites above) — only a genuinely UNEXPECTED throw
    // reaches the top-level `.catch` at the bottom of this file, which is otherwise unreachable
    // from a unit test (it's gated behind `import.meta.url === process.argv[1]`, true only when
    // this file is executed directly, never when imported). Asserting on the source itself is the
    // reliable way to pin this convention down.
    const source = await fs.readFile("src/hermes-execution/strategy-backtest-cli.ts", "utf-8");
    expect(source).toMatch(/main\(\)\.catch\(/);
    expect(source).toMatch(/process\.exitCode = 2/);
  });

  it("evidence written to disk never embeds the operator's own absolute dataset file path — only its basename", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-backtest-cli-redact-"));
    try {
      process.argv = ["node", "strategy-backtest-cli.ts", "--strategy", "TEST_BACKTEST_STRATEGY", "--version", "1.0.0", "--data", dataPath, "--instrument", "BTC", "--output-dir", outputDir, "--json"];
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const { main } = await import("@/hermes-execution/strategy-backtest-cli");
        await main();
      } finally {
        logSpy.mockRestore();
      }
      const files = await fs.readdir(outputDir);
      const persisted = JSON.parse(await fs.readFile(path.join(outputDir, files[0]!), "utf-8"));
      expect(persisted.dataset.filePath).toBe(path.basename(dataPath));
      expect(persisted.dataset.filePath).not.toContain(path.sep);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });
});
