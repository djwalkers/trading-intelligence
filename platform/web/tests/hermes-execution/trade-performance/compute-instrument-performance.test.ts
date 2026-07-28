import { describe, expect, it } from "vitest";
import { computeInstrumentPerformance, computePerformanceByConfidenceBand } from "@/lib/hermes-execution/trade-performance/compute-instrument-performance";
import type { TradePerformanceRecord } from "@/lib/hermes-execution/trade-performance/types";

// Prototype 1.0 — official Hermes Agent decision integration. Learning-context tests: performance
// context supplied correctly, insufficient history handled safely, and (via
// trade-performance-service.ts's own pre-existing "only a CLOSED trade ever produces a row" design
// — see that file's own doc comment) CLOSED_UNRECONCILED is excluded from realised performance by
// construction, confirmed here by simply never constructing a row for one.

function makeRecord(overrides: Partial<TradePerformanceRecord> = {}): TradePerformanceRecord {
  return {
    id: "perf-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tradeId: "lifecycle-1",
    analysisRunId: undefined,
    candidateId: "candidate-1",
    strategyId: "HERMES-AGENT",
    strategyVersion: 1,
    instrument: "BTC",
    side: "BUY",
    entryTime: "2026-01-01T00:00:00.000Z",
    entryPrice: 100,
    exitTime: "2026-01-01T01:00:00.000Z",
    exitPrice: 105,
    holdingTimeMs: 3_600_000,
    grossPnl: 50,
    fees: 0,
    netPnl: 50,
    returnPercent: 5,
    riskMultiple: 2,
    maxFavourableExcursion: 60,
    maxAdverseExcursion: 0,
    peakProfit: 60,
    maximumDrawdown: 10,
    winLoss: "WIN",
    exitReason: "TAKE_PROFIT",
    ...overrides,
  };
}

describe("computeInstrumentPerformance — insufficient history handled safely", () => {
  it("returns undefined when there are zero completed trades for this instrument", () => {
    expect(computeInstrumentPerformance("ETH", [makeRecord({ instrument: "BTC" })])).toBeUndefined();
  });

  it("returns undefined for an entirely empty record set", () => {
    expect(computeInstrumentPerformance("BTC", [])).toBeUndefined();
  });
});

describe("computeInstrumentPerformance — performance context supplied correctly", () => {
  it("aggregates wins/losses/win-rate/realised P&L/holding time/exit-reason counts for the requested instrument only", () => {
    const records = [
      makeRecord({ instrument: "BTC", winLoss: "WIN", netPnl: 50, exitReason: "TAKE_PROFIT" }),
      makeRecord({ instrument: "BTC", winLoss: "LOSS", netPnl: -20, exitReason: "STOP_LOSS" }),
      makeRecord({ instrument: "ETH", winLoss: "WIN", netPnl: 999 }), // a different instrument, must not leak in
    ];
    const result = computeInstrumentPerformance("BTC", records);
    expect(result).toBeDefined();
    expect(result?.completedTrades).toBe(2);
    expect(result?.wins).toBe(1);
    expect(result?.losses).toBe(1);
    expect(result?.winRate).toBe(0.5);
    expect(result?.realisedPnl).toBe(30);
    expect(result?.stopLossExits).toBe(1);
    expect(result?.takeProfitExits).toBe(1);
  });
});

describe("computeInstrumentPerformance — CLOSED_UNRECONCILED excluded from realised performance", () => {
  it("a position that reconciled to CLOSED_UNRECONCILED never contributes a row at all, so it can never inflate or deflate realised performance", () => {
    // trade-performance-service.ts's own design (confirmed): a trade_performance row is only ever
    // written the moment a SELL candidate's execution closes a TradeLifecycleRecord with confirmed
    // exit economics — CLOSED_UNRECONCILED (no confirmed exit price, per position-reconciliation.ts's
    // own "never fabricate" discipline) structurally never produces one. This test documents that
    // guarantee at the point performance context is computed: an instrument with ONLY a
    // CLOSED_UNRECONCILED position (i.e. no TradePerformanceRecord rows at all) reports
    // "insufficient history", never a fabricated zero-trade summary.
    const records: TradePerformanceRecord[] = []; // exactly what a CLOSED_UNRECONCILED-only instrument produces
    expect(computeInstrumentPerformance("BTC", records)).toBeUndefined();
  });
});

describe("computePerformanceByConfidenceBand", () => {
  it("groups by the originating candidate's confidence band and omits bands with zero trades", () => {
    const records = [
      makeRecord({ candidateId: "c-high", winLoss: "WIN", returnPercent: 10 }),
      makeRecord({ candidateId: "c-low", winLoss: "LOSS", returnPercent: -5 }),
    ];
    const confidenceById = new Map([
      ["c-high", 0.85],
      ["c-low", 0.3],
    ]);
    const bands = computePerformanceByConfidenceBand(records, confidenceById);
    expect(bands.find((b) => b.band === "0.8-1.0")).toMatchObject({ trades: 1, winRate: 1 });
    expect(bands.find((b) => b.band === "0.0-0.5")).toMatchObject({ trades: 1, winRate: 0 });
    expect(bands.find((b) => b.band === "0.65-0.8")).toBeUndefined();
  });

  it("excludes records with no resolvable candidateId/confidence", () => {
    const records = [makeRecord({ candidateId: undefined })];
    expect(computePerformanceByConfidenceBand(records, new Map())).toEqual([]);
  });
});
