import "server-only";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ResearchRunImportError, type RunFiles } from "./types";

async function readRequired(runDirectory: string, fileName: string): Promise<string> {
  try {
    return await fs.readFile(path.join(runDirectory, fileName), "utf-8");
  } catch {
    throw new ResearchRunImportError(
      `Required file "${fileName}" not found in ${runDirectory}.`,
      "missing_file",
    );
  }
}

// Reads all seven required contract files. Unlike AlphaVantageHistoricalMarketDataProvider's disk
// cache (which silently starts empty on a missing/corrupt file), a missing file here is always
// rejected — this importer's job is integrity, not graceful degradation. Read directly into the
// named fields via a fixed-length tuple of promises (not a .map() over an array, whose result type
// loses per-element typing under this project's noUncheckedIndexedAccess) so a typo in a file name
// can never produce a silent `undefined`.
export async function readRunFiles(runDirectory: string): Promise<RunFiles> {
  const [runJson, hypothesisMarkdown, comparisonMarkdown, strategyV1, strategyV2, resultsV1Json, resultsV2Json] =
    await Promise.all([
      readRequired(runDirectory, "run.json"),
      readRequired(runDirectory, "hypothesis.md"),
      readRequired(runDirectory, "comparison.md"),
      readRequired(runDirectory, "strategy-v1.py"),
      readRequired(runDirectory, "strategy-v2.py"),
      readRequired(runDirectory, "results-v1.json"),
      readRequired(runDirectory, "results-v2.json"),
    ]);

  return {
    runJson,
    hypothesisMarkdown,
    comparisonMarkdown,
    strategyV1,
    strategyV2,
    resultsV1Json,
    resultsV2Json,
  };
}
