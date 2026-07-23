import type {
  DecisionDifference,
  MetricDelta,
  ResearchComparisonResult,
  ResearchMetrics,
  ResearchRunResult,
  SimulatedTrade,
  TradeDifferenceSummary,
} from "./types";

// Phase 5 — Strategy Research Laboratory. Pure diffing over two already-computed ResearchRunResult
// values — no I/O, no re-running either strategy. Matches decision points by analysisRunId (never
// by array position) since that is the one identifier guaranteed stable across two independent
// runStrategyResearch() calls made with the same instrument/date-range filter.

const NUMERIC_METRICS: (keyof ResearchMetrics)[] = [
  "opportunityCount",
  "skippedCount",
  "tradeCount",
  "tradeFrequency",
  "opportunityFrequencyPerDay",
  "winRate",
  "lossRate",
  "expectancy",
  "profitFactor",
  "averageRiskMultiple",
  "sharpeRatio",
  "maximumDrawdown",
  "averageHoldingTimeMs",
];

function buildMetricDeltas(a: ResearchMetrics, b: ResearchMetrics): MetricDelta[] {
  return NUMERIC_METRICS.map((metric) => {
    const aValue = a[metric];
    const bValue = b[metric];
    return {
      metric,
      a: aValue,
      b: bValue,
      delta: aValue !== undefined && bValue !== undefined ? bValue - aValue : undefined,
    };
  });
}

function buildDecisionDifferences(a: ResearchRunResult, b: ResearchRunResult): DecisionDifference[] {
  const bByRunId = new Map(b.decisionPoints.map((point) => [point.analysisRunId, point]));
  const differences: DecisionDifference[] = [];
  for (const pointA of a.decisionPoints) {
    const pointB = bByRunId.get(pointA.analysisRunId);
    if (!pointB || pointB.action === pointA.action) continue;
    differences.push({
      analysisRunId: pointA.analysisRunId,
      timestamp: pointA.context.timestamp,
      actionA: pointA.action,
      actionB: pointB.action,
    });
  }
  return differences;
}

/** Trades are matched by entryTime — the same historical bar can only ever produce one BUY per
 * strategy under this simulator's own single-position-at-a-time rule, so entryTime is a safe,
 * stable join key between two runs over the identical historical window. A "divergent" trade is one
 * both strategies entered at the same bar but closed with a meaningfully different outcome (net
 * P/L differing by more than 1 cent — the same break-even tolerance used throughout this platform). */
function buildTradeDifferences(a: ResearchRunResult, b: ResearchRunResult): TradeDifferenceSummary {
  const bByEntryTime = new Map(b.trades.map((trade) => [trade.entryTime, trade]));
  const aEntryTimes = new Set(a.trades.map((trade) => trade.entryTime));

  const tradesOnlyInA: SimulatedTrade[] = [];
  const divergentTrades: { a: SimulatedTrade; b: SimulatedTrade }[] = [];

  for (const tradeA of a.trades) {
    const tradeB = bByEntryTime.get(tradeA.entryTime);
    if (!tradeB) {
      tradesOnlyInA.push(tradeA);
    } else if (Math.abs(tradeA.grossPnl - tradeB.grossPnl) > 0.01) {
      divergentTrades.push({ a: tradeA, b: tradeB });
    }
  }
  const tradesOnlyInB = b.trades.filter((trade) => !aEntryTimes.has(trade.entryTime));

  return { tradesOnlyInA, tradesOnlyInB, divergentTrades };
}

export function compareResearchRuns(a: ResearchRunResult, b: ResearchRunResult): ResearchComparisonResult {
  return {
    a,
    b,
    metricDeltas: buildMetricDeltas(a.metrics, b.metrics),
    decisionDifferences: buildDecisionDifferences(a, b),
    tradeDifferences: buildTradeDifferences(a, b),
  };
}
