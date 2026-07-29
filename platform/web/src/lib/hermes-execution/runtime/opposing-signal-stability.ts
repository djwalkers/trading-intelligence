// Hardening pass — opposing-signal exit stability. The current runtime could close a newly opened
// position almost immediately when Hermes reverses its view on the very next scan — a single
// reversal-then-back scan is not, on its own, sufficient evidence to close a real position. This
// module adds a deterministic, additional gate applied ONLY to the OPPOSING_SIGNAL trigger, layered
// on top of the existing, UNMODIFIED evaluateExitTrigger (exit-monitor.ts) — stop-loss, take-profit,
// kill-switch, strategy-disabled, and max-holding exits are never touched by this file at all, and
// remain exactly as immediate as they always were.
//
// Remediation pass (senior review finding C1) — keyed by POSITION IDENTITY (a TradeLifecycleRecord's
// own `id`), never by instrument alone. Two DIFFERENT positions on the same instrument — whether
// because the first closed (via this runtime's own exit, or discovered gone via reconciliation) and
// a later, unrelated position opened, or because reconciliation replaced one broker position with
// another within a single cycle (an adopted-orphan scenario) — always get their own, independent
// counters: the Map key is the position's own id, so a brand new position can never observe, let
// alone inherit, a count that belonged to a different position. `syncPosition()` (called once per
// instrument per cycle, from Phase A, immediately after reconciliation) is what detects "the
// previously-tracked position for this instrument is gone or has been replaced" and cleans up the
// OLD identity's own entry — see its own doc comment.
//
// Deliberately process-local, in-memory only (plain Maps, never persisted): a restart loses every
// count and position-identity mapping; the position simply starts re-accumulating confirmations from
// zero on the next opposing scan — never MORE cautious than intended (a restart can only delay an
// exit, never skip the minimum-hold-period check, which is derived fresh every cycle from the
// lifecycle record's own durable `openedAt`), and never trigger an exit that wouldn't otherwise have
// happened. This is a deliberate, documented trade-off: implementing durable cross-restart counting
// would require either a new persisted column (this hardening pass' own "no database migration unless
// genuinely necessary" instruction argues against) or overloading an existing field for an unrelated
// purpose — the safer, simpler choice is documented process-local state.

export interface OpposingSignalStabilityConfig {
  /** Minimum time (ms) a position must have been held before an OPPOSING_SIGNAL exit is even
   * considered. 0 disables this specific gate (the consecutive-confirmation gate still applies). */
  minHoldMs: number;
  /** How many CONSECUTIVE cycles the raw signal must be OPPOSING_SIGNAL before the exit is allowed
   * to fire, once the minimum hold period has also elapsed. Must be >= 1.
   *
   * Explicit policy (senior review finding M1, now documented rather than merely implicit):
   * confirmations observed WHILE the position is still within its minimum hold period DO
   * accumulate — they are never discarded or reset just because the hold period hasn't elapsed
   * yet. Once the hold period elapses, the exit fires on the very next opposing cycle if the
   * required count has ALREADY been reached (including confirmations counted during the hold
   * period) — there is no additional "fresh confirmations only after hold elapses" requirement.
   * Rationale: the two gates test two independent properties of the SAME ongoing evidence (how
   * long has the signal been consistently opposing, and how many consecutive cycles has it been
   * opposing) — an opposing signal that has held continuously since well before the minimum hold
   * period elapsed has already satisfied the "not a one-scan blip" concern this feature exists to
   * address; requiring a SECOND, fresh run of confirmations after the hold clock separately expires
   * would not add any real evidence, only delay. See OpposingSignalStabilityTracker.evaluate's own
   * increment-then-check order below for exactly where this is implemented. */
  requiredConsecutiveSignals: number;
}

export interface OpposingSignalGateInput {
  /** The position's own stable identity — a TradeLifecycleRecord's own `id` (see
   * runInstrumentPhaseB's own call site). NEVER the instrument name: two different positions on
   * the same instrument (a closed-then-reopened one, or a reconciliation-replaced one) must never
   * share a counter — see this module's own top-of-file comment. */
  positionId: string;
  /** Whether THIS cycle's own evaluateExitTrigger call actually returned "OPPOSING_SIGNAL" — every
   * other outcome (HOLD/no trigger, or a DIFFERENT trigger firing instead) resets the counter to
   * zero, satisfying "reset the opposing-signal count when the signal is no longer opposing." */
  isOpposingSignalTriggered: boolean;
  /** The position's own record.openedAt (ISO timestamp) — undefined only for a lifecycle record
   * that was never actually opened (should not occur for a position evaluateExitTrigger is being
   * run against at all, but handled defensively: treated as "minimum hold not yet reached," never
   * as "already held long enough"). */
  openedAt: string | undefined;
  now: Date;
  config: OpposingSignalStabilityConfig;
}

export type OpposingSignalGateResult =
  | { allow: true; consecutiveCount: number }
  | {
      allow: false;
      consecutiveCount: number;
      requiredConsecutiveSignals: number;
      /** Priority order when both gates would otherwise block: minimum hold period is checked
       * first — a position that hasn't been held long enough is deferred for that reason even if it
       * would also fail the confirmation count. */
      reason: "min-hold-not-reached" | "insufficient-confirmations";
      /** null (never 0) when `openedAt` was missing/malformed — see this field's own doc comment
       * on OpposingSignalGateInput.openedAt. 0 would misleadingly read as "just opened." */
      heldMs: number | null;
      minHoldMs: number;
    };

/**
 * Tracks, per POSITION IDENTITY (never per instrument alone — see this module's own top-of-file
 * comment), how many CONSECUTIVE cycles in a row the raw OPPOSING_SIGNAL trigger has fired — a
 * plain in-memory Map, one instance per TradingRuntime (see that class's own
 * `opposingSignalStability` field). `evaluate()` is the only way a count changes: called once per
 * open position per cycle, from runInstrumentPhaseB, immediately after evaluateExitTrigger returns.
 */
export class OpposingSignalStabilityTracker {
  private readonly consecutiveCounts = new Map<string, number>();
  /** instrument -> the position id last observed active for it (Phase A's own reconciled record,
   * if any) — the state syncPosition() uses to detect a closed-or-replaced position. */
  private readonly activePositionByInstrument = new Map<string, string>();

  /** Returns `undefined` when `input.isOpposingSignalTriggered` is false — nothing to gate this
   * cycle (also resets the counter for this position, per this module's own reset requirement).
   * Otherwise increments the counter and returns whether the exit is allowed to actually fire. */
  evaluate(input: OpposingSignalGateInput): OpposingSignalGateResult | undefined {
    if (!input.isOpposingSignalTriggered) {
      this.consecutiveCounts.delete(input.positionId);
      return undefined;
    }

    const rawHeldMs = input.openedAt !== undefined ? input.now.getTime() - Date.parse(input.openedAt) : Number.NaN;
    const heldMsKnown = Number.isFinite(rawHeldMs);
    const minHoldReached = heldMsKnown && rawHeldMs >= input.config.minHoldMs;

    // Explicit accumulation policy — see OpposingSignalStabilityConfig.requiredConsecutiveSignals's
    // own doc comment: the count increments regardless of whether the hold period has elapsed yet,
    // so confirmations observed during the hold period are never discarded.
    const nextCount = (this.consecutiveCounts.get(input.positionId) ?? 0) + 1;
    this.consecutiveCounts.set(input.positionId, nextCount);

    if (!minHoldReached) {
      return {
        allow: false,
        consecutiveCount: nextCount,
        requiredConsecutiveSignals: input.config.requiredConsecutiveSignals,
        reason: "min-hold-not-reached",
        heldMs: heldMsKnown ? rawHeldMs : null,
        minHoldMs: input.config.minHoldMs,
      };
    }

    if (nextCount < input.config.requiredConsecutiveSignals) {
      return {
        allow: false,
        consecutiveCount: nextCount,
        requiredConsecutiveSignals: input.config.requiredConsecutiveSignals,
        reason: "insufficient-confirmations",
        heldMs: rawHeldMs,
        minHoldMs: input.config.minHoldMs,
      };
    }

    return { allow: true, consecutiveCount: nextCount };
  }

  /** Explicitly clears this POSITION's own counter — called whenever it closes, by ANY means (an
   * allowed opposing-signal exit, a different automatic-exit trigger, or a human-approved SELL
   * candidate's own execution). Kept alongside syncPosition's own reconciliation-driven cleanup
   * (never a replacement for it — see this module's own top-of-file comment) so a position closed
   * by this runtime's own action is cleaned up immediately, not merely on the next cycle's sync. */
  reset(positionId: string): void {
    this.consecutiveCounts.delete(positionId);
  }

  /**
   * Remediation pass (senior review finding C1) — called once per instrument per cycle, from
   * Phase A, immediately after reconciliation resolves the current position for that instrument
   * (or the absence of one). Detects two distinct "the previously-tracked position is gone"
   * conditions and cleans up the OLD position's own confirmation count in both:
   *
   * 1. Closed via reconciliation alone (no explicit automatic-exit/candidate-execution reset call
   *    ever ran for it — e.g. a manual out-of-band closure, or any other externally-observed
   *    disappearance): `currentPositionId` is undefined where a position was previously tracked.
   * 2. Replaced by a DIFFERENT position within a single cycle (an adopted-orphan scenario, where
   *    reconciliation discovers a new broker position and creates a new lifecycle record for the
   *    same instrument without this runtime ever observing an intermediate "no position" cycle):
   *    `currentPositionId` differs from what was previously tracked, both defined.
   *
   * Never resets anything when there was no previously-tracked position for this instrument to
   * begin with (`currentPositionId` undefined and nothing tracked) — a pure no-op in that case, so
   * a fresh, never-opened instrument is never touched. Never resets when the identity is UNCHANGED
   * (the same position, still open) — this is what lets a genuine, still-accumulating count survive
   * across cycles for the SAME position.
   */
  syncPosition(instrument: string, currentPositionId: string | undefined): void {
    const previousPositionId = this.activePositionByInstrument.get(instrument);

    if (previousPositionId !== undefined && previousPositionId !== currentPositionId) {
      this.consecutiveCounts.delete(previousPositionId);
    }

    if (currentPositionId === undefined) {
      this.activePositionByInstrument.delete(instrument);
    } else {
      this.activePositionByInstrument.set(instrument, currentPositionId);
    }
  }
}
