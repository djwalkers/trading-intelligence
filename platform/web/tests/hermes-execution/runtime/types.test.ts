import { describe, expect, it } from "vitest";
import {
  assertValidRuntimeTransition,
  InvalidTradingRuntimeTransitionError,
  VALID_RUNTIME_TRANSITIONS,
  type TradingRuntimeState,
} from "@/lib/hermes-execution/runtime/types";

const ALL_STATES: TradingRuntimeState[] = ["STOPPED", "RUNNING", "PAUSED", "STOPPING"];

const VALID_PAIRS: Array<[TradingRuntimeState, TradingRuntimeState]> = [
  ["STOPPED", "RUNNING"],
  ["RUNNING", "PAUSED"],
  ["RUNNING", "STOPPING"],
  ["PAUSED", "RUNNING"],
  ["PAUSED", "STOPPING"],
  ["STOPPING", "STOPPED"],
];

describe("VALID_RUNTIME_TRANSITIONS", () => {
  it("has exactly the four required states as keys", () => {
    expect(Object.keys(VALID_RUNTIME_TRANSITIONS).sort()).toEqual([...ALL_STATES].sort());
  });
});

describe("assertValidRuntimeTransition — every valid transition", () => {
  for (const [from, to] of VALID_PAIRS) {
    it(`allows ${from} -> ${to}`, () => {
      expect(() => assertValidRuntimeTransition(from, to)).not.toThrow();
    });
  }
});

describe("assertValidRuntimeTransition — invalid transitions", () => {
  it("rejects every (from, to) pair not explicitly listed as valid", () => {
    const validSet = new Set(VALID_PAIRS.map(([from, to]) => `${from}->${to}`));
    let checked = 0;
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (validSet.has(`${from}->${to}`)) continue;
        expect(() => assertValidRuntimeTransition(from, to)).toThrow(InvalidTradingRuntimeTransitionError);
        checked += 1;
      }
    }
    expect(checked).toBe(ALL_STATES.length * ALL_STATES.length - VALID_PAIRS.length);
  });

  it("rejects starting an already-running runtime (RUNNING -> RUNNING)", () => {
    expect(() => assertValidRuntimeTransition("RUNNING", "RUNNING")).toThrow(InvalidTradingRuntimeTransitionError);
  });

  it("rejects resuming when not paused (RUNNING -> RUNNING via resume's own target)", () => {
    expect(() => assertValidRuntimeTransition("STOPPED", "RUNNING")).not.toThrow(); // start() is valid...
    expect(() => assertValidRuntimeTransition("RUNNING", "RUNNING")).toThrow(); // ...but resume()-while-RUNNING is not
  });

  it("rejects pausing when stopped (STOPPED -> PAUSED)", () => {
    expect(() => assertValidRuntimeTransition("STOPPED", "PAUSED")).toThrow(InvalidTradingRuntimeTransitionError);
  });

  it("rejects stopping an already-stopped runtime (STOPPED -> STOPPING)", () => {
    expect(() => assertValidRuntimeTransition("STOPPED", "STOPPING")).toThrow(InvalidTradingRuntimeTransitionError);
  });

  it("rejects a second concurrent stop (STOPPING -> STOPPING)", () => {
    expect(() => assertValidRuntimeTransition("STOPPING", "STOPPING")).toThrow(InvalidTradingRuntimeTransitionError);
  });

  it("STOPPING can only ever reach STOPPED — never RUNNING or PAUSED directly", () => {
    expect(() => assertValidRuntimeTransition("STOPPING", "RUNNING")).toThrow(InvalidTradingRuntimeTransitionError);
    expect(() => assertValidRuntimeTransition("STOPPING", "PAUSED")).toThrow(InvalidTradingRuntimeTransitionError);
  });

  it("error carries the from/to states and lists the valid alternatives", () => {
    try {
      assertValidRuntimeTransition("STOPPED", "PAUSED");
      expect.unreachable("expected assertValidRuntimeTransition to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTradingRuntimeTransitionError);
      const typed = error as InvalidTradingRuntimeTransitionError;
      expect(typed.from).toBe("STOPPED");
      expect(typed.to).toBe("PAUSED");
      expect(typed.message).toMatch(/RUNNING/);
    }
  });
});
