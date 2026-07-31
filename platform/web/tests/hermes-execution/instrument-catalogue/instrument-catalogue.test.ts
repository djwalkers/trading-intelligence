import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  validateEvidenceDocument,
  loadCapabilityEvidence,
  buildInstrumentCatalogue,
  computeEffectiveCapabilityStatus,
  FUTURE_TIMESTAMP_TOLERANCE_MS,
  type ValidatedEvidenceRecord,
} from "@/lib/hermes-execution/instrument-catalogue/instrument-catalogue";

// Phase 0 instrument catalogue — pure/fixture-only tests. Never calls eToro, never runs the probe,
// never touches the real .data/hermes-execution directory (a fresh, isolated temp directory is used
// for every filesystem-touching test, and removed afterwards).

// After every completedAt used anywhere in this file (including the "newer supersedes older"
// fixture at noon on 2026-07-31), so no existing fixture is accidentally treated as future-dated.
const FIXED_NOW_MS = Date.parse("2026-07-31T13:00:00.000Z");

// `overrides.instrument` (when given) also re-points `resolution.resolved.symbol` to match, since
// the two must agree by default — tests that want a mismatch pass `resolvedSymbol` explicitly.
function evidenceDoc(overrides: Record<string, unknown> & { resolvedSymbol?: string } = {}): unknown {
  const { resolvedSymbol, ...rest } = overrides;
  const instrument = typeof rest.instrument === "string" ? rest.instrument : "BTC";
  const symbol = resolvedSymbol ?? instrument;
  return [
    {
      timestamp: "2026-07-31T00:00:00.000Z",
      eventType: "INSTRUMENT_PROBE_CLASSIFIED",
      executionRunId: "probe-etoro-1000",
      instrument: "BTC",
      details: {
        schemaVersion: 2,
        runId: "probe-etoro-1000",
        instrument: "BTC",
        startedAt: "2026-07-31T00:00:00.000Z",
        completedAt: "2026-07-31T00:00:01.000Z",
        gitCommit: "abc123",
        appVersion: "1.13.0",
        configuration: { brokerProvider: "etoro-demo" },
        resolution: { kind: "success", resolved: { instrumentId: 100000, displayName: "Bitcoin", symbol, instrumentTypeID: 10, exchangeID: 8 } },
        classification: "READ_ONLY_VERIFIED",
        classificationReasons: [],
        ...rest,
      },
    },
  ];
}

function validate(raw: unknown, filePath = "/tmp/x.json") {
  return validateEvidenceDocument(raw, filePath, { nowMs: FIXED_NOW_MS });
}

describe("validateEvidenceDocument", () => {
  it("accepts a well-formed schema-version-2 BTC document", () => {
    const result = validate(evidenceDoc());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.instrument).toBe("BTC");
      expect(result.record.classification).toBe("READ_ONLY_VERIFIED");
      expect(result.record.brokerInstrumentId).toBe(100000);
      expect(result.record.instrumentTypeID).toBe(10);
      expect(result.record.exchangeID).toBe(8);
      expect(result.record.displayName).toBe("Bitcoin");
      expect(result.record.appVersion).toBe("1.13.0");
      expect(result.record.startedAt).toBe("2026-07-31T00:00:00.000Z");
    }
  });

  it("rejects schemaVersion 1 as SCHEMA_VERSION_TOO_OLD", () => {
    const result = validate(evidenceDoc({ schemaVersion: 1 }));
    expect(result).toMatchObject({ ok: false, reason: "SCHEMA_VERSION_TOO_OLD" });
  });

  it("rejects an unsupported provider", () => {
    const result = validate(evidenceDoc({ configuration: { brokerProvider: "trading212-demo" } }));
    expect(result).toMatchObject({ ok: false, reason: "UNSUPPORTED_PROVIDER" });
  });

  it("rejects a non-demo account mode", () => {
    const result = validate(evidenceDoc({ configuration: { brokerProvider: "etoro-live" } }));
    expect(result).toMatchObject({ ok: false, reason: "UNSUPPORTED_ACCOUNT_MODE" });
  });

  it("rejects malformed JSON shape (not an array)", () => {
    const result = validate({ not: "an array" });
    expect(result).toMatchObject({ ok: false, reason: "UNEXPECTED_SHAPE" });
  });

  it("rejects a document missing required fields", () => {
    const doc = evidenceDoc();
    delete (doc as Array<{ details: Record<string, unknown> }>)[0]!.details.runId;
    const result = validate(doc);
    expect(result).toMatchObject({ ok: false, reason: "MISSING_REQUIRED_FIELD" });
  });

  it("rejects an invalid completedAt date", () => {
    const result = validate(evidenceDoc({ completedAt: "not-a-date" }));
    expect(result).toMatchObject({ ok: false, reason: "INVALID_DATE" });
  });

  it("never trusts the filename over the document's own `instrument` field", () => {
    const result = validateEvidenceDocument(evidenceDoc(), "/some/path/probe-etoro-999__NOTBTC.json", { nowMs: FIXED_NOW_MS });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.instrument).toBe("BTC");
  });

  describe("requested/resolved symbol match (SYMBOL_MISMATCH)", () => {
    it("accepts an exact symbol match", () => {
      const result = validate(evidenceDoc({ instrument: "BTC", resolvedSymbol: "BTC" }));
      expect(result.ok).toBe(true);
    });

    it("accepts a normalised (case-insensitive, trimmed) match — the one documented normalisation rule", () => {
      const result = validate(evidenceDoc({ instrument: "BTC", resolvedSymbol: " btc " }));
      expect(result.ok).toBe(true);
    });

    it("rejects requested BTC resolving to ETH", () => {
      const result = validate(evidenceDoc({ instrument: "BTC", resolvedSymbol: "ETH" }));
      expect(result).toMatchObject({ ok: false, reason: "SYMBOL_MISMATCH" });
    });

    it("rejects requested SOL resolving to BTC", () => {
      const result = validate(evidenceDoc({ instrument: "SOL", resolvedSymbol: "BTC" }));
      expect(result).toMatchObject({ ok: false, reason: "SYMBOL_MISMATCH" });
    });

    it("rejects a successful resolution missing resolved.symbol entirely", () => {
      const doc = evidenceDoc();
      delete (doc as Array<{ details: { resolution: { resolved: Record<string, unknown> } } }>)[0]!.details.resolution.resolved.symbol;
      const result = validate(doc);
      expect(result).toMatchObject({ ok: false, reason: "MISSING_REQUIRED_FIELD" });
    });
  });

  describe("startedAt / temporal ordering", () => {
    it("rejects an invalid startedAt", () => {
      const result = validate(evidenceDoc({ startedAt: "not-a-date" }));
      expect(result).toMatchObject({ ok: false, reason: "INVALID_DATE" });
    });

    it("rejects completedAt before startedAt", () => {
      const result = validate(evidenceDoc({ startedAt: "2026-07-31T00:05:00.000Z", completedAt: "2026-07-31T00:00:00.000Z" }));
      expect(result).toMatchObject({ ok: false, reason: "INVALID_TIMESTAMP_ORDER" });
    });

    it("accepts equal startedAt/completedAt timestamps", () => {
      const result = validate(evidenceDoc({ startedAt: "2026-07-31T00:00:00.000Z", completedAt: "2026-07-31T00:00:00.000Z" }));
      expect(result.ok).toBe(true);
    });

    it("accepts valid chronological ordering (completedAt after startedAt)", () => {
      const result = validate(evidenceDoc({ startedAt: "2026-07-31T00:00:00.000Z", completedAt: "2026-07-31T00:05:00.000Z" }));
      expect(result.ok).toBe(true);
    });
  });

  describe("appVersion", () => {
    it("rejects a missing appVersion", () => {
      const doc = evidenceDoc();
      delete (doc as Array<{ details: Record<string, unknown> }>)[0]!.details.appVersion;
      const result = validate(doc);
      expect(result).toMatchObject({ ok: false, reason: "MISSING_REQUIRED_FIELD" });
    });

    it("rejects an empty appVersion", () => {
      const result = validate(evidenceDoc({ appVersion: "" }));
      expect(result).toMatchObject({ ok: false, reason: "MISSING_REQUIRED_FIELD" });
    });

    it("accepts a valid appVersion", () => {
      const result = validate(evidenceDoc({ appVersion: "2.0.0" }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.record.appVersion).toBe("2.0.0");
    });
  });

  describe("future-timestamp guard", () => {
    it("accepts a completedAt exactly at current time", () => {
      const result = validate(evidenceDoc({ completedAt: new Date(FIXED_NOW_MS).toISOString() }));
      expect(result.ok).toBe(true);
    });

    it("accepts a completedAt within the allowed clock-skew tolerance", () => {
      const withinSkew = new Date(FIXED_NOW_MS + FUTURE_TIMESTAMP_TOLERANCE_MS - 1000).toISOString();
      const result = validate(evidenceDoc({ completedAt: withinSkew }));
      expect(result.ok).toBe(true);
    });

    it("rejects a completedAt just beyond the allowed clock-skew tolerance", () => {
      const beyondSkew = new Date(FIXED_NOW_MS + FUTURE_TIMESTAMP_TOLERANCE_MS + 1000).toISOString();
      const result = validate(evidenceDoc({ completedAt: beyondSkew }));
      expect(result).toMatchObject({ ok: false, reason: "FUTURE_TIMESTAMP" });
    });

    it("rejects far-future evidence outright", () => {
      const result = validate(evidenceDoc({ completedAt: "2099-01-01T00:00:00.000Z" }));
      expect(result).toMatchObject({ ok: false, reason: "FUTURE_TIMESTAMP" });
    });
  });
});

describe("computeEffectiveCapabilityStatus", () => {
  it("never becomes VERIFIED from read-only evidence alone", () => {
    expect(computeEffectiveCapabilityStatus("READ_ONLY_VERIFIED", "NOT_TESTED")).toBe("READ_ONLY_VERIFIED");
  });

  it("becomes VERIFIED only when stage4 is VERIFIED", () => {
    expect(computeEffectiveCapabilityStatus("READ_ONLY_VERIFIED", "VERIFIED")).toBe("VERIFIED");
  });

  it("a Stage-4 FAILED dominates a read-only pass", () => {
    expect(computeEffectiveCapabilityStatus("READ_ONLY_VERIFIED", "FAILED")).toBe("FAILED");
  });
});

describe("loadCapabilityEvidence + buildInstrumentCatalogue (filesystem)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "instrument-catalogue-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeEvidence(fileName: string, content: unknown): Promise<void> {
    await fs.writeFile(path.join(dir, fileName), typeof content === "string" ? content : JSON.stringify(content), "utf-8");
  }

  async function load(directory = dir) {
    return loadCapabilityEvidence(directory, { nowMs: FIXED_NOW_MS });
  }

  it("returns empty accepted/rejected when the directory does not exist, never throwing", async () => {
    const result = await load(path.join(dir, "does-not-exist"));
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("ingests BTC/ETH/SOL schema-version-2 evidence and produces READ_ONLY_VERIFIED rows", async () => {
    await writeEvidence("btc.json", evidenceDoc());
    await writeEvidence("eth.json", evidenceDoc({ instrument: "ETH", runId: "probe-etoro-1001" }));
    await writeEvidence("sol.json", evidenceDoc({ instrument: "SOL", runId: "probe-etoro-1002" }));

    const evidence = await load();
    expect(evidence.accepted).toHaveLength(3);
    expect(evidence.rejected).toHaveLength(0);

    const entries = buildInstrumentCatalogue({ seedSymbols: ["BTC", "ETH", "SOL"], configuredUniverse: ["BTC", "ETH", "SOL"], evidence });
    expect(entries.map((e) => e.readOnlyCapabilityStatus)).toEqual(["READ_ONLY_VERIFIED", "READ_ONLY_VERIFIED", "READ_ONLY_VERIFIED"]);
    expect(entries.every((e) => e.effectiveCapabilityStatus === "READ_ONLY_VERIFIED")).toBe(true);
    expect(entries.every((e) => e.stage4CapabilityStatus === "NOT_TESTED")).toBe(true);
    expect(entries.every((e) => e.inConfiguredTradingUniverse)).toBe(true);
  });

  it("rejects a malformed JSON file and reports it, continuing to ingest the rest", async () => {
    await writeEvidence("broken.json", "{ not valid json");
    await writeEvidence("btc.json", evidenceDoc());

    const evidence = await load();
    expect(evidence.accepted).toHaveLength(1);
    expect(evidence.rejected).toHaveLength(1);
    expect(evidence.rejected[0]!.reason).toBe("INVALID_JSON");
  });

  it("rejects a document whose requested instrument doesn't match its resolved symbol, without populating any row from it", async () => {
    await writeEvidence("btc-claims-eth.json", evidenceDoc({ instrument: "BTC", resolvedSymbol: "ETH" }));

    const evidence = await load();
    expect(evidence.accepted).toHaveLength(0);
    expect(evidence.rejected).toHaveLength(1);
    expect(evidence.rejected[0]!.reason).toBe("SYMBOL_MISMATCH");

    const entries = buildInstrumentCatalogue({ seedSymbols: ["BTC", "ETH"], configuredUniverse: ["BTC", "ETH"], evidence });
    expect(entries.every((e) => e.readOnlyCapabilityStatus === "NOT_TESTED")).toBe(true);
    expect(entries.every((e) => e.history.length === 0)).toBe(true);
  });

  it("rejects duplicate/multiple evidence files for the same instrument only when malformed — otherwise both are accepted and precedence is resolved by buildInstrumentCatalogue", async () => {
    await writeEvidence("run1.json", evidenceDoc({ runId: "probe-etoro-1", startedAt: "2026-07-29T00:00:00.000Z", completedAt: "2026-07-30T00:00:00.000Z", classification: "READ_ONLY_VERIFIED" }));
    await writeEvidence("run2.json", evidenceDoc({ runId: "probe-etoro-2", completedAt: "2026-07-31T00:00:00.000Z", classification: "PARTIALLY_SUPPORTED" }));

    const evidence = await load();
    expect(evidence.accepted).toHaveLength(2);

    const entries = buildInstrumentCatalogue({ seedSymbols: ["BTC"], configuredUniverse: ["BTC"], evidence });
    expect(entries[0]!.readOnlyCapabilityStatus).toBe("PARTIALLY_SUPPORTED");
    expect(entries[0]!.evidenceRunId).toBe("probe-etoro-2");
    expect(entries[0]!.history).toHaveLength(2);
  });

  it("a newer trustworthy run supersedes an older one regardless of file iteration/name order", async () => {
    // Filenames deliberately sort in the OPPOSITE order of completedAt, to prove ordering is
    // driven by the document's own completedAt, never alphabetical filename order.
    await writeEvidence("a-newer.json", evidenceDoc({ runId: "probe-etoro-newer", completedAt: "2026-07-31T12:00:00.000Z", classification: "PARTIALLY_SUPPORTED" }));
    await writeEvidence("z-older.json", evidenceDoc({ runId: "probe-etoro-older", startedAt: "2026-07-29T00:00:00.000Z", completedAt: "2026-07-30T12:00:00.000Z", classification: "READ_ONLY_VERIFIED" }));

    const evidence = await load();
    const entries = buildInstrumentCatalogue({ seedSymbols: ["BTC"], configuredUniverse: ["BTC"], evidence });
    expect(entries[0]!.readOnlyCapabilityStatus).toBe("PARTIALLY_SUPPORTED");
    expect(entries[0]!.evidenceRunId).toBe("probe-etoro-newer");
  });

  it("far-future evidence is rejected and can never become the latest/current run", async () => {
    await writeEvidence("legit.json", evidenceDoc({ runId: "probe-etoro-legit", completedAt: "2026-07-31T00:00:01.000Z", classification: "READ_ONLY_VERIFIED" }));
    await writeEvidence("faked-future.json", evidenceDoc({ runId: "probe-etoro-faked", completedAt: "2099-01-01T00:00:00.000Z", classification: "UNSUPPORTED" }));

    const evidence = await load();
    expect(evidence.rejected.some((r) => r.reason === "FUTURE_TIMESTAMP")).toBe(true);

    const entries = buildInstrumentCatalogue({ seedSymbols: ["BTC"], configuredUniverse: ["BTC"], evidence });
    expect(entries[0]!.readOnlyCapabilityStatus).toBe("READ_ONLY_VERIFIED");
    expect(entries[0]!.evidenceRunId).toBe("probe-etoro-legit");
  });

  it("missing evidence for a seed symbol produces NOT_TESTED, never a crash or a guess", async () => {
    const evidence = await load(); // empty directory
    const entries = buildInstrumentCatalogue({ seedSymbols: ["BTC", "ETH", "SOL"], configuredUniverse: ["BTC", "ETH", "SOL"], evidence });
    expect(entries.map((e) => e.readOnlyCapabilityStatus)).toEqual(["NOT_TESTED", "NOT_TESTED", "NOT_TESTED"]);
    expect(entries.every((e) => e.effectiveCapabilityStatus === "NOT_TESTED")).toBe(true);
    expect(entries.every((e) => e.evidenceFile === null)).toBe(true);
  });

  it("currency stays null/unresolved when the evidence never confirms one", async () => {
    await writeEvidence("btc.json", evidenceDoc());
    const evidence = await load();
    const entries = buildInstrumentCatalogue({ seedSymbols: ["BTC"], configuredUniverse: ["BTC"], evidence });
    expect(entries[0]!.currency).toBeNull();
    expect(entries[0]!.currencySource).toBe("unresolved");
  });

  it("configured-universe membership is independent of capability evidence", async () => {
    // BTC has READ_ONLY_VERIFIED evidence but is NOT in the configured universe.
    await writeEvidence("btc.json", evidenceDoc());
    const evidence = await load();
    const entries = buildInstrumentCatalogue({ seedSymbols: ["BTC"], configuredUniverse: [], evidence });
    expect(entries[0]!.readOnlyCapabilityStatus).toBe("READ_ONLY_VERIFIED");
    expect(entries[0]!.configuredInUniverse).toBe(false);
  });

  it("READ_ONLY_VERIFIED evidence never auto-enables an instrument that isn't configured", async () => {
    await writeEvidence("btc.json", evidenceDoc());
    const evidence = await load();
    const entries = buildInstrumentCatalogue({ seedSymbols: ["BTC"], configuredUniverse: [], evidence });
    expect(entries[0]!.inConfiguredTradingUniverse).toBe(false);
  });

  it("never infers a Stage-4 VERIFIED state from read-only evidence, no matter how clean", async () => {
    await writeEvidence("btc.json", evidenceDoc());
    const evidence = await load();
    const entries = buildInstrumentCatalogue({ seedSymbols: ["BTC"], configuredUniverse: ["BTC"], evidence });
    expect(entries[0]!.stage4CapabilityStatus).toBe("NOT_TESTED");
    expect(entries[0]!.effectiveCapabilityStatus).not.toBe("VERIFIED");
  });

  it("produces deterministic output across repeated runs against the same evidence", async () => {
    await writeEvidence("btc.json", evidenceDoc());
    await writeEvidence("eth.json", evidenceDoc({ instrument: "ETH", runId: "probe-etoro-1001" }));

    const first = buildInstrumentCatalogue({ seedSymbols: ["BTC", "ETH", "SOL"], configuredUniverse: ["BTC", "ETH", "SOL"], evidence: await load() });
    const second = buildInstrumentCatalogue({ seedSymbols: ["BTC", "ETH", "SOL"], configuredUniverse: ["BTC", "ETH", "SOL"], evidence: await load() });
    expect(first).toEqual(second);
  });

  it("never mutates or deletes an evidence file on disk", async () => {
    await writeEvidence("btc.json", evidenceDoc());
    const before = await fs.readFile(path.join(dir, "btc.json"), "utf-8");
    await load();
    const after = await fs.readFile(path.join(dir, "btc.json"), "utf-8");
    expect(after).toBe(before);
  });

  it("explicitly excludes the append-only pointer log by filename, without counting it as malformed evidence", async () => {
    // The pointer log's shape (multiple stage-result events, no top-level `classification`) would
    // also fail shape validation, but exclusion must not depend on that — it is skipped by name
    // before any parse/validate attempt, so it never inflates the rejected count either.
    await writeEvidence(
      "etoro-instrument-probe-log.json",
      [{ timestamp: "2026-07-31T00:00:00.000Z", eventType: "INSTRUMENT_PROBE_STAGE_RESULT", executionRunId: "x", instrument: "BTC", details: { stage: "resolution" } }],
    );
    const evidence = await load();
    expect(evidence.accepted).toHaveLength(0);
    expect(evidence.rejected).toHaveLength(0);
  });

  it("rejects evidence read through a symlink pointing outside the evidence directory", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "instrument-catalogue-outside-"));
    try {
      const outsideFile = path.join(outsideDir, "external.json");
      await fs.writeFile(outsideFile, JSON.stringify(evidenceDoc()), "utf-8");
      await fs.symlink(outsideFile, path.join(dir, "link.json"));

      const evidence = await load();
      expect(evidence.accepted).toHaveLength(0);
      expect(evidence.rejected).toHaveLength(1);
      expect(evidence.rejected[0]!.reason).toBe("SYMLINK_REJECTED");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  describe("duplicate runId handling", () => {
    it("contributes an identical duplicate runId only once", async () => {
      await writeEvidence("a.json", evidenceDoc({ runId: "probe-etoro-dup" }));
      await writeEvidence("b.json", evidenceDoc({ runId: "probe-etoro-dup" }));

      const evidence = await load();
      expect(evidence.accepted).toHaveLength(1);
      expect(evidence.rejected).toHaveLength(0);

      const entries = buildInstrumentCatalogue({ seedSymbols: ["BTC"], configuredUniverse: ["BTC"], evidence });
      expect(entries[0]!.history).toHaveLength(1);
    });

    it("rejects conflicting duplicate runIds rather than silently tie-breaking them", async () => {
      await writeEvidence("a.json", evidenceDoc({ runId: "probe-etoro-conflict", classification: "READ_ONLY_VERIFIED" }));
      await writeEvidence("b.json", evidenceDoc({ runId: "probe-etoro-conflict", classification: "UNSUPPORTED" }));

      const evidence = await load();
      expect(evidence.accepted).toHaveLength(0);
      expect(evidence.rejected).toHaveLength(2);
      expect(evidence.rejected.every((r) => r.reason === "CONFLICTING_DUPLICATE_RUN_ID")).toBe(true);

      const entries = buildInstrumentCatalogue({ seedSymbols: ["BTC"], configuredUniverse: ["BTC"], evidence });
      expect(entries[0]!.readOnlyCapabilityStatus).toBe("NOT_TESTED");
      expect(entries[0]!.history).toHaveLength(0);
    });

    it("same completedAt with different runIds still resolves deterministically", async () => {
      await writeEvidence("a.json", evidenceDoc({ runId: "probe-etoro-a", completedAt: "2026-07-31T00:00:01.000Z", classification: "READ_ONLY_VERIFIED" }));
      await writeEvidence("b.json", evidenceDoc({ runId: "probe-etoro-b", completedAt: "2026-07-31T00:00:01.000Z", classification: "PARTIALLY_SUPPORTED" }));

      const first = buildInstrumentCatalogue({ seedSymbols: ["BTC"], configuredUniverse: ["BTC"], evidence: await load() });
      const second = buildInstrumentCatalogue({ seedSymbols: ["BTC"], configuredUniverse: ["BTC"], evidence: await load() });
      expect(first).toEqual(second);
      // runId "probe-etoro-b" sorts after "probe-etoro-a" — deterministic tie-break, not file order.
      expect(first[0]!.evidenceRunId).toBe("probe-etoro-b");
    });
  });
});
