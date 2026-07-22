import type { AnalysisDecision, AnalysisRun, StrategyPerformanceSummary } from "./types";
import type { TrendClassification } from "../technical-indicators";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence.

const TRENDS: TrendClassification[] = ["Bullish", "Bearish", "Sideways"];

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function percent(count: number, total: number): number {
  if (total === 0) return 0;
  return (count / total) * 100;
}

/**
 * Pure, side-effect-free — computes every Phase 2B analytics figure from an already-fetched array
 * of AnalysisRun. Independently unit-testable without a database, and reused identically by
 * SupabaseAnalysisRepository.getStrategyPerformance and the Decision Intelligence page's own
 * summary panels, so the two can never disagree about how a percentage is computed. Never mutates
 * `runs` and has no effect on runtime/trading behaviour — this is read-only analysis of
 * already-recorded history, computed well after the cycles it describes have already happened.
 */
export interface StrategyUsageEntry {
  strategyId: string;
  count: number;
  executedCount: number;
}

/** Pure — how often each strategy actually drove an analysis cycle, and how often that led to a
 * trade. Sorted by count, descending. Kept separate from computeStrategyPerformance's own
 * aggregate summary since a per-strategy breakdown is a distinct question ("which strategies are
 * active") from "how did the (already-filtered) set of runs behave overall". */
export function computeStrategyUsage(runs: AnalysisRun[]): StrategyUsageEntry[] {
  const counts = new Map<string, { count: number; executedCount: number }>();
  for (const run of runs) {
    const entry = counts.get(run.strategyId) ?? { count: 0, executedCount: 0 };
    entry.count += 1;
    if (run.executedTrade) entry.executedCount += 1;
    counts.set(run.strategyId, entry);
  }
  return [...counts.entries()]
    .map(([strategyId, { count, executedCount }]) => ({ strategyId, count, executedCount }))
    .sort((a, b) => b.count - a.count);
}

export function computeStrategyPerformance(runs: AnalysisRun[]): StrategyPerformanceSummary {
  const total = runs.length;

  const countByDecision = (decision: AnalysisDecision) => runs.filter((r) => r.decision === decision).length;
  const executedCount = runs.filter((r) => r.executedTrade).length;
  const errorCount = runs.filter((r) => r.decision === "ERROR" || r.errorCode !== undefined).length;
  const fallbackCount = runs.filter((r) => r.fallbackUsed).length;

  const rsiValues = runs.map((r) => r.rsi14).filter((v): v is number => v !== undefined);
  const atrValues = runs.map((r) => r.atr14).filter((v): v is number => v !== undefined);
  const runtimeValues = runs.map((r) => r.runtimeDurationMs).filter((v): v is number => v !== undefined && Number.isFinite(v));
  const confidenceValues = runs.map((r) => r.confidence).filter((v): v is number => v !== undefined);

  const instrumentCounts = new Map<string, number>();
  for (const run of runs) {
    instrumentCounts.set(run.instrument, (instrumentCounts.get(run.instrument) ?? 0) + 1);
  }
  const topInstruments = [...instrumentCounts.entries()]
    .map(([instrument, count]) => ({ instrument, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const trendDistribution: Record<TrendClassification, number> = { Bullish: 0, Bearish: 0, Sideways: 0 };
  for (const run of runs) {
    if (run.trend) trendDistribution[run.trend] += 1;
  }
  const mostCommonTrend = TRENDS.reduce<TrendClassification | null>((best, trend) => {
    if (trendDistribution[trend] === 0) return best;
    if (!best || trendDistribution[trend] > trendDistribution[best]) return trend;
    return best;
  }, null);

  return {
    totalRuns: total,
    buyPercent: percent(countByDecision("BUY"), total),
    sellPercent: percent(countByDecision("SELL"), total),
    holdPercent: percent(countByDecision("HOLD"), total),
    executionPercent: percent(executedCount, total),
    averageRsi14: average(rsiValues),
    averageAtr14: average(atrValues),
    averageRuntimeDurationMs: average(runtimeValues),
    averageConfidence: average(confidenceValues),
    topInstruments,
    mostCommonTrend,
    trendDistribution,
    errorRatePercent: percent(errorCount, total),
    fallbackRatePercent: percent(fallbackCount, total),
  };
}
