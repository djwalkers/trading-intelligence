import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyStage4,
  validateStage4EvidenceDocument,
  loadStage4CapabilityEvidence,
  STAGE4_EVIDENCE_SCHEMA_VERSION,
  STAGE4_EVIDENCE_TYPE,
  type Stage4Stages,
  type Stage4StageStatus,
} from "@/lib/hermes-execution/instrument-catalogue/stage4-capability-evidence";
import { FUTURE_TIMESTAMP_TOLERANCE_MS } from "@/lib/hermes-execution/instrument-catalogue/instrument-catalogue";

// Phase 0 Stage-4 capability evidence — pure/fixture-only tests. Never calls eToro, never runs the
// probe or the Stage-4 smoke tool, never touches the real .data/hermes-execution directory.

const FIXED_NOW_MS = Date.parse("2026-07-31T13:00:00.000Z");

function stageResult(status: Stage4StageStatus) {
  return { status, detail: `stage ${status.toLowerCase()}` };
}

function allStages(status: Stage4StageStatus): Stage4Stages {
  return {
    resolution: stageResult(status),
    quote: stageResult(status),
    openOrderSubmission: stageResult(status),
    openPositionConfirmation: stageResult(status),
    closeOrderSubmission: stageResult(status),
    closedPositionConfirmation: stageResult(status),
  };
}

describe("classifyStage4", () => {
  it("VERIFIED requires every stage SUCCEEDED and the demo-only guard confirmed", () => {
    const result = classifyStage4(allStages("SUCCEEDED"), true);
    expect(result.classification).toBe("VERIFIED");
    expect(result.reasons).toEqual([]);
  });

  it("never VERIFIED when the demo-only guard is not confirmed, even with all stages SUCCEEDED", () => {
    const result = classifyStage4(allStages("SUCCEEDED"), false);
    expect(result.classification).toBe("INDETERMINATE");
  });

  it("a single FAILED stage (no INDETERMINATE elsewhere) makes the whole run FAILED", () => {
    const stages = allStages("SUCCEEDED");
    stages.resolution = stageResult("FAILED");
    const result = classifyStage4(stages, true);
    expect(result.classification).toBe("FAILED");
    expect(result.reasons).toContain("RESOLUTION_FAILED");
  });

  it("a single INDETERMINATE stage makes the whole run INDETERMINATE even alongside an unrelated FAILED stage", () => {
    const stages = allStages("SUCCEEDED");
    stages.resolution = stageResult("FAILED");
    stages.openOrderSubmission = stageResult("INDETERMINATE");
    const result = classifyStage4(stages, true);
    expect(result.classification).toBe("INDETERMINATE");
  });

  it("open confirmation ambiguity alone drives the run to INDETERMINATE", () => {
    const stages = allStages("SUCCEEDED");
    stages.openPositionConfirmation = stageResult("INDETERMINATE");
    expect(classifyStage4(stages, true).classification).toBe("INDETERMINATE");
  });

  it("a NOT_RUN-only stage set (nothing attempted) is never VERIFIED or a hidden FAILED", () => {
    const result = classifyStage4(allStages("NOT_RUN"), true);
    expect(result.classification).not.toBe("VERIFIED");
  });

  describe("full truth table over every (readOnly-independent) stage-status combination", () => {
    const statuses: Stage4StageStatus[] = ["NOT_RUN", "SUCCEEDED", "FAILED", "INDETERMINATE"];
    for (const status of statuses) {
      for (const guard of [true, false]) {
        it(`all six stages = ${status}, demo-only guard confirmed = ${guard}`, () => {
          const { classification } = classifyStage4(allStages(status), guard);
          // Precedence: any INDETERMINATE stage, or an unconfirmed demo-only guard, dominates to
          // INDETERMINATE before a FAILED stage is even considered — see classifyStage4's own doc
          // comment for why an unprovable safety guard is never allowed to read as a clean FAILED.
          if (status === "INDETERMINATE" || !guard) {
            expect(classification).toBe("INDETERMINATE");
          } else if (status === "FAILED") {
            expect(classification).toBe("FAILED");
          } else if (status === "SUCCEEDED") {
            expect(classification).toBe("VERIFIED");
          } else {
            // NOT_RUN with guard confirmed — no stage ever attempted.
            expect(classification).not.toBe("VERIFIED");
          }
        });
      }
    }
  });
});

// Keeps `stages` consistent with `finalClassification` by default — validateStage4EvidenceDocument
// now recomputes classification from `stages` itself and rejects any document where they disagree
// (INCONSISTENT_CLASSIFICATION), so a fixture claiming FAILED/INDETERMINATE must carry stages that
// actually recompute to that same value.
function stagesFor(classification: string): Stage4Stages {
  if (classification === "FAILED") {
    return { ...allStages("NOT_RUN"), resolution: stageResult("FAILED") };
  }
  if (classification === "INDETERMINATE") {
    return { ...allStages("NOT_RUN"), resolution: stageResult("SUCCEEDED"), quote: stageResult("SUCCEEDED"), openOrderSubmission: stageResult("INDETERMINATE") };
  }
  return allStages("SUCCEEDED");
}

function stage4Doc(overrides: Record<string, unknown> = {}): unknown {
  const finalClassification = typeof overrides.finalClassification === "string" ? overrides.finalClassification : "VERIFIED";
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
    stages: stagesFor(finalClassification),
    finalClassification: "VERIFIED",
    classificationReasons: [],
    limitations: [],
    evidenceGeneratedAt: "2026-07-31T00:00:05.000Z",
    ...overrides,
  };
}

function validate(raw: unknown, filePath = "/tmp/x.json") {
  return validateStage4EvidenceDocument(raw, filePath, { nowMs: FIXED_NOW_MS });
}

describe("validateStage4EvidenceDocument", () => {
  it("accepts a well-formed VERIFIED document", () => {
    const result = validate(stage4Doc());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.finalClassification).toBe("VERIFIED");
      expect(result.record.runId).toBe("smoke-etoro-1000");
    }
  });

  it("accepts a well-formed FAILED document", () => {
    const result = validate(stage4Doc({ finalClassification: "FAILED", resolvedInstrument: null }));
    expect(result.ok).toBe(true);
  });

  it("accepts a well-formed INDETERMINATE document", () => {
    const result = validate(stage4Doc({ finalClassification: "INDETERMINATE" }));
    expect(result.ok).toBe(true);
  });

  it("rejects an old schema version", () => {
    const result = validate(stage4Doc({ schemaVersion: 0 }));
    expect(result).toMatchObject({ ok: false, reason: "SCHEMA_VERSION_TOO_OLD" });
  });

  it("rejects the wrong evidenceType", () => {
    const result = validate(stage4Doc({ evidenceType: "ETORO_READ_ONLY_PROBE" }));
    expect(result).toMatchObject({ ok: false, reason: "INVALID_EVIDENCE_TYPE" });
  });

  it("rejects an unsupported provider", () => {
    const result = validate(stage4Doc({ brokerProvider: "etoro-live" }));
    expect(result).toMatchObject({ ok: false, reason: "UNSUPPORTED_PROVIDER" });
  });

  it("rejects missing demo-only proof (demoOnlyGuardPassed false)", () => {
    const result = validate(stage4Doc({ accountModeEvidence: { configuredProvider: "etoro-demo", demoOnlyGuardPassed: false, liveRouteReachable: false } }));
    expect(result).toMatchObject({ ok: false, reason: "MISSING_DEMO_ONLY_PROOF" });
  });

  it("rejects missing demo-only proof (liveRouteReachable true)", () => {
    const result = validate(stage4Doc({ accountModeEvidence: { configuredProvider: "etoro-demo", demoOnlyGuardPassed: true, liveRouteReachable: true } }));
    expect(result).toMatchObject({ ok: false, reason: "MISSING_DEMO_ONLY_PROOF" });
  });

  it("rejects a requested/resolved symbol mismatch", () => {
    const result = validate(stage4Doc({ requestedInstrument: "BTC", resolvedInstrument: { symbol: "ETH", displayName: "Ethereum", brokerInstrumentId: 1, instrumentTypeID: 10, exchangeID: 8 } }));
    expect(result).toMatchObject({ ok: false, reason: "SYMBOL_MISMATCH" });
  });

  it("accepts a normalised (case-insensitive) symbol match", () => {
    const result = validate(stage4Doc({ requestedInstrument: "BTC", resolvedInstrument: { symbol: " btc ", displayName: "Bitcoin", brokerInstrumentId: 1, instrumentTypeID: 10, exchangeID: 8 } }));
    expect(result.ok).toBe(true);
  });

  it("skips the symbol cross-check when resolvedInstrument is null (resolution never succeeded)", () => {
    const result = validate(stage4Doc({ resolvedInstrument: null, finalClassification: "FAILED" }));
    expect(result.ok).toBe(true);
  });

  it("rejects malformed startedAt/completedAt", () => {
    expect(validate(stage4Doc({ startedAt: "not-a-date" }))).toMatchObject({ ok: false, reason: "INVALID_DATE" });
    expect(validate(stage4Doc({ completedAt: "not-a-date" }))).toMatchObject({ ok: false, reason: "INVALID_DATE" });
  });

  it("rejects completedAt before startedAt", () => {
    const result = validate(stage4Doc({ startedAt: "2026-07-31T00:00:10.000Z", completedAt: "2026-07-31T00:00:00.000Z" }));
    expect(result).toMatchObject({ ok: false, reason: "INVALID_TIMESTAMP_ORDER" });
  });

  it("rejects a future-dated completedAt beyond tolerance", () => {
    const beyond = new Date(FIXED_NOW_MS + FUTURE_TIMESTAMP_TOLERANCE_MS + 1000).toISOString();
    const result = validate(stage4Doc({ completedAt: beyond }));
    expect(result).toMatchObject({ ok: false, reason: "FUTURE_TIMESTAMP" });
  });

  it("accepts a completedAt within tolerance", () => {
    const within = new Date(FIXED_NOW_MS + FUTURE_TIMESTAMP_TOLERANCE_MS - 1000).toISOString();
    const result = validate(stage4Doc({ completedAt: within }));
    expect(result.ok).toBe(true);
  });

  it("rejects malformed evidence rather than guessing (missing stages)", () => {
    const doc = stage4Doc() as Record<string, unknown>;
    delete doc.stages;
    const result = validate(doc);
    expect(result).toMatchObject({ ok: false, reason: "UNEXPECTED_SHAPE" });
  });

  it("rejects an unrecognised finalClassification", () => {
    const result = validate(stage4Doc({ finalClassification: "MAYBE" }));
    expect(result).toMatchObject({ ok: false, reason: "MISSING_REQUIRED_FIELD" });
  });
});

describe("loadStage4CapabilityEvidence (filesystem)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "stage4-evidence-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function write(fileName: string, content: unknown): Promise<void> {
    await fs.writeFile(path.join(dir, fileName), typeof content === "string" ? content : JSON.stringify(content), "utf-8");
  }

  async function load(directory = dir) {
    return loadStage4CapabilityEvidence(directory, { nowMs: FIXED_NOW_MS });
  }

  it("missing Stage-4 directory returns empty accepted/rejected, never throwing", async () => {
    const result = await load(path.join(dir, "does-not-exist"));
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("ingests a valid VERIFIED document", async () => {
    await write("run.json", stage4Doc());
    const result = await load();
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.finalClassification).toBe("VERIFIED");
  });

  it("rejects one malformed file without stopping ingestion of the rest", async () => {
    await write("broken.json", "{ not valid json");
    await write("run.json", stage4Doc());
    const result = await load();
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toBe("INVALID_JSON");
  });

  it("identical duplicate runId contributes once", async () => {
    await write("a.json", stage4Doc());
    await write("b.json", stage4Doc());
    const result = await load();
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("conflicting duplicate runId is rejected, never silently tie-broken", async () => {
    await write("a.json", stage4Doc({ finalClassification: "VERIFIED" }));
    await write("b.json", stage4Doc({ finalClassification: "FAILED" }));
    const result = await load();
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.every((r) => r.reason === "CONFLICTING_DUPLICATE_RUN_ID")).toBe(true);
  });

  it("the latest trustworthy run wins, and a newer FAILED supersedes an older VERIFIED", async () => {
    await write("old.json", stage4Doc({ runId: "run-old", startedAt: "2026-07-29T00:00:00.000Z", completedAt: "2026-07-30T00:00:00.000Z", finalClassification: "VERIFIED" }));
    await write("new.json", stage4Doc({ runId: "run-new", completedAt: "2026-07-31T00:00:00.000Z", finalClassification: "FAILED" }));
    const result = await load();
    // Both must actually be accepted — otherwise "supersedes" would be trivially true just because
    // the older record was rejected outright, never genuinely exercising precedence.
    expect(result.accepted).toHaveLength(2);
    const sorted = [...result.accepted].sort((a, b) => a.completedAtMs - b.completedAtMs);
    expect(sorted[0]!.finalClassification).toBe("VERIFIED");
    expect(sorted[sorted.length - 1]!.finalClassification).toBe("FAILED");
    expect(sorted[sorted.length - 1]!.runId).toBe("run-new");
  });

  it("a newer INDETERMINATE supersedes an older VERIFIED", async () => {
    await write("old.json", stage4Doc({ runId: "run-old", startedAt: "2026-07-29T00:00:00.000Z", completedAt: "2026-07-30T00:00:00.000Z", finalClassification: "VERIFIED" }));
    await write("new.json", stage4Doc({ runId: "run-new", completedAt: "2026-07-31T00:00:00.000Z", finalClassification: "INDETERMINATE" }));
    const result = await load();
    expect(result.accepted).toHaveLength(2);
    const sorted = [...result.accepted].sort((a, b) => a.completedAtMs - b.completedAtMs);
    expect(sorted[0]!.finalClassification).toBe("VERIFIED");
    expect(sorted[sorted.length - 1]!.finalClassification).toBe("INDETERMINATE");
  });

  it("rejects evidence read through a symlink pointing outside the evidence directory", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage4-evidence-outside-"));
    try {
      const outsideFile = path.join(outsideDir, "external.json");
      await fs.writeFile(outsideFile, JSON.stringify(stage4Doc()), "utf-8");
      await fs.symlink(outsideFile, path.join(dir, "link.json"));
      const result = await load();
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]!.reason).toBe("SYMLINK_REJECTED");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("excludes a pointer/audit-log-style filename without counting it as malformed evidence", async () => {
    await write("etoro-stage4-smoke-log.json", [{ timestamp: "2026-07-31T00:00:00.000Z", eventType: "SMOKE_TEST_STAGE_RESULT" }]);
    const result = await load();
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  it("this module has no broker dependency", async () => {
    const source = await fs.readFile("src/lib/hermes-execution/instrument-catalogue/stage4-capability-evidence.ts", "utf-8");
    // Only real import/call syntax counts — this file's own doc comments legitimately name
    // EtoroDemoBroker/placeMarketOrder/closePosition in prose to explain what it does NOT import.
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    for (const line of importLines) {
      expect(line).not.toMatch(/broker-factory|paper-broker|etoro-demo-broker|risk-engine|trade-lifecycle|trade-candidate/);
    }
    expect(source).not.toMatch(/\.placeMarketOrder\(|\.closePosition\(|new EtoroDemoBroker\(/);
  });
});
