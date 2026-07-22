import { describe, expect, it } from "vitest";
import { analysisRunsToCsv } from "@/lib/hermes-execution/analysis/csv-export";
import type { AnalysisRun } from "@/lib/hermes-execution/analysis/types";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence.

function makeRun(overrides: Partial<AnalysisRun> = {}): AnalysisRun {
  return {
    id: "run-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    runtimeMode: "demo",
    brokerProvider: "etoro-demo",
    marketProvider: "live",
    instrument: "BTC",
    timeframe: "1h",
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    decision: "BUY",
    executedTrade: true,
    tradeId: "etoro-position-1",
    validationOk: true,
    fallbackUsed: false,
    runtimeDurationMs: 123,
    confidence: 0.82,
    ema20: 50_100,
    ema50: 50_000,
    rsi14: 55.4,
    atr14: 120.5,
    currentMid: 50_050,
    ...overrides,
  };
}

describe("analysisRunsToCsv", () => {
  it("produces a header row plus one row per run", () => {
    const csv = analysisRunsToCsv([makeRun(), makeRun({ id: "run-2" })]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Instrument");
    expect(lines[0]).toContain("Decision");
  });

  it("returns just the header for an empty run list", () => {
    const csv = analysisRunsToCsv([]);
    expect(csv.split("\n")).toHaveLength(1);
  });

  it("renders undefined/null fields as an empty cell, never the literal string 'undefined'", () => {
    const csv = analysisRunsToCsv([makeRun({ tradeId: undefined, errorCode: undefined })]);
    expect(csv).not.toContain("undefined");
  });

  it("quotes and escapes a value containing a comma", () => {
    const csv = analysisRunsToCsv([makeRun({ strategyId: "STRAT,WITH,COMMAS" })]);
    expect(csv).toContain('"STRAT,WITH,COMMAS"');
  });

  it("escapes an embedded double quote by doubling it", () => {
    const csv = analysisRunsToCsv([makeRun({ strategyId: 'STRAT "special"' })]);
    expect(csv).toContain('"STRAT ""special"""');
  });

  it("quotes a value containing a newline", () => {
    const csv = analysisRunsToCsv([makeRun({ strategyId: "line1\nline2" })]);
    expect(csv).toContain('"line1\nline2"');
  });

  it("includes real numeric/boolean values verbatim", () => {
    const csv = analysisRunsToCsv([makeRun({ confidence: 0.82, executedTrade: true })]);
    expect(csv).toContain("0.82");
    expect(csv).toContain("true");
  });
});
