import { MarketDecisionEngine } from "../market-decision-engine";
import { runMarketDecisionCycle, type MarketDecisionCycleInput, type MarketDecisionCycleResult } from "../market-decision-runner";
import { PortfolioRiskEngine } from "../portfolio-risk-engine";
import type { OrderRequest } from "../types";
import type { MarketDataSnapshot } from "../market-data/market-data-provider";
import type { TradeLifecycleRecord } from "./types";
import type { TradeLifecycleService } from "./trade-lifecycle-service";

// Milestone 6 — Trade Lifecycle & Performance Tracking. Pipeline integration, built entirely as a
// wrapper AROUND the existing, completely unmodified `runMarketDecisionCycle` (market-decision-
// runner.ts) — that file, market-decision-engine.ts, portfolio-risk-engine.ts, and every broker are
// untouched by this milestone; nothing about decision logic, risk rules, or broker behaviour
// changes here.
//
// The one real design tension: `runMarketDecisionCycle` computes the MarketDecision and (for a BUY)
// the PortfolioRiskDecision internally and only exposes the *final* outcome (decision/executed/
// blockedReasons/position/trade) — not those two intermediate objects, which the mission's
// TradeLifecycleRecord needs verbatim. Rather than touching the runner to also return them (which
// would still leave PortfolioRiskDecision unavailable in the one case that matters most — a broker
// call throwing, which the runner doesn't catch, so it returns nothing at all), this wrapper
// independently pre-computes the SAME MarketDecision and PortfolioRiskDecision by calling
// `MarketDecisionEngine.evaluate`/`PortfolioRiskEngine.evaluate` itself, using the identical inputs
// the runner will independently use a moment later. Both are pure, side-effect-free functions of
// their inputs, and nothing async happens between this wrapper's pre-computation and the runner's
// own — no broker state can change in between — so the two calls are guaranteed to agree; see
// trade-lifecycle-runner.test.ts's "pre-computed decision/risk always matches the runner's own"
// assertions. This lets lifecycle transitions (including EXECUTION_FAILED/CLOSE_FAILED, when the
// broker call itself throws) be recorded with real data, without changing what the runner does or
// how its own failures propagate — a thrown broker error still propagates out of this wrapper
// exactly as it always did out of the runner.

export interface TradeLifecycleCycleInput extends MarketDecisionCycleInput {
  lifecycleService: TradeLifecycleService;
  /** The raw provider read MarketIntelligenceBuilder consumed to build `marketContext` — not
   * derivable from `marketContext` alone, so the caller (whoever already called
   * MarketDataProvider.getMarketData()) must pass it through. */
  marketDataSnapshot: MarketDataSnapshot;
}

export interface TradeLifecycleCycleResult extends MarketDecisionCycleResult {
  /** Undefined only when the decision was HOLD, or a SELL with no matching lifecycle record found
   * (see the SELL branch below) — every BUY/SELL that reaches a tracked position gets one. */
  lifecycleRecord?: TradeLifecycleRecord;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one lifecycle-tracked market decision cycle. Always calls the real, unmodified
 * `runMarketDecisionCycle` to perform the actual work (risk evaluation, broker calls, its own
 * existing audit events) — this function only ever adds TradeLifecycleRecord bookkeeping around
 * that call, never replaces or short-circuits it.
 */
export async function runMarketDecisionCycleWithLifecycle(
  input: TradeLifecycleCycleInput,
): Promise<TradeLifecycleCycleResult> {
  const { broker, marketContext, amount, lifecycleService, portfolioRisk, marketDataSnapshot } = input;
  const { instrument, strategy } = marketContext;

  // Excursion tracking for whatever's already open on this strategy+instrument, independent of
  // this cycle's own decision — a position sits open across many HOLD cycles, and that's exactly
  // when its MFE/MAE keeps moving. Re-bound to the (possibly updated) return value so a later
  // recordCloseRequested() in the SELL branch below never overwrites this update with stale data.
  let existingOpenRecord = await lifecycleService.findOpenRecord(strategy.strategyId, instrument);
  if (existingOpenRecord) {
    existingOpenRecord = await lifecycleService.updateExcursion(existingOpenRecord, marketContext.bid);
  }

  // Pure, side-effect-free — see this file's top-of-file comment for why calling it here (ahead of
  // the runner's own internal, identical call) is safe.
  const decision = MarketDecisionEngine.evaluate(marketContext);

  if (decision.action === "HOLD") {
    return await runMarketDecisionCycle(input);
  }

  if (decision.action === "BUY") {
    let record = await lifecycleService.createFromDecision({
      strategyId: strategy.strategyId,
      symbol: instrument,
      side: "BUY",
      quantity: amount,
      decision,
      marketDataSnapshot,
      intelligenceSummary: marketContext,
    });

    const timestamp = input.timestamp ?? marketContext.timestamp;
    const proposedOrder: OrderRequest = {
      strategyId: strategy.strategyId,
      strategyVersion: strategy.version,
      sourceType: strategy.sourceType,
      instrument,
      side: "BUY",
      quantity: amount,
      price: marketContext.ask,
      timestamp,
    };
    const riskDecision = PortfolioRiskEngine.evaluate({
      account: broker.getAccount(),
      openPositions: broker.getOpenPositions(),
      dailyTradeCount: portfolioRisk.dailyTradeCount,
      brokerAvailable: portfolioRisk.brokerAvailable,
      proposedOrder,
      config: portfolioRisk.config,
    });

    if (!riskDecision.permitted) {
      record = await lifecycleService.recordRiskRejected(record, riskDecision);
      const result = await runMarketDecisionCycle(input);
      return { ...result, lifecycleRecord: record };
    }

    record = await lifecycleService.recordApproved(record, riskDecision);
    record = await lifecycleService.recordExecutionSubmitted(record);

    let result: MarketDecisionCycleResult;
    try {
      result = await runMarketDecisionCycle(input);
    } catch (error) {
      await lifecycleService.recordExecutionFailed(record, { message: toErrorMessage(error) });
      throw error;
    }

    if (!result.position) {
      // Defensive: riskDecision.permitted mirrors what the runner itself independently computed
      // from the same inputs (see top-of-file comment) — reaching here would mean the two
      // disagreed, which should be impossible. An explicit failure beats silently returning a
      // lifecycle record stuck at EXECUTION_SUBMITTED.
      throw new Error(
        `Trade lifecycle runner expected an opened position for "${instrument}" after an approved BUY, but none was returned.`,
      );
    }
    record = await lifecycleService.recordOpened(record, {
      entryPrice: result.position.entryPrice,
      brokerOrderId: result.orderId ?? "",
    });
    return { ...result, lifecycleRecord: record };
  }

  // decision.action === "SELL"
  if (!existingOpenRecord) {
    // No lifecycle record tracks this position (e.g. it predates lifecycle tracking being wired
    // in) — fall back to the plain, untracked cycle rather than fabricating a record for a trade
    // this service never saw opened.
    return await runMarketDecisionCycle(input);
  }

  let record = await lifecycleService.recordCloseRequested(existingOpenRecord);
  let result: MarketDecisionCycleResult;
  try {
    result = await runMarketDecisionCycle(input);
  } catch (error) {
    await lifecycleService.recordCloseFailed(record, { message: toErrorMessage(error) });
    throw error;
  }

  if (!result.trade) {
    throw new Error(`Trade lifecycle runner expected a completed trade for "${instrument}" after a SELL, but none was returned.`);
  }
  record = await lifecycleService.recordClosed(record, {
    exitPrice: result.trade.exitPrice,
    exitReason: result.trade.closeReason,
  });
  return { ...result, lifecycleRecord: record };
}
