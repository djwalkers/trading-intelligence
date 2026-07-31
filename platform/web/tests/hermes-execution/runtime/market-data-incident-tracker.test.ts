import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  computeIncidentFingerprint,
  DEFAULT_MARKET_DATA_INCIDENT_RECOVERY_THRESHOLD,
  MARKET_DATA_INCIDENT_STATE_SCHEMA_VERSION,
  MarketDataIncidentTracker,
  type CanonicalIncidentReason,
  type InstrumentObservation,
} from "@/lib/hermes-execution/runtime/market-data-incident-tracker";

// Repeated-Telegram-alert fix. Direct unit coverage of the tracker's own state machine, in
// isolation from TradingRuntime (see trading-runtime-market-data-incident.test.ts for the
// end-to-end scenarios through a real runtime/audit trail/Telegram-eligible-event pipeline).

// Production-readiness review — ordered-writes regression test support. Node's ESM module
// namespace is not configurable (vi.spyOn on a bare `import * as fs` binding throws — "Module
// namespace is not configurable in ESM"), so intercepting a single fs.promises method for one
// deterministic test requires vi.mock's own module-replacement mechanism instead. Every OTHER
// test in this file is unaffected: `renameOverride.current` stays undefined throughout, so this
// wrapper delegates straight to the real implementation.
const { renameOverride } = vi.hoisted(() => ({
  renameOverride: { current: undefined as ((oldPath: string, newPath: string) => Promise<void>) | undefined },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (oldPath: string, newPath: string) => {
      if (renameOverride.current) return renameOverride.current(oldPath, newPath);
      return actual.rename(oldPath, newPath);
    },
  };
});

const T0 = new Date("2026-07-30T14:00:00.000Z");
const T1 = new Date("2026-07-30T15:00:00.000Z");
const T2 = new Date("2026-07-30T16:00:00.000Z");
const T3 = new Date("2026-07-30T17:00:00.000Z");

const MISSING_CANDLES_REASON_A: CanonicalIncidentReason = {
  category: "missing-candles",
  timeframe: "1h",
  missingIntervalStartMs: Date.parse("2026-07-30T14:00:00.000Z"),
  missingIntervalEndMs: Date.parse("2026-07-30T16:00:00.000Z"),
  summary: 'Invalid historical candle history for "ETH": missing candle(s) between 14:00 and 16:00.',
};

const MISSING_CANDLES_REASON_B: CanonicalIncidentReason = {
  category: "missing-candles",
  timeframe: "1h",
  missingIntervalStartMs: Date.parse("2026-07-30T18:00:00.000Z"),
  missingIntervalEndMs: Date.parse("2026-07-30T20:00:00.000Z"),
  summary: 'Invalid historical candle history for "ETH": missing candle(s) between 18:00 and 20:00.',
};

function invalid(instrument: string, reason: CanonicalIncidentReason): InstrumentObservation {
  return { instrument, valid: false, reason };
}
function healthy(instrument: string): InstrumentObservation {
  return { instrument, valid: true };
}

describe("computeIncidentFingerprint", () => {
  it("is identical for the exact same instrument/category/timeframe/gap boundaries, regardless of the free-text summary", () => {
    const a = computeIncidentFingerprint("ETH", MISSING_CANDLES_REASON_A);
    const b = computeIncidentFingerprint("ETH", { ...MISSING_CANDLES_REASON_A, summary: "a completely different message" });
    expect(a).toBe(b);
  });

  it("differs when the instrument differs, even with an identical reason", () => {
    const eth = computeIncidentFingerprint("ETH", MISSING_CANDLES_REASON_A);
    const sol = computeIncidentFingerprint("SOL", MISSING_CANDLES_REASON_A);
    expect(eth).not.toBe(sol);
  });

  it("differs when the missing-interval boundaries differ", () => {
    const a = computeIncidentFingerprint("ETH", MISSING_CANDLES_REASON_A);
    const b = computeIncidentFingerprint("ETH", MISSING_CANDLES_REASON_B);
    expect(a).not.toBe(b);
  });

  it("differs when the category differs, even with the same instrument/timeframe", () => {
    const missing = computeIncidentFingerprint("ETH", MISSING_CANDLES_REASON_A);
    const stale = computeIncidentFingerprint("ETH", { category: "stale-data", timeframe: "1h", summary: "stale" });
    expect(missing).not.toBe(stale);
  });
});

describe("MarketDataIncidentTracker — healthy -> invalid opens exactly once", () => {
  it("returns an `opened` transition on first failure, and never again for the same unresolved incident", async () => {
    const tracker = new MarketDataIncidentTracker();

    const first = await tracker.recordCycleObservations(T0, [invalid("ETH", MISSING_CANDLES_REASON_A)]);
    expect(first.opened).toHaveLength(1);
    expect(first.opened[0]!.instrument).toBe("ETH");
    expect(first.opened[0]!.observationCount).toBe(1);

    const second = await tracker.recordCycleObservations(T1, [invalid("ETH", MISSING_CANDLES_REASON_A)]);
    expect(second.opened).toHaveLength(0);
    expect(second.changed).toHaveLength(0);
    expect(second.unchanged).toHaveLength(1);
    expect(second.unchanged[0]!.observationCount).toBe(2);
    expect(second.unchanged[0]!.fingerprint).toBe(first.opened[0]!.fingerprint);
  });

  it("stays silent (never opens) for an instrument that is healthy and was never previously tracked", async () => {
    const tracker = new MarketDataIncidentTracker();
    const outcome = await tracker.recordCycleObservations(T0, [healthy("ETH")]);
    expect(outcome.opened).toHaveLength(0);
    expect(outcome.unchanged).toHaveLength(0);
    expect(outcome.recoveryPending).toHaveLength(0);
    expect(outcome.recovered).toHaveLength(0);
    expect(outcome.changed).toHaveLength(0);
  });
});

describe("MarketDataIncidentTracker — unchanged incident stays silent across many cycles", () => {
  it("never re-opens or re-changes the same persistent fingerprint no matter how many cycles observe it", async () => {
    const tracker = new MarketDataIncidentTracker();
    await tracker.recordCycleObservations(T0, [invalid("ETH", MISSING_CANDLES_REASON_A)]);

    let lastObservationCount = 1;
    for (let i = 0; i < 50; i++) {
      const outcome = await tracker.recordCycleObservations(new Date(T0.getTime() + (i + 1) * 3_600_000), [
        invalid("ETH", MISSING_CANDLES_REASON_A),
      ]);
      expect(outcome.opened).toHaveLength(0);
      expect(outcome.changed).toHaveLength(0);
      expect(outcome.unchanged).toHaveLength(1);
      lastObservationCount = outcome.unchanged[0]!.observationCount;
    }
    expect(lastObservationCount).toBe(51);
  });
});

describe("MarketDataIncidentTracker — a materially different reason produces exactly one CHANGED, never a duplicate OPENED or a spurious RECOVERED", () => {
  it("preserves openedAt across the change and reports both the old and new fingerprint", async () => {
    const tracker = new MarketDataIncidentTracker();
    const opened = await tracker.recordCycleObservations(T0, [invalid("ETH", MISSING_CANDLES_REASON_A)]);
    const openedAt = opened.opened[0]!.openedAt;
    const previousFingerprint = opened.opened[0]!.fingerprint;

    const changedOutcome = await tracker.recordCycleObservations(T1, [invalid("ETH", MISSING_CANDLES_REASON_B)]);
    expect(changedOutcome.opened).toHaveLength(0);
    expect(changedOutcome.recovered).toHaveLength(0);
    expect(changedOutcome.changed).toHaveLength(1);
    const changed = changedOutcome.changed[0]!;
    expect(changed.previousFingerprint).toBe(previousFingerprint);
    expect(changed.fingerprint).not.toBe(previousFingerprint);
    expect(changed.openedAt).toBe(openedAt);
  });
});

describe("MarketDataIncidentTracker — recovery hysteresis", () => {
  it("requires the configured number of consecutive healthy cycles before RECOVERED, resetting on any intervening failure", async () => {
    const tracker = new MarketDataIncidentTracker({ recoveryThreshold: 3 });
    await tracker.recordCycleObservations(T0, [invalid("ETH", MISSING_CANDLES_REASON_A)]);

    const pending1 = await tracker.recordCycleObservations(T1, [healthy("ETH")]);
    expect(pending1.recoveryPending).toHaveLength(1);
    expect(pending1.recoveryPending[0]!.consecutiveHealthyCount).toBe(1);
    expect(pending1.recovered).toHaveLength(0);

    // A failure in between resets the streak back to 0, not merely pauses it.
    const relapse = await tracker.recordCycleObservations(T2, [invalid("ETH", MISSING_CANDLES_REASON_A)]);
    expect(relapse.unchanged).toHaveLength(1); // same fingerprint as the original incident — not a fresh open.
    expect(relapse.opened).toHaveLength(0);

    const pendingAgain = await tracker.recordCycleObservations(T3, [healthy("ETH")]);
    expect(pendingAgain.recoveryPending[0]!.consecutiveHealthyCount).toBe(1); // reset, not 2.

    const pending2 = await tracker.recordCycleObservations(new Date(T3.getTime() + 3_600_000), [healthy("ETH")]);
    expect(pending2.recoveryPending[0]!.consecutiveHealthyCount).toBe(2);
    expect(pending2.recovered).toHaveLength(0);

    const recovered = await tracker.recordCycleObservations(new Date(T3.getTime() + 2 * 3_600_000), [healthy("ETH")]);
    expect(recovered.recovered).toHaveLength(1);
    expect(recovered.recovered[0]!.requiredConsecutiveHealthy).toBe(3);
  });

  it("defaults to DEFAULT_MARKET_DATA_INCIDENT_RECOVERY_THRESHOLD when unconfigured", async () => {
    const tracker = new MarketDataIncidentTracker();
    expect(DEFAULT_MARKET_DATA_INCIDENT_RECOVERY_THRESHOLD).toBe(2);
    await tracker.recordCycleObservations(T0, [invalid("ETH", MISSING_CANDLES_REASON_A)]);
    const pending = await tracker.recordCycleObservations(T1, [healthy("ETH")]);
    expect(pending.recovered).toHaveLength(0);
    const recovered = await tracker.recordCycleObservations(T2, [healthy("ETH")]);
    expect(recovered.recovered).toHaveLength(1);
  });

  it("a re-failure after RECOVERED is a brand new incident (fresh OPENED), never treated as a continuation", async () => {
    const tracker = new MarketDataIncidentTracker({ recoveryThreshold: 1 });
    await tracker.recordCycleObservations(T0, [invalid("ETH", MISSING_CANDLES_REASON_A)]);
    const recovered = await tracker.recordCycleObservations(T1, [healthy("ETH")]);
    expect(recovered.recovered).toHaveLength(1);

    const reopened = await tracker.recordCycleObservations(T2, [invalid("ETH", MISSING_CANDLES_REASON_A)]);
    expect(reopened.opened).toHaveLength(1);
    expect(reopened.opened[0]!.observationCount).toBe(1);

    // Healthy after recovery, with no further failure, stays completely silent.
    const tracker2 = new MarketDataIncidentTracker({ recoveryThreshold: 1 });
    await tracker2.recordCycleObservations(T0, [invalid("ETH", MISSING_CANDLES_REASON_A)]);
    await tracker2.recordCycleObservations(T1, [healthy("ETH")]);
    const silentAfterRecovery = await tracker2.recordCycleObservations(T2, [healthy("ETH")]);
    expect(silentAfterRecovery.opened).toHaveLength(0);
    expect(silentAfterRecovery.unchanged).toHaveLength(0);
    expect(silentAfterRecovery.recoveryPending).toHaveLength(0);
    expect(silentAfterRecovery.recovered).toHaveLength(0);
  });
});

describe("MarketDataIncidentTracker — independent per-instrument tracking", () => {
  it("tracks ETH and SOL completely independently within the same cycle and across cycles", async () => {
    const tracker = new MarketDataIncidentTracker();

    const cycle1 = await tracker.recordCycleObservations(T0, [
      invalid("ETH", MISSING_CANDLES_REASON_A),
      healthy("SOL"),
    ]);
    expect(cycle1.opened.map((o) => o.instrument)).toEqual(["ETH"]);

    const cycle2 = await tracker.recordCycleObservations(T1, [
      invalid("ETH", MISSING_CANDLES_REASON_A), // unchanged
      invalid("SOL", MISSING_CANDLES_REASON_A), // now opens independently, same reason shape as ETH
    ]);
    expect(cycle2.unchanged.map((u) => u.instrument)).toEqual(["ETH"]);
    expect(cycle2.opened.map((o) => o.instrument)).toEqual(["SOL"]);
    // Same category/timeframe/gap shape, but distinct instruments still fingerprint distinctly.
    expect(cycle2.opened[0]!.fingerprint).not.toBe(cycle2.unchanged[0]!.fingerprint);
  });

  it("aggregates multiple simultaneous opens deterministically, in the order observations were given", async () => {
    const tracker = new MarketDataIncidentTracker();
    const outcome = await tracker.recordCycleObservations(T0, [
      invalid("BTC", MISSING_CANDLES_REASON_A),
      invalid("ETH", MISSING_CANDLES_REASON_A),
      invalid("SOL", MISSING_CANDLES_REASON_A),
    ]);
    expect(outcome.opened.map((o) => o.instrument)).toEqual(["BTC", "ETH", "SOL"]);
  });
});

describe("MarketDataIncidentTracker — bounded state", () => {
  it("currentActiveIncidents() only ever holds one record per instrument, never an unbounded history", async () => {
    const tracker = new MarketDataIncidentTracker();
    for (let i = 0; i < 10; i++) {
      await tracker.recordCycleObservations(new Date(T0.getTime() + i * 3_600_000), [invalid("ETH", MISSING_CANDLES_REASON_A)]);
    }
    expect(tracker.currentActiveIncidents()).toHaveLength(1);
  });
});

describe("MarketDataIncidentTracker — durable persistence", () => {
  async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      return await fn(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("writes an atomic, versioned, instrument-keyed JSON file that a fresh tracker instance can load back", () =>
    withTempDir("market-data-incident-tracker-persist-", async (dir) => {
      const statePath = path.join(dir, "state.json");
      const writer = new MarketDataIncidentTracker({ persistencePath: statePath });
      await writer.recordCycleObservations(T0, [invalid("ETH", MISSING_CANDLES_REASON_A)]);
      await writer.waitForPendingPersistence();

      const raw = JSON.parse(await fs.readFile(statePath, "utf-8"));
      expect(raw.schemaVersion).toBe(MARKET_DATA_INCIDENT_STATE_SCHEMA_VERSION);
      expect(Object.keys(raw.incidents)).toEqual(["ETH"]);
      // No secret data — only the bounded, structured fields this module documents.
      expect(Object.keys(raw.incidents.ETH).sort()).toEqual(
        ["category", "consecutiveHealthyCount", "fingerprint", "instrument", "lastObservedAt", "observationCount", "openedAt", "reason"].sort(),
      );

      const reader = new MarketDataIncidentTracker({ persistencePath: statePath });
      await reader.loadPersistedState();
      expect(reader.currentActiveIncidents()).toHaveLength(1);

      // The exact same still-invalid observation is recognised as UNCHANGED, never a fresh OPENED —
      // this is the entire point of durable persistence (restart-safe deduplication).
      const outcome = await reader.recordCycleObservations(T1, [invalid("ETH", MISSING_CANDLES_REASON_A)]);
      expect(outcome.opened).toHaveLength(0);
      expect(outcome.unchanged).toHaveLength(1);
    }));

  // Production-readiness review — restart guarantee. consecutiveHealthyCount progress made toward
  // recovery must survive a restart, not silently reset to 0 — otherwise a restart landing exactly
  // mid-recovery would make hysteresis take longer than configured every time it coincides with a
  // PM2 restart, which (given restarts are common in production) would defeat the point of
  // configuring a threshold > 1 at all.
  it("recovery-pending progress (consecutiveHealthyCount) survives a restart — it never resets to 0 merely because a new tracker instance loaded the file", () =>
    withTempDir("market-data-incident-tracker-recovery-restart-", async (dir) => {
      const statePath = path.join(dir, "state.json");
      const writer = new MarketDataIncidentTracker({ persistencePath: statePath, recoveryThreshold: 2 });
      await writer.recordCycleObservations(T0, [invalid("ETH", MISSING_CANDLES_REASON_A)]); // opens
      const pending = await writer.recordCycleObservations(T1, [healthy("ETH")]); // 1 of 2 healthy cycles
      expect(pending.recoveryPending).toHaveLength(1);
      expect(pending.recoveryPending[0]!.consecutiveHealthyCount).toBe(1);
      await writer.waitForPendingPersistence();

      const persisted = JSON.parse(await fs.readFile(statePath, "utf-8"));
      expect(persisted.incidents.ETH.consecutiveHealthyCount).toBe(1);

      // Simulate a restart: a brand new tracker instance, same file, same recoveryThreshold.
      const reader = new MarketDataIncidentTracker({ persistencePath: statePath, recoveryThreshold: 2 });
      await reader.loadPersistedState();

      // Exactly ONE more healthy cycle should be enough to recover (1 carried over + 1 = 2) — if
      // the restart had silently reset the count to 0, this would incorrectly report
      // recovery-pending again instead of recovered.
      const afterRestart = await reader.recordCycleObservations(T2, [healthy("ETH")]);
      expect(afterRestart.recovered).toHaveLength(1);
      expect(afterRestart.recoveryPending).toHaveLength(0);
    }));

  it("a missing state file loads as empty state, never throwing", () =>
    withTempDir("market-data-incident-tracker-missing-", async (dir) => {
      const statePath = path.join(dir, "does-not-exist", "state.json");
      const tracker = new MarketDataIncidentTracker({ persistencePath: statePath });
      await expect(tracker.loadPersistedState()).resolves.toBeUndefined();
      expect(tracker.currentActiveIncidents()).toHaveLength(0);
    }));

  it("a corrupted (non-JSON) state file fails safe to empty state, never throwing", () =>
    withTempDir("market-data-incident-tracker-corrupt-", async (dir) => {
      const statePath = path.join(dir, "state.json");
      await fs.writeFile(statePath, "not json at all {{{", "utf-8");
      const tracker = new MarketDataIncidentTracker({ persistencePath: statePath });
      await expect(tracker.loadPersistedState()).resolves.toBeUndefined();
      expect(tracker.currentActiveIncidents()).toHaveLength(0);
    }));

  it("a well-formed JSON file with an unrecognised schema shape fails safe to empty state, never throwing", () =>
    withTempDir("market-data-incident-tracker-badschema-", async (dir) => {
      const statePath = path.join(dir, "state.json");
      await fs.writeFile(statePath, JSON.stringify({ schemaVersion: 999, incidents: {} }), "utf-8");
      const tracker = new MarketDataIncidentTracker({ persistencePath: statePath });
      await expect(tracker.loadPersistedState()).resolves.toBeUndefined();
      expect(tracker.currentActiveIncidents()).toHaveLength(0);
    }));

  it("never writes to disk at all when no persistencePath is configured", () =>
    withTempDir("market-data-incident-tracker-noop-", async (dir) => {
      const tracker = new MarketDataIncidentTracker();
      await tracker.recordCycleObservations(T0, [invalid("ETH", MISSING_CANDLES_REASON_A)]);
      await tracker.waitForPendingPersistence();
      expect(await fs.readdir(dir)).toEqual([]);
    }));

  it("a persist error (e.g. an unwritable path) is swallowed — recordCycleObservations still returns the correct in-memory outcome", async () => {
    // A path with a null byte is invalid on every platform, guaranteeing the write itself fails
    // (ENOENT/EINVAL), independent of filesystem permissions.
    const tracker = new MarketDataIncidentTracker({ persistencePath: "/nonexistent-dir-\0-invalid/state.json" });
    const outcome = await tracker.recordCycleObservations(T0, [invalid("ETH", MISSING_CANDLES_REASON_A)]);
    expect(outcome.opened).toHaveLength(1);
    await expect(tracker.waitForPendingPersistence()).resolves.toBeUndefined();
  });

  // Production-readiness review — ordered-writes requirement. Two persist-triggering cycles fired
  // back-to-back (never awaited relative to each other's own disk I/O, exactly like two rapid
  // TradingRuntime cycles would) must still land on disk in SCHEDULE order, never completion order
  // — otherwise an artificially slow first write could finish AFTER a fast second write and
  // silently clobber it with stale state. The first write's own `rename` call is held open with an
  // explicit gate (never a real-timer race) so this test is fully deterministic.
  it("serializes overlapping writes — a slow first write can never let its stale content overwrite a faster later write's result", () =>
    withTempDir("market-data-incident-tracker-overlap-", async (dir) => {
      const statePath = path.join(dir, "state.json");
      const tracker = new MarketDataIncidentTracker({ persistencePath: statePath });

      let renameCallCount = 0;
      let signalFirstRenameStarted: () => void;
      const firstRenameStarted = new Promise<void>((resolve) => {
        signalFirstRenameStarted = resolve;
      });
      let releaseFirstRename: () => void;
      const firstRenameGate = new Promise<void>((resolve) => {
        releaseFirstRename = resolve;
      });
      const realRename = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises").then((m) => m.rename);

      renameOverride.current = async (oldPath, newPath) => {
        renameCallCount += 1;
        if (renameCallCount === 1) {
          signalFirstRenameStarted();
          await firstRenameGate;
        }
        return realRename(oldPath, newPath);
      };

      try {
        // Fired back-to-back, neither awaited relative to the other — mirrors two rapid cycles
        // whose own recordCycleObservations calls both return long before either write lands.
        const firstCall = tracker.recordCycleObservations(T0, [invalid("ETH", MISSING_CANDLES_REASON_A)]);
        const secondCall = tracker.recordCycleObservations(T1, [invalid("ETH", MISSING_CANDLES_REASON_B)]);

        await firstRenameStarted; // the first write has reached (and is now held at) its own rename call
        expect(renameCallCount).toBe(1); // the second write must be queued behind it, never racing ahead

        releaseFirstRename!();
        await Promise.all([firstCall, secondCall]);
        await tracker.waitForPendingPersistence();
      } finally {
        renameOverride.current = undefined;
      }

      expect(renameCallCount).toBe(2);
      const raw = JSON.parse(await fs.readFile(statePath, "utf-8"));
      // The LAST-scheduled state (gap B) must win on disk — never gap A reappearing merely because
      // its write was artificially slow.
      expect(raw.incidents.ETH.fingerprint).toBe(computeIncidentFingerprint("ETH", MISSING_CANDLES_REASON_B));
    }));
});
