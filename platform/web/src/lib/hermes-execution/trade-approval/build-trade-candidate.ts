import type { MarketDecision, MarketDecisionContext } from "../market-decision-engine";
import type { MarketDataSnapshot } from "../market-data/market-data-provider";
import type { TradeCandidateInput } from "./types";

// Phase 3.5 — Trade Review & Approval. Pure, side-effect-free — mirrors build-analysis-record.ts's
// own "never calls the engine/broker, only reshapes an already-finished decision" convention. Never
// re-evaluates MarketDecisionEngine or a Strategy, never talks to a broker, never computes an
// indicator — every input here was already produced by unmodified, existing code.

/** ATR multiple used for the stop-loss distance — a fixed, documented constant, not configurable
 * per-strategy and not derived from any strategy's own rules (this candidate's SL/TP is purely an
 * informational review aid; see TradeCandidateInput.riskReward's own doc comment). */
const ATR_STOP_MULTIPLIER = 1.5;
/** Reward:risk multiple applied on top of the ATR stop distance to place take-profit. */
const REWARD_RISK_RATIO = 2;
/** Floor for the ATR-derived stop distance, as a fraction of entry price — guards against a
 * degenerate zero-width (or negative) stop/target when atr14 is 0 or implausibly small, which
 * would otherwise make riskReward undefined or the stop equal to the entry price. */
const MIN_STOP_DISTANCE_RATIO = 0.001;

export interface TradeLevels {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
}

/** BUY: enter at ask (matches the existing order construction in market-decision-runner.ts),
 * stop below, target above. SELL: enter at bid (matches the existing close-price argument to
 * broker.closePosition in the same file), stop above, target below — mirrored, not re-derived. */
export function computeTradeLevels(context: MarketDecisionContext, direction: "BUY" | "SELL"): TradeLevels {
  const entryPrice = direction === "BUY" ? context.ask : context.bid;
  const stopDistance = Math.max(context.atr14 * ATR_STOP_MULTIPLIER, entryPrice * MIN_STOP_DISTANCE_RATIO);
  const targetDistance = stopDistance * REWARD_RISK_RATIO;

  const stopLoss = direction === "BUY" ? entryPrice - stopDistance : entryPrice + stopDistance;
  const takeProfit = direction === "BUY" ? entryPrice + targetDistance : entryPrice - targetDistance;

  return { entryPrice, stopLoss, takeProfit, riskReward: REWARD_RISK_RATIO };
}

export interface BuildTradeCandidateInputOptions {
  decision: MarketDecision;
  context: MarketDecisionContext;
  marketDataSnapshot: MarketDataSnapshot;
  amount: number;
  analysisRunId: string | undefined;
  /** Wall-clock "now" — injected, never read from Date.now() directly, so expiry is deterministic
   * in tests (matches SchedulerClock's own injected-time convention used throughout this pipeline). */
  now: Date;
  expiryMs: number;
}

/** Only ever called for decision.action "BUY" | "SELL" — HOLD never reaches this (see
 * trade-candidate-service.ts's createTradeCandidateForDecision, which is the only caller). */
export function buildTradeCandidateInput(options: BuildTradeCandidateInputOptions): TradeCandidateInput {
  const { decision, context, marketDataSnapshot, amount, analysisRunId, now, expiryMs } = options;
  const direction = decision.action as "BUY" | "SELL";
  const levels = computeTradeLevels(context, direction);

  return {
    analysisRunId,
    strategyId: context.strategy.strategyId,
    strategyVersion: context.strategy.version,
    instrument: context.instrument,
    direction,
    confidence: decision.confidence,
    entryPrice: levels.entryPrice,
    stopLoss: levels.stopLoss,
    takeProfit: levels.takeProfit,
    riskReward: levels.riskReward,
    reasoning: decision.reasoning,
    validationNotes: decision.validationNotes ?? [],
    expiresAt: new Date(now.getTime() + expiryMs).toISOString(),
    execution: { marketContext: context, marketDataSnapshot, amount },
  };
}
