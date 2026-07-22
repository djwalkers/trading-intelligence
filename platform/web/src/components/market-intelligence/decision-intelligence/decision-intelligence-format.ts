import type { AnalysisDecision } from "@/lib/hermes-execution/analysis/types";
import type { TrendClassification } from "@/lib/hermes-execution/technical-indicators";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. Pure presentation helpers
// only — mirrors the diagnostics page's own diagnostics-format.ts convention (kept local to this
// feature, nothing here is reused elsewhere in the app).

export function decisionBadgeClasses(decision: AnalysisDecision): string {
  switch (decision) {
    case "BUY":
      return "border-accent-teal/30 bg-accent-teal/10 text-accent-teal";
    case "SELL":
      return "border-accent-red/30 bg-accent-red/10 text-accent-red";
    case "HOLD":
      return "border-base-600 bg-base-800 text-ink-300";
    case "ERROR":
      return "border-accent-amber/30 bg-accent-amber/10 text-accent-amber";
  }
}

export function trendBadgeClasses(trend: TrendClassification): string {
  switch (trend) {
    case "Bullish":
      return "border-accent-teal/30 bg-accent-teal/10 text-accent-teal";
    case "Bearish":
      return "border-accent-red/30 bg-accent-red/10 text-accent-red";
    case "Sideways":
      return "border-base-600 bg-base-800 text-ink-300";
  }
}

export function decisionDotColor(decision: AnalysisDecision): string {
  switch (decision) {
    case "BUY":
      return "#3ecf9e"; // accent-teal
    case "SELL":
      return "#e2584f"; // accent-red
    case "HOLD":
      return "#4d5666"; // base-500-ish neutral
    case "ERROR":
      return "#e8a33d"; // accent-amber
  }
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatMaybeNumber(value: number | null | undefined, fractionDigits = 2): string {
  return value === null || value === undefined ? "—" : value.toFixed(fractionDigits);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
