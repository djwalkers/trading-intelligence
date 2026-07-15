import type { ResearchRun, ResearchRunSummary } from "./types";

export interface ResearchRunSummaryDbRow {
  id: string;
  run_id: string;
  symbol: string;
  strategy_name: string;
  model: string;
  status: string;
  verdict: string;
  run_created_at: string;
}

export interface ResearchRunDbRow extends ResearchRunSummaryDbRow {
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
  imported_at: string;
}

// Columns actually rendered by the list and Strategy History pages — kept in sync with
// ResearchRunSummary's own fields so a query using this string and fromSummaryDbRow always agree.
export const RESEARCH_RUN_SUMMARY_COLUMNS =
  "id, run_id, symbol, strategy_name, model, status, verdict, run_created_at";

export function fromSummaryDbRow(row: ResearchRunSummaryDbRow): ResearchRunSummary {
  return {
    id: row.id,
    runId: row.run_id,
    symbol: row.symbol,
    strategyName: row.strategy_name,
    model: row.model,
    status: row.status,
    verdict: row.verdict,
    runCreatedAt: row.run_created_at,
  };
}

export function fromDbRow(row: ResearchRunDbRow): ResearchRun {
  return {
    ...fromSummaryDbRow(row),
    verdictReason: row.verdict_reason,
    dataSource: row.data_source,
    dateRangeStart: row.date_range_start,
    dateRangeEnd: row.date_range_end,
    hypothesis: row.hypothesis,
    falsificationCriterion: row.falsification_criterion,
    resultsV1: row.results_v1,
    resultsV2: row.results_v2,
    resultsDiff: row.results_diff,
    hypothesisMarkdown: row.hypothesis_markdown,
    comparisonMarkdown: row.comparison_markdown,
    importedAt: row.imported_at,
  };
}
