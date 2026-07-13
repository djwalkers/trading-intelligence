import { describe, expect, it } from "vitest";
import {
  combineDataSourceResults,
  historicalTelemetryToDataSourceResult,
  quoteTelemetryToDataSourceResult,
} from "@/lib/bot/data-source-result";
import type { HistoricalFetchTelemetry, QuoteFetchTelemetry } from "@/lib/types";

function historicalTelemetry(overrides: Partial<HistoricalFetchTelemetry>): HistoricalFetchTelemetry {
  return {
    symbolsRequested: ["AAPL"],
    symbolsServedExternally: [],
    symbolsServedFromFallback: [],
    symbolsFailed: [],
    usedFallback: false,
    source: "Mock",
    provider: "Sample data",
    ...overrides,
  };
}

function quoteTelemetry(overrides: Partial<QuoteFetchTelemetry>): QuoteFetchTelemetry {
  return {
    symbolsRequested: ["AAPL"],
    symbolsServedExternally: [],
    symbolsServedFromFallback: [],
    symbolsFailed: [],
    usedFallback: false,
    source: "Mock",
    provider: "Sample data",
    ...overrides,
  };
}

describe("historicalTelemetryToDataSourceResult", () => {
  it("reports fallback whenever usedFallback is true, regardless of source", () => {
    expect(historicalTelemetryToDataSourceResult(historicalTelemetry({ usedFallback: true, source: "External" }))).toBe(
      "fallback",
    );
    expect(historicalTelemetryToDataSourceResult(historicalTelemetry({ usedFallback: true, source: "Mock" }))).toBe(
      "fallback",
    );
  });

  it("reports external when not a fallback and source is External", () => {
    expect(
      historicalTelemetryToDataSourceResult(historicalTelemetry({ usedFallback: false, source: "External" })),
    ).toBe("external");
  });

  it("reports mock when not a fallback and source is Mock (never configured, not a failure)", () => {
    expect(historicalTelemetryToDataSourceResult(historicalTelemetry({ usedFallback: false, source: "Mock" }))).toBe(
      "mock",
    );
  });
});

describe("quoteTelemetryToDataSourceResult", () => {
  it("mirrors the historical mapping exactly", () => {
    expect(quoteTelemetryToDataSourceResult(quoteTelemetry({ usedFallback: true, source: "External" }))).toBe(
      "fallback",
    );
    expect(quoteTelemetryToDataSourceResult(quoteTelemetry({ usedFallback: false, source: "External" }))).toBe(
      "external",
    );
    expect(quoteTelemetryToDataSourceResult(quoteTelemetry({ usedFallback: false, source: "Mock" }))).toBe("mock");
  });
});

describe("combineDataSourceResults", () => {
  it("returns sample_data when there are no touchpoints at all", () => {
    expect(combineDataSourceResults([])).toBe("sample_data");
  });

  it("returns verified_external_data only when every touchpoint was external", () => {
    expect(combineDataSourceResults(["external", "external", "external"])).toBe("verified_external_data");
  });

  it("returns fallback_sample_data when any touchpoint used a fallback, even if others were external", () => {
    expect(combineDataSourceResults(["external", "fallback", "external"])).toBe("fallback_sample_data");
  });

  it("returns fallback_sample_data even when every other touchpoint is fully external and only one fallback exists", () => {
    expect(combineDataSourceResults(["external", "external", "fallback"])).toBe("fallback_sample_data");
  });

  it("returns sample_data for a mock-only scan (no fallback, not fully external)", () => {
    expect(combineDataSourceResults(["mock", "mock"])).toBe("sample_data");
  });

  it("returns sample_data for a mixed external/mock scan with no declared fallback", () => {
    expect(combineDataSourceResults(["external", "mock"])).toBe("sample_data");
  });
});
