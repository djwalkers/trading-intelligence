import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ResearchResult } from "./research-result";

// Phase 3 — Strategy Research Workflow. Immutable evidence files, written ONLY when the CLI is given
// an explicit --output-dir — mirrors backtest-persistence.ts's own atomic, create-only design
// exactly (never a second, differently-behaved persistence mechanism). No broker/execution/lifecycle
// import, no network call.

/** Filename derived purely from `researchFingerprint` (never `researchRunId`, a fresh random value
 * every run) — a repeat run of the identical plan+strategy+datasets+experiment matrix always targets
 * the same evidence file. */
export function researchEvidenceFileName(result: ResearchResult): string {
  return `research-${result.plan.researchPlanId}-${result.plan.researchPlanVersion}-${result.researchFingerprint}.json`;
}

/**
 * Redacts every absolute local filesystem path out of the persisted copy — `datasets[].filePath` is
 * reduced to its bare filename, exactly like `backtest-persistence.ts`'s own `redactForPersistence`.
 * The in-memory/CLI-stdout result the operator sees in their own terminal keeps the full paths.
 */
function redactForPersistence(result: ResearchResult): ResearchResult {
  return { ...result, datasets: result.datasets.map((d) => ({ ...d, filePath: path.basename(d.filePath) })) };
}

export type WriteResearchEvidenceResult = { outcome: "written"; filePath: string } | { outcome: "already-exists"; filePath: string } | { outcome: "error"; detail: string };

/**
 * Atomic, create-only write — identical technique to `backtest-persistence.ts`'s own
 * `writeBacktestEvidence`: a unique temp file (fsynced) hard-linked to the final destination
 * (`fs.link` fails with EEXIST if it already exists, unlike `fs.rename`, which would silently
 * overwrite it). A repeat write for the SAME fingerprint reports `"already-exists"` — an expected,
 * non-error success outcome, never a silent overwrite. The temp file is removed in every case
 * (success, "already-exists", or an outright error at any step) via one outer `finally`.
 */
export async function writeResearchEvidence(outputDir: string, result: ResearchResult): Promise<WriteResearchEvidenceResult> {
  const filePath = path.join(outputDir, researchEvidenceFileName(result));
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
