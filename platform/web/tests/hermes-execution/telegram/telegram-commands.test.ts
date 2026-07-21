import { describe, expect, it } from "vitest";
import {
  formatHelp,
  formatPnl,
  formatPositions,
  formatStatus,
  formatTrades,
  summarizePnl,
} from "@/lib/hermes-execution/telegram/telegram-commands";
import type { TradingRuntimeStatus } from "@/lib/hermes-execution/runtime/types";
import type { TradeLifecycleRecord, TradeLifecycleStatus } from "@/lib/hermes-execution/trade-lifecycle/types";
import type { MarketDataSnapshot } from "@/lib/hermes-execution/market-data/market-data-provider";
import type { MarketDecisionContext } from "@/lib/hermes-execution/market-decision-engine";

const MARKET_DATA_SNAPSHOT: MarketDataSnapshot = {
  instrument: "BTC",
  timestamp: "2026-01-01T00:00:00.000Z",
  candles: [],
  bid: 100,
  ask: 100.1,
  spread: 0.1,
  latestPrice: 100.05,
  volume: 10,
};

const INTELLIGENCE_SUMMARY: MarketDecisionContext = {
  instrument: "BTC",
  bid: 100,
  ask: 100.1,
  spread: 0.1,
  midPrice: 100.05,
  timestamp: "2026-01-01T00:00:00.000Z",
  positionOpen: false,
  strategy: { strategyId: "STRAT-0001", version: 1, sourceType: "HERMES_APPROVED" },
  recentCandles: [],
  ema20: 101,
  ema50: 99,
  rsi14: 55,
  atr14: 1,
  volume: 10,
  dailyHigh: 102,
  dailyLow: 98,
  volatility24h: 0.01,
  marketSession: "Crypto Always Open",
  trend: "Bullish",
};

function makeRecord(id: string, status: TradeLifecycleStatus, overrides: Partial<TradeLifecycleRecord> = {}): TradeLifecycleRecord {
  return {
    id,
    strategyId: "STRAT-0001",
    symbol: "BTC",
    side: "BUY",
    quantity: 10,
    decision: "BUY",
    confidence: 0.7,
    decisionReasons: ["EMA20 above EMA50"],
    marketDataSnapshot: MARKET_DATA_SNAPSHOT,
    intelligenceSummary: INTELLIGENCE_SUMMARY,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function baseStatus(overrides: Partial<TradingRuntimeStatus> = {}): TradingRuntimeStatus {
  return {
    state: "RUNNING",
    startedAt: "2026-01-01T00:00:00.000Z",
    pausedAt: null,
    stoppedAt: null,
    intervalMs: 60_000,
    isCycleRunning: false,
    lastRunStartedAt: null,
    lastRunCompletedAt: null,
    nextRunAt: "2026-01-01T00:01:00.000Z",
    successfulRunCount: 0,
    failedRunCount: 0,
    skippedOverlapCount: 0,
    skippedPausedCount: 0,
    skippedMarketClosedCount: 0,
    lastResult: null,
    lastError: null,
    ...overrides,
  };
}

describe("formatStatus", () => {
  it("includes state, timestamps, and cycle counters", () => {
    const text = formatStatus(baseStatus({ state: "PAUSED", successfulRunCount: 3, failedRunCount: 1 }));
    expect(text).toContain("State: PAUSED");
    expect(text).toContain("Successful/failed cycles: 3/1");
  });

  it("includes the last result when present", () => {
    const text = formatStatus(
      baseStatus({ lastResult: { decision: "BUY", executed: true, instrument: "BTC" } }),
    );
    expect(text).toContain("Last decision: BUY on BTC (executed: true)");
  });

  it("includes the last error when present", () => {
    const text = formatStatus(
      baseStatus({ lastError: { message: "broker unreachable", occurredAt: "2026-01-01T00:05:00.000Z" } }),
    );
    expect(text).toContain("Last error: broker unreachable");
  });

  it("omits last-result/last-error lines when neither is present", () => {
    const text = formatStatus(baseStatus());
    expect(text).not.toContain("Last decision:");
    expect(text).not.toContain("Last error:");
  });
});

describe("formatPositions", () => {
  it("reports no open positions when the list is empty", () => {
    expect(formatPositions([])).toBe("No open positions.");
  });

  it("lists each open record's symbol, status, entry price, and quantity", () => {
    const text = formatPositions([makeRecord("t1", "OPEN", { entryPrice: 50_000, quantity: 0.01 })]);
    expect(text).toContain("BTC — OPEN");
    expect(text).toContain("entry 50000");
    expect(text).toContain("qty 0.01");
  });

  it("includes MFE/MAE when present", () => {
    const text = formatPositions([
      makeRecord("t1", "OPEN", { maximumFavourableExcursion: 12.5, maximumAdverseExcursion: -3.25 }),
    ]);
    expect(text).toContain("MFE 12.50 / MAE -3.25");
  });
});

describe("formatTrades", () => {
  it("reports no completed trades when the list is empty", () => {
    expect(formatTrades([])).toBe("No completed trades yet.");
  });

  it("orders most-recent-first and caps at the given limit", () => {
    const records = [
      makeRecord("t1", "CLOSED", { closedAt: "2026-01-01T00:00:00.000Z", entryPrice: 1, exitPrice: 1 }),
      makeRecord("t2", "CLOSED", { closedAt: "2026-01-03T00:00:00.000Z", entryPrice: 2, exitPrice: 2 }),
      makeRecord("t3", "CLOSED", { closedAt: "2026-01-02T00:00:00.000Z", entryPrice: 3, exitPrice: 3 }),
    ];
    const lines = formatTrades(records, 2).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("entry 2 -> exit 2");
    expect(lines[1]).toContain("entry 3 -> exit 3");
  });

  it("includes realised P/L and exit reason for each trade", () => {
    const text = formatTrades([
      makeRecord("t1", "CLOSED", {
        closedAt: "2026-01-01T00:00:00.000Z",
        entryPrice: 100,
        exitPrice: 110,
        realisedPnl: 10,
        realisedPnlPercent: 10,
        exitReason: "take-profit",
      }),
    ]);
    expect(text).toContain("P/L 10.00 (10.00%)");
    expect(text).toContain("reason: take-profit");
  });
});

describe("summarizePnl / formatPnl", () => {
  it("returns a zeroed summary and 'no trades' message for an empty list", () => {
    expect(summarizePnl([])).toEqual({
      tradeCount: 0,
      winCount: 0,
      winRate: 0,
      totalRealisedPnl: 0,
      averageRealisedPnlPercent: 0,
    });
    expect(formatPnl([])).toBe("No completed trades yet.");
  });

  it("computes win rate, total realised P/L, and average realised P/L% across closed trades", () => {
    const records = [
      makeRecord("t1", "CLOSED", { realisedPnl: 10, realisedPnlPercent: 5 }),
      makeRecord("t2", "CLOSED", { realisedPnl: -4, realisedPnlPercent: -2 }),
      makeRecord("t3", "CLOSED", { realisedPnl: 6, realisedPnlPercent: 3 }),
    ];
    const summary = summarizePnl(records);
    expect(summary.tradeCount).toBe(3);
    expect(summary.winCount).toBe(2);
    expect(summary.winRate).toBeCloseTo(2 / 3);
    expect(summary.totalRealisedPnl).toBe(12);
    expect(summary.averageRealisedPnlPercent).toBeCloseTo(2);
  });

  it("excludes records with no realisedPnl from the summary", () => {
    const records = [makeRecord("t1", "CLOSE_FAILED"), makeRecord("t2", "CLOSED", { realisedPnl: 5, realisedPnlPercent: 1 })];
    expect(summarizePnl(records).tradeCount).toBe(1);
  });

  it("formatPnl renders win rate and totals as readable text", () => {
    const text = formatPnl([makeRecord("t1", "CLOSED", { realisedPnl: 20, realisedPnlPercent: 4 })]);
    expect(text).toContain("Trades: 1");
    expect(text).toContain("Win rate: 100.0%");
    expect(text).toContain("Total realised P/L: 20.00");
  });
});

describe("formatHelp", () => {
  it("documents exactly the eight supported commands", () => {
    const text = formatHelp();
    for (const command of ["/status", "/positions", "/trades", "/pnl", "/pause", "/resume", "/run", "/help"]) {
      expect(text).toContain(command);
    }
  });
});
