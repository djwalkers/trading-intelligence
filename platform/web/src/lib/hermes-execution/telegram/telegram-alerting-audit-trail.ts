import type { AuditTrail } from "../audit-trail";
import type { AuditEvent } from "../types";
import { formatExitReasonLabel, formatGbp, formatHoldingDuration, formatLondonTimestamp, formatPriceLevel, formatSignedGbp, formatSignedPercent } from "./format-alert-values";

// Prototype V1 — minimum Telegram integration. A decorator, not a new event system: wraps an
// existing AuditTrail (JsonFileAuditTrail in production, InMemoryAuditTrail in tests) and forwards
// every record() call to it completely unchanged, additionally dispatching a Telegram alert for a
// small fixed set of event types. This is the entire integration point between the existing
// runtime/lifecycle pipeline and Telegram — no runtime, scheduler, lifecycle, or broker file is
// touched to wire alerts in; swapping this decorator in or out only requires changing which
// AuditTrail market-runtime.ts constructs.
//
// Telegram alert refinement. Deliberately curated down to ONLY genuinely actionable trading
// events — TRADE_OPENED, TRADE_CLOSED, a small, tightly-scoped set of critical operational
// failures (broker connection lost, an automatic close failing so a position remains unprotected,
// or the whole trading cycle crashing), and (candle-gap production incident fix) a rate-limited
// market-data incident alert/recovery pair — see formatAlertCore's own doc comment for the full
// list of event types this deliberately does NOT alert on any more, and why. Every other event
// this pipeline records continues to be written to the (unmodified) inner audit trail/log exactly
// as before — "no Telegram alert" never means "no record."
//
// DAILY_PORTFOLIO_SUMMARY is deliberately NOT handled here at all (falls through to `default`,
// returns undefined) — see daily-account-summary-service.ts's own doc comment: that service sends
// the daily summary DIRECTLY through its own AlertSender, because (unlike every other alert here) it
// needs to observe delivery success/failure itself, to decide whether it may safely persist "today's
// summary was sent" (a failed send must be retryable; a successful one must never be duplicated).
// Dispatching it through this generic, fire-and-forget per-event path would give it no way to do
// that. If some other, future caller ever records a DAILY_PORTFOLIO_SUMMARY event through the plain
// audit trail, this deliberately sends nothing for it — never a duplicate, un-tracked send.

/** Duck-typed — implemented by TelegramBot, but this file never imports it, so alerting can never
 * accidentally depend on polling/command-dispatch concerns it has nothing to do with. */
export interface AlertSender {
  sendAlert(text: string): Promise<void>;
}

function detailNumber(details: Record<string, unknown>, key: string): number | undefined {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function detailString(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** "Position value" — NOTIONAL sizing IS already a monetary amount (eToro's own CFD "amount", the
 * account-currency value risked) and is shown in GBP; UNITS sizing is a share/contract/coin count,
 * never fabricated into a currency figure it isn't. Undefined/unrecognised sizingMode or a missing
 * quantity never guesses — shows "Unavailable" instead of a wrong-looking number. */
function formatPositionValue(details: Record<string, unknown>): string {
  const quantity = detailNumber(details, "quantity");
  const sizingMode = details.sizingMode;
  if (quantity === undefined) return "Unavailable";
  if (sizingMode === "NOTIONAL") return formatGbp(quantity);
  if (sizingMode === "UNITS") return `${quantity} units`;
  return "Unavailable";
}

/**
 * 🟢 TRADE OPENED [DEMO] — sent once, only from TRADE_OPENED (see trade-lifecycle-service.ts's own
 * recordOpened) which itself only ever fires after the broker has confirmed a position is genuinely
 * OPEN (an approved candidate's own execution, or a reconciled/adopted broker position) — never for
 * a candidate merely being created or approved. Returns undefined (no alert) if the event is missing
 * the minimum fields a trustworthy alert needs (instrument/side/entryPrice) — this should never
 * happen for a genuine TRADE_OPENED event, but a partial/malformed one must never produce a
 * misleading half-alert.
 */
function formatTradeOpenedAlert(event: AuditEvent): string | undefined {
  const entryPrice = detailNumber(event.details, "entryPrice");
  const side = detailString(event.details, "side");
  if (entryPrice === undefined || side === undefined || event.instrument === undefined) return undefined;

  const stopLoss = detailNumber(event.details, "stopLoss");
  const takeProfit = detailNumber(event.details, "takeProfit");
  const brokerPositionId = detailString(event.details, "brokerPositionId") ?? "Unavailable";
  const openedAt = detailString(event.details, "openedAt") ?? event.timestamp;

  return [
    "🟢 TRADE OPENED [DEMO]",
    "",
    `Instrument: ${event.instrument}`,
    `Direction: ${side}`,
    `Entry: ${formatPriceLevel(entryPrice)}`,
    `Position value: ${formatPositionValue(event.details)}`,
    `Stop-loss: ${stopLoss !== undefined ? formatPriceLevel(stopLoss) : "Not set"}`,
    `Take-profit: ${takeProfit !== undefined ? formatPriceLevel(takeProfit) : "Not set"}`,
    `Position ID: ${brokerPositionId}`,
    `Opened: ${formatLondonTimestamp(openedAt)}`,
  ].join("\n");
}

/**
 * 🔴 TRADE CLOSED [DEMO] — sent once, only from TRADE_CLOSED (see trade-lifecycle-service.ts's own
 * recordClosed), which itself only ever fires after the broker close has been confirmed and the
 * lifecycle record has transitioned to CLOSED (never CLOSED_UNRECONCILED — that status carries no
 * confirmed exit price/P&L and correctly never reaches this event at all, see
 * position-reconciliation.ts). Realised P/L is NEVER estimated: if it is somehow absent, this shows
 * "Unavailable" rather than inventing a number — see requirement 2's own explicit instruction.
 */
function formatTradeClosedAlert(event: AuditEvent): string | undefined {
  const entryPrice = detailNumber(event.details, "entryPrice");
  const exitPrice = detailNumber(event.details, "exitPrice");
  const exitReason = detailString(event.details, "exitReason");
  if (entryPrice === undefined || exitPrice === undefined || exitReason === undefined || event.instrument === undefined) {
    return undefined;
  }

  const realisedPnl = detailNumber(event.details, "realisedPnl");
  const realisedPnlPercent = detailNumber(event.details, "realisedPnlPercent");
  const holdingDurationMs = detailNumber(event.details, "holdingDurationMs");
  const brokerPositionId = detailString(event.details, "brokerPositionId") ?? "Unavailable";
  const closedAt = detailString(event.details, "closedAt") ?? event.timestamp;

  return [
    "🔴 TRADE CLOSED [DEMO]",
    "",
    `Instrument: ${event.instrument}`,
    `Reason: ${formatExitReasonLabel(exitReason)}`,
    `Entry: ${formatPriceLevel(entryPrice)}`,
    `Exit: ${formatPriceLevel(exitPrice)}`,
    `Realised P/L: ${realisedPnl !== undefined ? formatSignedGbp(realisedPnl) : "Unavailable"}`,
    `Return: ${realisedPnlPercent !== undefined ? formatSignedPercent(realisedPnlPercent) : "Unavailable"}`,
    `Held: ${holdingDurationMs !== undefined ? formatHoldingDuration(holdingDurationMs) : "Unavailable"}`,
    `Position ID: ${brokerPositionId}`,
    `Closed: ${formatLondonTimestamp(closedAt)}`,
  ].join("\n");
}

/**
 * Telegram alert refinement — requirement 4 (critical operational failures only). Deliberately a
 * MINIMAL set — only a failure that genuinely "prevents safe trading or leaves an open position
 * unprotected" (the requirement's own exact wording), never a routine or expected outcome:
 *
 * - BROKER_CONNECTION_FAILED: the broker itself is unreachable — no open position can be evaluated
 *   or protected this cycle, and no fresh entry can be safely considered either.
 * - TRADE_CLOSE_FAILED: an automatic protective close (stop-loss/take-profit/kill-switch/opposing-
 *   signal/max-holding) was triggered and the broker close call itself failed — the position remains
 *   OPEN and genuinely unprotected until a later cycle retries it.
 * - TRADING_CYCLE_FAILED: an unhandled exception crashed the entire cycle — decision-making AND
 *   exit-monitoring both failed to run at all this tick.
 *
 * Deliberately EXCLUDED (logged/audited, never Telegrammed): TRADE_EXECUTION_FAILED (a failed BUY
 * attempt never leaves anything open or unprotected — nothing to act on urgently), TRADE_RISK_REJECTED/
 * DUPLICATE_ENTRY_SUPPRESSED/KILL_SWITCH_ENTRY_BLOCKED (expected, routine risk/safety gating, not a
 * failure), BROKER_RECONCILIATION_MISMATCH in both its forms (a genuine CLOSED_UNRECONCILED outcome
 * means the position is no longer open at all — nothing left exposed; a "failed-closed" reconciliation
 * outcome means a fresh entry was conservatively skipped this cycle, not that an existing position was
 * left unprotected).
 */
function formatCriticalFailureAlert(event: AuditEvent): string | undefined {
  switch (event.eventType) {
    case "BROKER_CONNECTION_FAILED": {
      const reason = detailString(event.details, "reason") ?? "unknown reason";
      return `⚠️ ALERT: Broker connection failed${event.instrument ? ` (${event.instrument})` : ""} — ${reason}. Trading and position protection may be impaired.`;
    }
    case "TRADE_CLOSE_FAILED": {
      const message = detailString(event.details, "message") ?? "unknown reason";
      return `⚠️ ALERT: Close failed for ${event.instrument ?? "an open position"} — ${message}. The position remains OPEN and may be unprotected.`;
    }
    case "TRADING_CYCLE_FAILED": {
      const message = detailString(event.details, "message") ?? "unknown reason";
      return `⚠️ ALERT: Trading cycle failed — ${message}. Automated protection may not have run this cycle.`;
    }
    default:
      return undefined;
  }
}

/**
 * Candle-gap production incident fix. MARKET_DATA_INCIDENT_ALERT is already rate-limited by the
 * caller (runtime/market-data-incident-tracker.ts, via TradingRuntime.recordMarketDataIncidentState) —
 * this function only ever formats whatever occurrence it's given, never decides whether to send
 * one. `details.isReminder` distinguishes the initial alert from a periodic reminder in the message
 * text itself, so an operator scrolling a chat history can tell the two apart without needing to
 * cross-reference timestamps.
 */
function formatMarketDataIncidentAlert(event: AuditEvent): string | undefined {
  const affectedInstruments = event.details.affectedInstruments;
  if (!Array.isArray(affectedInstruments) || affectedInstruments.length === 0) return undefined;
  const isReminder = event.details.isReminder === true;
  const reasons = event.details.reasons;
  const firstReason =
    reasons && typeof reasons === "object" ? Object.values(reasons as Record<string, unknown>)[0] : undefined;

  return [
    isReminder ? "⚠️ REMINDER: Market data incident still active" : "⚠️ ALERT: Market data incident detected",
    "",
    `Affected instruments: ${affectedInstruments.join(", ")}`,
    `Reason: ${typeof firstReason === "string" ? firstReason : "Invalid/gapped historical candle history."}`,
    "Entry/strategy analysis: blocked for affected instruments.",
    "Exit protection (stop-loss/take-profit/kill-switch): continuing via live quotes where a position is open.",
    "Opposing-signal exit: unavailable for affected instruments until candle history recovers.",
  ].join("\n");
}

/** Candle-gap production incident fix. Sent once, only when the tracker confirms every previously
 * affected instrument has recovered — an operator who received the alert above is never left to
 * infer recovery from silence alone. */
function formatMarketDataIncidentRecoveredAlert(event: AuditEvent): string | undefined {
  const recoveredInstruments = event.details.recoveredInstruments;
  if (!Array.isArray(recoveredInstruments) || recoveredInstruments.length === 0) return undefined;
  return [
    "✅ RESOLVED: Market data incident cleared",
    "",
    `Recovered instruments: ${recoveredInstruments.join(", ")}`,
    "Valid historical candle history has resumed — entry/strategy analysis and full exit protection are both active again.",
  ].join("\n");
}

/** The only place any AuditEventType is decided to be alert-worthy or not — every other event type
 * (runtime started/stopped, scan started/completed, HOLD decisions, candidate created/expired/auto-
 * approved, normal reconciliation, opposing-signal-deferred, routine health events, and every event
 * type not explicitly named above) returns undefined here: no Telegram message, ever, for it — see
 * this file's own top-of-file doc comment for the full rationale. */
function formatAlertCore(event: AuditEvent): string | undefined {
  switch (event.eventType) {
    case "TRADE_OPENED":
      return formatTradeOpenedAlert(event);
    case "TRADE_CLOSED":
      return formatTradeClosedAlert(event);
    case "BROKER_CONNECTION_FAILED":
    case "TRADE_CLOSE_FAILED":
    case "TRADING_CYCLE_FAILED":
      return formatCriticalFailureAlert(event);
    case "MARKET_DATA_INCIDENT_ALERT":
      return formatMarketDataIncidentAlert(event);
    case "MARKET_DATA_INCIDENT_RECOVERED":
      return formatMarketDataIncidentRecoveredAlert(event);
    default:
      return undefined;
  }
}

function formatAlert(event: AuditEvent): string | undefined {
  return formatAlertCore(event);
}

// Prototype 1.0 — Telegram observability. Field names checked in priority order — whichever
// durable identifier the ORIGINAL event already carries (never invented) — so a failed
// notification can be traced back to the trade/candidate/lifecycle record it concerned, without
// this module needing to know every event type's own details shape in advance.
const DURABLE_ID_FIELDS = ["candidateId", "lifecycleRecordId", "tradeLifecycleId", "brokerOrderId", "brokerPositionId"] as const;

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
