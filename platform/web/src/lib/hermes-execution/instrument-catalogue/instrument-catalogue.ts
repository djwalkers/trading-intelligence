import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";

// Phase 0 — Instrument Catalogue foundation. Ingests the read-only eToro capability probe's own
// schema-version-2 evidence documents (etoro-instrument-probe.ts) into a small, typed, queryable
// catalogue. Pure library + a separate read-only CLI (instrument-catalogue-cli.ts) — this module
// never imports a broker, never makes a network call, and is never wired into any live trading
// decision. See docs/project-status/INSTRUMENT_CATALOGUE_PHASE0.md for the full design.
//
// Deliberately duplicates (rather than imports) etoro-instrument-probe.ts's own Classification
// union below — a `src/lib` module intentionally never depends on a top-level CLI script.

/** Mirrors etoro-instrument-probe.ts's own `Classification` type exactly (the four states a
 * read-only probe run can produce; VERIFIED is Stage-4-only and never appears here). */
export type ReadOnlyCapabilityStatus = "NOT_TESTED" | "UNSUPPORTED" | "PARTIALLY_SUPPORTED" | "READ_ONLY_VERIFIED";

/** Stage 4 (broker-etoro-smoke.ts) evidence is not ingested by this first version at all — no
 * Stage-4 evidence file format/location exists yet (see this module's own top-of-file note and the
 * design doc's "known limitation"). Every catalogue entry's `stage4CapabilityStatus` is therefore
 * always NOT_TESTED today; the type exists so `effectiveCapabilityStatus` and a future Stage-4
 * loader are both already well-typed. */
export type Stage4CapabilityStatus = "NOT_TESTED" | "VERIFIED" | "FAILED";

/** Never READ_ONLY_VERIFIED-derived-VERIFIED — see computeEffectiveCapabilityStatus's own doc
 * comment for the exact precedence. */
export type EffectiveCapabilityStatus = ReadOnlyCapabilityStatus | "VERIFIED" | "FAILED";

export type AssetClass = "crypto" | "equity" | "unknown";

/** Always "unresolved" today — no eToro response (search/rates/portfolio) reports a per-instrument
 * settlement currency anywhere (confirmed by the probe's own ProbeConfiguration.currency, always
 * null). Kept as its own field/enum, not a boolean, so a future provider-confirmed source has
 * somewhere to report the difference explicitly rather than overloading `currency: null`. */
export type CurrencySource = "provider-confirmed" | "unresolved";

export type EvidenceRejectionReason =
  | "READ_ERROR"
  | "INVALID_JSON"
  | "UNEXPECTED_SHAPE"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_DATE"
  | "INVALID_TIMESTAMP_ORDER"
  | "FUTURE_TIMESTAMP"
  | "SCHEMA_VERSION_TOO_OLD"
  | "UNSUPPORTED_PROVIDER"
  | "UNSUPPORTED_ACCOUNT_MODE"
  | "SYMBOL_MISMATCH"
  | "SYMLINK_REJECTED"
  | "CONFLICTING_DUPLICATE_RUN_ID";

export interface RejectedEvidenceFile {
  filePath: string;
  reason: EvidenceRejectionReason;
  detail: string;
}

/** The minimal, validated shape this module actually trusts out of a schema-version-2 evidence
 * document — never the raw `unknown` JSON. `instrument` always comes from the DOCUMENT's own field,
 * never inferred from the filename (see loadCapabilityEvidence's own doc comment). */
export interface ValidatedEvidenceRecord {
  filePath: string;
  instrument: string;
  schemaVersion: number;
  runId: string;
  startedAt: string;
  completedAt: string;
  completedAtMs: number;
  gitCommit: string | undefined;
  appVersion: string;
  classification: ReadOnlyCapabilityStatus;
  classificationReasons: string[];
  brokerInstrumentId: number | null;
  instrumentTypeID: number | null;
  exchangeID: number | null;
  displayName: string | null;
}

export interface InstrumentCatalogueEntry {
  symbol: string;
  displayName: string | null;
  brokerProvider: "etoro-demo";
  accountMode: "demo";
  brokerInstrumentId: number | null;
  instrumentTypeID: number | null;
  exchangeID: number | null;
  assetClass: AssetClass;
  currency: string | null;
  currencySource: CurrencySource;
  configuredInUniverse: boolean;
  readOnlyCapabilityStatus: ReadOnlyCapabilityStatus;
  stage4CapabilityStatus: Stage4CapabilityStatus;
  effectiveCapabilityStatus: EffectiveCapabilityStatus;
  /** Proves ONLY membership in `config.hermesAgent.instrumentUniverse` (identical to
   * `configuredInUniverse` today) — never derived from capability evidence, and NOT a claim that
   * execution is safe, risk-approved, or broker-available. A READ_ONLY_VERIFIED (or even a
   * hypothetical VERIFIED) instrument that is not in the configured universe stays
   * `inConfiguredTradingUniverse: false`. Deliberately not named "tradingEnabled" — that name
   * previously implied execution eligibility this field never proved. */
  inConfiguredTradingUniverse: boolean;
  lastVerifiedAt: string | null;
  evidenceSchemaVersion: number | null;
  evidenceRunId: string | null;
  evidenceGitCommit: string | null;
  evidenceFile: string | null;
  classificationReasons: string[];
  limitations: string[];
  /** Every trusted evidence run found for this instrument, oldest first — requirement 7's own
   * "retain summary/history of prior states if practical." The LAST element is always the one
   * every other field above was derived from. */
  history: Array<{ completedAt: string; runId: string; classification: ReadOnlyCapabilityStatus; evidenceFile: string }>;
}

export const CATALOGUE_SCHEMA_MIN_VERSION = 2;
const ACCEPTED_BROKER_PROVIDER = "etoro-demo";
const KNOWN_CLASSIFICATIONS: readonly ReadOnlyCapabilityStatus[] = ["NOT_TESTED", "UNSUPPORTED", "PARTIALLY_SUPPORTED", "READ_ONLY_VERIFIED"];
const CRYPTO_INSTRUMENT_TYPE_ID = 10; // matches etoro-demo-broker.ts's own CRYPTO_INSTRUMENT_TYPE_ID convention.

/** Small, documented clock-skew allowance — evidence claiming to have completed further in the
 * future than this (relative to catalogue generation time) is untrustworthy (wrong clock, or
 * hand-crafted) and must never win precedence as "latest." */
export const FUTURE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/** The probe's own append-only pointer log — never evidence, excluded by name up front so it is
 * never even attempted as a document (previously relied solely on shape-validation failure,
 * which is fragile if the pointer log's shape ever changes). */
const POINTER_LOG_FILENAME = "etoro-instrument-probe-log.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Same uppercase+trim convention config.ts uses for `HERMES_INSTRUMENT_UNIVERSE` entries — the
 * one normalisation rule this module documents and applies when comparing a requested instrument
 * symbol against the broker's own resolved symbol. */
function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/** Two validated records are "identical" for duplicate-runId purposes when every field except
 * `filePath` matches exactly. Field order is stable because both are built by the same object
 * literal in `validateEvidenceDocument`. */
function recordsEqual(a: ValidatedEvidenceRecord, b: ValidatedEvidenceRecord): boolean {
  const { filePath: _a, ...restA } = a;
  const { filePath: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

/**
 * Pure. Validates one already-parsed JSON value against the minimum shape this catalogue trusts —
 * never guesses a missing/malformed field, always returns an explicit rejection reason instead
 * (requirement 9). `filePath` is used only for the returned record/rejection's own reporting field;
 * `instrument`/every other fact always comes from `document` itself, never the filename
 * (requirement 12).
 */
export function validateEvidenceDocument(
  raw: unknown,
  filePath: string,
  options: { nowMs?: number; clockSkewMs?: number } = {},
): { ok: true; record: ValidatedEvidenceRecord } | { ok: false; reason: EvidenceRejectionReason; detail: string } {
  const nowMs = options.nowMs ?? Date.now();
  const clockSkewMs = options.clockSkewMs ?? FUTURE_TIMESTAMP_TOLERANCE_MS;
  // On-disk shape is the same JSON-array-of-one-AuditEvent every JsonFileAuditTrail file uses
  // (see writeInstrumentEvidence) — `details` on that one event IS the evidence document.
  if (!Array.isArray(raw) || raw.length === 0 || !isRecord(raw[0]) || !isRecord(raw[0].details)) {
    return { ok: false, reason: "UNEXPECTED_SHAPE", detail: "expected a JSON array whose first element has an object `details` field" };
  }
  const doc = raw[0].details;

  const schemaVersion = doc.schemaVersion;
  if (typeof schemaVersion !== "number") {
    return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "schemaVersion missing or not a number" };
  }
  if (schemaVersion < CATALOGUE_SCHEMA_MIN_VERSION) {
    return { ok: false, reason: "SCHEMA_VERSION_TOO_OLD", detail: `schemaVersion ${schemaVersion} < ${CATALOGUE_SCHEMA_MIN_VERSION} — known-defective, never trusted for catalogue promotion` };
  }

  const runId = doc.runId;
  const instrument = doc.instrument;
  const startedAt = doc.startedAt;
  const completedAt = doc.completedAt;
  const appVersion = doc.appVersion;
  if (typeof runId !== "string" || runId.length === 0) return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "runId missing or not a string" };
  if (typeof instrument !== "string" || instrument.length === 0) return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "instrument missing or not a string" };
  if (typeof startedAt !== "string" || startedAt.length === 0) return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "startedAt missing or not a string" };
  if (typeof completedAt !== "string" || completedAt.length === 0) return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "completedAt missing or not a string" };
  if (typeof appVersion !== "string" || appVersion.length === 0) return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "appVersion missing or not a string" };

  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return { ok: false, reason: "INVALID_DATE", detail: `startedAt "${startedAt}" is not a parseable date` };
  }

  const completedAtMs = Date.parse(completedAt);
  if (!Number.isFinite(completedAtMs)) {
    return { ok: false, reason: "INVALID_DATE", detail: `completedAt "${completedAt}" is not a parseable date` };
  }

  if (completedAtMs < startedAtMs) {
    return { ok: false, reason: "INVALID_TIMESTAMP_ORDER", detail: `completedAt "${completedAt}" is before startedAt "${startedAt}"` };
  }

  if (completedAtMs > nowMs + clockSkewMs) {
    return {
      ok: false,
      reason: "FUTURE_TIMESTAMP",
      detail: `completedAt "${completedAt}" is more than ${clockSkewMs}ms ahead of catalogue generation time`,
    };
  }

  const classification = doc.classification;
  if (typeof classification !== "string" || !KNOWN_CLASSIFICATIONS.includes(classification as ReadOnlyCapabilityStatus)) {
    return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: `classification missing or unrecognised: ${String(classification)}` };
  }

  const classificationReasons = Array.isArray(doc.classificationReasons) ? doc.classificationReasons.filter((r): r is string => typeof r === "string") : [];

  const configuration = doc.configuration;
  const brokerProvider = isRecord(configuration) ? configuration.brokerProvider : undefined;
  if (typeof brokerProvider !== "string") {
    return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "configuration.brokerProvider missing or not a string" };
  }
  if (brokerProvider !== ACCEPTED_BROKER_PROVIDER) {
    // "etoro-demo" is the only value this adapter has ever written (no "etoro-live" provider
    // exists in this system at all) — a value starting with "etoro" but not ending in "demo" is
    // treated as an account-mode violation specifically; anything else is an unsupported provider.
    if (brokerProvider.startsWith("etoro") && !brokerProvider.endsWith("demo")) {
      return { ok: false, reason: "UNSUPPORTED_ACCOUNT_MODE", detail: `only accountMode "demo" is accepted in this phase, found broker provider "${brokerProvider}"` };
    }
    return { ok: false, reason: "UNSUPPORTED_PROVIDER", detail: `only provider "${ACCEPTED_BROKER_PROVIDER}" is accepted in this phase, found "${brokerProvider}"` };
  }

  const resolution = doc.resolution;
  if (!isRecord(resolution) || typeof resolution.kind !== "string") {
    return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "resolution missing or malformed" };
  }
  const resolved = resolution.kind === "success" && isRecord(resolution.resolved) ? resolution.resolved : undefined;

  if (resolution.kind === "success") {
    if (!resolved) {
      return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "resolution.resolved missing or malformed for a successful resolution" };
    }
    const resolvedSymbol = resolved.symbol;
    if (typeof resolvedSymbol !== "string" || resolvedSymbol.length === 0) {
      return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "resolution.resolved.symbol missing or not a string" };
    }
    if (normalizeSymbol(resolvedSymbol) !== normalizeSymbol(instrument)) {
      return {
        ok: false,
        reason: "SYMBOL_MISMATCH",
        detail: `requested instrument "${instrument}" does not match resolution.resolved.symbol "${resolvedSymbol}"`,
      };
    }
  }

  return {
    ok: true,
    record: {
      filePath,
      instrument,
      schemaVersion,
      runId,
      startedAt,
      completedAt,
      completedAtMs,
      gitCommit: typeof doc.gitCommit === "string" ? doc.gitCommit : undefined,
      appVersion,
      classification: classification as ReadOnlyCapabilityStatus,
      classificationReasons,
      brokerInstrumentId: resolved && typeof resolved.instrumentId === "number" ? resolved.instrumentId : null,
      instrumentTypeID: resolved && typeof resolved.instrumentTypeID === "number" ? resolved.instrumentTypeID : null,
      exchangeID: resolved && typeof resolved.exchangeID === "number" ? resolved.exchangeID : null,
      displayName: resolved && typeof resolved.displayName === "string" ? resolved.displayName : null,
    },
  };
}

export interface EvidenceLoadResult {
  sourceDirectory: string;
  accepted: ValidatedEvidenceRecord[];
  rejected: RejectedEvidenceFile[];
}

/**
 * The only I/O in this module — read-only (fs.readdir/fs.readFile only, never a write, never a
 * rename, never a delete), and safe when the directory is entirely absent (a fresh checkout, or an
 * environment that has simply never run the probe — treated as "zero evidence found," never a
 * crash — requirement 10's own "missing evidence means NOT_TESTED" starts here). Never reads
 * etoro-instrument-probe-log.json (the append-only pointer log) as evidence — excluded by filename
 * up front (POINTER_LOG_FILENAME), before any parse/validate attempt. Only regular `*.json` files
 * are considered; symbolic links are rejected outright (SYMLINK_REJECTED) rather than followed.
 */
export async function loadCapabilityEvidence(
  directory: string,
  options: { nowMs?: number; clockSkewMs?: number } = {},
): Promise<EvidenceLoadResult> {
  const rejected: RejectedEvidenceFile[] = [];
  const candidates: ValidatedEvidenceRecord[] = [];

  let names: string[];
  try {
    names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json") && name !== POINTER_LOG_FILENAME).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { sourceDirectory: directory, accepted: [], rejected };
    }
    rejected.push({ filePath: directory, reason: "READ_ERROR", detail: toErrorMessage(error) });
    return { sourceDirectory: directory, accepted: [], rejected };
  }

  for (const name of names) {
    const filePath = path.join(directory, name);

    // lstat (never stat) so a symlink is identified by its own entry, never by whatever it
    // resolves to — a symlink pointing outside `directory` must never be silently followed.
    let stat: Stats;
    try {
      stat = await fs.lstat(filePath);
    } catch (error) {
      rejected.push({ filePath, reason: "READ_ERROR", detail: toErrorMessage(error) });
      continue;
    }
    if (stat.isSymbolicLink()) {
      rejected.push({ filePath, reason: "SYMLINK_REJECTED", detail: "symbolic links are never trusted as evidence sources" });
      continue;
    }
    if (!stat.isFile()) {
      rejected.push({ filePath, reason: "READ_ERROR", detail: "not a regular file" });
      continue;
    }

    let text: string;
    try {
      text = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      rejected.push({ filePath, reason: "READ_ERROR", detail: toErrorMessage(error) });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      rejected.push({ filePath, reason: "INVALID_JSON", detail: toErrorMessage(error) });
      continue;
    }
    const result = validateEvidenceDocument(parsed, filePath, options);
    if (result.ok) {
      candidates.push(result.record);
    } else {
      rejected.push({ filePath, reason: result.reason, detail: result.detail });
    }
  }

  // Duplicate-runId resolution — deterministic regardless of directory enumeration order, since
  // it groups by the document's own runId, never by file position. Identical duplicates (byte-for-
  // byte equal once parsed/validated) contribute once; conflicting duplicates are rejected outright
  // rather than silently tie-broken by sort order.
  const byRunId = new Map<string, ValidatedEvidenceRecord[]>();
  for (const record of candidates) {
    const list = byRunId.get(record.runId) ?? [];
    list.push(record);
    byRunId.set(record.runId, list);
  }

  const accepted: ValidatedEvidenceRecord[] = [];
  for (const [runId, records] of byRunId) {
    if (records.length === 1) {
      accepted.push(records[0]!);
      continue;
    }
    const allIdentical = records.every((r) => recordsEqual(r, records[0]!));
    if (allIdentical) {
      const winner = [...records].sort((a, b) => a.filePath.localeCompare(b.filePath))[0]!;
      accepted.push(winner);
    } else {
      for (const r of records) {
        rejected.push({
          filePath: r.filePath,
          reason: "CONFLICTING_DUPLICATE_RUN_ID",
          detail: `runId "${runId}" appears in multiple evidence files with conflicting content`,
        });
      }
    }
  }

  return { sourceDirectory: directory, accepted, rejected };
}

function inferAssetClass(instrumentTypeID: number | null): AssetClass {
  if (instrumentTypeID === CRYPTO_INSTRUMENT_TYPE_ID) return "crypto";
  return "unknown";
}

/**
 * Never VERIFIED purely from read-only evidence (requirement: "Effective status must not become
 * VERIFIED from read-only evidence alone") — VERIFIED requires stage4 === "VERIFIED" specifically.
 * A Stage-4 FAILED result dominates (a concrete broker-execution failure is never masked by an
 * unrelated read-only pass); otherwise effective mirrors the read-only status as-is.
 */
export function computeEffectiveCapabilityStatus(readOnly: ReadOnlyCapabilityStatus, stage4: Stage4CapabilityStatus): EffectiveCapabilityStatus {
  if (stage4 === "VERIFIED") return "VERIFIED";
  if (stage4 === "FAILED") return "FAILED";
  return readOnly;
}

export interface BuildCatalogueOptions {
  /** The Phase 0 seed — deliberately a small, explicit list, never derived from
   * `config.hermesAgent.instrumentUniverse` (which may list equities with zero verified
   * evidence) — see this module's own top-of-file note and the design doc. */
  seedSymbols: readonly string[];
  /** The REAL, currently-configured universe (config.hermesAgent.instrumentUniverse) — used only
   * to compute `configuredInUniverse`/`inConfiguredTradingUniverse`, never to decide which symbols
   * get a catalogue row at all. */
  configuredUniverse: readonly string[];
  evidence: EvidenceLoadResult;
}

/**
 * Pure — given already-loaded evidence, builds one entry per seed symbol (never more, never
 * fewer: an unconfigured or unverified seed symbol still gets a row, at NOT_TESTED/not-enabled).
 * "Latest trustworthy run wins" (requirement 7/8): accepted records for one instrument are sorted
 * by (completedAtMs, runId) and the LAST one is authoritative — this is purely chronological, so a
 * newer PARTIALLY_SUPPORTED or even UNSUPPORTED run correctly supersedes an older
 * READ_ONLY_VERIFIED one (requirement 6), never the reverse.
 */
export function buildInstrumentCatalogue(options: BuildCatalogueOptions): InstrumentCatalogueEntry[] {
  const byInstrument = new Map<string, ValidatedEvidenceRecord[]>();
  for (const record of options.evidence.accepted) {
    const list = byInstrument.get(record.instrument) ?? [];
    list.push(record);
    byInstrument.set(record.instrument, list);
  }
  for (const list of byInstrument.values()) {
    list.sort((a, b) => a.completedAtMs - b.completedAtMs || a.runId.localeCompare(b.runId));
  }

  return options.seedSymbols.map((symbol) => {
    const records = byInstrument.get(symbol) ?? [];
    const current = records[records.length - 1];
    const configuredInUniverse = options.configuredUniverse.includes(symbol);
    const readOnlyCapabilityStatus: ReadOnlyCapabilityStatus = current?.classification ?? "NOT_TESTED";
    const stage4CapabilityStatus: Stage4CapabilityStatus = "NOT_TESTED"; // no Stage-4 evidence source ingested in this phase.
    const effectiveCapabilityStatus = computeEffectiveCapabilityStatus(readOnlyCapabilityStatus, stage4CapabilityStatus);

    const limitations: string[] = ["Stage 4 (broker execution) not yet verified — capability is read-only-only."];
    if (current?.instrumentTypeID == null) limitations.push("assetClass unresolved — no confirmed instrumentTypeID from evidence.");

    return {
      symbol,
      displayName: current?.displayName ?? null,
      brokerProvider: "etoro-demo",
      accountMode: "demo",
      brokerInstrumentId: current?.brokerInstrumentId ?? null,
      instrumentTypeID: current?.instrumentTypeID ?? null,
      exchangeID: current?.exchangeID ?? null,
      assetClass: inferAssetClass(current?.instrumentTypeID ?? null),
      currency: null,
      currencySource: "unresolved",
      configuredInUniverse,
      readOnlyCapabilityStatus,
      stage4CapabilityStatus,
      effectiveCapabilityStatus,
      inConfiguredTradingUniverse: configuredInUniverse,
      lastVerifiedAt: current?.completedAt ?? null,
      evidenceSchemaVersion: current?.schemaVersion ?? null,
      evidenceRunId: current?.runId ?? null,
      evidenceGitCommit: current?.gitCommit ?? null,
      evidenceFile: current?.filePath ?? null,
      classificationReasons: current?.classificationReasons ?? [],
      limitations,
      history: records.map((r) => ({ completedAt: r.completedAt, runId: r.runId, classification: r.classification, evidenceFile: r.filePath })),
    };
  });
}
