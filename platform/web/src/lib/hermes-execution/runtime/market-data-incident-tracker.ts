import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger/logger";

// Repeated-Telegram-alert fix. Replaces the previous time-based "remind every 30 minutes" design
// with deterministic, per-instrument, fingerprint-based incident tracking: the exact same
// underlying failure (e.g. the exact same missing-candle gap) is recognised as the SAME incident
// across every cycle it persists, and produces exactly one notification when it opens, exactly one
// more if its material reason genuinely changes, and exactly one when it recovers — never a
// repeated notification for an unchanged condition, whether that condition persists for one cycle
// or one thousand.
//
// No broker/execution/approval/lifecycle/risk import — this module only ever reads a small,
// bounded, instrument-keyed JSON state file (see loadPersistedState/persist below) and computes
// pure state transitions from the market-data validation outcomes it's given.

export type IncidentCategory =
  | "insufficient-candle-count"
  | "malformed-candle"
  | "duplicate-timestamp"
  | "missing-candles"
  | "stale-data"
  | "fetch-failed"
  | "unknown";

/**
 * The material facts that identify WHICH failure this is — deliberately excludes anything volatile:
 * no cycle timestamp, no generated message text, no stack trace, no live quote data. `summary` is
 * the one exception — free text, included for human-readable alert content ONLY, never read by
 * `computeIncidentFingerprint` below.
 */
export interface CanonicalIncidentReason {
  category: IncidentCategory;
  timeframe?: string;
  missingIntervalStartMs?: number;
  missingIntervalEndMs?: number;
  summary: string;
}

export interface InstrumentObservation {
  instrument: string;
  /** True = this instrument's market data validated successfully this cycle. */
  valid: boolean;
  /** Required when `valid` is false; ignored when `valid` is true. */
  reason?: CanonicalIncidentReason;
}

/**
 * Deterministic and stable: the exact same underlying failure produces the exact same fingerprint
 * on every cycle it persists, regardless of when it's observed. Never includes `summary` (free
 * text) or any timestamp OTHER than the two fixed boundaries of an actual missing-candle gap
 * (which, for a genuinely persistent gap, never change cycle to cycle — see candle-validation.ts's
 * own `fail()` call sites, which always report the same two candle timestamps either side of the
 * same gap, never a rolling/relative value).
 */
export function computeIncidentFingerprint(instrument: string, reason: CanonicalIncidentReason): string {
  return [instrument, reason.category, reason.timeframe ?? "", reason.missingIntervalStartMs ?? "", reason.missingIntervalEndMs ?? ""].join("|");
}

export interface ActiveIncidentRecord {
  instrument: string;
  fingerprint: string;
  category: IncidentCategory;
  reason: CanonicalIncidentReason;
  openedAt: string;
  lastObservedAt: string;
  observationCount: number;
  /** Consecutive HEALTHY observations seen while this incident is still ACTIVE — reset to 0 the
   * moment another invalid observation (any fingerprint) recurs. Reaching the configured recovery
   * threshold is what actually clears the incident (see MarketDataIncidentTracker's own doc
   * comment on hysteresis). */
  consecutiveHealthyCount: number;
}

export interface OpenedTransition {
  kind: "opened";
  instrument: string;
  fingerprint: string;
  reason: CanonicalIncidentReason;
  openedAt: string;
  observationCount: number;
}
export interface ChangedTransition {
  kind: "changed";
  instrument: string;
  fingerprint: string;
  previousFingerprint: string;
  reason: CanonicalIncidentReason;
  openedAt: string;
  observationCount: number;
}
export interface RecoveredTransition {
  kind: "recovered";
  instrument: string;
  previousFingerprint: string;
  openedAt: string;
  recoveredAt: string;
  requiredConsecutiveHealthy: number;
}
export interface UnchangedTransition {
  kind: "unchanged";
  instrument: string;
  fingerprint: string;
  observationCount: number;
  openedAt: string;
  lastObservedAt: string;
}
export interface RecoveryPendingTransition {
  kind: "recovery-pending";
  instrument: string;
  fingerprint: string;
  consecutiveHealthyCount: number;
  requiredConsecutiveHealthy: number;
}

export interface CycleIncidentOutcome {
  opened: OpenedTransition[];
  changed: ChangedTransition[];
  recovered: RecoveredTransition[];
  unchanged: UnchangedTransition[];
  recoveryPending: RecoveryPendingTransition[];
}

/** Require this many CONSECUTIVE healthy validation cycles before declaring recovery — a single
 * anomalous successful fetch never clears an incident on its own (data quality may flap). Opening
 * an incident always remains immediate — this hysteresis only ever applies to the recovery side. */
export const DEFAULT_MARKET_DATA_INCIDENT_RECOVERY_THRESHOLD = 2;

export const MARKET_DATA_INCIDENT_STATE_SCHEMA_VERSION = 1;

// Production-readiness review. Mirrors audit-log-path.ts's own HERMES_RUNTIME_AUDIT_LOG_PATH and
// daily-account-summary-state-store.ts's own DEFAULT_DAILY_ACCOUNT_SUMMARY_STATE_PATH exactly — the
// same established `.data/hermes-execution/` convention every other small, local, git-ignored
// runtime-state file on this VPS already uses. market-runtime.ts (the production bootstrap) passes
// this as TradingRuntimeDeps.marketDataIncidentStatePath so a PM2 restart doesn't lose incident
// dedup state; tests use their own isolated temp-file paths instead of this constant.
export const DEFAULT_MARKET_DATA_INCIDENT_STATE_PATH = path.join(
  process.cwd(),
  ".data",
  "hermes-execution",
  "market-data-incident-state.json",
);

export interface PersistedMarketDataIncidentState {
  schemaVersion: typeof MARKET_DATA_INCIDENT_STATE_SCHEMA_VERSION;
  incidents: Record<string, ActiveIncidentRecord>;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isActiveIncidentRecord(value: unknown): value is ActiveIncidentRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.instrument === "string" &&
    typeof record.fingerprint === "string" &&
    typeof record.category === "string" &&
    typeof record.openedAt === "string" &&
    typeof record.lastObservedAt === "string" &&
    typeof record.observationCount === "number" &&
    typeof record.consecutiveHealthyCount === "number" &&
    typeof record.reason === "object" &&
    record.reason !== null
  );
}

function isPersistedState(value: unknown): value is PersistedMarketDataIncidentState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== MARKET_DATA_INCIDENT_STATE_SCHEMA_VERSION) return false;
  if (typeof record.incidents !== "object" || record.incidents === null || Array.isArray(record.incidents)) return false;
  return Object.values(record.incidents as Record<string, unknown>).every(isActiveIncidentRecord);
}

/**
 * Read-only except for its own temp file. A missing file is a legitimate, expected first-run
 * state (never a crash); a corrupted or unrecognised-schema file fails SAFE to an empty state
 * (never trusted, never crashes startup) — see this module's own top-of-file "corrupted state
 * fails safely" requirement.
 */
async function readPersistedState(filePath: string): Promise<Map<string, ActiveIncidentRecord>> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    logger.warn("Could not read market-data incident state file — starting from empty state", {
      component: "market-data-incident-tracker",
      filePath,
      reason: toErrorMessage(error),
    });
    return new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    logger.warn("Market-data incident state file is not valid JSON — starting from empty state", {
      component: "market-data-incident-tracker",
      filePath,
      reason: toErrorMessage(error),
    });
    return new Map();
  }

  if (!isPersistedState(parsed)) {
    logger.warn("Market-data incident state file has an unrecognised shape/schema — starting from empty state", {
      component: "market-data-incident-tracker",
      filePath,
    });
    return new Map();
  }

  return new Map(Object.entries(parsed.incidents));
}

/**
 * Atomic write: a unique temp file, fsynced, then renamed over the destination — the destination is
 * always either the PRIOR complete file or the NEW complete file, never a partially-written one.
 * Unlike the strategy-registry's own create-only atomic write, this state file is legitimately
 * mutable (overwritten every time an incident opens/changes/recovers) — a plain rename (which can
 * replace an existing file) is correct here, never `fs.link`'s create-only semantics.
 */
async function writePersistedStateAtomically(filePath: string, incidents: ReadonlyMap<string, ActiveIncidentRecord>): Promise<void> {
  const state: PersistedMarketDataIncidentState = {
    schemaVersion: MARKET_DATA_INCIDENT_STATE_SCHEMA_VERSION,
    incidents: Object.fromEntries(incidents),
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const handle = await fs.open(tempPath, "w");
  try {
    await handle.writeFile(JSON.stringify(state, null, 2), "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, filePath);
}

export interface MarketDataIncidentTrackerOptions {
  /** Consecutive healthy cycles required before an ACTIVE incident is declared RECOVERED. Defaults
   * to DEFAULT_MARKET_DATA_INCIDENT_RECOVERY_THRESHOLD (2). */
  recoveryThreshold?: number;
  /** Durable persistence path. Undefined disables persistence entirely — the tracker still works
   * correctly within one continuous process lifetime, but a restart loses all incident state (see
   * this module's own doc comment / the fix's final report for this explicit, documented trade-off
   * when persistence is disabled). */
  persistencePath?: string;
}

/**
 * Per-instrument, fingerprint-based market-data incident state machine. Call `loadPersistedState()`
 * once (e.g. from TradingRuntime.start()) before the first `recordCycleObservations()` call, then
 * call `recordCycleObservations()` exactly once per cycle, after every configured instrument's own
 * validation outcome for that cycle is known — never per-instrument, never more than once per
 * cycle. Bounded state: exactly one record per instrument, keyed by instrument — never an
 * unbounded history, never anything beyond the small set of configured instruments.
 */
export class MarketDataIncidentTracker {
  private readonly incidents = new Map<string, ActiveIncidentRecord>();
  private readonly recoveryThreshold: number;
  private readonly persistencePath: string | undefined;
  private stateLoaded = false;
  /** Repeated-Telegram-alert fix. A cycle's own state transitions/audit events never wait on disk
   * I/O — a persist is scheduled here (chained onto whatever's already pending, so writes still
   * land in order) and this class's own state machine returns immediately regardless of how long
   * the write takes. `waitForPendingPersistence()` below is the only way to observe completion
   * (tests, and TradingRuntime.stop()'s own best-effort flush on graceful shutdown) — production
   * cycle timing is never coupled to it. */
  private pendingPersist: Promise<void> = Promise.resolve();

  constructor(options: MarketDataIncidentTrackerOptions = {}) {
    this.recoveryThreshold = options.recoveryThreshold ?? DEFAULT_MARKET_DATA_INCIDENT_RECOVERY_THRESHOLD;
    this.persistencePath = options.persistencePath;
  }

  /** Idempotent — safe to call more than once; only the first call ever actually reads the file.
   * A no-op when no persistencePath was configured (pure in-memory mode). Never throws — a missing
   * or corrupted file both fail safe to empty state (see readPersistedState's own doc comment). */
  async loadPersistedState(): Promise<void> {
    if (this.stateLoaded || !this.persistencePath) return;
    this.stateLoaded = true;
    const loaded = await readPersistedState(this.persistencePath);
    this.incidents.clear();
    for (const [instrument, record] of loaded) this.incidents.set(instrument, record);
  }

  /** Schedules a write of the CURRENT incident map, chained after any already-pending write so
   * writes always land in the order they were scheduled — never awaited inline by
   * recordCycleObservations (see this class's own `pendingPersist` doc comment above). */
  private schedulePersist(): void {
    if (!this.persistencePath) return;
    const persistencePath = this.persistencePath;
    const snapshot = new Map(this.incidents);
    this.pendingPersist = this.pendingPersist.then(async () => {
      try {
        await writePersistedStateAtomically(persistencePath, snapshot);
      } catch (error) {
        logger.error("Failed to persist market-data incident state — continuing in-memory only", {
          component: "market-data-incident-tracker",
          reason: toErrorMessage(error),
        });
      }
    });
  }

  /** Resolves once every persist scheduled so far has settled (success or failure) — production
   * cycle logic never needs this; TradingRuntime.stop() calls it as a best-effort durability flush
   * on graceful shutdown, and tests use it to observe the persisted file deterministically without
   * relying on real wall-clock waiting. */
  async waitForPendingPersistence(): Promise<void> {
    await this.pendingPersist;
  }

  /**
   * Pure state update for one cycle, given every configured instrument's own validation outcome —
   * see InstrumentObservation. Returns exactly which per-instrument transitions happened, grouped
   * by kind, so the caller can decide notification behaviour without re-deriving any of this
   * module's own state-machine logic:
   *
   *  - HEALTHY -> INVALID: `opened` (immediate, no hysteresis).
   *  - INVALID -> same fingerprint: `unchanged` (never a notification).
   *  - INVALID -> different fingerprint (still invalid): `changed` — a single, in-place transition,
   *    never a `recovered` immediately followed by a new `opened` for the same instrument in the
   *    same cycle. `openedAt` is preserved (this is the SAME overall incident, just an evolved
   *    reason), only `fingerprint`/`category`/`reason` update.
   *  - INVALID -> HEALTHY: `recoveryPending` until `recoveryThreshold` CONSECUTIVE healthy
   *    observations have been seen, then exactly one `recovered`. Any invalid observation in
   *    between resets the consecutive-healthy count back to 0.
   *  - HEALTHY -> HEALTHY (no active incident): completely silent, not reported in any list.
   *
   * Schedules a persist (best-effort, fire-and-forget — see `pendingPersist`'s own doc comment;
   * never awaited here, never able to delay this method's return) only when an incident actually
   * opened, changed, or recovered — a merely-`unchanged`/`recovery-pending` tick never triggers a
   * disk write, so a long-lived incident does not write to disk every single cycle; the one
   * property this relies on for correctness (never safety) is that `fingerprint`/`openedAt` — the
   * only facts a restart needs to avoid re-alerting — are unaffected by that choice. Returns a
   * Promise for interface stability (recordCycleObservations may gain genuine async work later
   * without a breaking signature change) even though nothing here is actually awaited today.
   */
  async recordCycleObservations(now: Date, observations: readonly InstrumentObservation[]): Promise<CycleIncidentOutcome> {
    const outcome: CycleIncidentOutcome = { opened: [], changed: [], recovered: [], unchanged: [], recoveryPending: [] };
    let shouldPersist = false;
    const nowIso = now.toISOString();

    for (const observation of observations) {
      const { instrument } = observation;
      const existing = this.incidents.get(instrument);

      if (observation.valid) {
        if (!existing) continue; // already healthy — silent, nothing to track.

        const consecutiveHealthyCount = existing.consecutiveHealthyCount + 1;
        if (consecutiveHealthyCount >= this.recoveryThreshold) {
          this.incidents.delete(instrument);
          outcome.recovered.push({
            kind: "recovered",
            instrument,
            previousFingerprint: existing.fingerprint,
            openedAt: existing.openedAt,
            recoveredAt: nowIso,
            requiredConsecutiveHealthy: this.recoveryThreshold,
          });
          shouldPersist = true;
        } else {
          this.incidents.set(instrument, { ...existing, consecutiveHealthyCount, lastObservedAt: nowIso });
          outcome.recoveryPending.push({
            kind: "recovery-pending",
            instrument,
            fingerprint: existing.fingerprint,
            consecutiveHealthyCount,
            requiredConsecutiveHealthy: this.recoveryThreshold,
          });
          // Production-readiness review — restart guarantee fix. Without this, a restart mid-
          // recovery (e.g. after 1 of 2 required healthy cycles) would silently lose that progress:
          // the persisted file would still show consecutiveHealthyCount from whenever the incident
          // last opened/changed, so recovery would incorrectly restart from 0 rather than resuming.
          // Never a safety issue either way (recovery hysteresis only ever gates the RECOVERED
          // notification, never entry-blocking or protective exits), but is a real, avoidable
          // regression of dedup accuracy across a restart — worth the small amount of extra I/O,
          // bounded to at most `recoveryThreshold - 1` writes per incident.
          shouldPersist = true;
        }
        continue;
      }

      // Invalid observation from here — `reason` is required by the InstrumentObservation contract
      // whenever `valid` is false; defensively skipped (never crashes) if a caller violates that.
      if (!observation.reason) continue;
      const fingerprint = computeIncidentFingerprint(instrument, observation.reason);

      if (!existing) {
        const record: ActiveIncidentRecord = {
          instrument,
          fingerprint,
          category: observation.reason.category,
          reason: observation.reason,
          openedAt: nowIso,
          lastObservedAt: nowIso,
          observationCount: 1,
          consecutiveHealthyCount: 0,
        };
        this.incidents.set(instrument, record);
        outcome.opened.push({ kind: "opened", instrument, fingerprint, reason: observation.reason, openedAt: nowIso, observationCount: 1 });
        shouldPersist = true;
        continue;
      }

      const observationCount = existing.observationCount + 1;
      if (fingerprint === existing.fingerprint) {
        this.incidents.set(instrument, { ...existing, lastObservedAt: nowIso, observationCount, consecutiveHealthyCount: 0 });
        outcome.unchanged.push({ kind: "unchanged", instrument, fingerprint, observationCount, openedAt: existing.openedAt, lastObservedAt: nowIso });
      } else {
        const updated: ActiveIncidentRecord = {
          instrument,
          fingerprint,
          category: observation.reason.category,
          reason: observation.reason,
          openedAt: existing.openedAt, // preserved — same overall incident, reason evolved.
          lastObservedAt: nowIso,
          observationCount,
          consecutiveHealthyCount: 0,
        };
        this.incidents.set(instrument, updated);
        outcome.changed.push({
          kind: "changed",
          instrument,
          fingerprint,
          previousFingerprint: existing.fingerprint,
          reason: observation.reason,
          openedAt: updated.openedAt,
          observationCount,
        });
        shouldPersist = true;
      }
    }

    if (shouldPersist) this.schedulePersist();
    return outcome;
  }

  /** Test/diagnostic use only. */
  currentActiveIncidents(): ActiveIncidentRecord[] {
    return [...this.incidents.values()];
  }
}
