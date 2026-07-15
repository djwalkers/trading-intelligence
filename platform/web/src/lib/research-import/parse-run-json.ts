import "server-only";
import { ResearchRunImportError, type ParsedRunJson, type RunChecksums } from "./types";

// All fields optional on the raw shape, mirroring AlphaVantageDailyResponse's exact pattern for
// parsing untrusted external JSON — the parser below explicitly checks for each field this importer
// needs and throws a typed error naming exactly what's missing. Every other key present in the
// file, recognised or not, is simply never read here — that is what "ignore unknown fields" means
// in practice: reading only known field names off a permissively-typed object, the same way every
// other untrusted-JSON parser in this codebase already works. No explicit "strip unknown keys" step
// exists or is needed.
interface RawRunJson {
  runId?: unknown;
  symbol?: unknown;
  strategyName?: unknown;
  model?: unknown;
  status?: unknown;
  verdict?: unknown;
  verdictReason?: unknown;
  dataSource?: unknown;
  dateRangeStart?: unknown;
  dateRangeEnd?: unknown;
  hypothesis?: unknown;
  falsificationCriterion?: unknown;
  createdAt?: unknown;
  checksums?: unknown;
}

function requireString(raw: RawRunJson, field: keyof RawRunJson): string {
  const value = raw[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ResearchRunImportError(
      `run.json is missing required field "${field}".`,
      "missing_required_field",
    );
  }
  return value;
}

function optionalString(raw: RawRunJson, field: keyof RawRunJson): string | null {
  const value = raw[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseRunJson(rawText: string): ParsedRunJson {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new ResearchRunImportError("run.json is not valid JSON.", "malformed_json");
  }
  if (raw === null || typeof raw !== "object") {
    throw new ResearchRunImportError("run.json must contain a JSON object.", "malformed_json");
  }
  const rawObject = raw as RawRunJson & Record<string, unknown>;

  const checksumsValue = rawObject.checksums;
  const checksums: RunChecksums =
    checksumsValue !== null && typeof checksumsValue === "object"
      ? (checksumsValue as RunChecksums)
      : {};

  return {
    runId: requireString(rawObject, "runId"),
    symbol: requireString(rawObject, "symbol"),
    strategyName: requireString(rawObject, "strategyName"),
    model: requireString(rawObject, "model"),
    status: requireString(rawObject, "status"),
    verdict: requireString(rawObject, "verdict"),
    verdictReason: requireString(rawObject, "verdictReason"),
    dataSource: requireString(rawObject, "dataSource"),
    dateRangeStart: optionalString(rawObject, "dateRangeStart"),
    dateRangeEnd: optionalString(rawObject, "dateRangeEnd"),
    hypothesis: requireString(rawObject, "hypothesis"),
    falsificationCriterion: requireString(rawObject, "falsificationCriterion"),
    createdAt: requireString(rawObject, "createdAt"),
    checksums,
    raw: rawObject,
  };
}
