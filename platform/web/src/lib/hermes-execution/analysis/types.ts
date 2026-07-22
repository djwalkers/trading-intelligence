import type { BrokerProvider, MarketDataProviderType, RuntimeMode } from "../config";
import type { MarketDecisionAction } from "../market-decision-engine";
import type { TrendClassification } from "../technical-indicators";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. Domain-level types only —
// nothing here is a database row shape (see analysis-repository.ts for the snake_case mapping) and
// nothing here is SQL. trading-runtime.ts (business logic) only ever constructs an
// AnalysisRunInput/AnalysisEventInput and hands it to AnalysisRepository — "no SQL inside business
// logic" per this phase's own requirement.

/** decision_history's own MarketDecisionAction ("BUY"/"SELL"/"HOLD") plus "ERROR" for a cycle that
 * failed before MarketDecisionEngine ever produced a decision — see build-analysis-record.ts. */
export type AnalysisDecision = MarketDecisionAction | "ERROR";

export const ANALYSIS_EVENT_TYPES = [
  "CYCLE_STARTED",
  "MARKET_DATA_FETCHED",
  "INDICATORS_CALCULATED",
  "DECISION_COMPLETED",
  "EXECUTION_STARTED",
  "EXECUTION_SKIPPED",
  "EXECUTION_COMPLETED",
  "ERROR",
] as const;
export type AnalysisEventType = (typeof ANALYSIS_EVENT_TYPES)[number];

export type AnalysisEventSeverity = "debug" | "info" | "warn" | "error";

export interface AnalysisEventInput {
  timestamp: string;
  eventType: AnalysisEventType;
  severity: AnalysisEventSeverity;
  message: string;
  payload?: Record<string, unknown>;
}

export interface AnalysisRunInput {
  runtimeMode: RuntimeMode;
  brokerProvider: BrokerProvider;
  marketProvider: MarketDataProviderType;
  instrument: string;
  timeframe: string;
  strategyId: string;
  strategyVersion: number;

  currentBid?: number;
  currentAsk?: number;
  currentMid?: number;
  lastClose?: number;

  ema20?: number;
  ema50?: number;
  rsi14?: number;
  atr14?: number;
  trend?: TrendClassification;

  confidence?: number;
  decision: AnalysisDecision;
  decisionReason?: string;

  executedTrade: boolean;
  tradeId?: string;

  validationOk: boolean;
  fallbackUsed: boolean;
  candleCount?: number;
  dataAgeSeconds?: number;

  runtimeDurationMs: number;

  errorCode?: string;
  errorMessage?: string;

  /** Everything not worth its own column: the full MarketDecision.reasoning array (under
   * `reasoning`), PortfolioRiskEngine's own blockedReasons (under `blockedReasons`), the trigger
   * ("scheduled" | "manual", under `trigger`) — additive only, never required for any analytics
   * calculation (those all read named columns, never reach into metadata). */
  metadata?: Record<string, unknown>;
}

export interface AnalysisRun extends AnalysisRunInput {
  id: string;
  createdAt: string;
}

export interface AnalysisEvent extends AnalysisEventInput {
  id: string;
  analysisRunId: string;
}

export type AnalysisRetentionWindow = "30d" | "90d" | "365d" | "all";

export interface AnalysisFilter {
  instrument?: string;
  decision?: AnalysisDecision;
  strategyId?: string;
  /** ISO date (yyyy-mm-dd) or full timestamp — analyses at or after this moment. */
  since?: string;
  /** ISO date or full timestamp — analyses at or before this moment. */
  until?: string;
  retention?: AnalysisRetentionWindow;
  limit?: number;
}

export interface StrategyPerformanceSummary {
  totalRuns: number;
  buyPercent: number;
  sellPercent: number;
  holdPercent: number;
  executionPercent: number;
  averageRsi14: number | null;
  averageAtr14: number | null;
  averageRuntimeDurationMs: number | null;
  averageConfidence: number | null;
  topInstruments: { instrument: string; count: number }[];
  mostCommonTrend: TrendClassification | null;
  trendDistribution: Record<TrendClassification, number>;
  errorRatePercent: number;
  fallbackRatePercent: number;
}
