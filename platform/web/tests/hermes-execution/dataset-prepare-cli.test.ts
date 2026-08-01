import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 4 — Historical Dataset Intake CLI. Never calls eToro, never runs a broker/probe/smoke
// command, never touches PM2, never wires anything into live execution, never promotes a strategy —
// isolated temp directories, plus a static source scan proving no provider/broker/runtime import
// exists at all.

const VALID_CSV = ["timestamp,open,high,low,close,volume", "2026-01-01T00:00:00Z,100,101,99,100.5,10", "2026-01-01T01:00:00Z,100.5,102,100,101.5,12", "2026-01-01T02:00:00Z,101.5,103,101,102.5,11"].join(
  "\n",
);

describe("dataset-prepare-cli", () => {
  let dir: string;
  let inputPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "dataset-prepare-cli-"));
    inputPath = path.join(dir, "input.csv");
    await fs.writeFile(inputPath, VALID_CSV, "utf-8");
    vi.resetModules();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("never imports a broker/execution/risk/lifecycle/approval/reconciliation/telegram/provider module", async () => {
    const source = await fs.readFile("src/hermes-execution/dataset-prepare-cli.ts", "utf-8");
    expect(source).not.toMatch(/broker-factory|paper-broker|etoro-demo-broker|risk-engine|trade-lifecycle|trade-candidate|placeMarketOrder|closePosition|broker-etoro-smoke|telegram|trading-runtime|market-runtime|market-data-provider/i);
  });

  it("never touches strategy promotion/approval-status fields anywhere in its own source", async () => {
    const source = await fs.readFile("src/hermes-execution/dataset-prepare-cli.ts", "utf-8");
    expect(source).not.toMatch(/usableForDemo|APPROVED_FOR_DEMO/);
  });

  it("--json produces pure JSON on stdout for a successful dry-run", async () => {
    process.argv = ["node", "dataset-prepare-cli.ts", "--input", inputPath, "--format", "csv", "--instrument", "BTC", "--timeframe", "1h", "--source", "test", "--timezone", "UTC", "--json", "--dry-run"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-prepare-cli");
      await main();
      expect(process.exitCode).not.toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.ok).toBe(true);
      expect(parsed.report.validationStatus).toBe("VALID");
      expect(parsed.report.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      logSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("--json produces pure JSON on stdout for a validation rejection", async () => {
    await fs.writeFile(inputPath, "timestamp,open,high,low,close\n2026-01-01T00:00:00Z,100,101,99,100.5\n2026-01-01T00:00:00Z,100,101,99,100.5", "utf-8");
    process.argv = ["node", "dataset-prepare-cli.ts", "--input", inputPath, "--format", "csv", "--instrument", "BTC", "--timeframe", "1h", "--source", "test", "--timezone", "UTC", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-prepare-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe("DUPLICATE_TIMESTAMP");
    } finally {
      logSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("dry-run never writes the output file", async () => {
    const outputPath = path.join(dir, "out.json");
    process.argv = [
      "node",
      "dataset-prepare-cli.ts",
      "--input",
      inputPath,
      "--format",
      "csv",
      "--instrument",
      "BTC",
      "--timeframe",
      "1h",
      "--source",
      "test",
      "--timezone",
      "UTC",
      "--output",
      outputPath,
      "--dry-run",
      "--json",
    ];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-prepare-cli");
      await main();
    } finally {
      logSpy.mockRestore();
    }
    await expect(fs.access(outputPath)).rejects.toThrow();
  });

  it("writes a create-only output file, and a repeat run is rejected rather than overwriting", async () => {
    const outputPath = path.join(dir, "out.json");
    const argv = ["node", "dataset-prepare-cli.ts", "--input", inputPath, "--format", "csv", "--instrument", "BTC", "--timeframe", "1h", "--source", "test", "--timezone", "UTC", "--output", outputPath, "--json"];

    process.argv = argv;
    const logSpy1 = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-prepare-cli");
      await main();
    } finally {
      logSpy1.mockRestore();
    }
    const written = JSON.parse(await fs.readFile(outputPath, "utf-8"));
    expect(written.schemaVersion).toBe(1);

    vi.resetModules();
    process.argv = argv;
    const logSpy2 = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-prepare-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy2.mock.calls[0]![0]));
      expect(parsed.reason).toBe("OUTPUT_ALREADY_EXISTS");
    } finally {
      logSpy2.mockRestore();
      process.exitCode = 0;
    }
  });

  it("generates a manifest entry and rejects a duplicate (instrument, role) append", async () => {
    const outputPath = path.join(dir, "out.json");
    const manifestPath = path.join(dir, "manifest.json");
    const argv = [
      "node",
      "dataset-prepare-cli.ts",
      "--input",
      inputPath,
      "--format",
      "csv",
      "--instrument",
      "BTC",
      "--timeframe",
      "1h",
      "--source",
      "test",
      "--timezone",
      "UTC",
      "--output",
      outputPath,
      "--manifest-output",
      manifestPath,
      "--role",
      "FULL_HISTORY",
      "--json",
    ];
    process.argv = argv;
    const logSpy1 = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-prepare-cli");
      await main();
    } finally {
      logSpy1.mockRestore();
    }
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    expect(manifest).toHaveLength(1);
    expect(manifest[0].instrument).toBe("BTC");
    expect(manifest[0].role).toBe("FULL_HISTORY");
    expect(manifest[0].expectedDatasetHash).toMatch(/^[0-9a-f]{64}$/);

    // Second dataset for the SAME instrument/role must be rejected as a duplicate, never silently merged.
    const secondOutput = path.join(dir, "out2.json");
    const outputFlagIndex = argv.indexOf("--output");
    const secondArgv = [...argv];
    secondArgv[outputFlagIndex + 1] = secondOutput;
    process.argv = secondArgv;
    vi.resetModules();
    const logSpy2 = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-prepare-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy2.mock.calls[0]![0]));
      expect(parsed.reason).toBe("DUPLICATE_MANIFEST_ENTRY");
    } finally {
      logSpy2.mockRestore();
      process.exitCode = 0;
    }
  });

  it("rejects --manifest-output without --role", async () => {
    process.argv = ["node", "dataset-prepare-cli.ts", "--input", inputPath, "--format", "csv", "--instrument", "BTC", "--timeframe", "1h", "--source", "test", "--timezone", "UTC", "--manifest-output", path.join(dir, "m.json"), "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-prepare-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.detail).toContain("--role");
    } finally {
      logSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("rejects an unsupported timeframe", async () => {
    process.argv = ["node", "dataset-prepare-cli.ts", "--input", inputPath, "--format", "csv", "--instrument", "BTC", "--timeframe", "3h", "--source", "test", "--timezone", "UTC", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-prepare-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.detail).toContain("--timeframe");
    } finally {
      logSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("rejects an unsupported timezone assumption", async () => {
    process.argv = ["node", "dataset-prepare-cli.ts", "--input", inputPath, "--format", "csv", "--instrument", "BTC", "--timeframe", "1h", "--source", "test", "--timezone", "America/New_York", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-prepare-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.detail).toContain("--timezone");
    } finally {
      logSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("rejects --output and --manifest-output pointing at the same path, before doing any work", async () => {
    const samePath = path.join(dir, "same.json");
    process.argv = [
      "node",
      "dataset-prepare-cli.ts",
      "--input",
      inputPath,
      "--format",
      "csv",
      "--instrument",
      "BTC",
      "--timeframe",
      "1h",
      "--source",
      "test",
      "--timezone",
      "UTC",
      "--output",
      samePath,
      "--manifest-output",
      samePath,
      "--role",
      "FULL_HISTORY",
      "--json",
    ];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-prepare-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.detail).toContain("same path");
    } finally {
      logSpy.mockRestore();
      process.exitCode = 0;
    }
    await expect(fs.access(samePath)).rejects.toThrow();
  });

  it("--date-from/--date-to are parsed through the same explicit timezone handling as candle timestamps, not the host machine's local timezone", async () => {
    // A naive (offset-less) --date-to combined with a non-UTC --timezone must shift exactly like a
    // candle timestamp would, never falling back to whatever timezone the test runner happens to use.
    process.argv = [
      "node",
      "dataset-prepare-cli.ts",
      "--input",
      inputPath,
      "--format",
      "csv",
      "--instrument",
      "BTC",
      "--timeframe",
      "1h",
      "--source",
      "test",
      "--timezone",
      "+02:00",
      "--date-to",
      "2026-01-01T04:00:00",
      "--json",
      "--dry-run",
    ];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-prepare-cli");
      await main();
      expect(process.exitCode).not.toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      // dateTo "2026-01-01T04:00:00+02:00" == "2026-01-01T02:00:00Z" (exclusive) -> the 00:00Z and 01:00Z candles survive, 02:00Z is excluded.
      expect(parsed.ok).toBe(true);
      expect(parsed.report.lastTimestamp).toBe("2026-01-01T01:00:00.000Z");
    } finally {
      logSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("rejects an invalid --date-from/--date-to (unparseable, or not strictly before the other bound)", async () => {
    process.argv = ["node", "dataset-prepare-cli.ts", "--input", inputPath, "--format", "csv", "--instrument", "BTC", "--timeframe", "1h", "--source", "test", "--timezone", "UTC", "--date-from", "not-a-date", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-prepare-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.detail).toContain("--date-from");
    } finally {
      logSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("a manifest-stage failure after a successful --output write reports that the output was already written", async () => {
    const outputPath = path.join(dir, "out.json");
    const manifestPath = path.join(dir, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify([{ instrument: "BTC", timeframe: "1h", datasetFile: "x.json", expectedDatasetHash: "a".repeat(64), startTimestamp: "2026-01-01T00:00:00.000Z", endTimestamp: "2026-01-02T00:00:00.000Z", role: "FULL_HISTORY" }]), "utf-8");
    process.argv = [
      "node",
      "dataset-prepare-cli.ts",
      "--input",
      inputPath,
      "--format",
      "csv",
      "--instrument",
      "BTC",
      "--timeframe",
      "1h",
      "--source",
      "test",
      "--timezone",
      "UTC",
      "--output",
      outputPath,
      "--manifest-output",
      manifestPath,
      "--role",
      "FULL_HISTORY",
      "--json",
    ];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-prepare-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.reason).toBe("DUPLICATE_MANIFEST_ENTRY");
      expect(parsed.output.outcome).toBe("written");
      expect(parsed.output.filePath).toBe(outputPath);
    } finally {
      logSpy.mockRestore();
      process.exitCode = 0;
    }
    // The dataset output file remains on disk — it is never rolled back by an unrelated, later
    // manifest-registration failure.
    const written = JSON.parse(await fs.readFile(outputPath, "utf-8"));
    expect(written.schemaVersion).toBe(1);
  });

  it("no leftover temp file remains after a write failure (existing output path)", async () => {
    const outputPath = path.join(dir, "out.json");
    await fs.writeFile(outputPath, "not a real dataset", "utf-8");
    process.argv = ["node", "dataset-prepare-cli.ts", "--input", inputPath, "--format", "csv", "--instrument", "BTC", "--timeframe", "1h", "--source", "test", "--timezone", "UTC", "--output", outputPath, "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-prepare-cli");
      await main();
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      process.exitCode = 0;
    }
    const files = await fs.readdir(dir);
    expect(files.filter((f) => f.startsWith(".tmp-"))).toHaveLength(0);
  });

  it("the top-level crash handler is JSON-aware, matching every other Phase 3/4 CLI", async () => {
    const source = await fs.readFile("src/hermes-execution/dataset-prepare-cli.ts", "utf-8");
    expect(source).toMatch(/main\(\)\.catch\(/);
    expect(source).toMatch(/process\.argv\.includes\(["']--json["']\)/);
    expect(source).toMatch(/process\.exitCode = 2/);
  });
});
