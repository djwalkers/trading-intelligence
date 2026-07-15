import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readRunFiles } from "./read-run-files";
import { verifyChecksums } from "./verify-checksums";
import { parseRunJson } from "./parse-run-json";
import { computeResultsDiff } from "./compute-results-diff";
import { ResearchRunImportError, type ParsedRunJson } from "./types";

const TABLE = "research_runs";

interface ResearchRunDbRow {
  run_id: string;
  symbol: string;
  strategy_name: string;
  model: string;
  status: string;
  verdict: string;
  verdict_reason: string;
  data_source: string;
  date_range_start: string | null;
  date_range_end: string | null;
  hypothesis: string;
  falsification_criterion: string;
  results_v1: Record<string, unknown>;
  results_v2: Record<string, unknown>;
  results_diff: Record<string, number>;
  hypothesis_markdown: string;
  comparison_markdown: string;
  raw_run_json: Record<string, unknown>;
  run_created_at: string;
}

function parseResultsJson(rawText: string, fileName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new ResearchRunImportError(`${fileName} is not valid JSON.`, "malformed_json");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new ResearchRunImportError(`${fileName} must contain a JSON object.`, "malformed_json");
  }
  return parsed as Record<string, unknown>;
}

function toDbRow(
  parsedRunJson: ParsedRunJson,
  resultsV1: Record<string, unknown>,
  resultsV2: Record<string, unknown>,
  hypothesisMarkdown: string,
  comparisonMarkdown: string,
): ResearchRunDbRow {
  return {
    run_id: parsedRunJson.runId,
    symbol: parsedRunJson.symbol,
    strategy_name: parsedRunJson.strategyName,
    model: parsedRunJson.model,
    status: parsedRunJson.status,
    verdict: parsedRunJson.verdict,
    verdict_reason: parsedRunJson.verdictReason,
    data_source: parsedRunJson.dataSource,
    date_range_start: parsedRunJson.dateRangeStart,
    date_range_end: parsedRunJson.dateRangeEnd,
    hypothesis: parsedRunJson.hypothesis,
    falsification_criterion: parsedRunJson.falsificationCriterion,
    results_v1: resultsV1,
    results_v2: resultsV2,
    results_diff: computeResultsDiff(resultsV1, resultsV2),
    hypothesis_markdown: hypothesisMarkdown,
    comparison_markdown: comparisonMarkdown,
    raw_run_json: parsedRunJson.raw,
    run_created_at: parsedRunJson.createdAt,
  };
}

// Validation order, each step aborting the whole import on failure, never a partial row: required
// files exist (read-run-files.ts) → JSON parses (parse-run-json.ts / here, for the two results
// files) → checksums match (verify-checksums.ts) → required fields present (parse-run-json.ts) →
// upsert. `onConflict: "run_id"` makes re-running the import for the same run-id idempotent — an
// update, never a duplicate-row error.
export async function importResearchRun(
  client: SupabaseClient,
  runDirectory: string,
): Promise<{ runId: string }> {
  const files = await readRunFiles(runDirectory);
  const parsedRunJson = parseRunJson(files.runJson);
  verifyChecksums(files, parsedRunJson.checksums);

  const resultsV1 = parseResultsJson(files.resultsV1Json, "results-v1.json");
  const resultsV2 = parseResultsJson(files.resultsV2Json, "results-v2.json");

  const row = toDbRow(
    parsedRunJson,
    resultsV1,
    resultsV2,
    files.hypothesisMarkdown,
    files.comparisonMarkdown,
  );

  const { error } = await client.from(TABLE).upsert(row, { onConflict: "run_id" });
  if (error) throw new Error(error.message);

  return { runId: parsedRunJson.runId };
}
