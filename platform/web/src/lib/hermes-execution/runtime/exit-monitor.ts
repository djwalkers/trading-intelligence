import type { AuditTrail } from "../audit-trail";
import type { MarketDecision } from "../market-decision-engine";
import type { PaperBroker } from "../paper-broker";
import type { TradeLifecycleService } from "../trade-lifecycle/trade-lifecycle-service";
import type { TradeLifecycleRecord } from "../trade-lifecycle/types";

// Restart-Resilient Autonomy Phase — Phase 3 (Automatic exit monitoring). Runs, every scheduled
// cycle, for every reconciled open position — BEFORE any fresh entry decision is ever evaluated
// (see trading-runtime.ts's own runCycleBody). Automatic exits never require human approval in demo
// mode (closing an already-open position is a risk-reduction action, never a new commitment of
// capital) — this deliberately bypasses the TradeCandidate/approval queue entirely, unlike a fresh
// BUY/SELL decision.
//
// "Opposing strategy signal" is deliberately NOT re-implemented here: it is simply this cycle's own
// freshly-evaluated MarketDecisionEngine.evaluate(context) (with positionOpen: true) returning
// "SELL" — the exact same opposing-signal logic every registered Strategy already implements (see
// e.g. Demo0001Strategy.checkExitConditions) — passed in as `freshDecision`, never recomputed
// independently, so this module can never disagree with the engine about what counts as an
// opposing signal.

export type ExitTrigger = "KILL_SWITCH" | "STOP_LOSS" | "TAKE_PROFIT" | "STRATEGY_DISABLED" | "MAX_HOLDING_DURATION" | "OPPOSING_SIGNAL";

export interface EvaluateExitTriggerInput {
  record: TradeLifecycleRecord;
  /** A freshly fetched bid, never the price frozen into any prior candidate/decision — see this
   * module's own top-of-file comment and the mission's own explicit "do not use the stale price
   * frozen into a prior candidate" requirement. */
  freshBid: number;
  /** This cycle's own fresh MarketDecisionEngine.evaluate(context) result (positionOpen: true). */
  freshDecision: MarketDecision;
  killSwitchEnabled: boolean;
  maxHoldingDurationMs: number | undefined;
  /** Pre-computed by the caller (a fresh re-check against the strategy registry, not this record's
   * own frozen decision) — true unless the strategy has since been disabled or removed. */
  strategyStillEnabled: boolean;
  now: Date;
}

/**
 * Pure — decides WHETHER and WHY an exit should happen, given already-fresh inputs the caller
 * fetched; never calls the broker or mutates anything itself. Priority, highest first: KILL_SWITCH
 * (an operator emergency always wins) > STOP_LOSS > TAKE_PROFIT > STRATEGY_DISABLED >
 * MAX_HOLDING_DURATION > OPPOSING_SIGNAL. `record.stopLoss`/`record.takeProfit` are undefined for a
 * position adopted from an orphaned broker read (position-reconciliation.ts) — that check is simply
 * skipped for such a record, never treated as "0" or "always triggered."
 */
export function evaluateExitTrigger(input: EvaluateExitTriggerInput): ExitTrigger | undefined {
  const { record, freshBid, freshDecision, killSwitchEnabled, maxHoldingDurationMs, strategyStillEnabled, now } = input;

  if (killSwitchEnabled) return "KILL_SWITCH";

  if (record.stopLoss !== undefined) {
    const stopHit = record.side === "BUY" ? freshBid <= record.stopLoss : freshBid >= record.stopLoss;
    if (stopHit) return "STOP_LOSS";
  }

  if (record.takeProfit !== undefined) {
    const targetHit = record.side === "BUY" ? freshBid >= record.takeProfit : freshBid <= record.takeProfit;
    if (targetHit) return "TAKE_PROFIT";
  }

  if (!strategyStillEnabled) return "STRATEGY_DISABLED";

  if (maxHoldingDurationMs !== undefined && record.openedAt !== undefined) {
    const heldMs = now.getTime() - Date.parse(record.openedAt);
    if (Number.isFinite(heldMs) && heldMs >= maxHoldingDurationMs) return "MAX_HOLDING_DURATION";
  }

  if (freshDecision.action === "SELL") return "OPPOSING_SIGNAL";

  return undefined;
}

export interface RateFetchingBroker {
  getRate(instrument: string): Promise<{ bid: number; ask: number }>;
}

export function hasRateFetching(broker: unknown): broker is RateFetchingBroker {
  return typeof (broker as Partial<RateFetchingBroker>).getRate === "function";
}

export interface ExecuteAutomaticExitInput {
  broker: PaperBroker;
  record: TradeLifecycleRecord;
  trigger: ExitTrigger;
  lifecycleService: TradeLifecycleService;
  auditTrail: AuditTrail;
  executionRunId: string;
  now: Date;
}

export type ExecuteAutomaticExitResult = { closed: true; record: TradeLifecycleRecord } | { closed: false; reason: string };

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Performs one automatic close. Always re-confirms the broker's OWN current open-position list
 * still contains this position (by brokerPositionId, never `instrument` alone once that identifier
 * is available) immediately before doing anything — this is what makes repeated automatic-exit
 * attempts across cycles safe: a position that already closed (whether by a prior successful
 * attempt this function doesn't know succeeded, or by any other means) simply won't be found here,
 * and no second close order is ever submitted. Fetches a fresh bid again, immediately before
 * submitting the close, per the mission's own explicit requirement — never reuses the bid the
 * trigger was evaluated against.
 */
export async function executeAutomaticExit(input: ExecuteAutomaticExitInput): Promise<ExecuteAutomaticExitResult> {
  const { broker, record, trigger, lifecycleService, auditTrail, executionRunId, now } = input;

  await auditTrail.record({
    timestamp: now.toISOString(),
    eventType: "AUTOMATIC_EXIT_TRIGGERED",
    executionRunId,
    strategyId: record.strategyId,
    instrument: record.symbol,
    details: {
      trigger,
      lifecycleRecordId: record.id,
      brokerPositionId: record.brokerPositionId,
      entryPrice: record.entryPrice,
      stopLoss: record.stopLoss,
      takeProfit: record.takeProfit,
    },
  });

  const openPositions = broker.getOpenPositions();
  const brokerPosition = record.brokerPositionId
    ? openPositions.find((p) => p.brokerPositionId === record.brokerPositionId)
    : openPositions.find((p) => p.instrument === record.symbol);
  if (!brokerPosition) {
    return {
      closed: false,
      reason: `No matching broker position found to close for lifecycle record ${record.id} (instrument ${record.symbol}) — it may have already closed.`,
    };
  }

  // Fresh price fetched again, right before submission — never the bid the trigger was evaluated
  // against a moment earlier. Falls back to the broker's own last-known entry price only if this
  // second fetch itself fails, so a transient rate-fetch error never blocks a risk-reduction close
  // outright.
  let exitPrice = brokerPosition.entryPrice;
  if (hasRateFetching(broker)) {
    try {
      const rate = await broker.getRate(record.symbol);
      exitPrice = rate.bid;
    } catch {
      // fall through with the defensive fallback above
    }
  }

  const closeRequestedRecord = record.status === "OPEN" ? await lifecycleService.recordCloseRequested(record) : record;

  try {
    const result = await broker.closePosition(brokerPosition.positionId, exitPrice, now.toISOString(), `automatic-exit-${trigger.toLowerCase()}`);
    const closed = await lifecycleService.recordClosed(closeRequestedRecord, {
      exitPrice: result.trade.exitPrice,
      exitReason: result.trade.closeReason,
      closedAt: now.toISOString(),
    });
    return { closed: true, record: closed };
  } catch (error) {
    const reason = toErrorMessage(error);
    await lifecycleService.recordCloseFailed(closeRequestedRecord, { message: reason });
    return { closed: false, reason };
  }
}
