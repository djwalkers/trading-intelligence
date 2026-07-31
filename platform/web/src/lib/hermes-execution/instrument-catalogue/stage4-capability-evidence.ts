import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import { FUTURE_TIMESTAMP_TOLERANCE_MS, normalizeSymbol } from "./instrument-catalogue";

// Phase 0 — Stage-4 (broker-mutation) capability evidence. A formal, durable contract for
// broker-etoro-smoke.ts's own resolve -> quote -> open -> confirm -> close -> confirm workflow,
// deliberately never reused from the read-only probe's evidence shape (schemaVersion here is its
// own, independent counter — see STAGE4_EVIDENCE_SCHEMA_VERSION). This module is pure and
// filesystem-only: it NEVER imports EtoroDemoBroker, placeMarketOrder/closePosition, execution/
// approval/lifecycle/risk services, or any trading-runtime module — Stage 4 mutation access stays
// exclusively inside broker-etoro-smoke.ts, the only file this module's own consumers (the
// catalogue, this file itself) ever trust to have actually run it.
//
// `Stage4EvidenceDocument` is shared, by design, between the writer (broker-etoro-smoke.ts) and the
// reader (validateStage4EvidenceDocument/loadStage4CapabilityEvidence below) — one canonical field
// contract, so the two can never silently drift on field names/shape. The reader still never trusts
// that a parsed file actually matches this type just because it claims to — every field is
// re-validated from `unknown` on every load (defence in depth against a corrupted or hand-edited
// file, exactly like the read-only loader).

export const STAGE4_EVIDENCE_SCHEMA_VERSION = 1;
export const STAGE4_EVIDENCE_TYPE = "ETORO_STAGE4_CAPABILITY";
const ACCEPTED_STAGE4_BROKER_PROVIDER = "etoro-demo";
const STAGE4_POINTER_LOG_FILENAME = "etoro-stage4-smoke-log.json";

export type Stage4StageStatus = "NOT_RUN" | "SUCCEEDED" | "FAILED" | "INDETERMINATE";

/** Every stage records the same minimal, safe shape — never a raw provider payload (see each
 * concrete stage's own optional fields below for the only additional facts ever captured). */
export interface Stage4StageResult {
  status: Stage4StageStatus;
  /** Safe, human-readable, already-redacted — never a raw error object or provider payload. */
  detail: string;
  elapsedMs?: number;
  /** Bounded retry count, when this stage's own operation was retried at least once. */
  attempts?: number;
}

export interface Stage4ResolutionStageResult extends Stage4StageResult {
  brokerInstrumentId?: number;
}

export interface Stage4QuoteStageResult extends Stage4StageResult {
  bid?: number;
  ask?: number;
}

export interface Stage4OpenOrderSubmissionStageResult extends Stage4StageResult {
  requestedNotional?: number;
  brokerOrderId?: string;
  brokerPositionId?: string;
}

export interface Stage4OpenPositionConfirmationStageResult extends Stage4StageResult {
  brokerPositionId?: string;
  entryPrice?: number;
  confirmedAt?: string;
}

export interface Stage4CloseOrderSubmissionStageResult extends Stage4StageResult {
  brokerPositionId?: string;
  brokerCloseOrderId?: string;
}

export interface Stage4ClosedPositionConfirmationStageResult extends Stage4StageResult {
  brokerPositionId?: string;
  confirmedAt?: string;
}

export interface Stage4Stages {
  resolution: Stage4ResolutionStageResult;
  quote: Stage4QuoteStageResult;
  openOrderSubmission: Stage4OpenOrderSubmissionStageResult;
  openPositionConfirmation: Stage4OpenPositionConfirmationStageResult;
  closeOrderSubmission: Stage4CloseOrderSubmissionStageResult;
  closedPositionConfirmation: Stage4ClosedPositionConfirmationStageResult;
}

/** Proves the run was demo-only using only facts actually available from the existing
 * smoke/config/broker path — this schema deliberately does NOT carry a broker-confirmed
 * "accountMode" field, because no eToro response (search/rates/portfolio/order) returns one (same
 * limitation documented for the read-only probe). `configuredProvider`/`demoOnlyGuardPassed` come
 * from this process's own pre-flight config check (checkEtoroDemoConfig); `liveRouteReachable` is
 * always `false` because no eToro CLI tool in this codebase ever constructs a live-route client. */
export interface Stage4AccountModeEvidence {
  configuredProvider: "etoro-demo";
  demoOnlyGuardPassed: boolean;
  liveRouteReachable: false;
}

export interface Stage4ResolvedInstrumentInfo {
  symbol: string;
  displayName: string;
  brokerInstrumentId: number;
  instrumentTypeID: number | null;
  exchangeID: number | null;
}

export type Stage4FinalClassification = "VERIFIED" | "FAILED" | "INDETERMINATE";

export interface Stage4EvidenceDocument {
  schemaVersion: number;
  evidenceType: string;
  runId: string;
  startedAt: string;
  completedAt: string;
  gitCommit: string | undefined;
  appVersion: string;
  brokerProvider: string;
  requestedInstrument: string;
  /** Only non-null once the resolution stage SUCCEEDED — never guessed/backfilled otherwise. */
  resolvedInstrument: Stage4ResolvedInstrumentInfo | null;
  accountModeEvidence: Stage4AccountModeEvidence;
  stages: Stage4Stages;
  finalClassification: Stage4FinalClassification;
  classificationReasons: string[];
  limitations: string[];
  evidenceGeneratedAt: string;
}

/**
 * Pure. Derives `finalClassification` from the six stage outcomes plus whether the demo-only guard
 * was actually confirmed — the ONLY place this decision is made, so both the writer (which persists
 * the result) and every test exercising this rule set call the exact same function.
 *
 * VERIFIED requires ALL of: demo-only guard confirmed, and every one of the six stages SUCCEEDED
 * (see Stage4Stages) — never inferred from a subset.
 *
 * An INDETERMINATE stage dominates everything else: once any stage's own outcome is unknown (an
 * open/close submission that timed out or couldn't be reconciled to a single position, a
 * confirmation step that found an ambiguous or missing result), the overall run is INDETERMINATE
 * even if another stage independently FAILED outright — an unresolved ambiguity about whether
 * broker state changed is never allowed to be papered over by a clean-looking FAILED elsewhere.
 *
 * Absent any INDETERMINATE stage, a definitive FAILED stage makes the run FAILED. A run only
 * reaches here with neither INDETERMINATE nor FAILED among the six, but with `accountModeConfirmed
 * === false`, if the demo-only guard itself couldn't be confirmed — safety cannot be proven, so this
 * is treated as INDETERMINATE too, never silently upgraded to VERIFIED.
 */
export function classifyStage4(
  stages: Stage4Stages,
  accountModeConfirmed: boolean,
): { classification: Stage4FinalClassification; reasons: string[] } {
  const orderedStageEntries: Array<[string, Stage4StageStatus]> = [
    ["RESOLUTION", stages.resolution.status],
    ["QUOTE", stages.quote.status],
    ["OPEN_ORDER_SUBMISSION", stages.openOrderSubmission.status],
    ["OPEN_POSITION_CONFIRMATION", stages.openPositionConfirmation.status],
    ["CLOSE_ORDER_SUBMISSION", stages.closeOrderSubmission.status],
    ["CLOSED_POSITION_CONFIRMATION", stages.closedPositionConfirmation.status],
  ];

  const reasons: string[] = [];
  if (!accountModeConfirmed) reasons.push("DEMO_ONLY_GUARD_NOT_CONFIRMED");
  for (const [name, status] of orderedStageEntries) {
    if (status !== "SUCCEEDED") reasons.push(`${name}_${status}`);
  }

  const statuses = orderedStageEntries.map(([, status]) => status);
  if (statuses.includes("INDETERMINATE")) {
    return { classification: "INDETERMINATE", reasons };
  }
  if (!accountModeConfirmed) {
    return { classification: "INDETERMINATE", reasons };
  }
  if (statuses.includes("FAILED")) {
    return { classification: "FAILED", reasons };
  }
  if (statuses.every((status) => status === "SUCCEEDED")) {
    return { classification: "VERIFIED", reasons: [] };
  }
  // Structurally unreachable in a well-formed run (a stage left NOT_RUN without an earlier FAILED/
  // INDETERMINATE stage explaining why) — never silently promoted to VERIFIED regardless.
  return { classification: "INDETERMINATE", reasons: reasons.length > 0 ? reasons : ["INCOMPLETE_RUN"] };
}

export type Stage4EvidenceRejectionReason =
  | "READ_ERROR"
  | "INVALID_JSON"
  | "UNEXPECTED_SHAPE"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_DATE"
  | "INVALID_TIMESTAMP_ORDER"
  | "FUTURE_TIMESTAMP"
  | "SCHEMA_VERSION_TOO_OLD"
  | "INVALID_EVIDENCE_TYPE"
  | "UNSUPPORTED_PROVIDER"
  | "MISSING_DEMO_ONLY_PROOF"
  | "SYMBOL_MISMATCH"
  | "SYMLINK_REJECTED"
  | "CONFLICTING_DUPLICATE_RUN_ID"
  | "INCONSISTENT_CLASSIFICATION";

export interface RejectedStage4EvidenceFile {
  filePath: string;
  reason: Stage4EvidenceRejectionReason;
  detail: string;
}

/** The minimal, validated shape the catalogue actually trusts out of a Stage-4 evidence document —
 * never the raw `unknown` JSON, and never the per-stage internal detail (the catalogue only needs
 * provenance + the already-decided classification, never re-derives it from the six stages itself —
 * exactly like the read-only loader trusts `doc.classification` directly). */
export interface ValidatedStage4EvidenceRecord {
  filePath: string;
  requestedInstrument: string;
  schemaVersion: number;
  runId: string;
  startedAt: string;
  completedAt: string;
  completedAtMs: number;
  gitCommit: string | undefined;
  appVersion: string;
  finalClassification: Stage4FinalClassification;
  classificationReasons: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordsEqual(a: ValidatedStage4EvidenceRecord, b: ValidatedStage4EvidenceRecord): boolean {
  const { filePath: _a, ...restA } = a;
  const { filePath: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

const KNOWN_CLASSIFICATIONS: readonly Stage4FinalClassification[] = ["VERIFIED", "FAILED", "INDETERMINATE"];
const KNOWN_STAGE_STATUSES: readonly Stage4StageStatus[] = ["NOT_RUN", "SUCCEEDED", "FAILED", "INDETERMINATE"];
const STAGE_KEYS = [
  "resolution",
  "quote",
  "openOrderSubmission",
  "openPositionConfirmation",
  "closeOrderSubmission",
  "closedPositionConfirmation",
] as const;

/** Requires all six known stage keys to be present with a recognised status — a document missing a
 * stage, or using an unrecognised status string, is malformed and never guessed. Only `status` is
 * actually needed to recompute a classification below; `detail`/other per-stage fields are the
 * writer's own concern (see this module's own top-of-file note on why the catalogue never re-derives
 * per-stage internal detail). */
function parseStages(raw: unknown): Stage4Stages | undefined {
  if (!isRecord(raw)) return undefined;
  const result: Partial<Record<(typeof STAGE_KEYS)[number], Stage4StageResult>> = {};
  for (const key of STAGE_KEYS) {
    const stage = raw[key];
    if (!isRecord(stage) || typeof stage.status !== "string" || !KNOWN_STAGE_STATUSES.includes(stage.status as Stage4StageStatus)) {
      return undefined;
    }
    result[key] = { status: stage.status as Stage4StageStatus, detail: typeof stage.detail === "string" ? stage.detail : "" };
  }
  return result as Stage4Stages;
}

/**
 * Pure. Validates one already-parsed JSON value against the minimum Stage-4 evidence shape the
 * catalogue trusts. Deliberately narrower than the full writer contract above — per-stage internal
 * detail is the writer's own concern (and its own tests' concern); this loader validates only what
 * it later reads: identity, timestamps, provider, demo-only proof, symbol agreement, and the
 * already-decided classification. Never guesses a missing/malformed field.
 */
export function validateStage4EvidenceDocument(
  raw: unknown,
  filePath: string,
  options: { nowMs?: number; clockSkewMs?: number } = {},
): { ok: true; record: ValidatedStage4EvidenceRecord } | { ok: false; reason: Stage4EvidenceRejectionReason; detail: string } {
  const nowMs = options.nowMs ?? Date.now();
  const clockSkewMs = options.clockSkewMs ?? FUTURE_TIMESTAMP_TOLERANCE_MS;

  if (!isRecord(raw)) {
    return { ok: false, reason: "UNEXPECTED_SHAPE", detail: "expected a JSON object at the document root" };
  }

  const schemaVersion = raw.schemaVersion;
  if (typeof schemaVersion !== "number") {
    return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "schemaVersion missing or not a number" };
  }
  if (schemaVersion < STAGE4_EVIDENCE_SCHEMA_VERSION) {
    return { ok: false, reason: "SCHEMA_VERSION_TOO_OLD", detail: `schemaVersion ${schemaVersion} < ${STAGE4_EVIDENCE_SCHEMA_VERSION}` };
  }

  if (raw.evidenceType !== STAGE4_EVIDENCE_TYPE) {
    return { ok: false, reason: "INVALID_EVIDENCE_TYPE", detail: `expected evidenceType "${STAGE4_EVIDENCE_TYPE}", found ${JSON.stringify(raw.evidenceType)}` };
  }

  const runId = raw.runId;
  const requestedInstrument = raw.requestedInstrument;
  const startedAt = raw.startedAt;
  const completedAt = raw.completedAt;
  const appVersion = raw.appVersion;
  if (typeof runId !== "string" || runId.length === 0) return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "runId missing or not a string" };
  if (typeof requestedInstrument !== "string" || requestedInstrument.length === 0) {
    return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "requestedInstrument missing or not a string" };
  }
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
    return { ok: false, reason: "FUTURE_TIMESTAMP", detail: `completedAt "${completedAt}" is more than ${clockSkewMs}ms ahead of catalogue generation time` };
  }

  const brokerProvider = raw.brokerProvider;
  if (brokerProvider !== ACCEPTED_STAGE4_BROKER_PROVIDER) {
    return { ok: false, reason: "UNSUPPORTED_PROVIDER", detail: `only provider "${ACCEPTED_STAGE4_BROKER_PROVIDER}" is accepted in this phase, found ${JSON.stringify(brokerProvider)}` };
  }

  const accountModeEvidence = raw.accountModeEvidence;
  if (
    !isRecord(accountModeEvidence) ||
    accountModeEvidence.configuredProvider !== ACCEPTED_STAGE4_BROKER_PROVIDER ||
    accountModeEvidence.demoOnlyGuardPassed !== true ||
    accountModeEvidence.liveRouteReachable !== false
  ) {
    return { ok: false, reason: "MISSING_DEMO_ONLY_PROOF", detail: "accountModeEvidence missing or does not prove a demo-only run" };
  }

  const finalClassification = raw.finalClassification;
  if (typeof finalClassification !== "string" || !KNOWN_CLASSIFICATIONS.includes(finalClassification as Stage4FinalClassification)) {
    return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: `finalClassification missing or unrecognised: ${String(finalClassification)}` };
  }

  const classificationReasons = Array.isArray(raw.classificationReasons) ? raw.classificationReasons.filter((r): r is string => typeof r === "string") : [];

  const parsedStages = parseStages(raw.stages);
  if (!parsedStages) {
    return { ok: false, reason: "UNEXPECTED_SHAPE", detail: "stages missing, malformed, or contains an unrecognised status" };
  }

  // Defence in depth, symmetric with the symbol cross-check below: never trust a claimed
  // `finalClassification` at face value — recompute it from the document's OWN stage statuses via
  // the exact same pure function the writer itself uses, and reject outright on any disagreement.
  // This is what actually prevents a malformed/dishonest document from claiming VERIFIED while one
  // of its own six stages didn't SUCCEED, or claiming FAILED/VERIFIED over stages that recompute to
  // INDETERMINATE.
  const accountModeConfirmed = true; // guaranteed by the MISSING_DEMO_ONLY_PROOF check above.
  const recomputed = classifyStage4(parsedStages, accountModeConfirmed).classification;
  if (recomputed !== finalClassification) {
    return {
      ok: false,
      reason: "INCONSISTENT_CLASSIFICATION",
      detail: `document claims finalClassification "${finalClassification}" but its own stages recompute to "${recomputed}"`,
    };
  }

  const resolvedInstrument = raw.resolvedInstrument;
  if (resolvedInstrument !== null) {
    if (!isRecord(resolvedInstrument) || typeof resolvedInstrument.symbol !== "string" || resolvedInstrument.symbol.length === 0) {
      return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "resolvedInstrument present but missing a valid symbol" };
    }
    if (normalizeSymbol(resolvedInstrument.symbol) !== normalizeSymbol(requestedInstrument)) {
      return {
        ok: false,
        reason: "SYMBOL_MISMATCH",
        detail: `requestedInstrument "${requestedInstrument}" does not match resolvedInstrument.symbol "${resolvedInstrument.symbol}"`,
      };
    }
  }

  return {
    ok: true,
    record: {
      filePath,
      requestedInstrument,
      schemaVersion,
      runId,
      startedAt,
      completedAt,
      completedAtMs,
      gitCommit: typeof raw.gitCommit === "string" ? raw.gitCommit : undefined,
      appVersion,
      finalClassification: finalClassification as Stage4FinalClassification,
      classificationReasons,
    },
  };
}

export interface Stage4EvidenceLoadResult {
  sourceDirectory: string;
  accepted: ValidatedStage4EvidenceRecord[];
  rejected: RejectedStage4EvidenceFile[];
}

/**
 * The only I/O in this module — read-only, safe when the directory is entirely absent (Stage 4 has
 * simply never been run — treated as "zero evidence found," never a crash). Mirrors the read-only
 * loader's own safety properties exactly: symlinks are rejected outright (never followed), a known
 * pointer/audit-log filename is excluded up front, one malformed file never stops the rest, and
 * duplicate runIds are resolved deterministically (identical duplicates contribute once; conflicting
 * duplicates are rejected, never silently tie-broken).
 */
export async function loadStage4CapabilityEvidence(
  directory: string,
  options: { nowMs?: number; clockSkewMs?: number } = {},
): Promise<Stage4EvidenceLoadResult> {
  const rejected: RejectedStage4EvidenceFile[] = [];
  const candidates: ValidatedStage4EvidenceRecord[] = [];

  let names: string[];
  try {
    names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json") && name !== STAGE4_POINTER_LOG_FILENAME).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { sourceDirectory: directory, accepted: [], rejected };
    }
    rejected.push({ filePath: directory, reason: "READ_ERROR", detail: toErrorMessage(error) });
    return { sourceDirectory: directory, accepted: [], rejected };
  }

  for (const name of names) {
    const filePath = path.join(directory, name);

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
    const result = validateStage4EvidenceDocument(parsed, filePath, options);
    if (result.ok) {
      candidates.push(result.record);
    } else {
      rejected.push({ filePath, reason: result.reason, detail: result.detail });
    }
  }

  const byRunId = new Map<string, ValidatedStage4EvidenceRecord[]>();
  for (const record of candidates) {
    const list = byRunId.get(record.runId) ?? [];
    list.push(record);
    byRunId.set(record.runId, list);
  }

  const accepted: ValidatedStage4EvidenceRecord[] = [];
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
          detail: `runId "${runId}" appears in multiple Stage-4 evidence files with conflicting content`,
        });
      }
    }
  }

  return { sourceDirectory: directory, accepted, rejected };
}
