import "server-only";

export type ResearchRunImportFailureReason =
  | "missing_file"
  | "malformed_json"
  | "checksum_mismatch"
  | "missing_required_field";

export class ResearchRunImportError extends Error {
  constructor(
    message: string,
    public readonly reason: ResearchRunImportFailureReason,
  ) {
    super(message);
    this.name = "ResearchRunImportError";
  }
}

// The contract every completed Hermes Lab run must satisfy — validated, never modified by this
// app. `evidence/` is a real part of the contract but is not read or persisted in this phase (the
// data model has no column for it); only these seven files are required and checked.
export const REQUIRED_RUN_FILES = [
  "run.json",
  "hypothesis.md",
  "comparison.md",
  "strategy-v1.py",
  "strategy-v2.py",
  "results-v1.json",
  "results-v2.json",
] as const;

export type RequiredRunFile = (typeof REQUIRED_RUN_FILES)[number];

export interface RunFiles {
  runJson: string;
  hypothesisMarkdown: string;
  comparisonMarkdown: string;
  strategyV1: string;
  strategyV2: string;
  resultsV1Json: string;
  resultsV2Json: string;
}

// run.json's own declared checksums: filename -> expected sha256 hex digest, for every required
// file except run.json itself (a file cannot meaningfully declare its own checksum).
export type RunChecksums = Partial<Record<Exclude<RequiredRunFile, "run.json">, string>>;

// Parsed from run.json. The raw JSON is treated permissively (see parse-run-json.ts) — only these
// known fields are ever read off it; every other field present in the file, known or not, is
// preserved verbatim in `raw` (persisted as-is to raw_run_json) rather than inspected or rejected.
export interface ParsedRunJson {
  runId: string;
  symbol: string;
  strategyName: string;
  model: string;
  status: string;
  verdict: string;
  verdictReason: string;
  dataSource: string;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  hypothesis: string;
  falsificationCriterion: string;
  createdAt: string;
  checksums: RunChecksums;
  raw: Record<string, unknown>;
}
