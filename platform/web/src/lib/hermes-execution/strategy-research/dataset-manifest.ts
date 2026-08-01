import { SUPPORTED_TIMEFRAMES, type SupportedTimeframe } from "../strategy-definitions/strategy-definition";
import { loadCandleDataset, type ValidatedCandleDataset } from "../backtest/backtest-dataset";

// Phase 3 — Strategy Research Workflow. Dataset manifest: maps each declared instrument to a fixed
// local candle dataset file, an EXPECTED hash (verified against the actually-loaded file — a
// mismatch is rejected outright, never silently trusted), a declared date range, and a role. No
// provider call, no dataset generated or fetched automatically — the ONE piece of I/O
// (`loadAndVerifyManifest`) is a thin wrapper around Phase 2's own `loadCandleDataset`, never a
// second, parallel dataset loader.
//
// A manifest path (`datasetFile`) is an INPUT, never an identity — two manifests pointing at
// different paths for byte-for-byte identical content verify identically (same `datasetHash`); this
// is exactly Phase 2's own `filePath`-excluded-from-`datasetHash` precedent, reused, not
// reinvented.

export type DatasetRole = "IN_SAMPLE" | "OUT_OF_SAMPLE" | "FULL_HISTORY" | "STRESS_PERIOD";
const DATASET_ROLES: readonly DatasetRole[] = ["IN_SAMPLE", "OUT_OF_SAMPLE", "FULL_HISTORY", "STRESS_PERIOD"];

export interface DatasetManifestEntry {
  instrument: string;
  timeframe: SupportedTimeframe;
  /** A local filesystem path — an INPUT the manifest resolver reads from, never part of any hash or
   * identity (see this module's own top-of-file doc comment). */
  datasetFile: string;
  /** The dataset content hash (Phase 2's own `computeDatasetHash`) this manifest author expects the
   * file at `datasetFile` to have RIGHT NOW — verified, never assumed, at manifest-resolution time
   * (see `loadAndVerifyManifest`). A mismatch (the file was edited, replaced, or simply never
   * matched) is rejected outright rather than silently backtesting against different data than the
   * plan's own author reviewed. */
  expectedDatasetHash: string;
  /** Declared date range — cross-checked (not merely trusted) against the dataset's own actual
   * first/last candle timestamps: the ACTUAL range must fall within this DECLARED range. */
  startTimestamp: string;
  endTimestamp: string;
  role: DatasetRole;
}

export const DATASET_MANIFEST_ENTRY_KEYS = ["instrument", "timeframe", "datasetFile", "expectedDatasetHash", "startTimestamp", "endTimestamp", "role"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Pure field-shape validation only — never touches the filesystem (that's `loadAndVerifyManifest`'s
 * job, deliberately kept separate so plan-schema validation, including this function, remains pure
 * and synchronous, matching validateStrategyDefinition's own precedent). Returns a flat list of
 * error strings (never throws), each already prefixed with `path` — the same "collect everything,
 * report once" convention `validateResearchPlan` and `validateStrategyDefinition` both use.
 */
export function validateDatasetManifestEntry(raw: unknown, path: string): string[] {
  if (!isRecord(raw)) return [`${path}: missing or malformed`];
  const errors: string[] = [];
  const extra = Object.keys(raw).filter((k) => !(DATASET_MANIFEST_ENTRY_KEYS as readonly string[]).includes(k));
  if (extra.length > 0) errors.push(`${path}: unsupported field(s) ${extra.join(", ")}`);

  if (typeof raw.instrument !== "string" || raw.instrument.trim().length === 0) errors.push(`${path}.instrument: missing or not a non-empty string`);
  if (typeof raw.timeframe !== "string" || !(SUPPORTED_TIMEFRAMES as readonly string[]).includes(raw.timeframe)) {
    errors.push(`${path}.timeframe: must be one of ${SUPPORTED_TIMEFRAMES.join(", ")} (got ${JSON.stringify(raw.timeframe)})`);
  }
  if (typeof raw.datasetFile !== "string" || raw.datasetFile.trim().length === 0) errors.push(`${path}.datasetFile: missing or not a non-empty string`);
  if (typeof raw.expectedDatasetHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.expectedDatasetHash)) {
    errors.push(`${path}.expectedDatasetHash: missing or not a 64-hex-char sha256 digest`);
  }
  if (typeof raw.startTimestamp !== "string" || Number.isNaN(Date.parse(raw.startTimestamp))) errors.push(`${path}.startTimestamp: must be a parseable ISO timestamp`);
  if (typeof raw.endTimestamp !== "string" || Number.isNaN(Date.parse(raw.endTimestamp))) errors.push(`${path}.endTimestamp: must be a parseable ISO timestamp`);
  if (typeof raw.startTimestamp === "string" && typeof raw.endTimestamp === "string" && !Number.isNaN(Date.parse(raw.startTimestamp)) && !Number.isNaN(Date.parse(raw.endTimestamp))) {
    if (Date.parse(raw.startTimestamp) >= Date.parse(raw.endTimestamp)) errors.push(`${path}: startTimestamp must be strictly before endTimestamp`);
  }
  if (typeof raw.role !== "string" || !DATASET_ROLES.includes(raw.role as DatasetRole)) {
    errors.push(`${path}.role: must be one of ${DATASET_ROLES.join(", ")} (got ${JSON.stringify(raw.role)})`);
  }
  return errors;
}

export interface ResolvedManifestEntry {
  entry: DatasetManifestEntry;
  dataset: ValidatedCandleDataset;
}

export type ManifestResolutionResult = { ok: true; resolved: ResolvedManifestEntry[] } | { ok: false; reason: string; detail: string };

/**
 * The only I/O in this module: loads and validates every declared dataset file (via Phase 2's own
 * `loadCandleDataset` — never a second parser), then cross-checks each one against its own manifest
 * entry: the ACTUAL `datasetHash` must equal `expectedDatasetHash`, the dataset's own declared
 * `instrument`/`timeframe` must equal the manifest entry's, and the dataset's actual first/last
 * candle timestamps must fall within the manifest's declared `[startTimestamp, endTimestamp]` range.
 * Any single mismatch rejects the WHOLE manifest outright (never silently proceeds with some
 * datasets verified and others not) — a research result must never be partially evidenced.
 */
export async function loadAndVerifyManifest(entries: readonly DatasetManifestEntry[], now: () => string = () => new Date().toISOString()): Promise<ManifestResolutionResult> {
  const duplicateCheck = checkNoDuplicateManifestEntries(entries);
  if (!duplicateCheck.ok) return { ok: false, reason: "DUPLICATE_MANIFEST_ENTRY", detail: duplicateCheck.detail };

  const resolved: ResolvedManifestEntry[] = [];
  for (const entry of entries) {
    const loaded = await loadCandleDataset(entry.datasetFile, now);
    if (!loaded.ok) {
      return { ok: false, reason: "DATASET_LOAD_FAILED", detail: `${entry.instrument}/${entry.role} (${entry.datasetFile}): [${loaded.reason}] ${loaded.detail}` };
    }
    if (loaded.dataset.datasetHash !== entry.expectedDatasetHash) {
      return {
        ok: false,
        reason: "DATASET_HASH_MISMATCH",
        detail: `${entry.instrument}/${entry.role} (${entry.datasetFile}): actual dataset hash "${loaded.dataset.datasetHash}" does not match manifest's expectedDatasetHash "${entry.expectedDatasetHash}"`,
      };
    }
    if (loaded.dataset.document.instrument !== entry.instrument) {
      return { ok: false, reason: "INSTRUMENT_MISMATCH", detail: `${entry.datasetFile}: dataset instrument "${loaded.dataset.document.instrument}" does not match manifest instrument "${entry.instrument}"` };
    }
    if (loaded.dataset.document.timeframe !== entry.timeframe) {
      return { ok: false, reason: "TIMEFRAME_MISMATCH", detail: `${entry.datasetFile}: dataset timeframe "${loaded.dataset.document.timeframe}" does not match manifest timeframe "${entry.timeframe}"` };
    }
    const actualStartMs = Date.parse(loaded.dataset.provenance.firstTimestamp);
    const actualEndMs = Date.parse(loaded.dataset.provenance.lastTimestamp);
    const declaredStartMs = Date.parse(entry.startTimestamp);
    const declaredEndMs = Date.parse(entry.endTimestamp);
    if (actualStartMs < declaredStartMs || actualEndMs > declaredEndMs) {
      return {
        ok: false,
        reason: "DATE_RANGE_MISMATCH",
        detail: `${entry.datasetFile}: actual candle range [${loaded.dataset.provenance.firstTimestamp}, ${loaded.dataset.provenance.lastTimestamp}] is not contained within the manifest's declared range [${entry.startTimestamp}, ${entry.endTimestamp}]`,
      };
    }
    resolved.push({ entry, dataset: loaded.dataset });
  }

  const overlapCheck = checkNoInSampleOutOfSampleOverlap(entries);
  if (!overlapCheck.ok) return { ok: false, reason: "OVERLAPPING_SPLIT", detail: overlapCheck.detail };

  return { ok: true, resolved };
}

/**
 * Pre-commit review fix. Two manifest entries sharing the same `(instrument, role)` pair used to be
 * silently resolved by `resolveInstrumentDatasetPlans` (research-engine.ts) picking whichever one
 * `Array.prototype.find` happened to see first — an unannounced, easy-to-miss "first wins" behaviour
 * for what is actually a conflicting, ambiguous manifest. Rejected outright here instead, before any
 * file is even read, exactly like `strategy-definition-registry.ts`'s own conflicting-duplicate-
 * version handling never silently picks a winner either.
 */
export function checkNoDuplicateManifestEntries(entries: readonly DatasetManifestEntry[]): { ok: true } | { ok: false; detail: string } {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.instrument}:${entry.role}`;
    if (seen.has(key)) {
      return { ok: false, detail: `duplicate manifest entry for instrument "${entry.instrument}" with role "${entry.role}" — each (instrument, role) pair must appear at most once` };
    }
    seen.add(key);
  }
  return { ok: true };
}

/**
 * For any instrument with BOTH an explicit `IN_SAMPLE` and an explicit `OUT_OF_SAMPLE` manifest
 * entry (the "separate files" mode — see research-engine.ts's own doc comment on the two supported
 * IS/OOS modes), the in-sample entry's own declared range must end at or before the out-of-sample
 * entry's own declared range begins — chronological, non-overlapping. Never applies to the
 * `FULL_HISTORY` + `chronologicalSplits` mode, where non-overlap is already structurally guaranteed
 * by Phase 2's own single-timestamp split (see backtest-result.ts's own `resolveSplit`).
 */
export function checkNoInSampleOutOfSampleOverlap(entries: readonly DatasetManifestEntry[]): { ok: true } | { ok: false; detail: string } {
  const byInstrument = new Map<string, DatasetManifestEntry[]>();
  for (const entry of entries) {
    const list = byInstrument.get(entry.instrument) ?? [];
    list.push(entry);
    byInstrument.set(entry.instrument, list);
  }
  for (const [instrument, list] of byInstrument) {
    const inSample = list.find((e) => e.role === "IN_SAMPLE");
    const outOfSample = list.find((e) => e.role === "OUT_OF_SAMPLE");
    if (!inSample || !outOfSample) continue;
    if (Date.parse(inSample.endTimestamp) > Date.parse(outOfSample.startTimestamp)) {
      return {
        ok: false,
        detail: `${instrument}: declared IN_SAMPLE range ends (${inSample.endTimestamp}) after declared OUT_OF_SAMPLE range begins (${outOfSample.startTimestamp}) — the two must be chronological and non-overlapping`,
      };
    }
  }
  return { ok: true };
}
