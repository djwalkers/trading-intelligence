import type { TradeCandidate } from "../trade-approval/types";
import type { TradeCandidateRepository } from "../trade-approval/trade-candidate-repository";
import type { TradeLifecycleStore } from "../trade-lifecycle/trade-lifecycle-store";
import { buildTradePerformanceInput } from "./calculate-trade-performance";
import type { TradePerformanceRecord } from "./types";
import type { TradePerformanceRepository } from "./trade-performance-repository";

// Phase 4 — Trade Performance Engine. Called from exactly one place: TradingRuntime.runCycleBody,
// once per cycle, for each candidate id that cycle's own (unmodified) executeApprovedTradeCandidate
// step reports as executed — mirroring Phase 2B's persistAnalysis() precedent exactly: a small,
// best-effort, read-only observation step bolted onto an already-completed cycle, wrapped in a
// try/catch by the caller so a failure here can never affect the cycle's own decision, risk,
// execution, or approval outcome. This module only ever calls existing, unmodified READ methods on
// TradeCandidateRepository/TradeLifecycleStore (getById/list) — it never writes to either, and
// never touches MarketDecisionEngine, a Strategy, PortfolioRiskEngine, the broker, or the trade
// approval workflow's own mutation paths (approve/reject/execute).
//
// Data-locality note: TradeLifecycleStore is still in-memory only (see its own top-of-file
// comment, unchanged since Milestone 6) — MFE/MAE/realised P&L/holding time only exist inside the
// SAME process as the standalone trading runtime. This is why this module is invoked from
// trading-runtime.ts itself rather than as a fully decoupled reconciliation job: nothing outside
// that process can observe those figures at all.

/**
 * Finds the BUY-direction, EXECUTED TradeCandidate that most recently opened this strategy+
 * instrument's position before the closing SELL candidate — the candidate whose stop-loss
 * `calculateRiskMultiple` needs. Undefined is a legitimate outcome (e.g. the position pre-dates
 * this repository's data, or was opened by something other than an approved candidate) — never
 * guessed or defaulted.
 */
async function findOpeningCandidate(
  candidateRepository: TradeCandidateRepository,
  closingCandidate: TradeCandidate,
): Promise<TradeCandidate | undefined> {
  const executed = await candidateRepository.list({
    status: "EXECUTED",
    strategyId: closingCandidate.strategyId,
    instrument: closingCandidate.instrument,
    limit: 500,
  });

  const openingCandidates = executed
    .filter((candidate) => candidate.direction === "BUY" && candidate.executedAt !== undefined)
    .filter((candidate) => candidate.executedAt! <= (closingCandidate.executedAt ?? closingCandidate.createdAt))
    .sort((a, b) => b.executedAt!.localeCompare(a.executedAt!));

  return openingCandidates[0];
}

export interface RecordTradePerformanceInput {
  candidateRepository: TradeCandidateRepository;
  lifecycleStore: TradeLifecycleStore;
  performanceRepository: TradePerformanceRepository;
  /** A candidate id this cycle's executeApprovedTradeCandidate step reported as executed — not
   * every such id represents a closing trade (a BUY execution opens a position, not closes one);
   * this function itself filters for that. */
  candidateId: string;
}

/**
 * Returns the recorded TradePerformanceRecord, or undefined when `candidateId` did not represent a
 * closing (SELL) execution with a resolvable CLOSED lifecycle record — not an error, just nothing
 * to record this time. Idempotent (see TradePerformanceRepository.upsert's own doc comment): safe
 * to call more than once for the same closed trade.
 */
export async function recordTradePerformanceForExecutedCandidate(
  input: RecordTradePerformanceInput,
): Promise<TradePerformanceRecord | undefined> {
  const { candidateRepository, lifecycleStore, performanceRepository, candidateId } = input;

  const closingCandidate = await candidateRepository.getById(candidateId);
  if (!closingCandidate || closingCandidate.direction !== "SELL" || closingCandidate.status !== "EXECUTED") {
    return undefined;
  }
  if (!closingCandidate.lifecycleRecordId) return undefined;

  const record = await lifecycleStore.getById(closingCandidate.lifecycleRecordId);
  if (!record || record.status !== "CLOSED") return undefined;

  const openingCandidate = await findOpeningCandidate(candidateRepository, closingCandidate);

  const performanceInput = buildTradePerformanceInput({
    record,
    closingCandidate,
    openingCandidate,
  });

  return performanceRepository.upsert(performanceInput);
}
