import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STAGE4_EVIDENCE_SCHEMA_VERSION, STAGE4_EVIDENCE_TYPE } from "@/lib/hermes-execution/instrument-catalogue/stage4-capability-evidence";

// Phase 0 instrument catalogue CLI — never calls eToro, never runs the probe or the Stage-4 smoke
// tool, never imports a broker/execution/risk/lifecycle module at all (verified structurally
// below). Points at isolated temp directories (via the CLI's own test-only override env vars)
// rather than the real .data/hermes-execution/* directories, which other suites also write to in
// parallel — never races against shared, real filesystem state.

vi.mock("@/lib/hermes-execution/config", () => ({
  getHermesExecutionConfig: () => ({
    hermesAgent: { instrumentUniverse: ["BTC", "ETH", "SOL"] },
  }),
}));

function stage4Doc(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: STAGE4_EVIDENCE_SCHEMA_VERSION,
    evidenceType: STAGE4_EVIDENCE_TYPE,
    runId: "smoke-etoro-1000",
    startedAt: "2026-07-31T00:00:00.000Z",
    completedAt: "2026-07-31T00:00:05.000Z",
    gitCommit: "abc123",
    appVersion: "1.13.0",
    brokerProvider: "etoro-demo",
    requestedInstrument: "BTC",
    resolvedInstrument: { symbol: "BTC", displayName: "Bitcoin", brokerInstrumentId: 100000, instrumentTypeID: 10, exchangeID: 8 },
    accountModeEvidence: { configuredProvider: "etoro-demo", demoOnlyGuardPassed: true, liveRouteReachable: false },
    stages: {
      resolution: { status: "SUCCEEDED", detail: "ok" },
      quote: { status: "SUCCEEDED", detail: "ok" },
      openOrderSubmission: { status: "SUCCEEDED", detail: "ok" },
      openPositionConfirmation: { status: "SUCCEEDED", detail: "ok" },
      closeOrderSubmission: { status: "SUCCEEDED", detail: "ok" },
      closedPositionConfirmation: { status: "SUCCEEDED", detail: "ok" },
    },
    finalClassification: "VERIFIED",
    classificationReasons: [],
    limitations: [],
    evidenceGeneratedAt: "2026-07-31T00:00:05.000Z",
    ...overrides,
  };
}

describe("instrument-catalogue-cli", () => {
  let dir: string;
  let stage4Dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "instrument-catalogue-cli-test-"));
    stage4Dir = await fs.mkdtemp(path.join(os.tmpdir(), "instrument-catalogue-cli-stage4-test-"));
    process.env.HERMES_INSTRUMENT_CATALOGUE_EVIDENCE_DIR_FOR_TESTS_ONLY = dir;
    process.env.HERMES_INSTRUMENT_CATALOGUE_STAGE4_EVIDENCE_DIR_FOR_TESTS_ONLY = stage4Dir;
  });

  afterEach(async () => {
    delete process.env.HERMES_INSTRUMENT_CATALOGUE_EVIDENCE_DIR_FOR_TESTS_ONLY;
    delete process.env.HERMES_INSTRUMENT_CATALOGUE_STAGE4_EVIDENCE_DIR_FOR_TESTS_ONLY;
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(stage4Dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("never imports a broker/execution/risk/lifecycle/approval module", async () => {
    const source = await fs.readFile("src/hermes-execution/instrument-catalogue-cli.ts", "utf-8");
    expect(source).not.toMatch(/broker-factory|paper-broker|risk-engine|trade-lifecycle|trade-candidate|placeMarketOrder|closePosition/);
  });

  it("never imports or invokes the Stage-4 smoke tool", async () => {
    const source = await fs.readFile("src/hermes-execution/instrument-catalogue-cli.ts", "utf-8");
    expect(source).not.toMatch(/broker-etoro-smoke/);
  });

  it("prints readOnly/stage4/effective separately and zero provider calls, safely handling missing evidence directories", async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(stage4Dir, { recursive: true, force: true });
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
      expect(row).toMatch(/effective=NOT_TESTED/);
      expect(row).toMatch(/inTradingUniverse=yes/);
    }
    expect(lines.some((l) => l.startsWith("Rejected read-only evidence files: 0"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Rejected Stage-4 evidence files: 0"))).toBe(true);
  });

  it("ingests valid Stage-4 VERIFIED evidence and reflects it in both the row and effective status", async () => {
    await fs.writeFile(path.join(stage4Dir, "smoke-etoro-1000__BTC.json"), JSON.stringify(stage4Doc()), "utf-8");
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
    const btcRow = lines.find((l) => l.startsWith("BTC"));
    expect(btcRow).toMatch(/stage4=VERIFIED/);
    // readOnly has no evidence in this test (only Stage-4 does), so effective can never be VERIFIED.
    expect(btcRow).toMatch(/readOnly=NOT_TESTED/);
    expect(btcRow).toMatch(/effective=NOT_TESTED/);
  });

  it("supports --json output with the required top-level fields, including full Stage-4 provenance/rejections", async () => {
    await fs.writeFile(path.join(stage4Dir, "smoke-etoro-1000__BTC.json"), JSON.stringify(stage4Doc()), "utf-8");
    await fs.writeFile(path.join(stage4Dir, "broken.json"), "{ not valid json", "utf-8");
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
    expect(typeof parsed.stage4SourceDirectory).toBe("string");
    expect(parsed.stage4RejectedEvidenceCount).toBe(1);
    expect(parsed.stage4Rejected).toHaveLength(1);
    const btcEntry = parsed.entries.find((e: { symbol: string }) => e.symbol === "BTC");
    expect(btcEntry.stage4CapabilityStatus).toBe("VERIFIED");
    expect(btcEntry.stage4EvidenceRunId).toBe("smoke-etoro-1000");
    expect(btcEntry.stage4History).toHaveLength(1);
  });

  it("caps default console rejection output for BOTH read-only and Stage-4, but keeps the full lists in --json", async () => {
    const REJECTION_COUNT = 15;
    for (let i = 0; i < REJECTION_COUNT; i++) {
      await fs.writeFile(path.join(dir, `broken-${i}.json`), "{ not valid json", "utf-8");
      await fs.writeFile(path.join(stage4Dir, `broken-${i}.json`), "{ not valid json", "utf-8");
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

    expect(lines.some((l) => l.startsWith(`Rejected read-only evidence files: ${REJECTION_COUNT}`))).toBe(true);
    expect(lines.some((l) => l.startsWith(`Rejected Stage-4 evidence files: ${REJECTION_COUNT}`))).toBe(true);
    const omittedLines = lines.filter((l) => l.includes("more rejection(s) omitted"));
    expect(omittedLines.length).toBe(2); // one per section, each capped independently.

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
    expect(parsed.stage4Rejected).toHaveLength(REJECTION_COUNT);
  });
});
