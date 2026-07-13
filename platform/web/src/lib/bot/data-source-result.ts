import type { DataProvenance, HistoricalFetchTelemetry, QuoteFetchTelemetry } from "@/lib/types";

// Sprint 290 — one scan-level touchpoint's outcome, derived directly from a freshly-returned
// telemetry object (HistoricalFetchTelemetry/QuoteFetchTelemetry), never from a provider's shared,
// mutable status. runBotScan collects one of these per historical fetch (always) and one per
// risk-evaluated candidate's quote fetch (zero or more), then reduces the whole scan-specific list
// via combineDataSourceResults below.
export type DataSourceResult = "external" | "fallback" | "mock";

export function historicalTelemetryToDataSourceResult(telemetry: HistoricalFetchTelemetry): DataSourceResult {
  if (telemetry.usedFallback) return "fallback";
  if (telemetry.source === "External") return "external";
  return "mock";
}

export function quoteTelemetryToDataSourceResult(telemetry: QuoteFetchTelemetry): DataSourceResult {
  if (telemetry.usedFallback) return "fallback";
  if (telemetry.source === "External") return "external";
  return "mock";
}

// Reduces every data touchpoint from one scan into that scan's overall DataProvenance. Any
// genuine fallback anywhere in the scan is conservative-by-design and wins outright, regardless of
// how many other touchpoints were external — a scan is only ever verified_external_data when
// EVERY touchpoint was external, with zero exceptions.
export function combineDataSourceResults(results: DataSourceResult[]): DataProvenance {
  if (results.length === 0) return "sample_data";
  if (results.some((result) => result === "fallback")) return "fallback_sample_data";
  if (results.every((result) => result === "external")) return "verified_external_data";
  return "sample_data";
}
