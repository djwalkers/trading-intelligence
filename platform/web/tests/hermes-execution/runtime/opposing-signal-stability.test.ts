import { describe, expect, it } from "vitest";
import { OpposingSignalStabilityTracker } from "@/lib/hermes-execution/runtime/opposing-signal-stability";

// Hardening pass — opposing-signal exit stability. Pure unit tests against the tracker itself —
// no TradingRuntime, no broker, no lifecycle service involved at all.
//
// Remediation pass (senior review finding C1) — the tracker is now keyed by POSITION IDENTITY
// (a TradeLifecycleRecord's own id), never by instrument alone. `positionId` below stands in for
// that id; the `describe("syncPosition ...")` block below covers the reconciliation-driven
// closure/replacement detection that keying alone does not (memory cleanup + the case where a
// replacement position is discovered without ever passing through an "undefined" observation).

const NOW = new Date("2026-01-01T12:00:00.000Z");
const CONFIG = { minHoldMs: 5 * 60_000, requiredConsecutiveSignals: 2 };

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

describe("OpposingSignalStabilityTracker — not triggered this cycle", () => {
  it("returns undefined and resets any prior count when isOpposingSignalTriggered is false", () => {
    const tracker = new OpposingSignalStabilityTracker();
    // Build up a count first.
    tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    const result = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: false, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    expect(result).toBeUndefined();

    // The count was reset — the next opposing signal starts from 1 again, not 2.
    const next = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    expect(next).toEqual({ allow: false, consecutiveCount: 1, requiredConsecutiveSignals: 2, reason: "insufficient-confirmations", heldMs: 10 * 60_000, minHoldMs: CONFIG.minHoldMs });
  });
});

describe("OpposingSignalStabilityTracker — minimum hold period", () => {
  it("defers with reason 'min-hold-not-reached' when the position hasn't been held long enough, even on the first signal", () => {
    const tracker = new OpposingSignalStabilityTracker();
    const result = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(1), now: NOW, config: CONFIG });
    expect(result).toEqual({
      allow: false,
      consecutiveCount: 1,
      requiredConsecutiveSignals: 2,
      reason: "min-hold-not-reached",
      heldMs: 60_000,
      minHoldMs: 300_000,
    });
  });

  it("prioritises min-hold-not-reached over insufficient-confirmations when both would otherwise block", () => {
    const tracker = new OpposingSignalStabilityTracker();
    // Two consecutive signals (would satisfy requiredConsecutiveSignals=2) but the position is
    // still well within the minimum hold period both times.
    tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(1), now: NOW, config: CONFIG });
    const result = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(1), now: NOW, config: CONFIG });
    expect(result).toMatchObject({ allow: false, reason: "min-hold-not-reached", consecutiveCount: 2 });
  });

  it("treats a missing openedAt as 'not held long enough' rather than as already-satisfied, and reports heldMs as null (never a misleading 0)", () => {
    const tracker = new OpposingSignalStabilityTracker();
    const result = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: undefined, now: NOW, config: CONFIG });
    expect(result).toEqual({
      allow: false,
      consecutiveCount: 1,
      requiredConsecutiveSignals: 2,
      reason: "min-hold-not-reached",
      heldMs: null,
      minHoldMs: 300_000,
    });
  });

  it("treats a malformed openedAt the same way — null heldMs, never 0", () => {
    const tracker = new OpposingSignalStabilityTracker();
    const result = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: "not-a-real-date", now: NOW, config: CONFIG });
    expect(result).toMatchObject({ allow: false, reason: "min-hold-not-reached", heldMs: null });
  });

  it("treats minHoldMs: 0 as always satisfied", () => {
    const tracker = new OpposingSignalStabilityTracker();
    const zeroHoldConfig = { minHoldMs: 0, requiredConsecutiveSignals: 1 };
    const result = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(0), now: NOW, config: zeroHoldConfig });
    expect(result).toEqual({ allow: true, consecutiveCount: 1 });
  });
});

describe("OpposingSignalStabilityTracker — consecutive confirmations", () => {
  it("defers with reason 'insufficient-confirmations' on the first signal once the hold period has elapsed", () => {
    const tracker = new OpposingSignalStabilityTracker();
    const result = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    expect(result).toEqual({
      allow: false,
      consecutiveCount: 1,
      requiredConsecutiveSignals: 2,
      reason: "insufficient-confirmations",
      heldMs: 600_000,
      minHoldMs: 300_000,
    });
  });

  it("allows the exit once the required number of consecutive signals is reached", () => {
    const tracker = new OpposingSignalStabilityTracker();
    tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    const result = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    expect(result).toEqual({ allow: true, consecutiveCount: 2 });
  });

  it("requires exactly 1 confirmation when configured that way (immediate, once the hold period elapses)", () => {
    const tracker = new OpposingSignalStabilityTracker();
    const config = { minHoldMs: 0, requiredConsecutiveSignals: 1 };
    const result = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config });
    expect(result).toEqual({ allow: true, consecutiveCount: 1 });
  });

  // Remediation pass (finding M1 / requirement 7) — explicit policy: confirmations accrued DURING
  // the minimum hold period are never discarded. Once hold elapses, the exit fires on the very
  // first opposing cycle after that if the required count was ALREADY reached beforehand — no
  // separate "fresh confirmations only after hold elapses" requirement exists.
  it("banks MORE than the required confirmations during the hold period, then exits on the first post-hold opposing cycle without needing further confirmations", () => {
    const tracker = new OpposingSignalStabilityTracker();
    const config = { minHoldMs: 5 * 60_000, requiredConsecutiveSignals: 2 };
    // Four consecutive opposing signals, all still within the 5-minute hold period (position held
    // only 1 minute each time) — every one is deferred for "min-hold-not-reached", but the count
    // keeps climbing well past requiredConsecutiveSignals (2).
    for (let i = 0; i < 4; i++) {
      const result = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(1), now: NOW, config });
      expect(result).toMatchObject({ allow: false, reason: "min-hold-not-reached", consecutiveCount: i + 1 });
    }
    // The very first cycle where the hold period has ALSO elapsed (5th consecutive opposing
    // signal overall) allows the exit immediately — the 4 banked confirmations already satisfy
    // requiredConsecutiveSignals (2), no fresh post-hold confirmations are required.
    const result = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config });
    expect(result).toEqual({ allow: true, consecutiveCount: 5 });
  });
});

describe("OpposingSignalStabilityTracker — per-position isolation", () => {
  it("tracks two different position ids entirely independently, even for the same instrument", () => {
    const tracker = new OpposingSignalStabilityTracker();
    tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    const other = tracker.evaluate({ positionId: "L2", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    expect(other).toMatchObject({ consecutiveCount: 1 }); // L1's own count of 2 never leaks into L2
  });
});

describe("OpposingSignalStabilityTracker — reset()", () => {
  it("clears the counter explicitly, so the next signal starts from 1 again", () => {
    const tracker = new OpposingSignalStabilityTracker();
    tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    tracker.reset("L1");
    const result = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    expect(result).toMatchObject({ consecutiveCount: 1 });
  });

  it("is a safe no-op for a position id with no existing counter", () => {
    const tracker = new OpposingSignalStabilityTracker();
    expect(() => tracker.reset("L1")).not.toThrow();
  });
});

// Remediation pass (senior review finding C1) — syncPosition is the mechanism that detects a
// tracked position has closed (via reconciliation alone, with no explicit reset() call ever
// having run for it) or been REPLACED by a different position within a single cycle, and cleans
// up the OLD position's own confirmation count in both cases.
describe("OpposingSignalStabilityTracker — syncPosition (reconciliation-driven closure/replacement)", () => {
  it("does nothing when there is currently no position and none was ever tracked for this instrument", () => {
    const tracker = new OpposingSignalStabilityTracker();
    expect(() => tracker.syncPosition("BTC", undefined)).not.toThrow();
    // No stale entry was created — a subsequent position starts fresh regardless.
    const result = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    expect(result).toMatchObject({ consecutiveCount: 1 });
  });

  it("does NOT reset an unchanged, still-open position's own accumulating count", () => {
    const tracker = new OpposingSignalStabilityTracker();
    tracker.syncPosition("BTC", "L1");
    tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    // Same position observed again next cycle — must not disturb the count.
    tracker.syncPosition("BTC", "L1");
    const result = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    expect(result).toEqual({ allow: true, consecutiveCount: 2 });
  });

  // THE regression test for finding C1 itself.
  it("resets a position's own count once reconciliation reports it no longer open, so a later, unrelated position on the same instrument starts fresh", () => {
    const tracker = new OpposingSignalStabilityTracker();

    // Cycle 1: position L1 opens on BTC.
    tracker.syncPosition("BTC", "L1");
    // Cycle 2: one opposing confirmation accumulates for L1 (deferred — requires 2).
    const first = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    expect(first).toMatchObject({ allow: false, consecutiveCount: 1 });

    // Cycle 3: L1 closes externally — reconciliation now reports no position for BTC at all, with
    // NO explicit reset() call ever having run for L1 (no automatic-exit/candidate-execution path
    // fired — this simulates a manual out-of-band closure or any other externally-observed
    // disappearance).
    tracker.syncPosition("BTC", undefined);

    // Cycle 4: a brand NEW, entirely unrelated position L2 opens on the same instrument BTC.
    tracker.syncPosition("BTC", "L2");
    // Its own first opposing signal must NOT inherit L1's stale count of 1 — it must start at 1,
    // not jump to 2 and satisfy a 2-confirmation requirement on a single real observation.
    const secondPositionFirstSignal = tracker.evaluate({
      positionId: "L2",
      isOpposingSignalTriggered: true,
      openedAt: minutesAgo(10),
      now: NOW,
      config: CONFIG,
    });
    expect(secondPositionFirstSignal).toMatchObject({ allow: false, consecutiveCount: 1, reason: "insufficient-confirmations" });
  });

  // Broker-position replacement: reconciliation discovers a DIFFERENT position for the same
  // instrument within a single cycle (an adopted-orphan scenario), without ever passing through
  // an intermediate "undefined" observation this tracker could otherwise have seen.
  it("resets on direct position replacement (no intermediate undefined observation)", () => {
    const tracker = new OpposingSignalStabilityTracker();

    tracker.syncPosition("BTC", "L1");
    tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });

    // Reconciliation jumps DIRECTLY from L1 to a new L2 for the same instrument — L1 is gone and
    // L2 is a genuinely different, newly-adopted position, observed in the very same cycle.
    tracker.syncPosition("BTC", "L2");

    const result = tracker.evaluate({ positionId: "L2", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    expect(result).toMatchObject({ allow: false, consecutiveCount: 1 });

    // L1's own entry is truly gone, not just shadowed — re-observing L1's id afresh also starts at 1.
    const l1Again = tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    expect(l1Again).toMatchObject({ consecutiveCount: 1 });
  });

  it("tracks multiple instruments' own active positions independently", () => {
    const tracker = new OpposingSignalStabilityTracker();
    tracker.syncPosition("BTC", "L1");
    tracker.syncPosition("ETH", "L2");
    tracker.evaluate({ positionId: "L1", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    tracker.evaluate({ positionId: "L2", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });

    // Only BTC's own position closes — ETH's own count must be untouched.
    tracker.syncPosition("BTC", undefined);

    const ethResult = tracker.evaluate({ positionId: "L2", isOpposingSignalTriggered: true, openedAt: minutesAgo(10), now: NOW, config: CONFIG });
    expect(ethResult).toEqual({ allow: true, consecutiveCount: 2 });
  });
});
