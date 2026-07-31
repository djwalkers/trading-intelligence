import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import type { InstrumentCatalogueEntry } from "../instrument-catalogue/instrument-catalogue";
import {
  validateStrategyDefinition,
  compareSemver,
  type StrategyDefinitionRejectionReason,
  type ValidatedStrategyRecord,
} from "./strategy-definition";

// Phase 1 — Declarative Strategy Foundation. Read-only, filesystem-only registry for HAND-AUTHORED
// strategy definitions (source-controlled, see the repo's own `strategies/` directory) — a
// deliberately NEW, separate concept from:
//  - `registry-client.ts`'s FileSystemRegistryClient, which reads the EXTERNAL Hermes Lab research
//    registry from an env-configured `HERMES_STRATEGY_REGISTRY_PATH` OUTSIDE this repo — this
//    module never reads or writes that path, and never competes with it.
//  - `strategies/strategy-registry.ts`'s InMemoryStrategyRegistry, which holds executable `Strategy`
//    objects actually driving live trading decisions — this module holds validated DATA only, and
//    is not wired into that registry or into any live decision path in this phase.
// No broker/execution/approval/lifecycle/risk import anywhere in this file; no network call.

export interface RejectedStrategyFile {
  filePath: string;
  reason: StrategyDefinitionRejectionReason;
  detail: string;
}

export interface StrategyDefinitionLoadResult {
  sourceDirectory: string;
  accepted: ValidatedStrategyRecord[];
  rejected: RejectedStrategyFile[];
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordKey(record: ValidatedStrategyRecord): string {
  return `${record.document.strategyId}@${record.document.strategyVersion}`;
}

/** Deterministic regardless of the source JSON text's own key order — a plain `JSON.stringify`
 * comparison is key-order-sensitive (JS preserves object insertion order, which follows the source
 * text), so two files with byte-for-byte identical content but keys written in a different order
 * would otherwise be misdetected as CONFLICTING rather than deduplicated. Arrays keep their own
 * order (order is meaningful there — e.g. `supportedInstruments`, `signalExitRules`); only object
 * KEYS are sorted. */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function recordsEqual(a: ValidatedStrategyRecord, b: ValidatedStrategyRecord): boolean {
  return canonicalStringify(a.document) === canonicalStringify(b.document);
}

/**
 * The only I/O in this module — read-only, safe when the directory is entirely absent (treated as
 * "zero strategies found," never a crash). Mirrors the Phase 0 instrument-catalogue loaders' own
 * safety properties: deterministic file ordering (sorted filenames), symlinks rejected outright
 * (never followed), one malformed file never stops the rest, and duplicate strategyId+strategyVersion
 * pairs are resolved deterministically (byte-for-byte identical documents contribute once;
 * conflicting duplicates are rejected, never silently tie-broken). The filename is never trusted —
 * every fact (including strategyId/strategyVersion themselves) comes from the document's own fields.
 */
export async function loadStrategyDefinitions(
  directory: string,
  catalogueEntries: readonly InstrumentCatalogueEntry[],
): Promise<StrategyDefinitionLoadResult> {
  const rejected: RejectedStrategyFile[] = [];
  const candidates: ValidatedStrategyRecord[] = [];

  let names: string[];
  try {
    names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
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
      rejected.push({ filePath, reason: "SYMLINK_REJECTED", detail: "symbolic links are never trusted as strategy sources" });
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
    const result = validateStrategyDefinition(parsed, filePath, catalogueEntries);
    if (result.ok) {
      candidates.push(result.record);
    } else {
      rejected.push({ filePath, reason: result.reason, detail: result.detail });
    }
  }

  // Duplicate strategyId+strategyVersion resolution — identical documents contribute once;
  // conflicting ones (same id+version, different content) are rejected outright rather than
  // silently picking one, since a strategyVersion must be immutable once published.
  const byKey = new Map<string, ValidatedStrategyRecord[]>();
  for (const record of candidates) {
    const key = recordKey(record);
    const list = byKey.get(key) ?? [];
    list.push(record);
    byKey.set(key, list);
  }

  const accepted: ValidatedStrategyRecord[] = [];
  for (const [key, records] of byKey) {
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
          reason: "CONFLICTING_DUPLICATE_VERSION",
          detail: `strategyId+strategyVersion "${key}" appears in multiple files with conflicting content — strategyVersion must be immutable once published`,
        });
      }
    }
  }

  return { sourceDirectory: directory, accepted, rejected };
}

/**
 * Deterministic "latest version" selection, grouped by strategyId — highest semantic version wins
 * (see strategy-definition.ts's own compareSemver doc comment for why this is never "most recently
 * written file" or lexicographic string comparison). A newer version's approval is NEVER inherited
 * from an older one — each accepted record's own `document.status`/`result` came from its own file,
 * independently validated; this function only picks which version is "latest", never rewrites or
 * merges any field across versions.
 */
export function selectLatestVersions(accepted: readonly ValidatedStrategyRecord[]): Map<string, ValidatedStrategyRecord> {
  const latest = new Map<string, ValidatedStrategyRecord>();
  for (const record of accepted) {
    const current = latest.get(record.document.strategyId);
    if (!current || compareSemver(record.document.strategyVersion, current.document.strategyVersion) > 0) {
      latest.set(record.document.strategyId, record);
    }
  }
  return latest;
}

/** Full version history for one strategyId, oldest first (semver-ordered, never file-order). */
export function versionHistory(accepted: readonly ValidatedStrategyRecord[], strategyId: string): ValidatedStrategyRecord[] {
  return accepted
    .filter((r) => r.document.strategyId === strategyId)
    .sort((a, b) => compareSemver(a.document.strategyVersion, b.document.strategyVersion));
}
