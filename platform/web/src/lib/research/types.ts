// Phase 2 — Research Import. Browser-facing domain shapes, deliberately split into a light
// "summary" (list/grouped-history views) and the full row (detail view) — the summary omits the
// markdown/jsonb fields the list and Strategy History pages never render, so those pages only ever
// fetch what they display.
export interface ResearchRunSummary {
  id: string;
  runId: string;
  symbol: string;
  strategyName: string;
  model: string;
  status: string;
  verdict: string;
  runCreatedAt: string;
}

export interface ResearchRun extends ResearchRunSummary {
  verdictReason: string;
  dataSource: string;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  hypothesis: string;
  falsificationCriterion: string;
  resultsV1: Record<string, unknown>;
  resultsV2: Record<string, unknown>;
  resultsDiff: Record<string, number>;
  hypothesisMarkdown: string;
  comparisonMarkdown: string;
  importedAt: string;
}
