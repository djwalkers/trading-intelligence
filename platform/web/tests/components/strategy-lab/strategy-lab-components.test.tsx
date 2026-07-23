import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ComparisonEquityCurveChart } from "@/components/strategy-lab/ComparisonEquityCurveChart";
import { MetricComparisonTable } from "@/components/strategy-lab/MetricComparisonTable";
import { DecisionDifferencesTable } from "@/components/strategy-lab/DecisionDifferencesTable";
import { TradeDifferencesTable } from "@/components/strategy-lab/TradeDifferencesTable";
import { computeResearchMetrics, buildResearchEquityCurve } from "@/lib/hermes-execution/research/research-metrics";
import { compareResearchRuns } from "@/lib/hermes-execution/research/research-comparison";
import type { ResearchDecisionPoint, ResearchRunResult, SimulatedTrade } from "@/lib/hermes-execution/research/types";

afterEach(cleanup);

function makeContext(overrides: Partial<ResearchDecisionPoint["context"]> = {}) {
  return {
    instrument: "BTC",
    bid: 100,
    ask: 100.05,
    spread: 0.05,
    midPrice: 100.025,
    timestamp: "2026-01-01T00:00:00.000Z",
    positionOpen: false,
    strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "DEMO_ONLY" as const },
    recentCandles: [],
    ema20: 110,
    ema50: 100,
    rsi14: 55,
    atr14: 1.5,
    volume: 0,
    dailyHigh: 100.05,
    dailyLow: 100,
    volatility24h: undefined,
    marketSession: "Crypto Always Open" as const,
    trend: "Bullish" as const,
    ...overrides,
  };
}

function makeDecisionPoint(analysisRunId: string, action: "BUY" | "SELL" | "HOLD", timestamp: string): ResearchDecisionPoint {
  return { analysisRunId, action, confidence: 0.7, reasoning: [], context: makeContext({ timestamp }) };
}

function makeTrade(overrides: Partial<SimulatedTrade> = {}): SimulatedTrade {
  return {
    entryTime: "2026-01-01T01:00:00.000Z",
    entryPrice: 100.05,
    exitTime: "2026-01-01T03:00:00.000Z",
    exitPrice: 112,
    holdingTimeMs: 2 * 3_600_000,
    grossPnl: 119.5,
    returnPercent: 11.9,
    riskMultiple: 1.5,
    maxFavourableExcursion: 130,
    maxAdverseExcursion: 0,
    ...overrides,
  };
}

function makeResult(strategyId: string, decisionPoints: ResearchDecisionPoint[], trades: SimulatedTrade[]): ResearchRunResult {
  const window = { since: "2026-01-01T00:00:00.000Z", until: "2026-01-01T04:00:00.000Z" };
  return {
    strategyId,
    strategyVersion: 1,
    instrument: "BTC",
    ...window,
    decisionPoints,
    trades,
    equityCurve: buildResearchEquityCurve(trades),
    metrics: computeResearchMetrics(decisionPoints, trades, window),
  };
}

describe("Strategy Laboratory dashboard components", () => {
  it("ComparisonEquityCurveChart shows a placeholder when neither side traded, and an SVG chart with both series labelled when they did", () => {
    const empty = makeResult("DEMO-0001", [], []);
    const { rerender } = render(<ComparisonEquityCurveChart a={empty} b={empty} />);
    expect(screen.getByText(/neither strategy took a trade/i)).toBeInTheDocument();

    const a = makeResult("DEMO-0001", [], [makeTrade({ grossPnl: 100 })]);
    const b = makeResult("RESEARCH-0001", [], [makeTrade({ grossPnl: 40 }), makeTrade({ grossPnl: 20 })]);
    rerender(<ComparisonEquityCurveChart a={a} b={b} />);
    expect(screen.getByRole("img", { name: /equity curves for DEMO-0001 and RESEARCH-0001/i })).toBeInTheDocument();
    expect(screen.getByText(/DEMO-0001 \(1 trades\)/)).toBeInTheDocument();
    expect(screen.getByText(/RESEARCH-0001 \(2 trades\)/)).toBeInTheDocument();
  });

  it("MetricComparisonTable renders one row per metric with correctly formatted A/B/delta values", () => {
    const a = makeResult("DEMO-0001", [makeDecisionPoint("r1", "HOLD", "t1")], []);
    const b = makeResult("RESEARCH-0001", [makeDecisionPoint("r1", "BUY", "t1")], [makeTrade()]);
    const comparison = compareResearchRuns(a, b);

    render(<MetricComparisonTable deltas={comparison.metricDeltas} labelA="DEMO-0001" labelB="RESEARCH-0001" />);
    expect(screen.getByText("Trades")).toBeInTheDocument();
    expect(screen.getByText("Win rate")).toBeInTheDocument();
    expect(screen.getByText("Sharpe ratio (approx.)")).toBeInTheDocument();
    // tradeCount row: A=0, B=1, delta=+1.00
    const row = screen.getByText("Trades").closest("tr")!;
    expect(row).toHaveTextContent("0.00");
    expect(row).toHaveTextContent("1.00");
    expect(row).toHaveTextContent("+1.00");
  });

  it("DecisionDifferencesTable shows a positive message when there are none, and a row per difference otherwise", () => {
    const { rerender } = render(<DecisionDifferencesTable differences={[]} labelA="A" labelB="B" />);
    expect(screen.getByText(/no decision differences/i)).toBeInTheDocument();

    rerender(
      <DecisionDifferencesTable
        differences={[{ analysisRunId: "r1", timestamp: "2026-01-01T00:00:00.000Z", actionA: "BUY", actionB: "HOLD" }]}
        labelA="A"
        labelB="B"
      />,
    );
    expect(screen.getAllByText("BUY").length).toBeGreaterThan(0);
    expect(screen.getAllByText("HOLD").length).toBeGreaterThan(0);
  });

  it("TradeDifferencesTable shows a positive message with no differences, and sections for only-A/only-B/divergent trades", () => {
    const { rerender } = render(
      <TradeDifferencesTable summary={{ tradesOnlyInA: [], tradesOnlyInB: [], divergentTrades: [] }} labelA="A" labelB="B" />,
    );
    expect(screen.getByText(/no trade differences/i)).toBeInTheDocument();

    const onlyA = makeTrade({ grossPnl: 55 });
    rerender(<TradeDifferencesTable summary={{ tradesOnlyInA: [onlyA], tradesOnlyInB: [], divergentTrades: [] }} labelA="Strategy A" labelB="Strategy B" />);
    expect(screen.getByText(/trades only Strategy A took \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/\+55\.00/)).toBeInTheDocument();
  });
});
