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
  /** A compact, stable status token — not a HealthStatus, a decision-outcome vocabulary:
   * "HOLD" | "RISK_REJECTED" | "OPENED" | "CLOSED" | "EXECUTION_FAILED" | "CLOSE_FAILED" |
   * "SKIPPED" | "unknown" (no matching downstream event found within the lookahead window). */
  status: string;
  realisedPnl?: number;
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
// generous, not tight.
const EXECUTION_LOOKAHEAD_WINDOW = 8;

function deriveExecutionResult(events: AuditEvent[], decisionIndex: number, instrument: string): HermesDecisionExecutionResult {
  const decisionEvent = events[decisionIndex]!;
  const action = decisionEvent.details.action;
  if (action === "HOLD") return { executed: false, status: "HOLD" };

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

/** Sourced entirely from MARKET_DECISION_RECEIVED audit events — the same events
 * market-decision-runner.ts already records around every MarketDecisionEngine.evaluate() call.
 * "strategy" comes from the event's own top-level `strategyId` field; "market snapshot" is
 * whatever's left of `details` once action/confidence/reasoning are removed (trend/RSI/EMA
 * relationship, whatever the decision engine attached — never re-derived). Returned newest first. */
export function listDecisions(events: AuditEvent[], filters: HermesDecisionFilters): HermesDecisionDto[] {
  const results: HermesDecisionDto[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.eventType !== "MARKET_DECISION_RECEIVED") continue;

    const action = event.details.action;
    if (typeof action !== "string" || (action !== "BUY" && action !== "SELL" && action !== "HOLD")) continue;
    const instrument = event.instrument ?? "unknown";

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
      executionResult: deriveExecutionResult(events, i, instrument),
    });
  }

  results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return results.slice(0, filters.limit);
}

/** The most recent thing worth an operator's attention — a failed cycle, a risk rejection, an
 * execution/close failure, or a broker-connection failure — whichever is most recent. Returns
 * `null` if none of those event types appear anywhere in the log. Used by /summary; deliberately
 * separate from deriveObservedRuntimeState's own `lastError` (which is scoped to the current start
 * and cycle-failures only) — this looks across the whole file and a wider set of event types. */
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

export function latestFailureOrWarning(events: AuditEvent[]): HermesRecentFailure | null {
  for (let i = events.length - 1; i >= 0; i--) {
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
