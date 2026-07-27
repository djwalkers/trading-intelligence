import { describe, expect, it } from "vitest";
import {
  assertValidTransition,
  InvalidTradeLifecycleTransitionError,
  VALID_TRANSITIONS,
  type TradeLifecycleStatus,
} from "@/lib/hermes-execution/trade-lifecycle/types";

const ALL_STATUSES: TradeLifecycleStatus[] = [
  "DECISION_CREATED",
  "RISK_REJECTED",
  "APPROVED",
  "EXECUTION_SUBMITTED",
  "OPEN",
  "CLOSE_REQUESTED",
  "CLOSED",
  "EXECUTION_FAILED",
  "CLOSE_FAILED",
  "CLOSED_UNRECONCILED",
  "EXECUTION_ABANDONED",
  "EXECUTION_RECONCILIATION_REQUIRED",
];

const VALID_PAIRS: Array<[TradeLifecycleStatus, TradeLifecycleStatus]> = [
  ["DECISION_CREATED", "RISK_REJECTED"],
  ["DECISION_CREATED", "APPROVED"],
  ["APPROVED", "EXECUTION_SUBMITTED"],
  ["EXECUTION_SUBMITTED", "OPEN"],
  ["EXECUTION_SUBMITTED", "EXECUTION_FAILED"],
  ["OPEN", "CLOSE_REQUESTED"],
  ["OPEN", "CLOSED_UNRECONCILED"],
  ["CLOSE_REQUESTED", "CLOSED"],
  ["CLOSE_REQUESTED", "CLOSE_FAILED"],
  ["CLOSE_REQUESTED", "CLOSED_UNRECONCILED"],
  // Restart-Resilient Autonomy Phase — reconciliation hardening. CLOSE_FAILED is no longer
  // unconditionally terminal: reconciliation may safely revert it to OPEN (broker still shows the
  // position live — a retry) or resolve it to CLOSED_UNRECONCILED (broker confirms it's gone, no
  // confirmed exit economics) — see position-reconciliation.ts.
  ["CLOSE_FAILED", "OPEN"],
  ["CLOSE_FAILED", "CLOSED_UNRECONCILED"],
  // Restart-Resilient Autonomy Phase — crash-window recovery (deployment safety review). A stale
  // DECISION_CREATED/APPROVED/EXECUTION_SUBMITTED record (or one already flagged
  // EXECUTION_RECONCILIATION_REQUIRED) may be abandoned (proven no real order/position exists) or,
  // for EXECUTION_SUBMITTED only in practice, flagged ambiguous — see runtime/lifecycle-recovery.ts.
  ["DECISION_CREATED", "EXECUTION_ABANDONED"],
  ["DECISION_CREATED", "EXECUTION_RECONCILIATION_REQUIRED"],
  ["APPROVED", "EXECUTION_ABANDONED"],
  ["APPROVED", "EXECUTION_RECONCILIATION_REQUIRED"],
  ["EXECUTION_SUBMITTED", "EXECUTION_ABANDONED"],
  ["EXECUTION_SUBMITTED", "EXECUTION_RECONCILIATION_REQUIRED"],
  ["EXECUTION_RECONCILIATION_REQUIRED", "OPEN"],
  ["EXECUTION_RECONCILIATION_REQUIRED", "EXECUTION_ABANDONED"],
];

const TERMINAL_STATUSES: TradeLifecycleStatus[] = [
  "RISK_REJECTED",
  "CLOSED",
  "EXECUTION_FAILED",
  "CLOSED_UNRECONCILED",
  "EXECUTION_ABANDONED",
];

describe("VALID_TRANSITIONS — covers every required lifecycle state", () => {
  it("has exactly the twelve states (nine original + CLOSED_UNRECONCILED + EXECUTION_ABANDONED + EXECUTION_RECONCILIATION_REQUIRED) as keys", () => {
    expect(Object.keys(VALID_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("marks RISK_REJECTED, CLOSED, EXECUTION_FAILED, CLOSED_UNRECONCILED and EXECUTION_ABANDONED as terminal (no outgoing transitions)", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(VALID_TRANSITIONS[status]).toEqual([]);
    }
  });

  it("CLOSE_FAILED is no longer terminal — it has exactly two outgoing transitions (OPEN, CLOSED_UNRECONCILED)", () => {
    expect([...VALID_TRANSITIONS.CLOSE_FAILED].sort()).toEqual(["CLOSED_UNRECONCILED", "OPEN"]);
  });

  it("EXECUTION_RECONCILIATION_REQUIRED is not terminal — it has exactly two outgoing transitions (OPEN, EXECUTION_ABANDONED)", () => {
    expect([...VALID_TRANSITIONS.EXECUTION_RECONCILIATION_REQUIRED].sort()).toEqual(["EXECUTION_ABANDONED", "OPEN"]);
  });
});

describe("assertValidTransition — every valid transition", () => {
  for (const [from, to] of VALID_PAIRS) {
    it(`allows ${from} -> ${to}`, () => {
      expect(() => assertValidTransition(from, to)).not.toThrow();
    });
  }
});

describe("assertValidTransition — invalid transitions", () => {
  it("rejects every (from, to) pair not explicitly listed as valid, for every status", () => {
    const validSet = new Set(VALID_PAIRS.map(([from, to]) => `${from}->${to}`));
    let checked = 0;
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (validSet.has(`${from}->${to}`)) continue;
        expect(() => assertValidTransition(from, to)).toThrow(InvalidTradeLifecycleTransitionError);
        checked += 1;
      }
    }
    // Sanity check that this test actually exercised a meaningful number of invalid pairs, not a
    // no-op loop (12x12 = 144 total pairs, 20 are valid, so 124 must have been checked here).
    expect(checked).toBe(ALL_STATUSES.length * ALL_STATUSES.length - VALID_PAIRS.length);
  });

  it("rejects a self-transition (e.g. OPEN -> OPEN)", () => {
    expect(() => assertValidTransition("OPEN", "OPEN")).toThrow(InvalidTradeLifecycleTransitionError);
  });

  it("rejects skipping a required intermediate state (DECISION_CREATED -> OPEN)", () => {
    expect(() => assertValidTransition("DECISION_CREATED", "OPEN")).toThrow(/DECISION_CREATED -> OPEN/);
  });

  it("rejects transitioning out of every terminal state", () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of ALL_STATUSES) {
        expect(() => assertValidTransition(from, to)).toThrow(InvalidTradeLifecycleTransitionError);
      }
    }
  });

  it("error carries the from/to statuses and lists the valid alternatives", () => {
    try {
      assertValidTransition("OPEN", "CLOSED");
      expect.unreachable("expected assertValidTransition to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTradeLifecycleTransitionError);
      const typed = error as InvalidTradeLifecycleTransitionError;
      expect(typed.from).toBe("OPEN");
      expect(typed.to).toBe("CLOSED");
      expect(typed.message).toMatch(/CLOSE_REQUESTED/);
    }
  });
});
