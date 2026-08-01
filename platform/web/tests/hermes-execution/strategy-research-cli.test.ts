import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baselineStrategyContentHash, datasetHashFor, makeBaselineStrategyDocument, makeDatasetDoc, makeResearchPlanRaw, writeJsonFile } from "./strategy-research/fixtures";

// Phase 3 — Strategy Research Workflow CLI. Never calls eToro, never runs a broker/probe/smoke
// command, never touches PM2, never wires a result into live execution, never promotes a strategy —
// isolated temp directories via the CLI's own test-only override env var, plus a static source scan
// proving no provider/broker/runtime import exists at all.

describe("strategy-research-cli", () => {
  let strategiesDir: string;
  let dataDir: string;
  let planDir: string;
  let planPath: string;

  beforeEach(async () => {
    strategiesDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-cli-strategies-"));
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-cli-data-"));
    planDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-cli-plan-"));
    process.env.HERMES_STRATEGY_DEFINITIONS_DIR_FOR_TESTS_ONLY = strategiesDir;

    await writeJsonFile(strategiesDir, "test.json", makeBaselineStrategyDocument());
    const doc = makeDatasetDoc("BTC", 150);
    const dataPath = await writeJsonFile(dataDir, "BTC.json", doc);
    const hash = datasetHashFor("BTC", 150);
    planPath = await writeJsonFile(
      planDir,
      "plan.json",
      makeResearchPlanRaw({
        strategyContentHash: baselineStrategyContentHash(),
        instruments: ["BTC"],
        datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: dataPath, expectedDatasetHash: hash, startTimestamp: doc.candles[0]!.timestamp, endTimestamp: doc.candles[doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
      }),
    );
  });

  afterEach(async () => {
    delete process.env.HERMES_STRATEGY_DEFINITIONS_DIR_FOR_TESTS_ONLY;
    await fs.rm(strategiesDir, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(planDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("never imports a broker/execution/risk/lifecycle/approval/reconciliation/telegram module, and never invokes a smoke/probe tool", async () => {
    const source = await fs.readFile("src/hermes-execution/strategy-research-cli.ts", "utf-8");
    expect(source).not.toMatch(/broker-factory|paper-broker|etoro-demo-broker|risk-engine|trade-lifecycle|trade-candidate|placeMarketOrder|closePosition|broker-etoro-smoke|telegram|trading-runtime|market-runtime/i);
  });

  it("--json produces pure, parseable JSON on stdout for a successful run", async () => {
    process.argv = ["node", "strategy-research-cli.ts", "--plan", planPath, "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-research-cli");
      await main();
    } finally {
      expect(logSpy).toHaveBeenCalledOnce();
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.ok).toBe(true);
      expect(parsed.researchFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(["PASS", "FAIL", "INCONCLUSIVE"]).toContain(parsed.outcome);
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("--json produces pure JSON on stdout for a validation failure, never plain text mixed in", async () => {
    process.argv = ["node", "strategy-research-cli.ts", "--plan", path.join(planDir, "missing.json"), "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-research-cli");
      await main();
      expect(process.exitCode).toBe(1);
      expect(logSpy).toHaveBeenCalledOnce();
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.ok).toBe(false);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("a FAIL research outcome exits 0 — it is evidence, never a CLI crash", async () => {
    const doc = makeDatasetDoc("BTC", 150);
    const dataPath = await writeJsonFile(dataDir, "BTC2.json", doc);
    const hash = datasetHashFor("BTC", 150);
    const failPlanPath = await writeJsonFile(
      planDir,
      "fail-plan.json",
      makeResearchPlanRaw({
        strategyContentHash: baselineStrategyContentHash(),
        instruments: ["BTC"],
        datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: dataPath, expectedDatasetHash: hash, startTimestamp: doc.candles[0]!.timestamp, endTimestamp: doc.candles[doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
        passCriteria: [{ metric: "MIN_NET_RETURN", operator: "GREATER_THAN_OR_EQUAL", threshold: 999, scope: "OVERALL" }],
      }),
    );
    process.argv = ["node", "strategy-research-cli.ts", "--plan", failPlanPath, "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-research-cli");
      await main();
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.outcome).toBe("FAIL");
      expect(process.exitCode).toBe(0);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("an unrecognised flag is rejected clearly, with exit code 1", async () => {
    process.argv = ["node", "strategy-research-cli.ts", "--plan", planPath, "--bogus-flag", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-research-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.ok).toBe(false);
      expect(parsed.detail).toContain("--bogus-flag");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("--max-experiments may only lower the built-in cap, never raise it", async () => {
    process.argv = ["node", "strategy-research-cli.ts", "--plan", planPath, "--max-experiments", "999999", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-research-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.ok).toBe(false);
      expect(parsed.detail).toContain("never raise it");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("--validate-only verifies the plan and every dataset without running a single backtest (Phase 4 first-run preparation)", async () => {
    process.argv = ["node", "strategy-research-cli.ts", "--plan", planPath, "--validate-only", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-research-cli");
      await main();
      expect(process.exitCode).not.toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.ok).toBe(true);
      expect(parsed.validateOnly).toBe(true);
      expect(parsed.plan.researchPlanId).toBe("TEST_RESEARCH_PLAN");
      expect(parsed.strategy.strategyContentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.datasets).toHaveLength(1);
      expect(parsed.datasets[0].datasetHash).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.outcome).toBeUndefined();
      expect(parsed.variants).toBeUndefined();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("--validate-only rejects an invalid plan the same way a full run would, still without running any backtest", async () => {
    process.argv = ["node", "strategy-research-cli.ts", "--plan", path.join(planDir, "missing.json"), "--validate-only", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-research-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.ok).toBe(false);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("--validate-only never reaches experiment expansion or a single backtest — a plan whose experiments would hard-fail a real run still validates successfully", async () => {
    // Every combination is structurally invalid (fast >= slow) — a real run would reject this at the
    // "experiments" stage with NO_VALID_VARIANTS, and would certainly never reach a backtest. If
    // --validate-only accidentally called generateExperimentMatrix/runVariant, this plan would make
    // that failure visible; since it doesn't, this proves zero experiment expansion and zero backtests.
    const doc = makeDatasetDoc("BTC", 150);
    const dataPath = await writeJsonFile(dataDir, "BTC2.json", doc);
    const hash = datasetHashFor("BTC", 150);
    const brokenExperimentsPlanPath = await writeJsonFile(
      planDir,
      "broken-experiments-plan.json",
      makeResearchPlanRaw({
        strategyContentHash: baselineStrategyContentHash(),
        instruments: ["BTC"],
        datasets: [{ instrument: "BTC", timeframe: "1h", datasetFile: dataPath, expectedDatasetHash: hash, startTimestamp: doc.candles[0]!.timestamp, endTimestamp: doc.candles[doc.candles.length - 1]!.timestamp, role: "FULL_HISTORY" }],
        parameterExperiments: { dimensions: { emaFastPeriod: { kind: "EXPLICIT_VALUES", values: [50, 60] }, emaSlowPeriod: { kind: "EXPLICIT_VALUES", values: [10, 20] } }, maxExperiments: 20 },
      }),
    );
    process.argv = ["node", "strategy-research-cli.ts", "--plan", brokenExperimentsPlanPath, "--validate-only", "--json"];
    let validateOnlyOutput: string;
    const logSpy1 = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-research-cli");
      await main();
    } finally {
      validateOnlyOutput = String(logSpy1.mock.calls[0]![0]);
      logSpy1.mockRestore();
      process.exitCode = 0;
    }
    const parsed = JSON.parse(validateOnlyOutput);
    expect(parsed.ok).toBe(true);

    // Confirm a FULL run of the identical plan really would have failed at the experiments stage —
    // otherwise this test would not actually be proving anything about --validate-only's own behaviour.
    vi.resetModules();
    process.argv = ["node", "strategy-research-cli.ts", "--plan", brokenExperimentsPlanPath, "--json"];
    let fullRunOutput: string;
    const logSpy2 = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main: main2 } = await import("@/hermes-execution/strategy-research-cli");
      await main2();
    } finally {
      fullRunOutput = String(logSpy2.mock.calls[0]![0]);
      logSpy2.mockRestore();
      process.exitCode = 0;
    }
    const fullRunParsed = JSON.parse(fullRunOutput);
    expect(fullRunParsed.ok).toBe(false);
    expect(fullRunParsed.stage).toBe("experiments");
  });

  it("--validate-only performs no filesystem writes, even when --output-dir is also supplied", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-cli-validate-only-output-"));
    try {
      process.argv = ["node", "strategy-research-cli.ts", "--plan", planPath, "--validate-only", "--output-dir", outputDir, "--json"];
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { main } = await import("@/hermes-execution/strategy-research-cli");
        await main();
        const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
        expect(parsed.ok).toBe(true);
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
      expect(await fs.readdir(outputDir)).toEqual([]);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("the top-level crash handler uses exit code 2, distinct from every known-rejection path's code 1", async () => {
    const source = await fs.readFile("src/hermes-execution/strategy-research-cli.ts", "utf-8");
    expect(source).toMatch(/main\(\)\.catch\(/);
    expect(source).toMatch(/process\.exitCode = 2/);
  });

  it("the top-level crash handler is JSON-aware — a --json caller must never have to fall back to scraping stderr text on an unexpected crash", async () => {
    const source = await fs.readFile("src/hermes-execution/strategy-research-cli.ts", "utf-8");
    expect(source).toMatch(/main\(\)\.catch\(/);
    expect(source).toMatch(/process\.argv\.includes\(["']--json["']\)/);
    expect(source).toMatch(/UNEXPECTED_ERROR/);
  });

  it("never carries the dead 'result.outcome === INVALID' check — a produced ResearchResult can never be INVALID (see determineOutcome)", async () => {
    const source = await fs.readFile("src/hermes-execution/strategy-research-cli.ts", "utf-8");
    expect(source).not.toMatch(/result\.outcome === "INVALID"/);
  });

  it("never writes anything when --output-dir is omitted", async () => {
    const filesBefore = await fs.readdir(strategiesDir);
    process.argv = ["node", "strategy-research-cli.ts", "--plan", planPath, "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-research-cli");
      await main();
    } finally {
      logSpy.mockRestore();
    }
    expect(await fs.readdir(strategiesDir)).toEqual(filesBefore);
  });

  it("writes atomic, create-only evidence only when --output-dir is supplied, and repeat runs return already-exists without overwriting", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-cli-output-"));
    try {
      process.argv = ["node", "strategy-research-cli.ts", "--plan", planPath, "--output-dir", outputDir, "--json"];
      const logSpy1 = vi.spyOn(console, "log").mockImplementation(() => {});
      let firstOutput: string;
      try {
        const { main } = await import("@/hermes-execution/strategy-research-cli");
        await main();
      } finally {
        firstOutput = String(logSpy1.mock.calls[0]![0]);
        logSpy1.mockRestore();
      }
      const firstParsed = JSON.parse(firstOutput);
      expect(firstParsed.evidence.outcome).toBe("written");
      const filesAfterFirst = await fs.readdir(outputDir);
      expect(filesAfterFirst).toHaveLength(1);
      const contentAfterFirst = await fs.readFile(path.join(outputDir, filesAfterFirst[0]!), "utf-8");

      vi.resetModules();
      const logSpy2 = vi.spyOn(console, "log").mockImplementation(() => {});
      let secondOutput: string;
      try {
        const { main } = await import("@/hermes-execution/strategy-research-cli");
        await main();
      } finally {
        secondOutput = String(logSpy2.mock.calls[0]![0]);
        logSpy2.mockRestore();
      }
      const secondParsed = JSON.parse(secondOutput);
      expect(secondParsed.evidence.outcome).toBe("already-exists");
      const filesAfterSecond = await fs.readdir(outputDir);
      expect(filesAfterSecond).toHaveLength(1);
      expect(await fs.readFile(path.join(outputDir, filesAfterSecond[0]!), "utf-8")).toBe(contentAfterFirst);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("persisted evidence never embeds the operator's own absolute dataset file path", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-cli-redact-"));
    try {
      process.argv = ["node", "strategy-research-cli.ts", "--plan", planPath, "--output-dir", outputDir, "--json"];
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const { main } = await import("@/hermes-execution/strategy-research-cli");
        await main();
      } finally {
        logSpy.mockRestore();
      }
      const files = await fs.readdir(outputDir);
      const persisted = JSON.parse(await fs.readFile(path.join(outputDir, files[0]!), "utf-8"));
      for (const dataset of persisted.datasets) {
        expect(dataset.filePath).not.toContain(path.sep);
      }
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("never modifies the source strategy definition file — no promotion side effect", async () => {
    const strategyFilePath = path.join(strategiesDir, "test.json");
    const before = await fs.readFile(strategyFilePath, "utf-8");
    process.argv = ["node", "strategy-research-cli.ts", "--plan", planPath, "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/strategy-research-cli");
      await main();
    } finally {
      logSpy.mockRestore();
    }
    const after = await fs.readFile(strategyFilePath, "utf-8");
    expect(after).toBe(before);
    expect(before).not.toMatch(/APPROVED_FOR_DEMO/);
  });

  it("human-readable output always includes the permanent research-only disclaimer", async () => {
    process.argv = ["node", "strategy-research-cli.ts", "--plan", planPath];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let lines: string[];
    try {
      const { main } = await import("@/hermes-execution/strategy-research-cli");
      await main();
    } finally {
      lines = logSpy.mock.calls.map((c) => String(c[0]));
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(lines.some((l) => l.includes("RESEARCH EVIDENCE ONLY — NOT APPROVED FOR DEMO OR LIVE TRADING"))).toBe(true);
  });
});
