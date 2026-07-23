import type { TradePerformanceRecord } from "./types";

// Phase 4 — Trade Performance Engine. Every function here is pure: takes an already-fetched array
// of TradePerformanceRecord and derives a summary — no I/O, no Supabase, independently unit-
// testable without a database, same discipline analysis-analytics.ts (Phase 2B) already
// established for this exact kind of derived-metrics module.

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function byExitTimeAscending(records: TradePerformanceRecord[]): TradePerformanceRecord[] {
  return [...records].sort((a, b) => a.exitTime.localeCompare(b.exitTime));
}

export interface StrategyPerformanceSummary {
  strategyId: string;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  breakevenCount: number;
  winRate: number;
  lossRate: number;
  averageWinner: number;
  averageLoser: number;
  /** sum(winning net_pnl) / abs(sum(losing net_pnl)). Undefined when there are no losing trades
   * (never Infinity) — a strategy with only wins has no meaningful "how many dollars won per
   * dollar lost" ratio yet. */
  profitFactor: number | undefined;
  expectancy: number;
  averageHoldingTimeMs: number;
  /** Peak-to-trough decline of the CUMULATIVE net_pnl curve for this strategy, ordered by
   * exit_time — a portfolio/equity-curve concept, distinct from any single trade's own
   * maximum_drawdown (see calculate-trade-performance.ts's own doc comment on that distinction). */
  maximumDrawdown: number;
  /** Mean risk_multiple across trades where it was resolvable — trades with an undefined
   * risk_multiple (no opening candidate found) are excluded, never treated as 0. */
  averageRiskMultiple: number | undefined;
  bestTrade: TradePerformanceRecord | undefined;
  worstTrade: TradePerformanceRecord | undefined;
  largestConsecutiveWins: number;
  largestConsecutiveLosses: number;
}

/** A single, portfolio-level (not per-trade) peak-to-trough measurement over a net_pnl-ordered
 * sequence — the same well-defined "equity curve drawdown" concept used both for a single
 * strategy's own summary and for the dashboard's overall equity curve. */
export function computeMaxDrawdown(recordsInOrder: TradePerformanceRecord[]): number {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const record of recordsInOrder) {
    cumulative += record.netPnl;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return maxDrawdown;
}

function longestStreak(recordsInOrder: TradePerformanceRecord[], winLoss: "WIN" | "LOSS"): number {
  let longest = 0;
  let current = 0;
  for (const record of recordsInOrder) {
    if (record.winLoss === winLoss) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

export function computeStrategyPerformance(strategyId: string, records: TradePerformanceRecord[]): StrategyPerformanceSummary {
  const ordered = byExitTimeAscending(records.filter((r) => r.strategyId === strategyId));
  const wins = ordered.filter((r) => r.winLoss === "WIN");
  const losses = ordered.filter((r) => r.winLoss === "LOSS");
  const breakeven = ordered.filter((r) => r.winLoss === "BREAKEVEN");
  const riskMultiples = ordered.map((r) => r.riskMultiple).filter((r): r is number => r !== undefined);

  const grossWinnings = wins.reduce((sum, r) => sum + r.netPnl, 0);
  const grossLosses = losses.reduce((sum, r) => sum + r.netPnl, 0); // negative or zero

  const bestTrade = ordered.length > 0 ? ordered.reduce((best, r) => (r.netPnl > best.netPnl ? r : best)) : undefined;
  const worstTrade = ordered.length > 0 ? ordered.reduce((worst, r) => (r.netPnl < worst.netPnl ? r : worst)) : undefined;

  return {
    strategyId,
    tradeCount: ordered.length,
    winCount: wins.length,
    lossCount: losses.length,
    breakevenCount: breakeven.length,
    winRate: ordered.length > 0 ? wins.length / ordered.length : 0,
    lossRate: ordered.length > 0 ? losses.length / ordered.length : 0,
    averageWinner: mean(wins.map((r) => r.netPnl)),
    averageLoser: mean(losses.map((r) => r.netPnl)),
    profitFactor: grossLosses < 0 ? grossWinnings / Math.abs(grossLosses) : undefined,
    expectancy: mean(ordered.map((r) => r.netPnl)),
    averageHoldingTimeMs: mean(ordered.map((r) => r.holdingTimeMs)),
    maximumDrawdown: computeMaxDrawdown(ordered),
    averageRiskMultiple: riskMultiples.length > 0 ? mean(riskMultiples) : undefined,
    bestTrade,
    worstTrade,
    largestConsecutiveWins: longestStreak(ordered, "WIN"),
    largestConsecutiveLosses: longestStreak(ordered, "LOSS"),
  };
}

export function computeAllStrategyPerformance(records: TradePerformanceRecord[]): StrategyPerformanceSummary[] {
  const strategyIds = [...new Set(records.map((r) => r.strategyId))].sort();
  return strategyIds.map((strategyId) => computeStrategyPerformance(strategyId, records));
}

// --- Dashboard-facing derived series --------------------------------------------------------------

export interface EquityCurvePoint {
  exitTime: string;
  tradeId: string;
  netPnl: number;
  cumulativeNetPnl: number;
}

/** Cumulative net_pnl over time, across every trade passed in (callers filter to one strategy or
 * "all" beforehand) — the running-total series an equity curve chart plots directly. */
export function buildEquityCurve(records: TradePerformanceRecord[]): EquityCurvePoint[] {
  const ordered = byExitTimeAscending(records);
  let cumulative = 0;
  return ordered.map((record) => {
    cumulative += record.netPnl;
    return { exitTime: record.exitTime, tradeId: record.tradeId, netPnl: record.netPnl, cumulativeNetPnl: cumulative };
  });
}

export interface MonthlySummary {
  /** "YYYY-MM", derived from exit_time (UTC) — when a trade closed, not when it opened. */
  month: string;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  netPnl: number;
  winRate: number;
}

export function buildMonthlySummary(records: TradePerformanceRecord[]): MonthlySummary[] {
  const byMonth = new Map<string, TradePerformanceRecord[]>();
  for (const record of records) {
    const month = record.exitTime.slice(0, 7); // "YYYY-MM"
    const bucket = byMonth.get(month) ?? [];
    bucket.push(record);
    byMonth.set(month, bucket);
  }

  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, monthRecords]) => {
      const winCount = monthRecords.filter((r) => r.winLoss === "WIN").length;
      const lossCount = monthRecords.filter((r) => r.winLoss === "LOSS").length;
      return {
        month,
        tradeCount: monthRecords.length,
        winCount,
        lossCount,
        netPnl: monthRecords.reduce((sum, r) => sum + r.netPnl, 0),
        winRate: monthRecords.length > 0 ? winCount / monthRecords.length : 0,
      };
    });
}
