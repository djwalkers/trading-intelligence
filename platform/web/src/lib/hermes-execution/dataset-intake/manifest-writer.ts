import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { checkNoDuplicateManifestEntries, validateDatasetManifestEntry, type DatasetManifestEntry } from "../strategy-research/dataset-manifest";

// Phase 4 — Historical Dataset Intake. Generates and merges Phase 3-compatible
// `DatasetManifestEntry` records — reuses Phase 3's own `validateDatasetManifestEntry`/
// `checkNoDuplicateManifestEntries` directly (never a second, parallel manifest-entry validator or
// duplicate-detection rule). The on-disk manifest FILE format is a flat JSON array of
// `DatasetManifestEntry` — copy/pasteable verbatim into a research plan's own `datasets` field.
//
// Deliberately a DIFFERENT atomic-write pattern than research-persistence.ts's create-only
// `fs.link`: a manifest file is a small, MUTABLE, mergeable working document an operator adds
// entries to over time (one dataset file at a time), never a one-shot immutable evidence record —
// so this module uses write-to-temp-then-`fs.rename` (atomic replace) instead, gated by its OWN
// duplicate check performed BEFORE the write, so a conflicting entry is rejected explicitly rather
// than either silently overwritten or silently blocked by a create-only filesystem primitive.
//
// KNOWN LIMITATION — no file locking: `appendManifestEntry` reads the existing manifest, validates,
// merges, then writes — with no lock held across that read-modify-write window. Two `dataset:prepare
// --manifest-output <same file>` invocations run CONCURRENTLY against the SAME manifest can both
// read the same starting content and each compute their own "merged" result from it; whichever
// process's `fs.rename` lands last wins, silently discarding the other's entry (the write itself
// stays atomic/never corrupts the file — see above — but the LOST UPDATE itself is real). This tool
// is intended for one operator running one dataset-preparation command at a time; never run two
// `--manifest-output` invocations against the same manifest file in parallel.

export type ManifestWriteRejectionReason = "MANIFEST_INVALID" | "DUPLICATE_MANIFEST_ENTRY";

export type ManifestReadResult = { ok: true; entries: DatasetManifestEntry[] } | { ok: false; reason: ManifestWriteRejectionReason; detail: string };

/** Pure: validates an already-parsed manifest file's own shape (a JSON array, each entry passing
 * `validateDatasetManifestEntry`, and no duplicate (instrument, role) pairs among the entries
 * already on file) — never trusts a pre-existing file blindly before appending to it. */
export function parseManifestFile(raw: unknown): ManifestReadResult {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "MANIFEST_INVALID", detail: "expected a top-level JSON array of dataset manifest entries" };
  }
  const errors = raw.flatMap((entry, index) => validateDatasetManifestEntry(entry, `[${index}]`));
  if (errors.length > 0) {
    return { ok: false, reason: "MANIFEST_INVALID", detail: `existing manifest file is invalid: ${errors.join("; ")}` };
  }
  const entries = raw as DatasetManifestEntry[];
  const duplicateCheck = checkNoDuplicateManifestEntries(entries);
  if (!duplicateCheck.ok) {
    return { ok: false, reason: "MANIFEST_INVALID", detail: `existing manifest file already contains a conflict: ${duplicateCheck.detail}` };
  }
  return { ok: true, entries };
}

export type AppendManifestEntryResult = { ok: true; entries: DatasetManifestEntry[]; filePath: string } | { ok: false; reason: ManifestWriteRejectionReason; detail: string };

/**
 * Reads (if present), validates, and appends one new entry to a manifest file — rejecting outright
 * (never silently overwriting) if the existing file is malformed, or if the new entry would create
 * a duplicate `(instrument, role)` pair against an entry already on file. Written atomically via a
 * unique temp file (fsynced) plus `fs.rename` into place; the temp file is removed on every path via
 * one outer `finally`. Does NOT write when `dryRun` is set — the caller can preview the resulting
 * entry list without touching disk.
 */
export async function appendManifestEntry(manifestPath: string, newEntry: DatasetManifestEntry, dryRun: boolean): Promise<AppendManifestEntryResult> {
  let existingEntries: DatasetManifestEntry[] = [];
  try {
    const text = await fs.readFile(manifestPath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { ok: false, reason: "MANIFEST_INVALID", detail: `existing manifest file is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
    const parsedManifest = parseManifestFile(parsed);
    if (!parsedManifest.ok) return parsedManifest;
    existingEntries = parsedManifest.entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, reason: "MANIFEST_INVALID", detail: `could not read existing manifest file: ${error instanceof Error ? error.message : String(error)}` };
    }
    // ENOENT: no existing manifest — starting a fresh one is expected, not an error.
  }

  const newEntryErrors = validateDatasetManifestEntry(newEntry, "newEntry");
  if (newEntryErrors.length > 0) {
    return { ok: false, reason: "MANIFEST_INVALID", detail: `generated manifest entry is invalid: ${newEntryErrors.join("; ")}` };
  }

  const merged = [...existingEntries, newEntry];
  const duplicateCheck = checkNoDuplicateManifestEntries(merged);
  if (!duplicateCheck.ok) {
    return { ok: false, reason: "DUPLICATE_MANIFEST_ENTRY", detail: duplicateCheck.detail };
  }

  if (dryRun) return { ok: true, entries: merged, filePath: manifestPath };

  const dir = path.dirname(manifestPath);
  const tempPath = path.join(dir, `.tmp-${randomUUID()}.json`);
  try {
    await fs.mkdir(dir, { recursive: true });
    const handle = await fs.open(tempPath, "w");
    try {
      await handle.writeFile(JSON.stringify(merged, null, 2), "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, manifestPath);
    return { ok: true, entries: merged, filePath: manifestPath };
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}
