import type { MarketDataSnapshot } from "../market-data/market-data-provider";
import type { MarketDecisionContext } from "../market-decision-engine";
import type { BrokerProvider, MarketDataProviderType, RuntimeMode } from "../config";
import type { TradeLifecycleCycleResult } from "../trade-lifecycle/trade-lifecycle-runner";
import type { AnalysisEventInput, AnalysisRunInput } from "./types";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. Pure, side-effect-free —
// translates one already-completed TradingRuntime cycle (success or failure) into the plain
// AnalysisRunInput/AnalysisEventInput[] trading-runtime.ts hands to AnalysisRepository. Never
// calls MarketDecisionEngine, the broker, or any execution method, and never influences a
// decision — every field here is read from an already-finished MarketDecisionContext/
// TradeLifecycleCycleResult (success) or a caught error (failure). This file's only job is
// shaping data that already exists; "no SQL inside business logic" lives one layer further in
// (analysis-repository.ts) — this file has no SQL either, only plain object construction.

interface BaseInput {
  trigger: "scheduled" | "manual";
  runtimeMode: RuntimeMode;
  brokerProvider: BrokerProvider;
  marketProvider: MarketDataProviderType;
  timeframe: string;
  strategyId: string;
  strategyVersion: number;
  instrument: string;
  runtimeDurationMs: number;
}

export interface BuildAnalysisRecordSuccessInput extends BaseInput {
  kind: "success";
  snapshot: MarketDataSnapshot;
  context: MarketDecisionContext;
  result: TradeLifecycleCycleResult;
}

export interface BuildAnalysisRecordFailureInput extends BaseInput {
  kind: "failure";
  error: unknown;
}

export type BuildAnalysisRecordInput = BuildAnalysisRecordSuccessInput | BuildAnalysisRecordFailureInput;

export interface BuiltAnalysisRecord {
  run: AnalysisRunInput;
  events: AnalysisEventInput[];
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Prefers a typed error's own `.reason` (e.g. MarketDataProviderError's "fetch-failed" /
 * "malformed-data") over the generic class name, since it's a more useful analysis-run error_code
 * — falls back to the error's own name, then a generic default. Never inspects `.message` here
 * (that's errorMessage's job) so error_code stays a short, filterable/groupable value. */
function toErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "reason" in error) {
    const reason = (error as { reason: unknown }).reason;
    if (typeof reason === "string") return reason;
  }
  if (error instanceof Error) return error.name;
  return "UNKNOWN_ERROR";
}

function buildFailureRecord(input: BuildAnalysisRecordFailureInput): BuiltAnalysisRecord {
  const now = new Date().toISOString();

  const run: AnalysisRunInput = {
    runtimeMode: input.runtimeMode,
    brokerProvider: input.brokerProvider,
    marketProvider: input.marketProvider,
    instrument: input.instrument,
    timeframe: input.timeframe,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    decision: "ERROR",
    executedTrade: false,
    validationOk: false,
    fallbackUsed: false,
    runtimeDurationMs: input.runtimeDurationMs,
    errorCode: toErrorCode(input.error),
    errorMessage: toErrorMessage(input.error),
    metadata: { trigger: input.trigger },
  };

  const events: AnalysisEventInput[] = [
    { timestamp: now, eventType: "CYCLE_STARTED", severity: "info", message: `Cycle started (${input.trigger}).` },
    { timestamp: now, eventType: "ERROR", severity: "error", message: toErrorMessage(input.error), payload: { errorCode: run.errorCode } },
  ];

  return { run, events };
}

function buildSuccessRecord(input: BuildAnalysisRecordSuccessInput): BuiltAnalysisRecord {
  const now = new Date().toISOString();
  const { snapshot, context, result } = input;

  const tradeId = result.position?.positionId ?? result.trade?.tradeId;
  const lastCandle = snapshot.candles[snapshot.candles.length - 1];
  const dataAgeSeconds = lastCandle ? Math.max(0, (Date.now() - Date.parse(lastCandle.timestamp)) / 1000) : undefined;

  const run: AnalysisRunInput = {
    runtimeMode: input.runtimeMode,
    brokerProvider: input.brokerProvider,
    marketProvider: input.marketProvider,
    instrument: input.instrument,
    timeframe: input.timeframe,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    currentBid: context.bid,
    currentAsk: context.ask,
    currentMid: context.midPrice,
    lastClose: lastCandle?.close,
    ema20: context.ema20,
    ema50: context.ema50,
    rsi14: context.rsi14,
    atr14: context.atr14,
    trend: context.trend,
    confidence: result.decision.confidence,
    decision: result.decision.action,
    decisionReason: result.decision.reasoning.join("; "),
    executedTrade: result.executed,
    tradeId,
    // A cycle only ever reaches this success path once buildMarketDecisionContext has already
    // succeeded — which means LiveMarketDataProvider's own candle-validation.ts pass already
    // succeeded too (a validation failure throws and lands in buildFailureRecord instead). See
    // MarketDiagnosticsValidation's identical "a result existing at all already proves this
    // passed" convention (market-diagnostics-service.ts) for the same reasoning applied there.
    validationOk: true,
    fallbackUsed: false,
    candleCount: snapshot.candles.length,
    dataAgeSeconds,
    runtimeDurationMs: input.runtimeDurationMs,
    metadata: {
      trigger: input.trigger,
      reasoning: result.decision.reasoning,
      blockedReasons: result.blockedReasons,
      lifecycleRecordId: result.lifecycleRecord?.id,
    },
  };

  const events: AnalysisEventInput[] = [
    { timestamp: now, eventType: "CYCLE_STARTED", severity: "info", message: `Cycle started (${input.trigger}).` },
    {
      timestamp: now,
      eventType: "MARKET_DATA_FETCHED",
      severity: "info",
      message: `Fetched ${snapshot.candles.length} candles for ${input.instrument}.`,
      payload: { candleCount: snapshot.candles.length, bid: context.bid, ask: context.ask },
    },
    {
      timestamp: now,
      eventType: "INDICATORS_CALCULATED",
      severity: "info",
      message: `EMA20=${context.ema20.toFixed(2)} EMA50=${context.ema50.toFixed(2)} RSI14=${context.rsi14.toFixed(1)} Trend=${context.trend}`,
      payload: { ema20: context.ema20, ema50: context.ema50, rsi14: context.rsi14, atr14: context.atr14, trend: context.trend },
    },
    {
      timestamp: now,
      eventType: "DECISION_COMPLETED",
      severity: "info",
      message: `Decision: ${result.decision.action} (confidence ${result.decision.confidence}).`,
      payload: { action: result.decision.action, confidence: result.decision.confidence, reasoning: result.decision.reasoning },
    },
    result.executed
      ? {
          timestamp: now,
          eventType: "EXECUTION_COMPLETED",
          severity: "info",
          message: tradeId ? `Execution completed — ${tradeId}.` : "Execution completed.",
          payload: { tradeId },
        }
      : {
          timestamp: now,
          eventType: "EXECUTION_SKIPPED",
          severity: "info",
          message:
            result.blockedReasons && result.blockedReasons.length > 0
              ? "Execution skipped — blocked by portfolio risk checks."
              : "Execution skipped — no trade signal.",
          payload: { blockedReasons: result.blockedReasons },
        },
  ];

  return { run, events };
}

export function buildAnalysisRecord(input: BuildAnalysisRecordInput): BuiltAnalysisRecord {
  return input.kind === "success" ? buildSuccessRecord(input) : buildFailureRecord(input);
}
