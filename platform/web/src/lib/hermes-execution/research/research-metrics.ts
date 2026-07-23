import type { ResearchDecisionPoint, ResearchMetrics, SimulatedTrade } from "./types";

// Phase 5 — Strategy Research Laboratory. Pure functions only — no I/O. Deliberately self-contained
// (does not import trade-performance/trade-performance-analytics.ts, kept out of scope this phase)
// even though a few formulas are conceptually similar to that module's own (win rate, profit
// factor, expectancy, equity-curve drawdown) — small, acceptable duplication in exchange for this
// research module never depending on the protected analytics system at all.

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function computeMaxDrawdown(tradesInExitOrder: SimulatedTrade[]): number {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of tradesInExitOrder) {
    cumulative += trade.grossPnl;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return maxDrawdown;
}

function daysBetween(sinceIso: string, untilIso: string): number {
  const ms = Date.parse(untilIso) - Date.parse(sinceIso);
  return Math.max(ms / 86_400_000, 1 / 24); // floor at one hour, so a same-hour window never divides by ~0
}

export function computeResearchMetrics(
  decisionPoints: ResearchDecisionPoint[],
  trades: SimulatedTrade[],
  window: { since: string; until: string },
): ResearchMetrics {
  const orderedTrades = [...trades].sort((a, b) => a.exitTime.localeCompare(b.exitTime));
  const wins = orderedTrades.filter((t) => t.grossPnl > 0.01);
  const losses = orderedTrades.filter((t) => t.grossPnl < -0.01);
  const grossWinnings = wins.reduce((sum, t) => sum + t.grossPnl, 0);
  const grossLosses = losses.reduce((sum, t) => sum + t.grossPnl, 0);
  const riskMultiples = orderedTrades.map((t) => t.riskMultiple).filter((r): r is number => r !== undefined);
  const returns = orderedTrades.map((t) => t.returnPercent);
  const returnStdDev = standardDeviation(returns);

  const opportunityCount = decisionPoints.length;
  const skippedCount = decisionPoints.filter((d) => d.action === "HOLD").length;
  const days = daysBetween(window.since, window.until);

  return {
    opportunityCount,
    skippedCount,
    tradeCount: orderedTrades.length,
    tradeFrequency: opportunityCount > 0 ? orderedTrades.length / opportunityCount : 0,
    opportunityFrequencyPerDay: opportunityCount / days,
    winRate: orderedTrades.length > 0 ? wins.length / orderedTrades.length : 0,
    lossRate: orderedTrades.length > 0 ? losses.length / orderedTrades.length : 0,
    expectancy: mean(orderedTrades.map((t) => t.grossPnl)),
    profitFactor: grossLosses < 0 ? grossWinnings / Math.abs(grossLosses) : undefined,
    averageRiskMultiple: riskMultiples.length > 0 ? mean(riskMultiples) : undefined,
    sharpeRatio: returns.length >= 2 && returnStdDev > 0 ? mean(returns) / returnStdDev : undefined,
    maximumDrawdown: computeMaxDrawdown(orderedTrades),
    averageHoldingTimeMs: mean(orderedTrades.map((t) => t.holdingTimeMs)),
  };
}

export function buildResearchEquityCurve(trades: SimulatedTrade[]): { timestamp: string; cumulativeNetPnl: number }[] {
  const ordered = [...trades].sort((a, b) => a.exitTime.localeCompare(b.exitTime));
  let cumulative = 0;
  return ordered.map((trade) => {
    cumulative += trade.grossPnl;
    return { timestamp: trade.exitTime, cumulativeNetPnl: cumulative };
  });
}
