import { describe, expect, it, vi } from "vitest";
import { TelegramAlertingAuditTrail, formatAlert } from "@/lib/hermes-execution/telegram/telegram-alerting-audit-trail";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { AuditEvent, AuditEventType } from "@/lib/hermes-execution/types";

// Telegram alert refinement. Curated down to ONLY genuinely actionable trading events —
// TRADE_OPENED, TRADE_CLOSED, and a small set of critical operational failures — see
// telegram-alerting-audit-trail.ts's own top-of-file doc comment for the full rationale.

function makeEvent(eventType: AuditEventType, details: Record<string, unknown> = {}, instrument = "BTC"): AuditEvent {
  return {
    timestamp: "2026-07-29T14:18:00.000Z",
    eventType,
    executionRunId: "test-run",
    instrument,
    details,
  };
}

function makeAlertSender() {
  const sent: string[] = [];
  return { sent, sendAlert: vi.fn(async (text: string) => { sent.push(text); }) };
}

const TRADE_OPENED_DETAILS = {
  entryPrice: 64_208.29,
  side: "BUY",
  quantity: 9.95,
  sizingMode: "NOTIONAL",
  stopLoss: 63_769.02,
  takeProfit: 65_304.91,
  brokerPositionId: "3570001762",
  brokerOrderId: "order-1",
  openedAt: "2026-07-29T14:18:00.000Z",
};

const TRADE_CLOSED_DETAILS = {
  entryPrice: 1_898.6,
  exitPrice: 1_887.89,
  exitReason: "automatic-exit-opposing_signal",
  realisedPnl: -0.06,
  realisedPnlPercent: -0.56,
  holdingDurationMs: 65 * 60_000,
  brokerPositionId: "3570011300",
  closedAt: "2026-07-29T15:23:00.000Z",
};

describe("formatAlert — TRADE OPENED", () => {
  it("matches the required template exactly, in Europe/London local time", () => {
    const text = formatAlert(makeEvent("TRADE_OPENED", TRADE_OPENED_DETAILS, "BTC"));
    expect(text).toBe(
      [
        "🟢 TRADE OPENED [DEMO]",
        "",
        "Instrument: BTC",
        "Direction: BUY",
        "Entry: 64,208.29",
        "Position value: £9.95",
        "Stop-loss: 63,769.02",
        "Take-profit: 65,304.91",
        "Position ID: 3570001762",
        "Opened: 29 Jul 2026, 15:18 BST",
      ].join("\n"),
    );
  });

  it("shows a UNITS position's own quantity, never a fabricated currency figure", () => {
    const text = formatAlert(makeEvent("TRADE_OPENED", { ...TRADE_OPENED_DETAILS, sizingMode: "UNITS", quantity: 10 }, "SOL"));
    expect(text).toContain("Position value: 10 units");
  });

  it("shows 'Not set' for a missing stop-loss/take-profit — never fabricates 0", () => {
    const text = formatAlert(
      makeEvent("TRADE_OPENED", { ...TRADE_OPENED_DETAILS, stopLoss: undefined, takeProfit: undefined }, "BTC"),
    );
    expect(text).toContain("Stop-loss: Not set");
    expect(text).toContain("Take-profit: Not set");
  });

  it("shows 'Unavailable' for a missing broker position ID — never omits the line", () => {
    const text = formatAlert(makeEvent("TRADE_OPENED", { ...TRADE_OPENED_DETAILS, brokerPositionId: undefined }, "BTC"));
    expect(text).toContain("Position ID: Unavailable");
  });

  it("returns undefined (no alert) when the minimum required fields are missing — never a partial/misleading alert", () => {
    expect(formatAlert(makeEvent("TRADE_OPENED", {}, "BTC"))).toBeUndefined();
    expect(formatAlert(makeEvent("TRADE_OPENED", { entryPrice: 100 }, "BTC"))).toBeUndefined(); // side missing
  });
});

describe("formatAlert — TRADE CLOSED", () => {
  it("matches the required template exactly, with a clear exit-reason label and Europe/London local time", () => {
    const text = formatAlert(makeEvent("TRADE_CLOSED", TRADE_CLOSED_DETAILS, "ETH"));
    expect(text).toBe(
      [
        "🔴 TRADE CLOSED [DEMO]",
        "",
        "Instrument: ETH",
        "Reason: Opposing signal",
        "Entry: 1,898.60",
        "Exit: 1,887.89",
        "Realised P/L: -£0.06",
        "Return: -0.56%",
        "Held: 1h 5m",
        "Position ID: 3570011300",
        "Closed: 29 Jul 2026, 16:23 BST",
      ].join("\n"),
    );
  });

  it.each([
    ["automatic-exit-stop_loss", "Stop-loss"],
    ["automatic-exit-take_profit", "Take-profit"],
    ["automatic-exit-opposing_signal", "Opposing signal"],
    ["market-decision-sell", "Opposing signal"],
    ["automatic-exit-max_holding_duration", "Maximum holding time"],
    ["automatic-exit-kill_switch", "Kill switch"],
    ["automatic-exit-strategy_disabled", "Other risk exit"],
    ["some-future-unrecognised-reason", "Other risk exit"],
  ])("maps closeReason %s to the clear label %s", (exitReason, expectedLabel) => {
    const text = formatAlert(makeEvent("TRADE_CLOSED", { ...TRADE_CLOSED_DETAILS, exitReason }, "ETH"));
    expect(text).toContain(`Reason: ${expectedLabel}`);
  });

  it("shows a positive realised P/L without a forced sign, matching a gain example", () => {
    const text = formatAlert(makeEvent("TRADE_CLOSED", { ...TRADE_CLOSED_DETAILS, realisedPnl: 12.5, realisedPnlPercent: 3.2 }, "ETH"));
    expect(text).toContain("Realised P/L: £12.50");
    expect(text).toContain("Return: 3.20%");
  });

  it("never estimates realised P/L — shows 'Unavailable' when it is genuinely absent", () => {
    const text = formatAlert(makeEvent("TRADE_CLOSED", { ...TRADE_CLOSED_DETAILS, realisedPnl: undefined }, "ETH"));
    expect(text).toContain("Realised P/L: Unavailable");
  });

  it("returns undefined (no alert) when the minimum required fields are missing", () => {
    expect(formatAlert(makeEvent("TRADE_CLOSED", {}, "ETH"))).toBeUndefined();
  });
});

describe("formatAlert — critical operational failures only", () => {
  it("BROKER_CONNECTION_FAILED", () => {
    const text = formatAlert(makeEvent("BROKER_CONNECTION_FAILED", { reason: "401 Unauthorized" }, "BTC"));
    expect(text).toContain("Broker connection failed");
    expect(text).toContain("401 Unauthorized");
    expect(text).toContain("BTC");
  });

  it("TRADE_CLOSE_FAILED — the position remains open and unprotected", () => {
    const text = formatAlert(makeEvent("TRADE_CLOSE_FAILED", { message: "close endpoint returned 404" }, "BTC"));
    expect(text).toContain("Close failed");
    expect(text).toContain("close endpoint returned 404");
    expect(text).toContain("remains OPEN");
  });

  it("TRADING_CYCLE_FAILED", () => {
    const text = formatAlert(makeEvent("TRADING_CYCLE_FAILED", { message: "unexpected exception" }));
    expect(text).toContain("Trading cycle failed");
    expect(text).toContain("unexpected exception");
  });
});

// Requirement 4 — noisy/routine events must never produce a Telegram message. Every one of these
// still gets recorded to the (unmodified) inner audit trail — see the TelegramAlertingAuditTrail
// describe block below for that separate assertion — only the ALERT dispatch is suppressed here.
describe("formatAlert — noisy/routine events send no Telegram message", () => {
  const noisyEvents: Array<[AuditEventType, Record<string, unknown>]> = [
    ["TRADING_RUNTIME_STARTED", {}],
    ["TRADING_RUNTIME_STOPPED", { timedOut: false }],
    ["TRADING_CYCLE_STARTED", {}],
    ["TRADING_CYCLE_COMPLETED", {}],
    ["UNIVERSE_SCAN_COMPLETED", { eligibleInstrumentCount: 5, selectedProposalCount: 2 }],
    ["HERMES_PROPOSAL_SELECTED", { action: "BUY", confidence: 0.82 }],
    ["HERMES_RESPONSE_REJECTED", { reason: "unknown instrument DOGE" }],
    ["HERMES_INSTRUMENT_DECISION_RECORDED", { action: "HOLD" }],
    ["TRADE_CANDIDATE_CREATED", { direction: "BUY", confidence: 0.82 }],
    ["TRADE_CANDIDATE_EXPIRED", {}],
    ["TRADE_CANDIDATE_AUTO_APPROVED", {}],
    ["TRADE_CANDIDATE_APPROVED", {}],
    ["TRADE_CANDIDATE_REJECTED", {}],
    ["BROKER_RECONCILIATION_MISMATCH", { resolution: "reconciled-closed-unreconciled" }],
    ["BROKER_RECONCILIATION_MISMATCH", { resolution: "failed-closed" }],
    ["OPPOSING_SIGNAL_EXIT_DEFERRED", { reason: "min-hold-not-reached" }],
    ["DUPLICATE_ENTRY_SUPPRESSED", { reason: "already pending" }],
    ["KILL_SWITCH_ENTRY_BLOCKED", {}],
    ["AUTOMATIC_EXIT_TRIGGERED", { trigger: "STOP_LOSS" }],
    ["TRADE_RISK_REJECTED", { blockedReasons: ["max exposure exceeded"] }],
    ["TRADE_EXECUTION_FAILED", { message: "broker rejected order" }],
    ["CANDLE_PROCESSED", {}],
    ["STRATEGY_LOADED", {}],
    ["AUTO_APPROVAL_FAILED", { reason: "x" }],
  ];

  it.each(noisyEvents)("%s sends nothing", (eventType, details) => {
    expect(formatAlert(makeEvent(eventType, details))).toBeUndefined();
  });

  // DAILY_PORTFOLIO_SUMMARY is deliberately excluded even though it IS a wanted alert — it is sent
  // through its own direct path (daily-account-summary-service.ts), never through this generic
  // per-event dispatch — see this file's own top-of-file doc comment for why.
  it("DAILY_PORTFOLIO_SUMMARY sends nothing through the generic per-event path", () => {
    expect(formatAlert(makeEvent("DAILY_PORTFOLIO_SUMMARY", { tradesOpenedToday: 1 }))).toBeUndefined();
  });
});

describe("TelegramAlertingAuditTrail", () => {
  it("always forwards record() to the inner audit trail first, unchanged — even for a routine, non-alert-worthy event", async () => {
    const inner = new InMemoryAuditTrail();
    const alertSender = makeAlertSender();
    const decorated = new TelegramAlertingAuditTrail(inner, alertSender);
    const event = makeEvent("CANDLE_PROCESSED");

    await decorated.record(event);

    expect(await inner.getEvents()).toEqual([event]);
    expect(alertSender.sendAlert).not.toHaveBeenCalled();
  });

  it("TRADE_OPENED dispatches exactly one message after a confirmed broker opening", async () => {
    const inner = new InMemoryAuditTrail();
    const alertSender = makeAlertSender();
    const decorated = new TelegramAlertingAuditTrail(inner, alertSender);

    await decorated.record(makeEvent("TRADE_OPENED", TRADE_OPENED_DETAILS, "BTC"));

    expect(alertSender.sendAlert).toHaveBeenCalledOnce();
    expect(alertSender.sent[0]).toContain("TRADE OPENED");
  });

  it("TRADE_CLOSED dispatches exactly one message, including realised P/L, after a verified closure", async () => {
    const inner = new InMemoryAuditTrail();
    const alertSender = makeAlertSender();
    const decorated = new TelegramAlertingAuditTrail(inner, alertSender);

    await decorated.record(makeEvent("TRADE_CLOSED", TRADE_CLOSED_DETAILS, "ETH"));

    expect(alertSender.sendAlert).toHaveBeenCalledOnce();
    expect(alertSender.sent[0]).toContain("TRADE CLOSED");
    expect(alertSender.sent[0]).toContain("Realised P/L: -£0.06");
  });

  it("scan and runtime events send no Telegram message", async () => {
    const inner = new InMemoryAuditTrail();
    const alertSender = makeAlertSender();
    const decorated = new TelegramAlertingAuditTrail(inner, alertSender);

    await decorated.record(makeEvent("TRADING_RUNTIME_STARTED"));
    await decorated.record(makeEvent("TRADING_CYCLE_STARTED"));
    await decorated.record(makeEvent("UNIVERSE_SCAN_COMPLETED", { eligibleInstrumentCount: 5, selectedProposalCount: 2 }));

    expect(alertSender.sendAlert).not.toHaveBeenCalled();
    expect(await inner.getEvents()).toHaveLength(3); // still fully recorded, just never alerted
  });

  it("sends no alert for an event type not in the curated list", async () => {
    const inner = new InMemoryAuditTrail();
    const alertSender = makeAlertSender();
    const decorated = new TelegramAlertingAuditTrail(inner, alertSender);

    await decorated.record(makeEvent("CANDLE_PROCESSED"));

    expect(alertSender.sendAlert).not.toHaveBeenCalled();
  });

  it("still records the event in the inner trail even when alert delivery fails", async () => {
    const inner = new InMemoryAuditTrail();
    const alertSender = { sendAlert: vi.fn(async () => { throw new Error("Telegram unreachable"); }) };
    const decorated = new TelegramAlertingAuditTrail(inner, alertSender);
    const event = makeEvent("TRADE_OPENED", TRADE_OPENED_DETAILS, "BTC");

    await expect(decorated.record(event)).resolves.toBeUndefined();

    const events = await inner.getEvents();
    expect(events[0]).toEqual(event);
  });

  // Prototype 1.0 — Telegram observability. A delivery failure must be audited, not silently
  // swallowed — but must never throw into the caller (an order may have already succeeded), and
  // must never block or delay trading.
  describe("TelegramAlertingAuditTrail — delivery-failure observability (notification failures remain non-blocking)", () => {
    it("records a TELEGRAM_NOTIFICATION_FAILED event referencing the original event type and reason", async () => {
      const inner = new InMemoryAuditTrail();
      const alertSender = { sendAlert: vi.fn(async () => { throw new Error("Hermes gateway delivery failed: timeout") }) };
      const decorated = new TelegramAlertingAuditTrail(inner, alertSender);
      const event = makeEvent("TRADE_OPENED", TRADE_OPENED_DETAILS, "BTC");

      await decorated.record(event);

      const events = await inner.getEvents();
      const failure = events.find((e) => e.eventType === "TELEGRAM_NOTIFICATION_FAILED");
      expect(failure).toBeDefined();
      expect(failure?.details.originalEventType).toBe("TRADE_OPENED");
      expect(failure?.details.reason).toContain("timeout");
    });

    it("includes the durable event ID (e.g. brokerPositionId) where the original event carries one", async () => {
      const inner = new InMemoryAuditTrail();
      const alertSender = { sendAlert: vi.fn(async () => { throw new Error("delivery failed") }) };
      const decorated = new TelegramAlertingAuditTrail(inner, alertSender);
      const { brokerOrderId: _brokerOrderId, ...detailsWithoutOrderId } = TRADE_OPENED_DETAILS;
      const event = makeEvent("TRADE_OPENED", detailsWithoutOrderId, "BTC");

      await decorated.record(event);

      const failure = (await inner.getEvents()).find((e) => e.eventType === "TELEGRAM_NOTIFICATION_FAILED");
      expect(failure?.details.durableEventId).toBe("3570001762");
    });

    it("never throws into the caller, even when a delivery failure occurs after an order has already succeeded", async () => {
      const inner = new InMemoryAuditTrail();
      const alertSender = { sendAlert: vi.fn(async () => { throw new Error("network unreachable") }) };
      const decorated = new TelegramAlertingAuditTrail(inner, alertSender);

      await expect(decorated.record(makeEvent("TRADE_OPENED", TRADE_OPENED_DETAILS, "BTC"))).resolves.toBeUndefined();
    });

    it("never exposes a credential/token-shaped value in the recorded failure's own reason field", async () => {
      const inner = new InMemoryAuditTrail();
      const alertSender = { sendAlert: vi.fn(async () => { throw new Error("Hermes gateway delivery failed: non-zero-exit") }) };
      const decorated = new TelegramAlertingAuditTrail(inner, alertSender);

      await decorated.record(makeEvent("TRADE_OPENED", TRADE_OPENED_DETAILS, "BTC"));

      const failure = (await inner.getEvents()).find((e) => e.eventType === "TELEGRAM_NOTIFICATION_FAILED");
      expect(failure?.details.reason).not.toMatch(/bot\d+:[A-Za-z0-9_-]{20,}/);
      expect(failure?.details.reason).not.toMatch(/api[_-]?key/i);
    });

    it("still records the failure observation even when the inner audit trail's own SECOND write also fails", async () => {
      const failingInner = {
        record: vi
          .fn()
          .mockResolvedValueOnce(undefined) // the original event's own record() succeeds
          .mockRejectedValueOnce(new Error("audit trail write failed")), // the failure-observation write does not
        getEvents: vi.fn(async () => []),
        getLatestEvent: vi.fn(async () => null),
      };
      const alertSender = { sendAlert: vi.fn(async () => { throw new Error("delivery failed") }) };
      const decorated = new TelegramAlertingAuditTrail(failingInner, alertSender);

      await expect(decorated.record(makeEvent("TRADE_OPENED", TRADE_OPENED_DETAILS, "BTC"))).resolves.toBeUndefined();
    });
  });

  it("getEvents()/getLatestEvent() delegate to the inner trail", async () => {
    const inner = new InMemoryAuditTrail();
    const alertSender = makeAlertSender();
    const decorated = new TelegramAlertingAuditTrail(inner, alertSender);
    const event = makeEvent("TRADING_RUNTIME_STARTED");
    await decorated.record(event);

    expect(await decorated.getEvents()).toEqual([event]);
    expect(await decorated.getLatestEvent()).toEqual(event);
  });

  it("never includes a bot token or credential-shaped value — it only ever forwards formatAlert's own plain text", async () => {
    const inner = new InMemoryAuditTrail();
    const alertSender = makeAlertSender();
    const decorated = new TelegramAlertingAuditTrail(inner, alertSender);

    await decorated.record(makeEvent("BROKER_CONNECTION_FAILED", { reason: "401 Unauthorized" }));

    expect(alertSender.sent[0]).not.toMatch(/bot\d+:[A-Za-z0-9_-]{20,}/);
  });
});
