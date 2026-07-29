import type { AuditEvent, AuditEventType } from "@/lib/hermes-execution/types";
import type { MarketDecisionAction } from "@/lib/hermes-execution/market-decision-engine";

// Hermes Integration API v1. Pure functions only — every one of these takes an already-read
// AuditEvent[] (see audit-log-reader.ts) and derives a read view of it. No I/O, no trading/
// decision/risk logic is reimplemented here — this only reads and reshapes events the existing
// pipeline (TradingRuntime, TradeLifecycleService, MarketDecisionEngine) already recorded.

export type HermesObservedRuntimeState = "RUNNING" | "PAUSED" | "STOPPED" | "unknown";

export interface HermesObservedRuntime {
  state: HermesObservedRuntimeState;
  startedAt: string | null;
  lastRunAt: string | null;
  successfulRunCount: number;
  failedRunCount: number;
  skippedOverlapCount: number;
  lastError: { message: string; occurredAt: string } | null;
}

const RUNTIME_LIFECYCLE_EVENT_TYPES = new Set<AuditEventType>([
  "TRADING_RUNTIME_STARTED",
  "TRADING_RUNTIME_STOPPED",
  "TRADING_RUNTIME_PAUSED",
  "TRADING_RUNTIME_RESUMED",
]);

function detailString(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" ? value : undefined;
}

function detailNumber(details: Record<string, unknown>, key: string): number | undefined {
  const value = details[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Derives a best-effort runtime snapshot from the persisted audit trail — the only durable,
 * cross-process record of the standalone `market:runtime` process's lifecycle this Next.js server
 * has (see audit-log-reader.ts's own doc comment). Every count/timestamp is scoped to the most
 * recent TRADING_RUNTIME_STARTED event, mirroring TradingRuntimeStatus's own in-memory semantics
 * (its counters reset to zero on every fresh start()). `state: "unknown"` — never a guessed
 * RUNNING/STOPPED — when no lifecycle event exists at all.
 */
export function deriveObservedRuntimeState(events: AuditEvent[]): HermesObservedRuntime {
  let lastStartIndex = -1;
  let state: HermesObservedRuntimeState = "unknown";
  let startedAt: string | null = null;

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (!RUNTIME_LIFECYCLE_EVENT_TYPES.has(event.eventType)) continue;
    switch (event.eventType) {
      case "TRADING_RUNTIME_STARTED":
        lastStartIndex = i;
        startedAt = event.timestamp;
        state = "RUNNING";
        break;
      case "TRADING_RUNTIME_STOPPED":
        state = "STOPPED";
        break;
      case "TRADING_RUNTIME_PAUSED":
        state = "PAUSED";
        break;
      case "TRADING_RUNTIME_RESUMED":
        state = "RUNNING";
        break;
    }
  }

  const sinceStart = lastStartIndex >= 0 ? events.slice(lastStartIndex) : [];
  let lastRunAt: string | null = null;
  let successfulRunCount = 0;
  let failedRunCount = 0;
  let skippedOverlapCount = 0;
  let lastError: { message: string; occurredAt: string } | null = null;

  for (const event of sinceStart) {
    if (event.eventType === "TRADING_CYCLE_COMPLETED") {
      successfulRunCount += 1;
      lastRunAt = event.timestamp;
    } else if (event.eventType === "TRADING_CYCLE_FAILED") {
      failedRunCount += 1;
      lastRunAt = event.timestamp;
      lastError = { message: detailString(event.details, "message") ?? "Unknown error.", occurredAt: event.timestamp };
    } else if (event.eventType === "TRADING_CYCLE_SKIPPED_OVERLAP") {
      skippedOverlapCount += 1;
    }
  }

  return { state, startedAt, lastRunAt, successfulRunCount, failedRunCount, skippedOverlapCount, lastError };
}

/**
 * Total realised P/L from TRADE_CLOSED events since the most recent TRADING_RUNTIME_STARTED event
 * (or across the whole file if no start event is present — e.g. a very old/atypical log). Returns
 * `null` — never `0` — when there are no closed trades to sum, so a caller can distinguish "no
 * trades yet" from "trades netted to exactly zero".
 */
export function sumRealisedPnlSinceLastStart(events: AuditEvent[]): number | null {
  let lastStartIndex = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.eventType === "TRADING_RUNTIME_STARTED") lastStartIndex = i;
  }
  const scoped = lastStartIndex >= 0 ? events.slice(lastStartIndex) : events;
  const closed = scoped.filter((event) => event.eventType === "TRADE_CLOSED");
  if (closed.length === 0) return null;
  return closed.reduce((sum, event) => sum + (detailNumber(event.details, "realisedPnl") ?? 0), 0);
}

export interface HermesDecisionExecutionResult {
  executed: boolean;
  /** A compact, stable status token — not a HealthStatus, a decision-outcome vocabulary. Two
   * distinct correlation paths feed this, tried in order (see deriveExecutionResult below):
   *
   * 1. Candidate-chain correlation (Phase 3.5+ Trade Review & Approval pipeline — the one this
   *    runtime actually uses today): "PENDING" | "APPROVED" | "OPENED" | "CLOSED" | "REJECTED" |
   *    "EXPIRED" | "FAILED" | "BLOCKED" | "SUPPRESSED", found by following a TradeCandidate's own
   *    id (and, once executed, its TradeLifecycleRecord id) forward through the audit trail,
   *    UNBOUNDED in time — a human approval or a much-later automatic exit is still correlated
   *    correctly, never limited to a fixed lookahead window. "BLOCKED"/"SUPPRESSED" (remediation
   *    pass, finding H2) cover the two cases where NO candidate was ever created for a fresh
   *    BUY/SELL decision, but the audit trail unambiguously explains why
   *    (KILL_SWITCH_ENTRY_BLOCKED / DUPLICATE_ENTRY_SUPPRESSED) — never labelled "executed",
   *    "failed", "rejected", or "expired", since none of those are semantically true here.
   * 2. Legacy immediate-execution correlation (the older, pre-Trade-Candidate pipeline —
   *    market-decide.ts's own direct-execution path, which never creates a TradeCandidate at all):
   *    "RISK_REJECTED" | "OPENED" | "CLOSED" | "EXECUTION_FAILED" | "CLOSE_FAILED" | "SKIPPED",
   *    found within a bounded lookahead window immediately after the decision event — unchanged
   *    from this field's own original behaviour, used only when no TradeCandidate is ever found.
   *
   * "HOLD" (no correlation attempted) and "unknown" (correlation was genuinely attempted but no
   * candidate/lifecycle event or known blocking/suppression reason could be found — never
   * fabricated) apply to both paths. */
  status: string;
  realisedPnl?: number;
  /** The correlated TradeCandidate's own id — present once a TRADE_CANDIDATE_CREATED event has
   * been found for this decision (candidate-chain path only). */
  candidateId?: string;
  /** The TradeLifecycleRecord id the candidate executed into — present once a
   * TRADE_CANDIDATE_EXECUTED event has been found for the candidate above. */
  lifecycleRecordId?: string;
  /** The broker's own order id for the executed candidate — present alongside lifecycleRecordId. */
  brokerOrderId?: string;
}

export interface HermesDecisionDto {
  timestamp: string;
  symbol: string;
  outcome: MarketDecisionAction;
  confidence: number | null;
  reasons: string[];
  strategy: string | null;
  marketSnapshot: Record<string, unknown>;
  executionResult: HermesDecisionExecutionResult;
}

export interface HermesDecisionFilters {
  limit: number;
  symbol?: string;
  outcome?: MarketDecisionAction;
  /** Inclusive lower bound — an ISO 8601 string produced by `Date.prototype.toISOString()`, always
   * compared as a plain string against event timestamps (also always `toISOString()`-produced
   * throughout this codebase) rather than parsed back into `Date` objects — safe because both
   * sides share the exact same fixed-precision, UTC-suffixed format. */
  since?: string;
}

// One trading cycle's own events (TRADING_CYCLE_STARTED..COMPLETED/FAILED) never contains more
// than a handful of entries — see trade-lifecycle-runner.ts's own cycle shape — so this bound is
// generous, not tight. Only used by the legacy immediate-execution fallback below — the
// candidate-chain path is deliberately unbounded (see its own doc comment).
const EXECUTION_LOOKAHEAD_WINDOW = 8;

/** Remediation pass (senior review finding C2) — the OLD decision-source event set, kept ONLY for
 * backward compatibility with an audit log written entirely before HERMES_INSTRUMENT_DECISION_RECORDED
 * existed (see buildCorrelationIndex's own hasInstrumentDecisionEvents flag and
 * chooseDecisionSourceTypes below, which decide which of these two sets is actually used). */
const LEGACY_DECISION_SOURCE_EVENT_TYPES = new Set<AuditEventType>(["MARKET_DECISION_RECEIVED", "HERMES_PROPOSAL_SELECTED"]);

/** The authoritative decision-source set once HERMES_INSTRUMENT_DECISION_RECORDED events exist
 * anywhere in the log — HERMES_PROPOSAL_SELECTED is deliberately EXCLUDED here (not added
 * alongside): every selected BUY/SELL proposal now ALSO gets a HERMES_INSTRUMENT_DECISION_RECORDED
 * event in the same scan (see universe-scanner.ts), so including both would double-count the same
 * decision as two separate DTOs. HERMES_INSTRUMENT_DECISION_RECORDED alone additionally covers
 * HOLD, which HERMES_PROPOSAL_SELECTED structurally never could (see that event's own doc comment
 * in types.ts) — this is the fix for "a stale BUY/SELL proposal can outrank a newer HOLD". */
const CURRENT_DECISION_SOURCE_EVENT_TYPES = new Set<AuditEventType>(["MARKET_DECISION_RECEIVED", "HERMES_INSTRUMENT_DECISION_RECORDED"]);

/** Every candidate-lifecycle event type this module follows when correlating via candidateId.
 * KILL_SWITCH_ENTRY_BLOCKED is included here ONLY for its approved-candidate-execution call site
 * (which alone carries a candidateId, per trading-runtime.ts's own recordAudit call) — its OTHER
 * call site (fresh-candidate-creation, no candidate exists yet) is handled separately below, via
 * NO_CANDIDATE_REASON_EVENT_TYPES. */
const CANDIDATE_LIFECYCLE_EVENT_TYPES = new Set<AuditEventType>([
  "TRADE_CANDIDATE_APPROVED",
  "TRADE_CANDIDATE_REJECTED",
  "TRADE_CANDIDATE_EXPIRED",
  "TRADE_CANDIDATE_EXECUTION_FAILED",
  "TRADE_CANDIDATE_EXECUTED",
  "KILL_SWITCH_ENTRY_BLOCKED",
]);

/** Remediation pass (finding H2) — the two "why was no candidate ever created for this decision"
 * events the audit trail already unambiguously explains. Neither is fabricated: both are recorded,
 * verbatim, by the exact call sites that decided not to create a candidate at all. */
const NO_CANDIDATE_REASON_EVENT_TYPES = new Set<AuditEventType>(["KILL_SWITCH_ENTRY_BLOCKED", "DUPLICATE_ENTRY_SUPPRESSED"]);

interface DecisionCorrelationIndex {
  hasInstrumentDecisionEvents: boolean;
  candidateCreatedByInstrument: Map<string, Array<{ index: number; candidateId: string }>>;
  eventsByCandidateId: Map<string, AuditEvent[]>;
  noCandidateReasonsByInstrument: Map<string, Array<{ index: number; event: AuditEvent }>>;
  closedByLifecycleId: Map<string, number | undefined>;
}

/**
 * Remediation pass (finding H1 — removes the O(N^2) behaviour). Builds every lookup structure
 * listDecisions' own correlation needs in exactly ONE forward pass over `events` — shared across
 * every decision correlated afterward, rather than each one separately re-scanning the whole array.
 */
function buildCorrelationIndex(events: AuditEvent[]): DecisionCorrelationIndex {
  const index: DecisionCorrelationIndex = {
    hasInstrumentDecisionEvents: false,
    candidateCreatedByInstrument: new Map(),
    eventsByCandidateId: new Map(),
    noCandidateReasonsByInstrument: new Map(),
    closedByLifecycleId: new Map(),
  };

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;

    if (event.eventType === "HERMES_INSTRUMENT_DECISION_RECORDED") {
      index.hasInstrumentDecisionEvents = true;
    }

    if (event.eventType === "TRADE_CANDIDATE_CREATED" && event.instrument !== undefined) {
      const candidateId = detailString(event.details, "candidateId");
      if (candidateId !== undefined) {
        const list = index.candidateCreatedByInstrument.get(event.instrument) ?? [];
        list.push({ index: i, candidateId });
        index.candidateCreatedByInstrument.set(event.instrument, list);
      }
    }

    if (CANDIDATE_LIFECYCLE_EVENT_TYPES.has(event.eventType)) {
      const candidateId = detailString(event.details, "candidateId");
      if (candidateId !== undefined) {
        const list = index.eventsByCandidateId.get(candidateId) ?? [];
        list.push(event);
        index.eventsByCandidateId.set(candidateId, list);
      }
    }

    // Only the fresh-candidate-creation KILL_SWITCH_ENTRY_BLOCKED case belongs here (it never
    // carries a candidateId) — the approved-candidate-execution one is already captured above via
    // eventsByCandidateId and must never be double-counted as "no candidate was ever created".
    if (NO_CANDIDATE_REASON_EVENT_TYPES.has(event.eventType) && event.instrument !== undefined) {
      const carriesCandidateId = detailString(event.details, "candidateId") !== undefined;
      if (!carriesCandidateId) {
        const list = index.noCandidateReasonsByInstrument.get(event.instrument) ?? [];
        list.push({ index: i, event });
        index.noCandidateReasonsByInstrument.set(event.instrument, list);
      }
    }

    if (event.eventType === "TRADE_CLOSED") {
      const lifecycleId = detailString(event.details, "tradeLifecycleId");
      if (lifecycleId !== undefined) {
        index.closedByLifecycleId.set(lifecycleId, detailNumber(event.details, "realisedPnl"));
      }
    }
  }

  return index;
}

/**
 * Phase 3.5+ Trade Review & Approval pipeline — the one this runtime actually uses. Correlates a
 * decision to the TradeCandidate it produced (the FIRST TRADE_CANDIDATE_CREATED for the same
 * instrument, before `boundary` — the next decision for that instrument, computed once by the
 * caller during its own single reverse traversal, never re-scanned here), then follows that
 * candidate's own id, UNBOUNDED in time (a human approval, or a much-later automatic exit, can
 * happen arbitrarily far in the future — never limited to a fixed lookahead window), through every
 * subsequent TRADE_CANDIDATE_* transition and — once executed — the resulting
 * TradeLifecycleRecord's own TRADE_CLOSED event. Every lookup here is against the pre-built
 * `index` (O(1)-ish, bounded by how many events concern ONE instrument/candidate — never the whole
 * log) — see finding H1. Returns `undefined` (never a fabricated guess) when no
 * TRADE_CANDIDATE_CREATED event AND no known blocking/suppression reason is ever found for this
 * decision, letting the caller fall back to the legacy immediate-execution correlation below.
 */
function correlateViaCandidateChain(
  index: DecisionCorrelationIndex,
  decisionIndex: number,
  boundary: number,
  instrument: string,
): HermesDecisionExecutionResult | undefined {
  const created = (index.candidateCreatedByInstrument.get(instrument) ?? []).find(
    (c) => c.index > decisionIndex && c.index < boundary,
  );

  if (!created) {
    // Remediation pass (finding H2) — no candidate was ever created; check whether a KNOWN,
    // never-fabricated reason explains why, within the SAME search window, before falling back to
    // genuine "unknown".
    const reason = (index.noCandidateReasonsByInstrument.get(instrument) ?? []).find(
      (r) => r.index > decisionIndex && r.index < boundary,
    );
    if (reason) {
      return reason.event.eventType === "DUPLICATE_ENTRY_SUPPRESSED"
        ? { executed: false, status: "SUPPRESSED" }
        : { executed: false, status: "BLOCKED" };
    }
    return undefined;
  }

  const { candidateId } = created;
  let status = "PENDING";
  let lifecycleRecordId: string | undefined;
  let brokerOrderId: string | undefined;

  for (const event of index.eventsByCandidateId.get(candidateId) ?? []) {
    if (event.eventType === "TRADE_CANDIDATE_APPROVED") {
      status = "APPROVED";
    } else if (event.eventType === "TRADE_CANDIDATE_REJECTED") {
      status = "REJECTED";
      break; // terminal
    } else if (event.eventType === "TRADE_CANDIDATE_EXPIRED") {
      status = "EXPIRED";
      break; // terminal
    } else if (event.eventType === "TRADE_CANDIDATE_EXECUTION_FAILED") {
      status = "FAILED";
      break; // terminal
    } else if (event.eventType === "TRADE_CANDIDATE_EXECUTED") {
      status = "OPENED";
      lifecycleRecordId = detailString(event.details, "lifecycleRecordId");
      brokerOrderId = detailString(event.details, "brokerOrderId");
      // Keep scanning — a later close is still possible and is looked up below.
    }
    // KILL_SWITCH_ENTRY_BLOCKED (approved-candidate-execution context) never changes `status` here:
    // the candidate's own repository status genuinely remains APPROVED (never transitioned) while
    // deferred — this is explanatory metadata, never a terminal status of its own, and must never
    // override a later, real transition.
  }

  let realisedPnl: number | undefined;
  if (status === "OPENED" && lifecycleRecordId !== undefined) {
    const closedPnl = index.closedByLifecycleId.get(lifecycleRecordId);
    if (index.closedByLifecycleId.has(lifecycleRecordId)) {
      status = "CLOSED";
      realisedPnl = closedPnl;
    }
  }

  const executed = status === "OPENED" || status === "CLOSED";
  return { executed, status, candidateId, lifecycleRecordId, brokerOrderId, realisedPnl };
}

/** The older, pre-Trade-Candidate immediate-execution correlation — unchanged from this field's
 * own original behaviour (a small, bounded lookahead window — never re-scans the whole log, so it
 * needs no pre-built index of its own). Only ever reached when correlateViaCandidateChain above
 * found no TradeCandidate AND no known blocking/suppression reason for this decision (e.g.
 * market-decide.ts's own direct-execution pipeline, which never creates a candidate at all). */
function correlateViaLegacyImmediateExecution(events: AuditEvent[], decisionIndex: number, instrument: string): HermesDecisionExecutionResult {
  const windowEnd = Math.min(events.length, decisionIndex + 1 + EXECUTION_LOOKAHEAD_WINDOW);
  for (let i = decisionIndex + 1; i < windowEnd; i++) {
    const event = events[i]!;
    if (event.eventType === "TRADING_CYCLE_COMPLETED" || event.eventType === "TRADING_CYCLE_FAILED") {
      // Cycle boundary reached with nothing more specific found for this instrument — stop.
      break;
    }
    if (event.instrument !== instrument) continue;
    switch (event.eventType) {
      case "TRADE_RISK_REJECTED":
        return { executed: false, status: "RISK_REJECTED" };
      case "TRADE_OPENED":
        return { executed: true, status: "OPENED" };
      case "TRADE_CLOSED":
        return { executed: true, status: "CLOSED", realisedPnl: detailNumber(event.details, "realisedPnl") };
      case "TRADE_EXECUTION_FAILED":
        return { executed: false, status: "EXECUTION_FAILED" };
      case "TRADE_CLOSE_FAILED":
        return { executed: false, status: "CLOSE_FAILED" };
      case "EXECUTION_SKIPPED":
        return { executed: false, status: "SKIPPED" };
    }
  }
  return { executed: false, status: "unknown" };
}

function deriveExecutionResult(
  events: AuditEvent[],
  index: DecisionCorrelationIndex,
  decisionIndex: number,
  boundary: number,
  instrument: string,
  action: string,
): HermesDecisionExecutionResult {
  if (action === "HOLD") return { executed: false, status: "HOLD" };

  return (
    correlateViaCandidateChain(index, decisionIndex, boundary, instrument) ??
    correlateViaLegacyImmediateExecution(events, decisionIndex, instrument)
  );
}

/**
 * Sourced from the authoritative per-instrument decision stream — remediation pass (finding C2):
 * HERMES_INSTRUMENT_DECISION_RECORDED (recorded for EVERY eligible instrument, every scan,
 * including HOLD — see universe-scanner.ts and this event's own doc comment in types.ts) once any
 * such event exists anywhere in the log, falling back to the OLD HERMES_PROPOSAL_SELECTED-based
 * behaviour ONLY for an audit log written entirely before this event existed (backward
 * compatibility — see chooseDecisionSourceTypes/buildCorrelationIndex above). MARKET_DECISION_RECEIVED
 * (market-decision-runner.ts's older deterministic-engine pipeline) is always included alongside
 * either. "strategy" comes from the event's own top-level `strategyId` field; "market snapshot" is
 * whatever's left of `details` once action/confidence/reasoning are removed (trend/RSI/EMA
 * relationship for MARKET_DECISION_RECEIVED; genuinely empty for a HOLD
 * HERMES_INSTRUMENT_DECISION_RECORDED, which carries no such fields — never fabricated).
 *
 * Remediation pass (finding H1) — traverses `events` newest-first and stops the moment `filters.limit`
 * decisions have been collected, using ONE shared, pre-built correlation index (buildCorrelationIndex)
 * rather than each decision separately re-scanning the whole log — O(N) overall for any `limit`,
 * including `limit: 1` (the /summary route's own call), rather than the previous O(N^2).
 */
export function listDecisions(events: AuditEvent[], filters: HermesDecisionFilters): HermesDecisionDto[] {
  const index = buildCorrelationIndex(events);
  const decisionSourceTypes = index.hasInstrumentDecisionEvents ? CURRENT_DECISION_SOURCE_EVENT_TYPES : LEGACY_DECISION_SOURCE_EVENT_TYPES;

  const results: HermesDecisionDto[] = [];
  // The most recent index, per instrument, already visited during this SAME reverse traversal —
  // exactly "the next decision for this instrument" from an earlier (lower-index) decision's own
  // point of view, computed for free as a side effect of iterating newest-first, with no separate
  // forward pre-scan needed.
  const lastSeenDecisionIndexByInstrument = new Map<string, number>();

  for (let i = events.length - 1; i >= 0 && results.length < filters.limit; i--) {
    const event = events[i]!;
    if (!decisionSourceTypes.has(event.eventType)) continue;

    const action = event.details.action;
    if (typeof action !== "string" || (action !== "BUY" && action !== "SELL" && action !== "HOLD")) continue;
    const instrument = event.instrument ?? "unknown";

    // Recorded BEFORE filters are applied below — even a decision this specific query filters out
    // still marks a genuine "next decision" boundary for an earlier, matching one's own
    // candidate-chain search (its own candidate must never be misattributed regardless of what
    // later query happens to be asking).
    const boundary = lastSeenDecisionIndexByInstrument.get(instrument) ?? events.length;
    lastSeenDecisionIndexByInstrument.set(instrument, i);

    if (filters.symbol && instrument !== filters.symbol) continue;
    if (filters.outcome && action !== filters.outcome) continue;
    if (filters.since && event.timestamp < filters.since) continue;

    const marketSnapshot: Record<string, unknown> = { ...event.details };
    delete marketSnapshot.action;
    delete marketSnapshot.confidence;
    delete marketSnapshot.reasoning;

    const confidence = detailNumber(event.details, "confidence");
    const reasoning = event.details.reasoning;

    results.push({
      timestamp: event.timestamp,
      symbol: instrument,
      outcome: action,
      confidence: confidence ?? null,
      reasons: Array.isArray(reasoning) ? (reasoning as string[]) : [],
      strategy: event.strategyId ?? null,
      marketSnapshot,
      executionResult: deriveExecutionResult(events, index, i, boundary, instrument, action),
    });
  }

  // Belt-and-suspenders re-sort — cheap now (bounded to `filters.limit` items, not the whole log)
  // and guards against any minor out-of-order jitter in the underlying file, matching this
  // function's own original output-ordering guarantee exactly.
  results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return results;
}

/** Returns the index of the most recent TRADING_RUNTIME_STARTED event, or -1 if none exists. Shared
 * by every "since the current run" derivation in this file (deriveObservedRuntimeState,
 * sumRealisedPnlSinceLastStart each keep their own identical inline scan, unchanged, for their own
 * established behaviour — this is the one new callers, e.g. the /summary route's own
 * recentFailure scoping below, should use going forward). */
export function findLastRuntimeStartIndex(events: AuditEvent[]): number {
  let lastStartIndex = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.eventType === "TRADING_RUNTIME_STARTED") lastStartIndex = i;
  }
  return lastStartIndex;
}

/** The most recent thing worth an operator's attention — a failed cycle, a risk rejection, an
 * execution/close failure, or a broker-connection failure — whichever is most recent. Returns
 * `null` if none of those event types appear anywhere in the searched range. Used by /summary;
 * deliberately separate from deriveObservedRuntimeState's own `lastError` (which is scoped to the
 * current start and cycle-failures only) — this looks across a wider set of event types.
 *
 * `options.sinceIndex` (inclusive) scopes the search — defaults to 0 (the WHOLE file), preserving
 * this function's own original, unscoped behaviour for any caller that doesn't pass it (e.g. a
 * future full-history endpoint — see this module's own "preserve full history" requirement). The
 * /summary route passes findLastRuntimeStartIndex(events) so a stale failure from BEFORE the
 * runtime's current run (e.g. an old candle-validation error left over from a previous process)
 * never resurfaces as "recent" after a restart. */
export interface HermesRecentFailure {
  eventType: AuditEventType;
  timestamp: string;
  instrument?: string;
  message: string;
}

const FAILURE_EVENT_TYPES = new Set<AuditEventType>([
  "TRADING_CYCLE_FAILED",
  "TRADE_RISK_REJECTED",
  "TRADE_EXECUTION_FAILED",
  "TRADE_CLOSE_FAILED",
  "BROKER_CONNECTION_FAILED",
]);

function summariseFailureMessage(event: AuditEvent): string {
  const message = detailString(event.details, "message") ?? detailString(event.details, "reason");
  if (message) return message;
  if (event.eventType === "TRADE_RISK_REJECTED") {
    const reasons = event.details.blockedReasons;
    if (Array.isArray(reasons)) return reasons.join("; ");
  }
  return event.eventType;
}

export function latestFailureOrWarning(events: AuditEvent[], options: { sinceIndex?: number } = {}): HermesRecentFailure | null {
  const sinceIndex = options.sinceIndex ?? 0;
  for (let i = events.length - 1; i >= sinceIndex; i--) {
    const event = events[i]!;
    if (!FAILURE_EVENT_TYPES.has(event.eventType)) continue;
    return {
      eventType: event.eventType,
      timestamp: event.timestamp,
      instrument: event.instrument,
      message: summariseFailureMessage(event),
    };
  }
  return null;
}

export interface HermesUnreconciledClosure {
  timestamp: string;
  instrument?: string;
  strategyId?: string;
  lifecycleRecordId?: string;
}

/**
 * Restart-Resilient Autonomy Phase — CLOSED_UNRECONCILED operator visibility (deployment safety
 * review). Every BROKER_RECONCILIATION_MISMATCH event whose own `details.resolution` is
 * "reconciled-closed-unreconciled" marks a lifecycle record that entered CLOSED_UNRECONCILED —
 * genuinely gone at the broker, but with no confirmed exit price or realised P&L (see
 * position-reconciliation.ts's own reconcileLocalActiveButBrokerAbsent). Sourced entirely from the
 * audit trail, the same "no direct TradeLifecycleStore read" convention every other derivation in
 * this file already follows (audit-log-reader.ts is the only durable, cross-process record this
 * Next.js server has of the standalone runtime process). Never scoped to "since last start" — an
 * unreconciled closure is exactly the kind of thing that must remain visible across a restart, not
 * reset to zero the moment the runtime that produced it restarts.
 */
export function listUnreconciledClosures(events: AuditEvent[]): HermesUnreconciledClosure[] {
  const results: HermesUnreconciledClosure[] = [];
  for (const event of events) {
    if (event.eventType !== "BROKER_RECONCILIATION_MISMATCH") continue;
    if (detailString(event.details, "resolution") !== "reconciled-closed-unreconciled") continue;
    results.push({
      timestamp: event.timestamp,
      instrument: event.instrument,
      strategyId: event.strategyId,
      lifecycleRecordId: detailString(event.details, "lifecycleRecordId"),
    });
  }
  return results;
}
