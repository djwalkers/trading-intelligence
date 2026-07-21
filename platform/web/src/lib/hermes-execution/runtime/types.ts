import type { MarketDecisionAction } from "../market-decision-engine";
import type { TradeLifecycleStatus } from "../trade-lifecycle/types";

// Milestone 7 — 24/7 Scheduler & Runtime Control. Same modeling conventions as Milestone 6's
// TradeLifecycleStatus/VALID_TRANSITIONS (trade-lifecycle/types.ts) — a plain string-literal union
// plus a `Record<State, State[]>` exhaustiveness table enforced by assertValidTransition, not
// encoded into the type system itself.

export type TradingRuntimeState = "STOPPED" | "RUNNING" | "PAUSED" | "STOPPING";

/**
 * STOPPED -> RUNNING: start().
 * RUNNING -> PAUSED: pause(). RUNNING -> STOPPING: stop().
 * PAUSED -> RUNNING: resume(). PAUSED -> STOPPING: stop() (pausing never skips graceful shutdown —
 *   an already-in-flight cycle from before the pause may still be running).
 * STOPPING -> STOPPED: reached automatically once any in-flight cycle finishes — never called
 *   directly by a public method.
 * Every other pair (including every self-transition, e.g. starting an already-running runtime, or
 * resuming when not paused) is invalid and throws InvalidTradingRuntimeTransitionError.
 */
export const VALID_RUNTIME_TRANSITIONS: Record<TradingRuntimeState, readonly TradingRuntimeState[]> = {
  STOPPED: ["RUNNING"],
  RUNNING: ["PAUSED", "STOPPING"],
  PAUSED: ["RUNNING", "STOPPING"],
  STOPPING: ["STOPPED"],
};

export class InvalidTradingRuntimeTransitionError extends Error {
  constructor(
    public readonly from: TradingRuntimeState,
    public readonly to: TradingRuntimeState,
  ) {
    super(
      `Invalid trading runtime transition: ${from} -> ${to}. Valid transitions from ${from}: ${
        VALID_RUNTIME_TRANSITIONS[from].length > 0 ? VALID_RUNTIME_TRANSITIONS[from].join(", ") : "(none)"
      }.`,
    );
    this.name = "InvalidTradingRuntimeTransitionError";
  }
}

export function assertValidRuntimeTransition(from: TradingRuntimeState, to: TradingRuntimeState): void {
  if (!VALID_RUNTIME_TRANSITIONS[from].includes(to)) {
    throw new InvalidTradingRuntimeTransitionError(from, to);
  }
}

/** A trimmed, JSON-serialisable summary of one cycle's outcome — never the full
 * MarketDecisionCycleResult (which nests PaperPosition/CompletedTrade/etc.), and never a raw Error
 * — "Do not expose raw Error objects in serialisable status." */
export interface TradingCycleResultSummary {
  decision: MarketDecisionAction;
  executed: boolean;
  instrument: string;
  lifecycleRecordId?: string;
  lifecycleStatus?: TradeLifecycleStatus;
}

export interface TradingErrorSummary {
  message: string;
  occurredAt: string;
}

/**
 * The full runtime status snapshot. All timestamps are ISO 8601 strings or null (never `Date`
 * objects — matches every other timestamp field in this codebase, and keeps this type trivially
 * JSON-serialisable for printing/logging).
 *
 * `lastResult` and `lastError` are independent "most recent" trackers, not cleared by each other:
 * `lastResult` holds the most recent SUCCESSFUL cycle's summary (a run that returned an outcome
 * without throwing, however that outcome resolved — HOLD/RISK_REJECTED/OPEN/CLOSED are all
 * "successful" here in the sense that the pipeline itself didn't error); `lastError` holds the most
 * recent FAILED cycle's error (the pipeline call itself threw, e.g. a broker execution failure). A
 * later failure does not blank out an earlier success, and vice versa — both remain visible.
 */
export interface TradingRuntimeStatus {
  state: TradingRuntimeState;
  startedAt: string | null;
  /** The most recent time pause() was called — sticky across a subsequent resume(), so "when were
   * we last paused" remains visible even while RUNNING again. Reset to null only by a fresh
   * start(). */
  pausedAt: string | null;
  stoppedAt: string | null;
  intervalMs: number;
  isCycleRunning: boolean;
  /** Set when a cycle actually starts executing — never set for a tick that was skipped (paused/
   * overlap/market-closed). */
  lastRunStartedAt: string | null;
  /** Set when a cycle finishes, successfully or not — the counterpart to lastRunStartedAt. */
  lastRunCompletedAt: string | null;
  nextRunAt: string | null;
  successfulRunCount: number;
  failedRunCount: number;
  skippedOverlapCount: number;
  skippedPausedCount: number;
  skippedMarketClosedCount: number;
  lastResult: TradingCycleResultSummary | null;
  lastError: TradingErrorSummary | null;
}
