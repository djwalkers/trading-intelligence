import type { PaperTrade } from "@/lib/types";
import type { DecisionRecord } from "./types";

// A £0.01 band around zero — small enough that it never masks a genuine win or loss, big enough
// that a trade that closes at (near-)exactly its entry price (e.g. a same-second open/close in a
// seeded test) reads as "Neutral" rather than an arbitrary Win or Loss decided by floating-point
// noise. One shared constant, not duplicated between the classification logic and any test/UI code
// that needs to reason about the same boundary.
export const NEUTRAL_PNL_THRESHOLD_GBP = 0.01;

export interface OutcomeUpdate {
  recordId: string;
  outcome: "Win" | "Loss" | "Neutral";
  realisedPnl: number;
  realisedPnlPercent: number;
  holdingDurationMinutes: number;
  closedAt: string;
  outcomeRecordedAt: string;
}

function classifyOutcome(realisedPnl: number): "Win" | "Loss" | "Neutral" {
  if (realisedPnl > NEUTRAL_PNL_THRESHOLD_GBP) return "Win";
  if (realisedPnl < -NEUTRAL_PNL_THRESHOLD_GBP) return "Loss";
  return "Neutral";
}

// Pure and deterministic: given one closed trade and the DecisionRecord already confirmed to link
// to it, compute the outcome update — or null if the pairing doesn't actually qualify for
// classification. Every guard here is also a data-integrity guarantee: a Rejected decision, a
// decision that's already been classified, an open trade, or a mismatched trade/record pairing all
// return null rather than ever producing a wrong or duplicate answer. Called from both the
// browser's automatic on-close reconciliation (decision-history-context.tsx) and the worker's
// batch reconciliation (reconcile-outcomes.ts) — the same function, so the two can never compute a
// different answer for the same trade.
export function computeOutcomeUpdate(trade: PaperTrade, record: DecisionRecord): OutcomeUpdate | null {
  if (record.actionTaken !== "Trade Opened") return null; // never classify a Rejected decision
  if (record.outcome !== "Pending") return null; // already classified — idempotent, not a re-run
  if (record.createdTradeId !== trade.id) return null; // not actually the linked trade
  if (trade.status !== "Closed") return null; // open trades are never Win/Loss/Neutral
  if (trade.realisedPnl === undefined || trade.realisedPnlPercent === undefined || !trade.closedAt) {
    return null; // closed but missing P/L data — structurally shouldn't happen, handled anyway
  }

  const openedMs = new Date(trade.timestamp).getTime();
  const closedMs = new Date(trade.closedAt).getTime();
  const holdingDurationMinutes = Math.max(0, Math.round((closedMs - openedMs) / 60_000));

  return {
    recordId: record.id,
    outcome: classifyOutcome(trade.realisedPnl),
    realisedPnl: trade.realisedPnl,
    realisedPnlPercent: trade.realisedPnlPercent,
    holdingDurationMinutes,
    closedAt: trade.closedAt,
    outcomeRecordedAt: new Date().toISOString(),
  };
}

// Given the full set of trades and decision records for one user (or one browser's local state),
// find every accepted, still-Pending decision whose linked trade has since closed, and compute its
// update. Idempotent by construction: a record that's already been classified is skipped by
// computeOutcomeUpdate's own guard, so calling this repeatedly with the same inputs after the
// first successful update produces an empty array — safe to call on every trade-list change
// (the browser) or every poll cycle (the worker) with no risk of duplicate or conflicting updates.
export function findReconcilableOutcomes(
  trades: PaperTrade[],
  records: DecisionRecord[],
): OutcomeUpdate[] {
  const tradesById = new Map(trades.map((trade) => [trade.id, trade]));
  const updates: OutcomeUpdate[] = [];

  for (const record of records) {
    if (record.actionTaken !== "Trade Opened" || record.outcome !== "Pending" || !record.createdTradeId) {
      continue;
    }
    const trade = tradesById.get(record.createdTradeId);
    // A Pending, accepted decision whose linked trade can't be found — either a genuinely open
    // trade the caller didn't include, or (documented as a known limitation, not expected in
    // practice) a legacy record whose trade no longer exists in this data source. Either way,
    // skipping is the safe behaviour: never guess an outcome without the real trade to prove it.
    if (!trade) continue;
    const update = computeOutcomeUpdate(trade, record);
    if (update) updates.push(update);
  }

  return updates;
}

// Pure merge — applies one OutcomeUpdate to the matching DecisionRecord, leaving every other field
// (and every non-matching record) untouched. Used to update in-memory React state immediately,
// without waiting for the persistence round-trip to complete.
export function applyOutcomeUpdate(record: DecisionRecord, update: OutcomeUpdate): DecisionRecord {
  if (record.id !== update.recordId) return record;
  return {
    ...record,
    outcome: update.outcome,
    realisedPnl: update.realisedPnl,
    realisedPnlPercent: update.realisedPnlPercent,
    holdingDurationMinutes: update.holdingDurationMinutes,
    closedAt: update.closedAt,
    outcomeRecordedAt: update.outcomeRecordedAt,
  };
}

export function applyOutcomeUpdates(records: DecisionRecord[], updates: OutcomeUpdate[]): DecisionRecord[] {
  if (updates.length === 0) return records;
  const updatesById = new Map(updates.map((update) => [update.recordId, update]));
  return records.map((record) => {
    const update = updatesById.get(record.id);
    return update ? applyOutcomeUpdate(record, update) : record;
  });
}
