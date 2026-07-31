import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { BacktestResult } from "./backtest-result";

// Phase 2 — Deterministic Backtesting Foundation. Immutable evidence files, written ONLY when the
// CLI is given an explicit --output-dir — no default mutation anywhere in this module, no
// broker/execution/lifecycle import, no network call.

/**
 * Filename is derived purely from `runFingerprint` (never `runId`, which is a fresh random value
 * every run) — a repeat run of the EXACT SAME strategy+dataset+config therefore always targets the
 * same evidence file, and `writeBacktestEvidence`'s own create-only semantics (below) make that
 * intentional: identical inputs never need a second, duplicate evidence file, and the write is
 * rejected (never silently overwritten) rather than clobbering whatever the first run already
 * recorded.
 */
export function evidenceFileName(result: BacktestResult): string {
  return `backtest-${result.strategy.strategyId}-${result.strategy.strategyVersion}-${result.runFingerprint}.json`;
}

/**
 * Pre-commit review fix. Evidence files are immutable, content-addressed records that may end up
 * shared or archived well beyond the machine/session that produced them — `result.dataset.filePath`
 * is the operator's own local (often absolute) filesystem path, which reveals machine/directory/
 * username details with no bearing on the run's own reproducibility (that's what `datasetHash`
 * already proves). Redacted to a bare filename here; the in-memory/CLI-stdout `result` object
 * itself is untouched (the full path remains useful to the operator in their own terminal).
 */
function redactForPersistence(result: BacktestResult): BacktestResult {
  return { ...result, dataset: { ...result.dataset, filePath: path.basename(result.dataset.filePath) } };
}

export type WriteBacktestEvidenceResult = { outcome: "written"; filePath: string } | { outcome: "already-exists"; filePath: string } | { outcome: "error"; detail: string };

/**
 * Atomic, create-only write: a unique temp file (fsynced) is hard-linked to the final destination —
 * `fs.link` fails with EEXIST if the destination already exists, unlike `fs.rename` (which would
 * silently overwrite it) — so two concurrent or repeated writes for the same fingerprint can never
 * corrupt or replace each other's evidence; the loser simply reports `"already-exists"` (an expected,
 * non-error outcome — proof the exact same backtest was already recorded — never treated as a
 * failure by any caller of this function). `fs.link` also can never be redirected through a symlink
 * planted at `filePath` ahead of time: it always attempts to CREATE a new directory entry at that
 * exact path and fails outright if anything (symlink or otherwise) already occupies it.
 *
 * The temp file is removed in every case — success, "already-exists", or an outright error at any
 * step (mkdir/open/write/sync/close/link) — via one outer `finally`, never only around the `link`
 * step alone (a prior version of this function leaked its temp file if the WRITE itself failed
 * partway through).
 */
export async function writeBacktestEvidence(outputDir: string, result: BacktestResult): Promise<WriteBacktestEvidenceResult> {
  const filePath = path.join(outputDir, evidenceFileName(result));
  const tempPath = path.join(outputDir, `.tmp-${randomUUID()}.json`);

  try {
    await fs.mkdir(outputDir, { recursive: true });
    const handle = await fs.open(tempPath, "w");
    try {
      await handle.writeFile(JSON.stringify(redactForPersistence(result), null, 2), "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await fs.link(tempPath, filePath);
      return { outcome: "written", filePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return { outcome: "already-exists", filePath };
      }
      throw error;
    }
  } catch (error) {
    return { outcome: "error", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}
