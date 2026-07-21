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

function formatAlert(event: AuditEvent): string | undefined {
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
    default:
      return undefined;
  }
}

/** Wraps `inner` (any existing AuditTrail) and dispatches one Telegram message per alert-worthy
 * event, using the exact same `record()` calls the pipeline already makes — no new audit event
 * types were introduced for this (see formatAlert's own switch — every case is an existing
 * AuditEventType from Missions 6/7). A Telegram delivery failure never breaks or delays the
 * underlying audit recording: `inner.record()` is always awaited and always completes first: only
 * the alert dispatch itself is best-effort. */
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
    } catch {
      // Best-effort only — if Telegram itself is unreachable, there is no channel left to alert
      // about that failure; the event is still safely recorded in `inner` regardless.
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
