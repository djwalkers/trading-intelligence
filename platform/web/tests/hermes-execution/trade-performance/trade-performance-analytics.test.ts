import { describe, expect, it } from "vitest";
import {
  buildEquityCurve,
  buildMonthlySummary,
  computeAllStrategyPerformance,
  computeMaxDrawdown,
  computeStrategyPerformance,
} from "@/lib/hermes-execution/trade-performance/trade-performance-analytics";
import type { TradePerformanceRecord, WinLoss } from "@/lib/hermes-execution/trade-performance/types";

let seq = 0;
function makeRecord(overrides: Partial<TradePerformanceRecord> = {}): TradePerformanceRecord {
  seq += 1;
  return {
    id: `performance-${seq}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tradeId: `trade-lifecycle-${seq}`,
    analysisRunId: undefined,
    candidateId: undefined,
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    instrument: "BTC",
    side: "BUY",
    entryTime: "2026-01-01T00:00:00.000Z",
    entryPrice: 100,
    exitTime: "2026-01-01T01:00:00.000Z",
    exitPrice: 106,
    holdingTimeMs: 3_600_000,
    grossPnl: 60,
    fees: 0,
    netPnl: 60,
    returnPercent: 6,
    riskMultiple: 1.2,
    maxFavourableExcursion: 80,
    maxAdverseExcursion: -10,
    peakProfit: 80,
    maximumDrawdown: 20,
    winLoss: "WIN",
    exitReason: "market-decision-sell",
    ...overrides,
  };
}

function win(exitTime: string, netPnl = 100): TradePerformanceRecord {
  return makeRecord({ exitTime, netPnl, grossPnl: netPnl, winLoss: "WIN" as WinLoss, riskMultiple: 2 });
}
function loss(exitTime: string, netPnl = -40): TradePerformanceRecord {
  return makeRecord({ exitTime, netPnl, grossPnl: netPnl, winLoss: "LOSS" as WinLoss, riskMultiple: -0.8 });
}

describe("computeMaxDrawdown", () => {
  it("is 0 for a monotonically increasing equity curve", () => {
    const records = [win("2026-01-01T00:00:00.000Z", 10), win("2026-01-02T00:00:00.000Z", 10)];
    expect(computeMaxDrawdown(records)).toBe(0);
  });

  it("measures the peak-to-trough decline of the cumulative net_pnl curve", () => {
    // cumulative: +100, +150 (peak), +90 (trough, drawdown 60), +130
    const records = [
      win("2026-01-01T00:00:00.000Z", 100),
      win("2026-01-02T00:00:00.000Z", 50),
      loss("2026-01-03T00:00:00.000Z", -60),
      win("2026-01-04T00:00:00.000Z", 40),
    ];
    expect(computeMaxDrawdown(records)).toBe(60);
  });
});

describe("computeStrategyPerformance", () => {
  it("computes win rate / loss rate / averages / profit factor / expectancy for a mixed strategy", () => {
    const records = [
      win("2026-01-01T00:00:00.000Z", 100),
      win("2026-01-02T00:00:00.000Z", 50),
      loss("2026-01-03T00:00:00.000Z", -40),
      makeRecord({ exitTime: "2026-01-04T00:00:00.000Z", netPnl: 0, grossPnl: 0, winLoss: "BREAKEVEN" }),
    ];

    const summary = computeStrategyPerformance("DEMO-0001", records);

    expect(summary.tradeCount).toBe(4);
    expect(summary.winCount).toBe(2);
    expect(summary.lossCount).toBe(1);
    expect(summary.breakevenCount).toBe(1);
    expect(summary.winRate).toBeCloseTo(0.5);
    expect(summary.lossRate).toBeCloseTo(0.25);
    expect(summary.averageWinner).toBeCloseTo(75); // (100+50)/2
    expect(summary.averageLoser).toBeCloseTo(-40);
    expect(summary.profitFactor).toBeCloseTo(150 / 40);
    expect(summary.expectancy).toBeCloseTo((100 + 50 - 40 + 0) / 4);
  });

  it("profit factor is undefined (never Infinity) when there are no losing trades", () => {
    const records = [win("2026-01-01T00:00:00.000Z"), win("2026-01-02T00:00:00.000Z")];
    const summary = computeStrategyPerformance("DEMO-0001", records);
    expect(summary.profitFactor).toBeUndefined();
  });

  it("identifies the best and worst trade by net_pnl", () => {
    const best = win("2026-01-02T00:00:00.000Z", 500);
    const worst = loss("2026-01-03T00:00:00.000Z", -300);
    const records = [win("2026-01-01T00:00:00.000Z", 10), best, worst];
    const summary = computeStrategyPerformance("DEMO-0001", records);
    expect(summary.bestTrade?.tradeId).toBe(best.tradeId);
    expect(summary.worstTrade?.tradeId).toBe(worst.tradeId);
  });

  it("finds the largest consecutive win/loss streaks in exit-time order, broken by a breakeven", () => {
    const records = [
      win("2026-01-01T00:00:00.000Z"),
      win("2026-01-02T00:00:00.000Z"),
      win("2026-01-03T00:00:00.000Z"),
      loss("2026-01-04T00:00:00.000Z"),
      makeRecord({ exitTime: "2026-01-05T00:00:00.000Z", netPnl: 0, winLoss: "BREAKEVEN" }),
      loss("2026-01-06T00:00:00.000Z"),
      loss("2026-01-07T00:00:00.000Z"),
    ];
    const summary = computeStrategyPerformance("DEMO-0001", records);
    expect(summary.largestConsecutiveWins).toBe(3);
    expect(summary.largestConsecutiveLosses).toBe(2); // the breakeven breaks the loss streak before it reaches 3
  });

  it("averageRiskMultiple excludes trades with an undefined risk_multiple rather than treating them as 0", () => {
    const records = [win("2026-01-01T00:00:00.000Z"), win("2026-01-02T00:00:00.000Z", 100)];
    records[1]!.riskMultiple = undefined;
    const summary = computeStrategyPerformance("DEMO-0001", records);
    expect(summary.averageRiskMultiple).toBe(2); // only the first record's R (2) counts
  });

  it("only includes records for the requested strategyId", () => {
    const records = [win("2026-01-01T00:00:00.000Z"), makeRecord({ strategyId: "OTHER-STRAT", exitTime: "2026-01-02T00:00:00.000Z" })];
    const summary = computeStrategyPerformance("DEMO-0001", records);
    expect(summary.tradeCount).toBe(1);
  });
});

describe("computeAllStrategyPerformance", () => {
  it("returns one summary per distinct strategyId present, sorted", () => {
    const records = [
      makeRecord({ strategyId: "STRAT-B", exitTime: "2026-01-01T00:00:00.000Z" }),
      makeRecord({ strategyId: "STRAT-A", exitTime: "2026-01-02T00:00:00.000Z" }),
    ];
    const summaries = computeAllStrategyPerformance(records);
    expect(summaries.map((s) => s.strategyId)).toEqual(["STRAT-A", "STRAT-B"]);
  });
});

describe("buildEquityCurve", () => {
  it("returns a running cumulative net_pnl series ordered by exit_time", () => {
    const records = [loss("2026-01-02T00:00:00.000Z", -30), win("2026-01-01T00:00:00.000Z", 100)]; // deliberately out of order
    const curve = buildEquityCurve(records);
    expect(curve.map((p) => p.cumulativeNetPnl)).toEqual([100, 70]);
    expect(curve[0]!.exitTime).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("buildMonthlySummary", () => {
  it("groups trades by exit month (YYYY-MM) and computes per-month totals", () => {
    const records = [
      win("2026-01-05T00:00:00.000Z", 100),
      loss("2026-01-20T00:00:00.000Z", -40),
      win("2026-02-01T00:00:00.000Z", 50),
    ];
    const summary = buildMonthlySummary(records);
    expect(summary).toEqual([
      { month: "2026-01", tradeCount: 2, winCount: 1, lossCount: 1, netPnl: 60, winRate: 0.5 },
      { month: "2026-02", tradeCount: 1, winCount: 1, lossCount: 0, netPnl: 50, winRate: 1 },
    ]);
  });
});
