import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 0 instrument catalogue CLI — never calls eToro, never runs the probe, never imports a
// broker/execution/risk/lifecycle module at all (verified structurally below). Points at an
// isolated temp directory (via the CLI's own test-only override env var) rather than the real
// .data/hermes-execution/etoro-capability-evidence directory, which other suites (the probe's own
// tests) also write to in parallel — never races against shared, real filesystem state.

vi.mock("@/lib/hermes-execution/config", () => ({
  getHermesExecutionConfig: () => ({
    hermesAgent: { instrumentUniverse: ["BTC", "ETH", "SOL"] },
  }),
}));

describe("instrument-catalogue-cli", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "instrument-catalogue-cli-test-"));
    process.env.HERMES_INSTRUMENT_CATALOGUE_EVIDENCE_DIR_FOR_TESTS_ONLY = dir;
  });

  afterEach(async () => {
    delete process.env.HERMES_INSTRUMENT_CATALOGUE_EVIDENCE_DIR_FOR_TESTS_ONLY;
    await fs.rm(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("never imports a broker/execution/risk/lifecycle/approval module", async () => {
    const source = await fs.readFile("src/hermes-execution/instrument-catalogue-cli.ts", "utf-8");
    expect(source).not.toMatch(/broker-factory|paper-broker|risk-engine|trade-lifecycle|trade-candidate|placeMarketOrder|closePosition/);
  });

  it("prints a table row per seed symbol and zero provider calls, safely handling a missing evidence directory", async () => {
    await fs.rm(dir, { recursive: true, force: true }); // the directory itself is absent — the "missing directory" path.
    process.argv = ["node", "instrument-catalogue-cli.ts"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let lines: string[];
    try {
      const { main } = await import("@/hermes-execution/instrument-catalogue-cli");
      await main();
    } finally {
      lines = logSpy.mock.calls.map((call) => String(call[0]));
      logSpy.mockRestore();
    }

    expect(lines.some((l) => l.includes("No provider calls made"))).toBe(true);
    for (const symbol of ["BTC", "ETH", "SOL"]) {
      const row = lines.find((l) => l.startsWith(symbol));
      expect(row).toBeTruthy();
      expect(row).toMatch(/configured=yes/);
      expect(row).toMatch(/readOnly=NOT_TESTED/);
      expect(row).toMatch(/stage4=NOT_TESTED/);
      expect(row).toMatch(/inTradingUniverse=yes/);
    }
    expect(lines.some((l) => l.startsWith("Rejected evidence files: 0"))).toBe(true);
  });

  it("supports --json output with the required top-level fields", async () => {
    process.argv = ["node", "instrument-catalogue-cli.ts", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let output: string;
    try {
      const { main } = await import("@/hermes-execution/instrument-catalogue-cli");
      await main();
    } finally {
      output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      logSpy.mockRestore();
    }

    const parsed = JSON.parse(output);
    expect(parsed.providerCallsMade).toBe(0);
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries).toHaveLength(3);
    expect(typeof parsed.generatedAt).toBe("string");
    expect(typeof parsed.sourceDirectory).toBe("string");
  });

  it("caps default console rejection output but keeps the full list in --json", async () => {
    const REJECTION_COUNT = 15;
    for (let i = 0; i < REJECTION_COUNT; i++) {
      await fs.writeFile(path.join(dir, `broken-${i}.json`), "{ not valid json", "utf-8");
    }

    process.argv = ["node", "instrument-catalogue-cli.ts"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let lines: string[];
    try {
      const { main } = await import("@/hermes-execution/instrument-catalogue-cli");
      await main();
    } finally {
      lines = logSpy.mock.calls.map((call) => String(call[0]));
      logSpy.mockRestore();
    }

    expect(lines.some((l) => l.startsWith(`Rejected evidence files: ${REJECTION_COUNT}`))).toBe(true);
    const printedDetailLines = lines.filter((l) => l.trim().startsWith("- ") || l.includes(".json:"));
    expect(printedDetailLines.length).toBeLessThanOrEqual(10);
    expect(lines.some((l) => l.includes("5 more rejection(s) omitted"))).toBe(true);

    vi.resetModules();
    process.argv = ["node", "instrument-catalogue-cli.ts", "--json"];
    const jsonLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let output: string;
    try {
      const { main } = await import("@/hermes-execution/instrument-catalogue-cli");
      await main();
    } finally {
      output = jsonLogSpy.mock.calls.map((call) => String(call[0])).join("\n");
      jsonLogSpy.mockRestore();
    }
    const parsed = JSON.parse(output);
    expect(parsed.rejected).toHaveLength(REJECTION_COUNT);
  });
});
