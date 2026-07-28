import type { AuditTrail } from "../audit-trail";
import type { AuditEvent } from "../types";

// Prototype V1 — minimum Telegram integration. A decorator, not a new event system: wraps an
// existing AuditTrail (JsonFileAuditTrail in production, InMemoryAuditTrail in tests) and forwards
// every record() call to it completely unchanged, additionally dispatching a Telegram alert for a
// small fixed set of event types. This is the entire integration point between the existing
// runtime/lifecycle pipeline and Telegram — no runtime, scheduler, lifecycle, or broker file is
// touched to wire alerts in; swapping this decorator in or out only requires changing which
// AuditTrail market-runtime.ts constructs.

/** Duck-typed — implemented by TelegramBot, but this file never imports it, so alerting can never
 * accidentally depend on polling/command-dispatch concerns it has nothing to do with. */
export interface AlertSender {
  sendAlert(text: string): Promise<void>;
}

// Prototype 1.0 — official Hermes Agent decision integration. Every alert this pipeline ever sends
// concerns a demo/virtual eToro account only (AUTO_LIVE is structurally impossible — see
// config.ts) — formatAlert's own exported wrapper below appends a single, consistent "[DEMO]"
// label to every message exactly once, rather than each case restating it, so this can never drift
// case-by-case.
function formatAlertCore(event: AuditEvent): string | undefined {
  const details = event.details;
  switch (event.eventType) {
    case "TRADING_RUNTIME_STARTED":
      return "Runtime started.";
    case "TRADING_RUNTIME_STOPPED":
      return details.timedOut
        ? "Runtime stopped. (forced — an active cycle did not finish within the shutdown timeout)"
        : "Runtime stopped.";
    case "TRADE_OPENED":
      return `Trade opened: ${event.instrument} @ ${details.entryPrice} (order ${details.brokerOrderId}).`;
    case "TRADE_CLOSED":
      return (
        `Trade closed: ${event.instrument}. Realised P/L ${details.realisedPnl} (${details.realisedPnlPercent}%). ` +
        `Reason: ${details.exitReason}.`
      );
    case "TRADE_RISK_REJECTED": {
      const reasons = Array.isArray(details.blockedReasons) ? details.blockedReasons.join("; ") : "unspecified";
      return `Risk rejection: ${event.instrument} — ${reasons}.`;
    }
    case "TRADE_EXECUTION_FAILED":
      return `Execution failure: ${event.instrument} — ${details.message}.`;
    case "TRADE_CLOSE_FAILED":
      return `Execution failure (close): ${event.instrument} — ${details.message}.`;
    case "BROKER_CONNECTION_FAILED":
      return `Broker error: connection failed — ${details.reason}.`;
    case "TRADING_CYCLE_FAILED":
      return `Runtime error: cycle failed — ${details.message}.`;
    // Restart-Resilient Autonomy Phase — CLOSED_UNRECONCILED operator visibility (deployment safety
    // review). "reconciled-closed-unreconciled" means a position genuinely entered
    // CLOSED_UNRECONCILED; "failed-closed" (Prototype 1.0 addition) is the general reconciliation
    // warning for every other fail-closed outcome this same event type carries — two distinct
    // messages for two distinct operator-visible situations, never conflated.
    case "BROKER_RECONCILIATION_MISMATCH":
      if (details.resolution === "reconciled-closed-unreconciled") {
        return (
          `Position closed with UNKNOWN exit price/P&L (CLOSED_UNRECONCILED): ${event.instrument} ` +
          `(lifecycle record ${details.lifecycleRecordId}). See /reconciliation for details.`
        );
      }
      if (details.resolution === "failed-closed") {
        return `Reconciliation warning: ${event.instrument} — ${details.reason ?? "could not safely reconcile this cycle"}.`;
      }
      return undefined;
    // Prototype 1.0 — official Hermes Agent decision integration.
    case "DUPLICATE_ENTRY_SUPPRESSED":
      return `Duplicate suppressed: ${event.instrument} — ${details.reason ?? "an equivalent entry is already in flight"}.`;
    case "KILL_SWITCH_ENTRY_BLOCKED":
      return `Kill switch active: entry blocked${event.instrument ? ` for ${event.instrument}` : ""}.`;
    case "TRADE_CANDIDATE_CREATED":
      return `Candidate pending manual approval: ${event.instrument} ${details.direction ?? ""} (confidence ${details.confidence}).`;
    case "TRADE_CANDIDATE_AUTO_APPROVED":
      return `Candidate auto-approved (AUTO_DEMO): ${event.instrument}.`;
    case "AUTOMATIC_EXIT_TRIGGERED": {
      const trigger = details.trigger;
      if (trigger === "STOP_LOSS") return `Stop-loss triggered: ${event.instrument}.`;
      if (trigger === "TAKE_PROFIT") return `Take-profit triggered: ${event.instrument}.`;
      if (trigger === "KILL_SWITCH") return `Kill switch: closing open position on ${event.instrument}.`;
      return `Automatic exit triggered (${trigger}): ${event.instrument}.`;
    }
    case "UNIVERSE_SCAN_COMPLETED":
      return (
        `Scan complete: ${details.eligibleInstrumentCount ?? "?"} eligible instrument(s), ` +
        `${details.selectedProposalCount ?? 0} proposal(s) selected.`
      );
    case "HERMES_PROPOSAL_SELECTED":
      return `Hermes opportunity selected: ${event.instrument} ${details.action} (confidence ${details.confidence}).`;
    case "HERMES_RESPONSE_REJECTED":
      return `Hermes proposal rejected as invalid — ${details.reason ?? "failed validation"}.`;
    case "DAILY_PORTFOLIO_SUMMARY":
      return (
        `Daily summary: ${details.tradeCount ?? 0} trade(s), realised P/L ${details.realisedPnl ?? 0}, ` +
        `${details.openPositionCount ?? 0} open position(s).`
      );
    default:
      return undefined;
  }
}

function formatAlert(event: AuditEvent): string | undefined {
  const message = formatAlertCore(event);
  return message === undefined ? undefined : `${message} [DEMO]`;
}

/** Wraps `inner` (any existing AuditTrail) and dispatches one Telegram message per alert-worthy
 * event, using the exact same `record()` calls the pipeline already makes — no new audit event
 * types were introduced for this (see formatAlert's own switch — every case is an existing
 * AuditEventType from Missions 6/7). A Telegram delivery failure never breaks or delays the
 * underlying audit recording: `inner.record()` is always awaited and always completes first: only
 * the alert dispatch itself is best-effort. */
// Prototype 1.0 — Telegram observability. Field names checked in priority order — whichever
// durable identifier the ORIGINAL event already carries (never invented) — so a failed
// notification can be traced back to the trade/candidate/lifecycle record it concerned, without
// this module needing to know every event type's own details shape in advance.
const DURABLE_ID_FIELDS = ["candidateId", "lifecycleRecordId", "tradeLifecycleId", "brokerOrderId"] as const;

function findDurableEventId(details: Record<string, unknown>): string | undefined {
  for (const field of DURABLE_ID_FIELDS) {
    const value = details[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export class TelegramAlertingAuditTrail implements AuditTrail {
  constructor(
    private readonly inner: AuditTrail,
    private readonly alertSender: AlertSender,
  ) {}

  async record(event: AuditEvent): Promise<void> {
    await this.inner.record(event);
    const message = formatAlert(event);
    if (message === undefined) return;
    try {
      await this.alertSender.sendAlert(message);
    } catch (error) {
      // Prototype 1.0 — Telegram observability. Delivery is always best-effort — a failure must
      // never throw into the caller (broker execution may have already succeeded) — but it must
      // not be swallowed invisibly either. Records a redacted failure fact (never the credential-
      // shaped internals of `error`, never the message text itself — only its own error `.message`,
      // which HermesGatewayAlertSender/TelegramBot both construct as a clear, bounded, own string,
      // never raw stderr or a raw transport error) referencing the ORIGINAL event's own durable
      // identifier where one exists. Wrapped in its own try/catch so a broken audit trail can
      // never surface here either.
      try {
        await this.inner.record({
          timestamp: event.timestamp,
          eventType: "TELEGRAM_NOTIFICATION_FAILED",
          executionRunId: event.executionRunId,
          strategyId: event.strategyId,
          instrument: event.instrument,
          details: {
            originalEventType: event.eventType,
            durableEventId: findDurableEventId(event.details),
            reason: error instanceof Error ? error.message : "unknown delivery failure",
          },
        });
      } catch {
        // Best-effort observability only — never lets a broken audit trail surface here.
      }
    }
  }

  async getEvents(): Promise<AuditEvent[]> {
    return this.inner.getEvents();
  }

  async getLatestEvent(): Promise<AuditEvent | null> {
    return this.inner.getLatestEvent();
  }
}

export { formatAlert };
