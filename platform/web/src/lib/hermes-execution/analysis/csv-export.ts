import type { AnalysisRun } from "./types";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. Pure, side-effect-free CSV
// serialization — no DOM/Blob/download-link logic here (that belongs to the UI component that
// triggers a browser download); this is directly unit-testable without jsdom.

const COLUMNS: { key: keyof AnalysisRun; header: string }[] = [
  { key: "createdAt", header: "Created At" },
  { key: "instrument", header: "Instrument" },
  { key: "timeframe", header: "Timeframe" },
  { key: "strategyId", header: "Strategy" },
  { key: "decision", header: "Decision" },
  { key: "confidence", header: "Confidence" },
  { key: "trend", header: "Trend" },
  { key: "ema20", header: "EMA20" },
  { key: "ema50", header: "EMA50" },
  { key: "rsi14", header: "RSI14" },
  { key: "atr14", header: "ATR14" },
  { key: "currentMid", header: "Mid Price" },
  { key: "executedTrade", header: "Executed" },
  { key: "tradeId", header: "Trade ID" },
  { key: "runtimeDurationMs", header: "Runtime (ms)" },
  { key: "errorCode", header: "Error Code" },
];

function escapeCsvValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/** Never includes `metadata`, `decisionReason` (free text, may contain commas/quotes handled fine,
 * but deliberately kept out to keep the export compact/scannable), or anything not already public
 * within the app (no tokens/credentials ever reach AnalysisRun in the first place — see
 * build-analysis-record.ts). */
export function analysisRunsToCsv(runs: AnalysisRun[]): string {
  const header = COLUMNS.map((c) => c.header).join(",");
  const lines = runs.map((run) => COLUMNS.map((c) => escapeCsvValue(run[c.key])).join(","));
  return [header, ...lines].join("\n");
}
