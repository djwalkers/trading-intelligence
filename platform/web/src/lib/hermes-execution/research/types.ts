import type { MarketDecisionAction, MarketDecisionContext } from "../market-decision-engine";

// Phase 5 — Strategy Research Laboratory. A strategy run against HISTORICAL analysis data, never
// against live market data, and never producing a TradeCandidate, a broker call, or any persisted
// row — see run-strategy-research.ts's own top-of-file comment. Research runs are ephemeral:
// computed on demand in the browser, never written to Supabase (this phase adds no migration and no
// new table — see this module's own docs).

export interface ResearchRunParams {
  strategyId: string;
  instrument: string;
  /** ISO date/timestamp — inclusive lower bound, matching AnalysisFilter.since's own convention. */
  since: string;
  /** ISO date/timestamp — inclusive upper bound, matching AnalysisFilter.until's own convention. */
  until: string;
  /** Simulated position size — purely a scaling factor for P/L figures; win rate, R-multiple, and
   * every ratio-based metric are unaffected by its value. Defaults to 10 (this pipeline's own
   * typical live `amount`) when not supplied by the caller. */
  amount?: number;
}

/** One reconstructed decision point — the context a Strategy actually saw, and what it decided.
 * `context.positionOpen` reflects THIS simulation's own running position state, which can diverge
 * between two strategies run over the identical historical window (see run-strategy-research.ts). */
export interface ResearchDecisionPoint {
  analysisRunId: string;
  context: MarketDecisionContext;
  action: MarketDecisionAction;
  confidence: number;
  reasoning: string[];
}

export interface SimulatedTrade {
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  holdingTimeMs: number;
  grossPnl: number;
  returnPercent: number;
  /** Same convention as trade-performance's own risk_multiple: net_pnl / (|entry - stopLoss| x
   * amount), stop-loss computed via the unmodified computeTradeLevels (build-trade-candidate.ts) at
   * entry. Undefined only if entry/stop-loss were degenerate (never fabricated). */
  riskMultiple: number | undefined;
  maxFavourableExcursion: number;
  maxAdverseExcursion: number;
}

export interface ResearchMetrics {
  opportunityCount: number;
  skippedCount: number;
  tradeCount: number;
  /** trades / opportunities — the fraction of decision points that resulted in a trade (an entry
   * OR an exit both count once each, per trade). */
  tradeFrequency: number;
  /** opportunities per day across the requested window — how often the strategy was even asked to
   * decide, independent of what it decided. */
  opportunityFrequencyPerDay: number;
  winRate: number;
  lossRate: number;
  expectancy: number;
  profitFactor: number | undefined;
  averageRiskMultiple: number | undefined;
  /** Simplified: mean(per-trade return%) / stdev(per-trade return%) — NOT an annualised, daily-
   * returns Sharpe ratio (trades are irregularly spaced, so there is no single "period" to
   * annualise against). Documented explicitly as an approximation ("if possible" per this phase's
   * own request) — see docs/strategy-research-laboratory-phase-5.md. Undefined with fewer than 2
   * trades (a standard deviation needs at least 2 points) or a zero standard deviation. */
  sharpeRatio: number | undefined;
  maximumDrawdown: number;
  averageHoldingTimeMs: number;
}

export interface ResearchRunResult {
  strategyId: string;
  strategyVersion: number;
  instrument: string;
  since: string;
  until: string;
  decisionPoints: ResearchDecisionPoint[];
  trades: SimulatedTrade[];
  equityCurve: { timestamp: string; cumulativeNetPnl: number }[];
  metrics: ResearchMetrics;
}

// --- Comparison -------------------------------------------------------------------------------

export interface MetricDelta {
  metric: keyof ResearchMetrics;
  a: number | undefined;
  b: number | undefined;
  /** b - a, when both are defined. */
  delta: number | undefined;
}

/** A decision point where both strategies were shown the SAME analysis run but decided
 * differently — index-aligned by analysisRunId, not by position (the two runs are always evaluated
 * over the identical historical sequence, so every analysisRunId present in one is present in the
 * other, but this is asserted, never assumed silently). */
export interface DecisionDifference {
  analysisRunId: string;
  timestamp: string;
  actionA: MarketDecisionAction;
  actionB: MarketDecisionAction;
}

export interface TradeDifferenceSummary {
  tradesOnlyInA: SimulatedTrade[];
  tradesOnlyInB: SimulatedTrade[];
  /** Trades both strategies took with an overlapping entry time (within the same analysis run
   * sequence) but a different outcome (net P/L sign or magnitude beyond a small tolerance). */
  divergentTrades: { a: SimulatedTrade; b: SimulatedTrade }[];
}

export interface ResearchComparisonResult {
  a: ResearchRunResult;
  b: ResearchRunResult;
  metricDeltas: MetricDelta[];
  decisionDifferences: DecisionDifference[];
  tradeDifferences: TradeDifferenceSummary;
}
