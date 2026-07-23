import { describe, expect, it } from "vitest";
import {
  buildTradePerformanceInput,
  calculatePeakProfitAndDrawdown,
  calculateRiskMultiple,
  classifyWinLoss,
} from "@/lib/hermes-execution/trade-performance/calculate-trade-performance";
import type { TradeLifecycleRecord } from "@/lib/hermes-execution/trade-lifecycle/types";
import type { TradeCandidate } from "@/lib/hermes-execution/trade-approval/types";

function makeClosedRecord(overrides: Partial<TradeLifecycleRecord> = {}): TradeLifecycleRecord {
  return {
    id: "trade-lifecycle-1",
    strategyId: "DEMO-0001",
    symbol: "BTC",
    side: "BUY",
    quantity: 10,
    decision: "BUY",
    confidence: 0.75,
    decisionReasons: ["EMA20 above EMA50"],
    marketDataSnapshot: {
      instrument: "BTC",
      timestamp: "2026-01-01T00:00:00.000Z",
      candles: [],
      bid: 100,
      ask: 100.05,
      spread: 0.05,
      latestPrice: 100.025,
      volume: 120,
    },
    intelligenceSummary: {
      instrument: "BTC",
      bid: 100,
      ask: 100.05,
      spread: 0.05,
      midPrice: 100.025,
      timestamp: "2026-01-01T00:00:00.000Z",
      positionOpen: false,
      strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "HERMES_APPROVED" },
      recentCandles: [],
      ema20: 110,
      ema50: 100,
      rsi14: 55,
      atr14: 1.5,
      volume: 120,
      dailyHigh: 112,
      dailyLow: 98,
      volatility24h: 0.01,
      marketSession: "Crypto Always Open",
      trend: "Bullish",
    },
    status: "CLOSED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T01:00:00.000Z",
    openedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "2026-01-01T01:00:00.000Z",
    entryPrice: 100,
    exitPrice: 106,
    exitReason: "market-decision-sell",
    realisedPnl: 60, // (106 - 100) * 10
    realisedPnlPercent: 6,
    holdingDurationMs: 3_600_000,
    maximumFavourableExcursion: 80,
    maximumAdverseExcursion: -10,
    ...overrides,
  };
}

function makeOpeningCandidate(overrides: Partial<TradeCandidate> = {}): TradeCandidate {
  return {
    id: "candidate-open-1",
    status: "EXECUTED",
    createdAt: "2025-12-31T23:59:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    analysisRunId: undefined,
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    instrument: "BTC",
    direction: "BUY",
    confidence: 0.75,
    entryPrice: 100,
    stopLoss: 95,
    takeProfit: 110,
    riskReward: 2,
    reasoning: ["EMA20 above EMA50"],
    validationNotes: [],
    expiresAt: "2026-01-01T00:20:00.000Z",
    executedAt: "2026-01-01T00:00:00.000Z",
    execution: {
      amount: 10,
      marketContext: makeClosedRecord().intelligenceSummary,
      marketDataSnapshot: makeClosedRecord().marketDataSnapshot,
    },
    ...overrides,
  };
}

describe("classifyWinLoss", () => {
  it("classifies a net_pnl clearly above the breakeven threshold as WIN", () => {
    expect(classifyWinLoss(50)).toBe("WIN");
  });
  it("classifies a net_pnl clearly below the breakeven threshold as LOSS", () => {
    expect(classifyWinLoss(-50)).toBe("LOSS");
  });
  it("classifies a net_pnl within 1 cent of break-even as BREAKEVEN", () => {
    expect(classifyWinLoss(0.005)).toBe("BREAKEVEN");
    expect(classifyWinLoss(-0.005)).toBe("BREAKEVEN");
    expect(classifyWinLoss(0)).toBe("BREAKEVEN");
  });
});

describe("calculateRiskMultiple", () => {
  it("computes net_pnl / dollar risk using the OPENING candidate's own stop-loss distance", () => {
    // risk = |100 - 95| * 10 = 50; net_pnl 60 -> R = 1.2
    const r = calculateRiskMultiple(60, makeOpeningCandidate());
    expect(r).toBeCloseTo(1.2);
  });

  it("is undefined when no opening candidate is available", () => {
    expect(calculateRiskMultiple(60, undefined)).toBeUndefined();
  });

  it("is undefined (never Infinity/NaN) when the resolved stop-loss implies zero risk", () => {
    const r = calculateRiskMultiple(60, makeOpeningCandidate({ entryPrice: 100, stopLoss: 100 }));
    expect(r).toBeUndefined();
  });

  it("computes a negative R for a losing trade", () => {
    const r = calculateRiskMultiple(-25, makeOpeningCandidate());
    expect(r).toBeCloseTo(-0.5);
  });
});

describe("calculatePeakProfitAndDrawdown", () => {
  it("peak_profit equals maximumFavourableExcursion, maximum_drawdown is the give-back from that peak to net_pnl", () => {
    const { peakProfit, maximumDrawdown } = calculatePeakProfitAndDrawdown(80, 60);
    expect(peakProfit).toBe(80);
    expect(maximumDrawdown).toBe(20); // gave back $20 of the $80 peak before closing
  });

  it("maximum_drawdown is floored at 0 when the trade closed at (or above) its own peak", () => {
    const { maximumDrawdown } = calculatePeakProfitAndDrawdown(60, 60);
    expect(maximumDrawdown).toBe(0);
  });

  it("peak_profit is floored at 0 even if maximumFavourableExcursion were somehow negative", () => {
    const { peakProfit } = calculatePeakProfitAndDrawdown(-5, -20);
    expect(peakProfit).toBe(0);
  });
});

describe("buildTradePerformanceInput", () => {
  it("builds a full TradePerformanceInput from a CLOSED record, closing candidate, and opening candidate", () => {
    const record = makeClosedRecord();
    const closingCandidate = { id: "candidate-close-1", analysisRunId: "analysis-run-9" };
    const opening = makeOpeningCandidate();

    const input = buildTradePerformanceInput({ record, closingCandidate, openingCandidate: opening });

    expect(input.tradeId).toBe("trade-lifecycle-1");
    expect(input.candidateId).toBe("candidate-close-1");
    expect(input.analysisRunId).toBe("analysis-run-9");
    expect(input.strategyId).toBe("DEMO-0001");
    expect(input.strategyVersion).toBe(1);
    expect(input.instrument).toBe("BTC");
    expect(input.entryPrice).toBe(100);
    expect(input.exitPrice).toBe(106);
    expect(input.holdingTimeMs).toBe(3_600_000);
    expect(input.grossPnl).toBe(60);
    expect(input.fees).toBe(0);
    expect(input.netPnl).toBe(60);
    expect(input.returnPercent).toBeCloseTo(6); // 60 / (100*10) * 100
    expect(input.riskMultiple).toBeCloseTo(1.2);
    expect(input.maxFavourableExcursion).toBe(80);
    expect(input.maxAdverseExcursion).toBe(-10);
    expect(input.peakProfit).toBe(80);
    expect(input.maximumDrawdown).toBe(20);
    expect(input.winLoss).toBe("WIN");
    expect(input.exitReason).toBe("market-decision-sell");
  });

  it("subtracts fees from gross_pnl to compute net_pnl and re-derives win_loss from net, not gross", () => {
    const record = makeClosedRecord({ realisedPnl: 5 }); // small gross win
    const input = buildTradePerformanceInput({
      record,
      closingCandidate: { id: "c", analysisRunId: undefined },
      openingCandidate: undefined,
      fees: 10, // fees exceed the gross win
    });
    expect(input.grossPnl).toBe(5);
    expect(input.netPnl).toBe(-5);
    expect(input.winLoss).toBe("LOSS");
  });

  it("leaves riskMultiple undefined when no opening candidate is resolvable", () => {
    const record = makeClosedRecord();
    const input = buildTradePerformanceInput({
      record,
      closingCandidate: { id: "c", analysisRunId: undefined },
      openingCandidate: undefined,
    });
    expect(input.riskMultiple).toBeUndefined();
  });

  it("throws when the record is not CLOSED", () => {
    const record = makeClosedRecord({ status: "OPEN" });
    expect(() =>
      buildTradePerformanceInput({ record, closingCandidate: { id: "c", analysisRunId: undefined }, openingCandidate: undefined }),
    ).toThrow(/CLOSED/);
  });

  it("throws when a CLOSED record is somehow missing required close fields (data-integrity guard)", () => {
    const record = makeClosedRecord({ realisedPnl: undefined });
    expect(() =>
      buildTradePerformanceInput({ record, closingCandidate: { id: "c", analysisRunId: undefined }, openingCandidate: undefined }),
    ).toThrow(/missing required close fields/);
  });
});
