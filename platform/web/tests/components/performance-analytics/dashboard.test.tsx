import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EquityCurveChart } from "@/components/performance-analytics/EquityCurveChart";
import { WinLossPie } from "@/components/performance-analytics/WinLossPie";
import { PnlOverTimeChart } from "@/components/performance-analytics/PnlOverTimeChart";
import { StrategyComparisonChart } from "@/components/performance-analytics/StrategyComparisonChart";
import { TradeDurationChart } from "@/components/performance-analytics/TradeDurationChart";
import { MonthlySummaryTable } from "@/components/performance-analytics/MonthlySummaryTable";
import { StrategySummaryCards } from "@/components/performance-analytics/StrategySummaryCards";
import { ClosedPositionsTable } from "@/components/performance-analytics/ClosedPositionsTable";
import { OpenPositionsTable } from "@/components/performance-analytics/OpenPositionsTable";
import { RecentPerformanceList } from "@/components/performance-analytics/RecentPerformanceList";
import { buildEquityCurve, buildMonthlySummary, computeAllStrategyPerformance } from "@/lib/hermes-execution/trade-performance/trade-performance-analytics";
import type { TradePerformanceRecord } from "@/lib/hermes-execution/trade-performance/types";
import type { TradeCandidate } from "@/lib/hermes-execution/trade-approval/types";

afterEach(cleanup);

let seq = 0;
function makeRecord(overrides: Partial<TradePerformanceRecord> = {}): TradePerformanceRecord {
  seq += 1;
  return {
    id: `performance-${seq}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tradeId: `trade-lifecycle-${seq}`,
    analysisRunId: "analysis-run-1",
    candidateId: `candidate-close-${seq}`,
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

const MARKET_CONTEXT = {
  instrument: "BTC",
  bid: 100,
  ask: 100.05,
  spread: 0.05,
  midPrice: 100.025,
  timestamp: "2026-01-01T00:00:00.000Z",
  positionOpen: true,
  strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "HERMES_APPROVED" as const },
  recentCandles: [],
  ema20: 110,
  ema50: 100,
  rsi14: 55,
  atr14: 1.5,
  volume: 120,
  dailyHigh: 112,
  dailyLow: 98,
  volatility24h: 0.01,
  marketSession: "Crypto Always Open" as const,
  trend: "Bearish" as const,
};

function makeClosingCandidate(id: string): TradeCandidate {
  return {
    id,
    status: "EXECUTED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T01:00:00.000Z",
    analysisRunId: "analysis-run-1",
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    instrument: "BTC",
    direction: "SELL",
    confidence: 0.8,
    entryPrice: 106,
    stopLoss: 110,
    takeProfit: 95,
    riskReward: 2,
    reasoning: ["Trend has turned Bearish"],
    validationNotes: [],
    expiresAt: "2026-01-01T02:00:00.000Z",
    executedAt: "2026-01-01T01:00:00.000Z",
    approvedAt: "2026-01-01T00:50:00.000Z",
    approvedByUserId: "user-1",
    brokerOrderId: "mock-close-1",
    execution: {
      amount: 10,
      marketContext: MARKET_CONTEXT,
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
    },
  };
}

describe("Performance analytics dashboard components", () => {
  it("EquityCurveChart renders a placeholder with no data, and an SVG chart with data", () => {
    const { rerender } = render(<EquityCurveChart points={[]} />);
    expect(screen.getByText(/no closed trades yet/i)).toBeInTheDocument();

    const records = [makeRecord({ netPnl: 60, exitTime: "2026-01-01T01:00:00.000Z" })];
    rerender(<EquityCurveChart points={buildEquityCurve(records)} />);
    expect(screen.getByRole("img", { name: /equity curve/i })).toBeInTheDocument();
  });

  it("WinLossPie renders correct win/loss/breakeven counts in its legend", () => {
    const records = [
      makeRecord({ winLoss: "WIN" }),
      makeRecord({ winLoss: "WIN" }),
      makeRecord({ winLoss: "LOSS" }),
      makeRecord({ winLoss: "BREAKEVEN" }),
    ];
    render(<WinLossPie records={records} />);
    expect(screen.getByText("2 (50%)")).toBeInTheDocument(); // Win
    expect(screen.getAllByText("1 (25%)")).toHaveLength(2); // Loss and Breakeven, one each
  });

  it("PnlOverTimeChart / StrategyComparisonChart / TradeDurationChart render without crashing for empty and populated data", () => {
    const records = [makeRecord(), makeRecord({ winLoss: "LOSS", netPnl: -30, grossPnl: -30 })];
    const summaries = computeAllStrategyPerformance(records);

    render(<PnlOverTimeChart records={[]} />);
    render(<PnlOverTimeChart records={records} />);
    expect(screen.getByRole("img", { name: /net profit and loss per closed trade/i })).toBeInTheDocument();

    render(<StrategyComparisonChart summaries={[]} />);
    render(<StrategyComparisonChart summaries={summaries} />);
    expect(screen.getByRole("img", { name: /net profit and loss by strategy/i })).toBeInTheDocument();

    render(<TradeDurationChart records={[]} />);
    render(<TradeDurationChart records={records} />);
    expect(screen.getByRole("img", { name: /distribution of trade holding times/i })).toBeInTheDocument();
  });

  it("MonthlySummaryTable renders one row per month, most recent first", () => {
    const records = [
      makeRecord({ exitTime: "2026-01-05T00:00:00.000Z" }),
      makeRecord({ exitTime: "2026-02-05T00:00:00.000Z" }),
    ];
    render(<MonthlySummaryTable months={buildMonthlySummary(records)} />);
    const rows = screen.getAllByRole("row");
    // header + 2 data rows, February (more recent) listed first
    expect(rows).toHaveLength(3);
    expect(rows[1]!).toHaveTextContent("2026-02");
    expect(rows[2]!).toHaveTextContent("2026-01");
  });

  it("StrategySummaryCards shows every requested per-strategy metric", () => {
    const records = [makeRecord(), makeRecord({ winLoss: "LOSS", netPnl: -30, grossPnl: -30, riskMultiple: -0.5 })];
    render(<StrategySummaryCards summaries={computeAllStrategyPerformance(records)} />);
    for (const label of [
      "Win rate",
      "Loss rate",
      "Avg winner",
      "Avg loser",
      "Profit factor",
      "Expectancy",
      "Avg hold time",
      "Max drawdown",
      "Avg R multiple",
      "Best trade",
      "Worst trade",
      "Longest win streak",
      "Longest loss streak",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("OpenPositionsTable shows a placeholder when empty and rows when populated", () => {
    const { rerender } = render(<OpenPositionsTable candidates={[]} />);
    expect(screen.getByText(/no open positions/i)).toBeInTheDocument();

    rerender(<OpenPositionsTable candidates={[makeClosingCandidate("candidate-open-1")]} />);
    expect(screen.getByText("BTC")).toBeInTheDocument();
  });

  it("RecentPerformanceList shows at most the 10 most recent trades, newest first", () => {
    const records = Array.from({ length: 15 }, (_, i) =>
      makeRecord({ exitTime: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 3_600_000).toISOString() }),
    );
    render(<RecentPerformanceList records={records} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
  });

  it("ClosedPositionsTable expands a row on click to reveal the full analysis-to-performance chain, and collapses on a second click", async () => {
    const user = userEvent.setup();
    const record = makeRecord({ tradeId: "trade-lifecycle-1", candidateId: "candidate-close-1" });
    const candidatesById = new Map([["candidate-close-1", makeClosingCandidate("candidate-close-1")]]);

    render(<ClosedPositionsTable records={[record]} candidatesById={candidatesById} />);

    // Chain detail is not shown until the row is clicked.
    expect(screen.queryByText("Trend has turned Bearish")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("closed-position-row-trade-lifecycle-1"));

    // Every link in the chain is now visible: Analysis, Indicators, Decision, Trade Candidate,
    // Approval, Execution, Performance.
    expect(screen.getByText("analysis-run-1")).toBeInTheDocument(); // Analysis
    expect(screen.getByText(/EMA20 110.00/)).toBeInTheDocument(); // Indicators
    expect(screen.getByText("Trend has turned Bearish")).toBeInTheDocument(); // Decision
    expect(screen.getByText(/candidate-close-1/)).toBeInTheDocument(); // Trade Candidate
    expect(screen.getByText(/user-1/)).toBeInTheDocument(); // Approval
    expect(screen.getByText("mock-close-1")).toBeInTheDocument(); // Execution

    await user.click(screen.getByTestId("closed-position-row-trade-lifecycle-1"));
    expect(screen.queryByText("Trend has turned Bearish")).not.toBeInTheDocument();
  });
});
