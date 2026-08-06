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
 *
 * Kill-switch exit defect fix. This function is only ever called for a record the caller believes
 * is genuinely still open (currentPositionOpen && currentRecord in trading-runtime.ts) — so EVERY
 * failure branch below now durably persists CLOSE_FAILED (retryable, visible) with a specific
 * reason, never silently returning `{closed:false}` with the record left exactly as it was. Three
 * structurally distinct failure sources are never conflated:
 *   1. The broker adapter has no matching open position at all (never adopted into this broker
 *      instance — see position-reconciliation.ts's own adoptPosition fix — or a genuine race). The
 *      broker was never called; safe to mark CLOSE_FAILED and let reconciliation's own next-cycle,
 *      broker-ground-truth check resolve it (back to OPEN if still genuinely live, or to
 *      CLOSED_UNRECONCILED if genuinely gone) — never guessed here.
 *   2. broker.closePosition() itself throws — the close never happened at the broker (or is
 *      genuinely unknown); safe to retry a FRESH close attempt next cycle.
 *   3. broker.closePosition() SUCCEEDS (POSITION_CLOSED/REALISED_PNL already fired from inside it)
 *      but the subsequent local lifecycle-persistence step then fails — the close is CONFIRMED and
 *      must never be resubmitted. The confirmed exit data is preserved in a dedicated audit event
 *      before CLOSE_FAILED is recorded, so it is never silently discarded even though this specific
 *      record write couldn't durably capture it.
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

  // Moved ahead of the broker-position lookup below (was previously computed only once a matching
  // broker position was already confirmed found) so EVERY failure branch — including "the broker
  // adapter doesn't have this position at all" — can route through the identical CLOSE_REQUESTED
  // state. CLOSE_REQUESTED -> CLOSE_FAILED is a valid transition; OPEN -> CLOSE_FAILED directly is
  // not (see trade-lifecycle/types.ts's own VALID_TRANSITIONS) — a caller must always be able to
  // see a failed close attempt reflected durably, never silently left exactly as it was.
  const closeRequestedRecord = record.status === "OPEN" ? await lifecycleService.recordCloseRequested(record) : record;

  const openPositions = broker.getOpenPositions();
  const brokerPosition = record.brokerPositionId
    ? openPositions.find((p) => p.brokerPositionId === record.brokerPositionId)
    : openPositions.find((p) => p.instrument === record.symbol);
  if (!brokerPosition) {
    const reason =
      `Broker adapter has no open position matching lifecycle record ${record.id} (brokerPositionId ` +
      `${record.brokerPositionId ?? "unknown"}, instrument ${record.symbol}) — it was never registered with this broker ` +
      `instance, or has genuinely already closed. Reconciliation will resolve this on the next cycle.`;
    await lifecycleService.recordCloseFailed(closeRequestedRecord, { message: reason, context: { failureKind: "POSITION_NOT_FOUND_AT_BROKER_ADAPTER" } });
    return { closed: false, reason };
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

  let brokerResult: Awaited<ReturnType<PaperBroker["closePosition"]>>;
  try {
    brokerResult = await broker.closePosition(brokerPosition.positionId, exitPrice, now.toISOString(), `automatic-exit-${trigger.toLowerCase()}`);
  } catch (error) {
    // The broker call itself never confirmed anything happened — safe to retry a fresh close
    // attempt next cycle.
    const reason = toErrorMessage(error);
    await lifecycleService.recordCloseFailed(closeRequestedRecord, { message: reason, context: { failureKind: "BROKER_CLOSE_REJECTED" } });
    return { closed: false, reason };
  }

  try {
    const closed = await lifecycleService.recordClosed(closeRequestedRecord, {
      exitPrice: brokerResult.trade.exitPrice,
      exitReason: brokerResult.trade.closeReason,
      closedAt: now.toISOString(),
    });
    return { closed: true, record: closed };
  } catch (error) {
    // Crash-window fix. The broker CONFIRMED this close already (trackedPositions no longer has it
    // — a retried broker.closePosition() call for the same positionId fails fast, locally, before
    // ever reaching a real HTTP call, never a duplicate real order — see
    // EtoroDemoBroker.closePosition's own lookup-before-call ordering). Only the LOCAL persistence
    // step failed, after the fact. The confirmed result is preserved here, in the one durable place
    // it cannot be lost, before CLOSE_FAILED is recorded — reconciliation's own broker-absent path
    // will resolve this record to CLOSED_UNRECONCILED next cycle; it must never be treated as safe
    // to resubmit a fresh close.
    const reason = toErrorMessage(error);
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "AUTOMATIC_EXIT_BROKER_CONFIRMED_PERSISTENCE_FAILED",
      executionRunId,
      strategyId: record.strategyId,
      instrument: record.symbol,
      details: {
        lifecycleRecordId: record.id,
        brokerPositionId: record.brokerPositionId,
        confirmedExitPrice: brokerResult.trade.exitPrice,
        confirmedCloseReason: brokerResult.trade.closeReason,
        confirmedRealisedPnl: brokerResult.trade.realisedPnl,
        persistenceError: reason,
      },
    });
    await lifecycleService.recordCloseFailed(closeRequestedRecord, {
      message:
        `Broker confirmed this position closed (exitPrice=${brokerResult.trade.exitPrice}), but persisting that result failed: ` +
        `${reason}. Never resubmit a broker close for this position — reconciliation will resolve it.`,
      context: { failureKind: "BROKER_CONFIRMED_BUT_PERSISTENCE_FAILED", confirmedExitPrice: brokerResult.trade.exitPrice },
    });
    return { closed: false, reason: `Broker confirmed the close but local persistence failed: ${reason}` };
  }
}
