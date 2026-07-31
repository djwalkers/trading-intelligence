import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EtoroNoInstrumentMatchError,
  EtoroAmbiguousInstrumentError,
  EtoroRateUnavailableError,
  EtoroReconciliationError,
  EtoroCleanupRequiredError,
} from "@/lib/hermes-execution/etoro/etoro-demo-broker";
import { EtoroApiError, EtoroTimeoutError } from "@/lib/hermes-execution/etoro/etoro-client";

// `configState` is mutable (via vi.hoisted, so the mock factory below can close over it) — the
// "configuration failure" test flips `configState.etoro.env` for its own duration and restores it
// afterwards, so every test in this file can share ONE static import of `main` (see below) instead
// of needing a fresh module instance (`vi.doMock` + `vi.resetModules()`) just to vary config.
const { createMock, configState } = vi.hoisted(() => ({
  createMock: vi.fn(),
  configState: {
    brokerProvider: "trading212-demo",
    etoro: {
      env: "demo",
      apiKey: "test-secret-api-key",
      userKey: "test-secret-user-key",
      testInstrument: "BTC",
      testAmount: 50,
    },
  },
}));

vi.mock("@/lib/hermes-execution/broker-factory", () => ({
  BrokerFactory: { create: createMock },
}));

// brokerProvider is deliberately set to a DIFFERENT provider — proves this command never reads it.
vi.mock("@/lib/hermes-execution/config", () => ({
  getHermesExecutionConfig: () => configState,
}));

// Isolated, unique-per-test-run directories — set BEFORE the one-and-only import of the module
// under test below, so its own top-level `SMOKE_AUDIT_LOG_PATH`/`STAGE4_EVIDENCE_DIR` consts pick
// them up. This suite's own filesystem I/O never touches the real, shared .data/hermes-execution
// directory, which several OTHER pre-existing suites (broker-factory, broker-trading212-smoke,
// broker-testnet-smoke, runtime-dependency-factory) wholesale-delete in their own afterEach hooks —
// racing against that from a concurrently-running worker is exactly what real .data/hermes-execution
// paths would risk here.
const STAGE4_EVIDENCE_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), "stage4-smoke-evidence-test-"));
const SMOKE_AUDIT_LOG_PATH = path.join(fsSync.mkdtempSync(path.join(os.tmpdir(), "smoke-audit-log-test-")), "etoro-smoke-audit-log.json");
process.env.HERMES_STAGE4_EVIDENCE_DIR_FOR_TESTS_ONLY = STAGE4_EVIDENCE_DIR;
process.env.HERMES_SMOKE_AUDIT_LOG_PATH_FOR_TESTS_ONLY = SMOKE_AUDIT_LOG_PATH;

// A dynamic `import()` here (never a static `import` declaration) is deliberate and load-bearing:
// it must execute AFTER the env vars above are set, in normal top-to-bottom module evaluation
// order — a static `import` would be hoisted above them. This is also the ONLY import of this
// module anywhere in the file, and `vi.resetModules()` is never called — both load-bearing for
// `instanceof EtoroApiError`-style checks inside broker-etoro-smoke.ts to work against the exact
// same class objects these tests construct (a second, freshly-reloaded copy of etoro-client.ts
// would silently break every such check, with the fallback branch running instead of erroring).
const { main } = await import("@/hermes-execution/broker-etoro-smoke");

interface FakePosition {
  positionId: string;
  brokerPositionId: string;
  entryPrice: number;
  quantity: number;
}

function createFakeBroker(overrides: Record<string, unknown> = {}) {
  const state: { positions: FakePosition[] } = { positions: [] };
  const base = {
    resolveInstrument: vi.fn().mockResolvedValue({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 }),
    getRate: vi.fn().mockResolvedValue({ bid: 100, ask: 101 }),
    placeMarketOrder: vi.fn().mockImplementation(async (order: { quantity: number }) => {
      const position: FakePosition = { positionId: "pos-1", brokerPositionId: "etoro-pos-1", entryPrice: 101, quantity: order.quantity };
      state.positions.push(position);
      return { position, orderId: "order-1" };
    }),
    closePosition: vi.fn().mockImplementation(async (positionId: string) => {
      state.positions = state.positions.filter((p) => p.positionId !== positionId);
      return { trade: { exitPrice: 102, realisedPnl: 1 }, orderId: "close-order-1" };
    }),
    getOpenPositions: vi.fn().mockImplementation(() => state.positions),
  };
  return { ...base, ...overrides };
}

async function readWrittenEvidence(): Promise<Record<string, unknown>> {
  const files = await fs.readdir(STAGE4_EVIDENCE_DIR);
  const jsonFiles = files.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
  expect(jsonFiles).toHaveLength(1);
  const text = await fs.readFile(path.join(STAGE4_EVIDENCE_DIR, jsonFiles[0]!), "utf-8");
  return JSON.parse(text);
}

async function listTempFiles(): Promise<string[]> {
  try {
    const files = await fs.readdir(STAGE4_EVIDENCE_DIR);
    return files.filter((f) => f.includes(".tmp"));
  } catch {
    return [];
  }
}

describe("broker-etoro-smoke", () => {
  beforeEach(async () => {
    createMock.mockReset();
    process.exitCode = undefined;
    // Guarantees a clean slate regardless of test order/position — including "the directory
    // doesn't exist yet" for the configuration-failure test, which must never see a leftover
    // (even empty) directory from this file's own mkdtempSync at import time.
    await fs.rm(STAGE4_EVIDENCE_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    process.exitCode = undefined;
    // Scoped entirely to this suite's own isolated temp directories — never the real, shared
    // .data/hermes-execution directory other suites concurrently read/write.
    await fs.rm(STAGE4_EVIDENCE_DIR, { recursive: true, force: true });
    await fs.rm(SMOKE_AUDIT_LOG_PATH, { force: true });
    configState.etoro.env = "demo"; // restore, in case the configuration-failure test flipped it.
    vi.restoreAllMocks();
  });

  it("always requests the etoro-demo provider from BrokerFactory, even though config.brokerProvider is trading212-demo", async () => {
    createMock.mockRejectedValue(new Error("stop-after-broker-factory-call"));
    await main();
    expect(createMock).toHaveBeenCalledTimes(1);
    const options = createMock.mock.calls[0]?.[3];
    expect(options).toEqual({ provider: "etoro-demo" });
  });

  it("a full successful run produces VERIFIED evidence, exit code 0, and tracks the exact broker position id throughout", async () => {
    const broker = createFakeBroker();
    createMock.mockResolvedValue(broker);
    await main();

    expect(process.exitCode).toBe(0);
    const doc = await readWrittenEvidence();
    expect(doc.finalClassification).toBe("VERIFIED");
    expect(doc.evidenceType).toBe("ETORO_STAGE4_CAPABILITY");
    const stages = doc.stages as {
      resolution: { status: string; brokerPositionId?: string };
      quote: { status: string; brokerPositionId?: string };
      openOrderSubmission: { status: string; brokerPositionId?: string };
      openPositionConfirmation: { status: string; brokerPositionId?: string };
      closeOrderSubmission: { status: string; brokerPositionId?: string };
      closedPositionConfirmation: { status: string; brokerPositionId?: string };
    };
    expect(stages.resolution.status).toBe("SUCCEEDED");
    expect(stages.quote.status).toBe("SUCCEEDED");
    expect(stages.openOrderSubmission.status).toBe("SUCCEEDED");
    expect(stages.openPositionConfirmation.status).toBe("SUCCEEDED");
    expect(stages.closeOrderSubmission.status).toBe("SUCCEEDED");
    expect(stages.closedPositionConfirmation.status).toBe("SUCCEEDED");
    // The exact broker position id is identical across every stage that captured one.
    expect(stages.openOrderSubmission.brokerPositionId).toBe("etoro-pos-1");
    expect(stages.openPositionConfirmation.brokerPositionId).toBe("etoro-pos-1");
    expect(stages.closeOrderSubmission.brokerPositionId).toBe("etoro-pos-1");
    expect(stages.closedPositionConfirmation.brokerPositionId).toBe("etoro-pos-1");
  });

  it("no live route is ever reachable, and the demo-only guard is proven in the written evidence", async () => {
    const broker = createFakeBroker();
    createMock.mockResolvedValue(broker);
    await main();
    const doc = await readWrittenEvidence();
    expect(doc.accountModeEvidence).toEqual({ configuredProvider: "etoro-demo", demoOnlyGuardPassed: true, liveRouteReachable: false });
  });

  it("resolution failure (no instrument match) -> FAILED evidence, resolution stage FAILED, exit code 2", async () => {
    const broker = createFakeBroker({ resolveInstrument: vi.fn().mockRejectedValue(new EtoroNoInstrumentMatchError("BTC")) });
    createMock.mockResolvedValue(broker);
    await main();
    expect(process.exitCode).toBe(2);
    const doc = await readWrittenEvidence();
    expect(doc.finalClassification).toBe("FAILED");
    expect((doc.stages as { resolution: { status: string } }).resolution.status).toBe("FAILED");
    expect(doc.resolvedInstrument).toBeNull();
  });

  it("resolution failure (ambiguous match) -> FAILED evidence", async () => {
    const broker = createFakeBroker({ resolveInstrument: vi.fn().mockRejectedValue(new EtoroAmbiguousInstrumentError("BTC", [])) });
    createMock.mockResolvedValue(broker);
    await main();
    const doc = await readWrittenEvidence();
    expect(doc.finalClassification).toBe("FAILED");
  });

  it("quote failure (rate unavailable) -> FAILED evidence, exit code 3", async () => {
    const broker = createFakeBroker({ getRate: vi.fn().mockRejectedValue(new EtoroRateUnavailableError(100000, "absent")) });
    createMock.mockResolvedValue(broker);
    await main();
    expect(process.exitCode).toBe(3);
    const doc = await readWrittenEvidence();
    expect(doc.finalClassification).toBe("FAILED");
    expect((doc.stages as { quote: { status: string } }).quote.status).toBe("FAILED");
    // Resolution DID succeed here — resolvedInstrument is populated even though the run overall FAILED.
    expect(doc.resolvedInstrument).not.toBeNull();
  });

  it("open submission definitive failure (EtoroApiError) -> FAILED evidence, exit code 4", async () => {
    const broker = createFakeBroker({
      placeMarketOrder: vi.fn().mockRejectedValue(new EtoroApiError("placeDemoMarketOrder", 400, "req-1", "BAD_REQUEST", "invalid amount")),
    });
    createMock.mockResolvedValue(broker);
    await main();
    expect(process.exitCode).toBe(4);
    const doc = await readWrittenEvidence();
    expect(doc.finalClassification).toBe("FAILED");
    expect((doc.stages as { openOrderSubmission: { status: string } }).openOrderSubmission.status).toBe("FAILED");
  });

  it("open submission timeout -> INDETERMINATE evidence, exit code 8", async () => {
    const broker = createFakeBroker({ placeMarketOrder: vi.fn().mockRejectedValue(new EtoroTimeoutError("placeDemoMarketOrder", 5000)) });
    createMock.mockResolvedValue(broker);
    await main();
    expect(process.exitCode).toBe(8);
    const doc = await readWrittenEvidence();
    expect(doc.finalClassification).toBe("INDETERMINATE");
    expect((doc.stages as { openOrderSubmission: { status: string } }).openOrderSubmission.status).toBe("INDETERMINATE");
  });

  it("open submission unknown/unreconciled outcome (EtoroReconciliationError) -> INDETERMINATE evidence", async () => {
    const broker = createFakeBroker({
      placeMarketOrder: vi.fn().mockRejectedValue(new EtoroReconciliationError("no-identifier", "no identifier returned")),
    });
    createMock.mockResolvedValue(broker);
    await main();
    expect(process.exitCode).toBe(8);
    const doc = await readWrittenEvidence();
    expect(doc.finalClassification).toBe("INDETERMINATE");
  });

  it("open confirmation ambiguity (position missing from the independent re-check) -> INDETERMINATE evidence, exit code 8", async () => {
    const broker = createFakeBroker({ getOpenPositions: vi.fn().mockReturnValue([]) });
    createMock.mockResolvedValue(broker);
    await main();
    expect(process.exitCode).toBe(8);
    const doc = await readWrittenEvidence();
    expect(doc.finalClassification).toBe("INDETERMINATE");
    expect((doc.stages as { openPositionConfirmation: { status: string } }).openPositionConfirmation.status).toBe("INDETERMINATE");
  });

  it("close submission definitive failure (EtoroApiError) -> FAILED evidence, exit code 6", async () => {
    const broker = createFakeBroker({
      closePosition: vi.fn().mockRejectedValue(new EtoroApiError("closeDemoPosition", 400, "req-2", "BAD_REQUEST", "cannot close")),
    });
    createMock.mockResolvedValue(broker);
    await main();
    expect(process.exitCode).toBe(6);
    const doc = await readWrittenEvidence();
    expect(doc.finalClassification).toBe("FAILED");
    expect((doc.stages as { closeOrderSubmission: { status: string } }).closeOrderSubmission.status).toBe("FAILED");
  });

  it("close submission timeout/cleanup-required -> INDETERMINATE evidence, exit code 8", async () => {
    const broker = createFakeBroker({
      closePosition: vi.fn().mockRejectedValue(new EtoroCleanupRequiredError(999, "cleanup required")),
    });
    createMock.mockResolvedValue(broker);
    await main();
    expect(process.exitCode).toBe(8);
    const doc = await readWrittenEvidence();
    expect(doc.finalClassification).toBe("INDETERMINATE");
  });

  it("final position still present after a successful-looking close -> INDETERMINATE evidence, exit code 8", async () => {
    // closePosition() "succeeds" per its own return, but the independent re-check still finds it.
    const broker = createFakeBroker();
    const originalClose = broker.closePosition;
    broker.closePosition = vi.fn().mockImplementation(async (positionId: string, ...rest: unknown[]) => {
      const result = await originalClose(positionId, ...rest);
      return result; // note: base fake ALREADY removes from state.positions — override below keeps it.
    });
    // Force the post-close re-check to still report the position open.
    const alwaysOpen = vi.fn().mockReturnValue([{ positionId: "pos-1", brokerPositionId: "etoro-pos-1", entryPrice: 101, quantity: 50 }]);
    broker.getOpenPositions = alwaysOpen;
    createMock.mockResolvedValue(broker);
    await main();
    expect(process.exitCode).toBe(8);
    const doc = await readWrittenEvidence();
    expect(doc.finalClassification).toBe("INDETERMINATE");
    expect((doc.stages as { closedPositionConfirmation: { status: string } }).closedPositionConfirmation.status).toBe("INDETERMINATE");
  });

  it("final position absent after close -> SUCCEEDED confirmation, overall VERIFIED", async () => {
    const broker = createFakeBroker();
    createMock.mockResolvedValue(broker);
    await main();
    const doc = await readWrittenEvidence();
    expect((doc.stages as { closedPositionConfirmation: { status: string } }).closedPositionConfirmation.status).toBe("SUCCEEDED");
    expect(doc.finalClassification).toBe("VERIFIED");
  });

  it("writes an evidence file on success", async () => {
    const broker = createFakeBroker();
    createMock.mockResolvedValue(broker);
    await main();
    const doc = await readWrittenEvidence();
    expect(doc.finalClassification).toBe("VERIFIED");
  });

  it("attempts (and writes) an evidence file even on a pre-mutation failure", async () => {
    const broker = createFakeBroker({ resolveInstrument: vi.fn().mockRejectedValue(new EtoroNoInstrumentMatchError("BTC")) });
    createMock.mockResolvedValue(broker);
    await main();
    const doc = await readWrittenEvidence();
    expect(doc.finalClassification).toBe("FAILED");
  });

  it("leaves no leftover .tmp files after a successful atomic write", async () => {
    const broker = createFakeBroker();
    createMock.mockResolvedValue(broker);
    await main();
    expect(await listTempFiles()).toEqual([]);
  });

  it("never overwrites an existing evidence file for the same runId, and reports the write failure honestly without hiding the broker outcome", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1234567890000);
    await fs.mkdir(STAGE4_EVIDENCE_DIR, { recursive: true });
    const existingPath = path.join(STAGE4_EVIDENCE_DIR, "smoke-etoro-1234567890000__BTC.json");
    await fs.writeFile(existingPath, JSON.stringify({ preexisting: true }), "utf-8");

    const broker = createFakeBroker();
    createMock.mockResolvedValue(broker);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await main();
    // Read calls BEFORE restoring — mockRestore() also clears recorded call history.
    const errorMessages = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();

    // Exit code reflects the evidence-write failure specifically...
    expect(process.exitCode).toBe(9);
    // ...but the console output still says the broker mutation itself completed, never hiding it.
    expect(errorMessages.some((m) => m.includes("broker operation(s) above completed as described"))).toBe(true);
    // The pre-existing file's content is untouched — never overwritten.
    const stillThere = JSON.parse(await fs.readFile(existingPath, "utf-8"));
    expect(stillThere).toEqual({ preexisting: true });
  });

  it("recursively redacts secrets from the written evidence, never persisting raw credential values", async () => {
    const broker = createFakeBroker({
      resolveInstrument: vi.fn().mockRejectedValue(new Error("boom while using test-secret-api-key and test-secret-user-key")),
    });
    createMock.mockResolvedValue(broker);
    await main();
    const raw = await fs.readFile((await fs.readdir(STAGE4_EVIDENCE_DIR).then((files) => path.join(STAGE4_EVIDENCE_DIR, files.find((f) => f.endsWith(".json"))!))), "utf-8");
    expect(raw).not.toContain("test-secret-api-key");
    expect(raw).not.toContain("test-secret-user-key");
    expect(raw).toContain("[REDACTED]");
  });

  it("configuration failure never writes Stage-4 evidence and exits with the configuration-failure code", async () => {
    configState.etoro.env = "live";
    await main();
    expect(process.exitCode).toBe(1);
    await expect(fs.readdir(STAGE4_EVIDENCE_DIR)).rejects.toThrow();
  });
});

describe("broker-etoro-smoke — never imported by the read-only probe or the catalogue", () => {
  // Mentioning "broker-etoro-smoke.ts" in a doc comment is fine and common (e.g. "see
  // broker-etoro-smoke.ts for Stage 4") — only an actual `import ... from ".../broker-etoro-smoke"`
  // statement would mean one of these read-only/filesystem-only tools could invoke Stage 4 itself.
  function hasImportOf(source: string, moduleName: string): boolean {
    return source.split("\n").some((line) => /^\s*import\b/.test(line) && line.includes(moduleName));
  }

  it("etoro-instrument-probe.ts never imports broker-etoro-smoke", async () => {
    const source = await fs.readFile("src/hermes-execution/etoro-instrument-probe.ts", "utf-8");
    expect(hasImportOf(source, "broker-etoro-smoke")).toBe(false);
  });

  it("instrument-catalogue-cli.ts and instrument-catalogue.ts never import broker-etoro-smoke", async () => {
    const cliSource = await fs.readFile("src/hermes-execution/instrument-catalogue-cli.ts", "utf-8");
    const libSource = await fs.readFile("src/lib/hermes-execution/instrument-catalogue/instrument-catalogue.ts", "utf-8");
    expect(hasImportOf(cliSource, "broker-etoro-smoke")).toBe(false);
    expect(hasImportOf(libSource, "broker-etoro-smoke")).toBe(false);
  });
});
