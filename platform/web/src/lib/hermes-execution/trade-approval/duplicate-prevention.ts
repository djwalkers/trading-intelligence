import type { TradeLifecycleStore } from "../trade-lifecycle/trade-lifecycle-store";
import type { TradeLifecycleStatus } from "../trade-lifecycle/types";
import type { TradeCandidateRepository } from "./trade-candidate-repository";

// Restart-Resilient Autonomy Phase — Phase 6 (Duplicate prevention). One shared check, called from
// TradingRuntime.runCycleBody immediately before a fresh BUY decision would otherwise become a new
// TradeCandidate. Deliberately never called for a fresh SELL decision — closing a position is
// always a risk-reduction action and must never be suppressed as a "duplicate."
//
// The broker-position / durable-OPEN-lifecycle-record case is already structurally covered before
// this even runs: position-reconciliation.ts overrides `positionOpen` on the MarketDecisionContext
// each cycle, and every registered Strategy's own evaluate() never proposes a BUY while
// positionOpen is true (see e.g. Demo0001Strategy.evaluate's own `if (positionOpen) {...}` branch).
// This check covers the remaining, structurally-independent cases the mission calls for: a PENDING
// or APPROVED BUY candidate already awaiting human/automatic action, or an order already submitted
// but not yet confirmed OPEN ("being reconciled").

export interface CheckForDuplicateEntryInput {
  tradeCandidateRepository: TradeCandidateRepository;
  lifecycleStore: TradeLifecycleStore;
  strategyId: string;
  instrument: string;
}

export type DuplicateEntryCheckResult = { duplicate: false } | { duplicate: true; reason: string };

// Restart-Resilient Autonomy Phase — reconciliation hardening. Widened to match migration 0026's
// own trade_lifecycle_records_active_strategy_instrument_uidx exactly (DECISION_CREATED/APPROVED
// added alongside the pre-existing three). CLOSE_FAILED in particular closes a real gap: excluding
// it let a fresh BUY be proposed for a strategy+instrument whose prior position had only failed to
// close (still genuinely live at the broker), not actually freed up. DECISION_CREATED/APPROVED are
// included for defense-in-depth/consistency with the database invariant, even though within one
// process a lifecycle record never lingers at either status past the same synchronous execution
// attempt that created it. EXECUTION_RECONCILIATION_REQUIRED (crash-window recovery) also included
// — an unresolved ambiguous record must keep blocking a fresh entry until a later recovery sweep
// resolves it one way or the other. EXECUTION_ABANDONED deliberately excluded — terminal, frees the
// slot, same as CLOSED_UNRECONCILED.
const IN_FLIGHT_STATUSES = new Set<TradeLifecycleStatus>([
  "DECISION_CREATED",
  "APPROVED",
  "EXECUTION_SUBMITTED",
  "OPEN",
  "CLOSE_REQUESTED",
  "CLOSE_FAILED",
  "EXECUTION_RECONCILIATION_REQUIRED",
]);

export async function checkForDuplicateEntry(input: CheckForDuplicateEntryInput): Promise<DuplicateEntryCheckResult> {
  const { tradeCandidateRepository, lifecycleStore, strategyId, instrument } = input;

  const [pendingCandidates, approvedCandidates, lifecycleRecords] = await Promise.all([
    tradeCandidateRepository.list({ status: "PENDING", strategyId, instrument }),
    tradeCandidateRepository.list({ status: "APPROVED", strategyId, instrument }),
    // Egress-containment fix: was lifecycleStore.list() — a full-table select("*"), JSONB `detail`
    // blob included — called before every fresh BUY decision. Bounded server-side to this exact
    // strategy+instrument+status set instead (at most one matching row, by construction of migration
    // 0026's own active-strategy-instrument uniqueness index).
    lifecycleStore.listActiveLifecycleRecords({ strategyId, instrument, statuses: [...IN_FLIGHT_STATUSES] }),
  ]);

  const pendingBuy = pendingCandidates.find((c) => c.direction === "BUY");
  if (pendingBuy) {
    return {
      duplicate: true,
      reason: `A PENDING BUY candidate (${pendingBuy.id}) already exists for ${strategyId} on ${instrument}.`,
    };
  }

  const approvedBuy = approvedCandidates.find((c) => c.direction === "BUY");
  if (approvedBuy) {
    return {
      duplicate: true,
      reason: `An APPROVED BUY candidate (${approvedBuy.id}) is already awaiting execution for ${strategyId} on ${instrument}.`,
    };
  }

  const inFlight = lifecycleRecords.find(
    (record) => record.strategyId === strategyId && record.symbol === instrument && IN_FLIGHT_STATUSES.has(record.status),
  );
  if (inFlight) {
    return {
      duplicate: true,
      reason:
        `An in-flight or open trade lifecycle record (${inFlight.id}, status ${inFlight.status}) already exists for ` +
        `${strategyId} on ${instrument}.`,
    };
  }

  return { duplicate: false };
}
