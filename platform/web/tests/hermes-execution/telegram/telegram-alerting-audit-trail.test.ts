import { describe, expect, it, vi } from "vitest";
import { TelegramAlertingAuditTrail, formatAlert } from "@/lib/hermes-execution/telegram/telegram-alerting-audit-trail";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { AuditEvent, AuditEventType } from "@/lib/hermes-execution/types";

function makeEvent(eventType: AuditEventType, details: Record<string, unknown> = {}, instrument = "BTC"): AuditEvent {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
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

describe("formatAlert — the eight required alert-worthy event types", () => {
  it("TRADING_RUNTIME_STARTED", () => {
    expect(formatAlert(makeEvent("TRADING_RUNTIME_STARTED"))).toBe("Runtime started. [DEMO]");
  });

  it("TRADING_RUNTIME_STOPPED — plain stop", () => {
    expect(formatAlert(makeEvent("TRADING_RUNTIME_STOPPED", { timedOut: false }))).toBe("Runtime stopped. [DEMO]");
  });

  it("TRADING_RUNTIME_STOPPED — forced by the bounded shutdown timeout", () => {
    const text = formatAlert(makeEvent("TRADING_RUNTIME_STOPPED", { timedOut: true }));
    expect(text).toContain("Runtime stopped.");
    expect(text).toContain("forced");
  });

  it("TRADE_OPENED — includes entry price and broker order id", () => {
    const text = formatAlert(makeEvent("TRADE_OPENED", { entryPrice: 50_000, brokerOrderId: "order-123" }));
    expect(text).toContain("Trade opened: BTC @ 50000");
    expect(text).toContain("order order-123");
  });

  it("TRADE_CLOSED — includes realised P/L (the mission's explicit requirement) and exit reason", () => {
    const text = formatAlert(
      makeEvent("TRADE_CLOSED", { realisedPnl: 42.5, realisedPnlPercent: 8.5, exitReason: "take-profit" }),
    );
    expect(text).toContain("Trade closed: BTC");
    expect(text).toContain("Realised P/L 42.5");
    expect(text).toContain("8.5%");
    expect(text).toContain("take-profit");
  });

  it("TRADE_RISK_REJECTED — includes the blocked reasons", () => {
    const text = formatAlert(makeEvent("TRADE_RISK_REJECTED", { blockedReasons: ["max exposure exceeded"] }));
    expect(text).toContain("Risk rejection: BTC");
    expect(text).toContain("max exposure exceeded");
  });

  it("TRADE_EXECUTION_FAILED — an open-side execution failure", () => {
    const text = formatAlert(makeEvent("TRADE_EXECUTION_FAILED", { message: "broker rejected order" }));
    expect(text).toContain("Execution failure: BTC");
    expect(text).toContain("broker rejected order");
  });

  it("TRADE_CLOSE_FAILED — a close-side execution failure", () => {
    const text = formatAlert(makeEvent("TRADE_CLOSE_FAILED", { message: "close endpoint returned 404" }));
    expect(text).toContain("Execution failure (close): BTC");
    expect(text).toContain("close endpoint returned 404");
  });

  it("BROKER_CONNECTION_FAILED — a broker/runtime error", () => {
    const text = formatAlert(makeEvent("BROKER_CONNECTION_FAILED", { reason: "invalid API key" }));
    expect(text).toContain("Broker error: connection failed");
    expect(text).toContain("invalid API key");
  });

  it("TRADING_CYCLE_FAILED — a runtime error", () => {
    const text = formatAlert(makeEvent("TRADING_CYCLE_FAILED", { message: "unexpected exception" }));
    expect(text).toContain("Runtime error: cycle failed");
    expect(text).toContain("unexpected exception");
  });

  it("returns undefined for every other event type — no alert noise for routine pipeline events", () => {
    expect(formatAlert(makeEvent("CANDLE_PROCESSED"))).toBeUndefined();
    expect(formatAlert(makeEvent("STRATEGY_LOADED"))).toBeUndefined();
    expect(formatAlert(makeEvent("TRADING_CYCLE_STARTED"))).toBeUndefined();
    expect(formatAlert(makeEvent("TRADE_APPROVED"))).toBeUndefined();
  });

  // Restart-Resilient Autonomy Phase — CLOSED_UNRECONCILED operator visibility (deployment safety
  // review: "emit a durable alert event whenever a lifecycle enters CLOSED_UNRECONCILED").
  it("BROKER_RECONCILIATION_MISMATCH — alerts when the resolution is 'reconciled-closed-unreconciled'", () => {
    const text = formatAlert(
      makeEvent("BROKER_RECONCILIATION_MISMATCH", { resolution: "reconciled-closed-unreconciled", lifecycleRecordId: "lifecycle-1" }),
    );
    expect(text).toContain("CLOSED_UNRECONCILED");
    expect(text).toContain("lifecycle-1");
  });

  // Prototype 1.0 — official Hermes Agent decision integration. "failed-closed" now ALSO alerts —
  // the general reconciliation-warning bullet the mission's own Phase 5 list requires — distinct
  // wording from the CLOSED_UNRECONCILED-specific message above, never conflated.
  it("BROKER_RECONCILIATION_MISMATCH — alerts with a general reconciliation warning for the 'failed-closed' resolution", () => {
    const text = formatAlert(makeEvent("BROKER_RECONCILIATION_MISMATCH", { resolution: "failed-closed", reason: "ambiguous broker state" }));
    expect(text).toContain("Reconciliation warning");
    expect(text).toContain("ambiguous broker state");
  });

  it("BROKER_RECONCILIATION_MISMATCH — returns undefined for any other/unknown resolution value", () => {
    expect(formatAlert(makeEvent("BROKER_RECONCILIATION_MISMATCH", { resolution: "some-future-resolution" }))).toBeUndefined();
  });
});

describe("formatAlert — Prototype 1.0 official Hermes Agent decision integration event types", () => {
  it("DUPLICATE_ENTRY_SUPPRESSED", () => {
    const text = formatAlert(makeEvent("DUPLICATE_ENTRY_SUPPRESSED", { reason: "already pending" }));
    expect(text).toContain("Duplicate suppressed");
    expect(text).toContain("already pending");
  });

  it("KILL_SWITCH_ENTRY_BLOCKED", () => {
    const text = formatAlert(makeEvent("KILL_SWITCH_ENTRY_BLOCKED", {}, "BTC"));
    expect(text).toContain("Kill switch active");
    expect(text).toContain("BTC");
  });

  it("TRADE_CANDIDATE_CREATED — candidate pending manual approval", () => {
    const text = formatAlert(makeEvent("TRADE_CANDIDATE_CREATED", { direction: "BUY", confidence: 0.82 }, "ETH"));
    expect(text).toContain("Candidate pending manual approval");
    expect(text).toContain("ETH");
    expect(text).toContain("BUY");
  });

  it("TRADE_CANDIDATE_AUTO_APPROVED — future AUTO_DEMO approval", () => {
    const text = formatAlert(makeEvent("TRADE_CANDIDATE_AUTO_APPROVED", {}, "ETH"));
    expect(text).toContain("auto-approved");
    expect(text).toContain("AUTO_DEMO");
  });

  it("AUTOMATIC_EXIT_TRIGGERED — stop-loss", () => {
    const text = formatAlert(makeEvent("AUTOMATIC_EXIT_TRIGGERED", { trigger: "STOP_LOSS" }, "BTC"));
    expect(text).toContain("Stop-loss triggered");
  });

  it("AUTOMATIC_EXIT_TRIGGERED — take-profit", () => {
    const text = formatAlert(makeEvent("AUTOMATIC_EXIT_TRIGGERED", { trigger: "TAKE_PROFIT" }, "BTC"));
    expect(text).toContain("Take-profit triggered");
  });

  it("AUTOMATIC_EXIT_TRIGGERED — kill switch close", () => {
    const text = formatAlert(makeEvent("AUTOMATIC_EXIT_TRIGGERED", { trigger: "KILL_SWITCH" }, "BTC"));
    expect(text).toContain("Kill switch");
  });

  it("UNIVERSE_SCAN_COMPLETED — scan summary", () => {
    const text = formatAlert(makeEvent("UNIVERSE_SCAN_COMPLETED", { eligibleInstrumentCount: 5, selectedProposalCount: 2 }));
    expect(text).toContain("Scan complete");
    expect(text).toContain("5");
    expect(text).toContain("2");
  });

  it("HERMES_PROPOSAL_SELECTED — Hermes opportunity identified", () => {
    const text = formatAlert(makeEvent("HERMES_PROPOSAL_SELECTED", { action: "BUY", confidence: 0.82 }, "ETH"));
    expect(text).toContain("Hermes opportunity selected");
    expect(text).toContain("ETH");
    expect(text).toContain("BUY");
  });

  it("HERMES_RESPONSE_REJECTED — Hermes proposal rejected as invalid", () => {
    const text = formatAlert(makeEvent("HERMES_RESPONSE_REJECTED", { reason: "unknown instrument DOGE" }));
    expect(text).toContain("Hermes proposal rejected as invalid");
    expect(text).toContain("unknown instrument DOGE");
  });

  it("DAILY_PORTFOLIO_SUMMARY", () => {
    const text = formatAlert(makeEvent("DAILY_PORTFOLIO_SUMMARY", { tradeCount: 3, realisedPnl: 42.5, openPositionCount: 1 }));
    expect(text).toContain("Daily summary");
    expect(text).toContain("3");
    expect(text).toContain("42.5");
  });

  it("every alert-worthy message clearly labels the account as DEMO", () => {
    const eventTypes: Array<[string, Record<string, unknown>]> = [
      ["TRADE_OPENED", { entryPrice: 100, brokerOrderId: "1" }],
      ["TRADE_CLOSED", { realisedPnl: 1, realisedPnlPercent: 1, exitReason: "x" }],
      ["UNIVERSE_SCAN_COMPLETED", {}],
      ["DAILY_PORTFOLIO_SUMMARY", {}],
    ];
    for (const [eventType, details] of eventTypes) {
      const text = formatAlert(makeEvent(eventType as never, details));
      expect(text).toMatch(/\[DEMO\]/);
    }
  });
});

describe("TelegramAlertingAuditTrail", () => {
  it("always forwards record() to the inner audit trail first, unchanged", async () => {
    const inner = new InMemoryAuditTrail();
    const alertSender = makeAlertSender();
    const decorated = new TelegramAlertingAuditTrail(inner, alertSender);
    const event = makeEvent("CANDLE_PROCESSED");

    await decorated.record(event);

    expect(await inner.getEvents()).toEqual([event]);
  });

  it("dispatches exactly one alert for an alert-worthy event", async () => {
    const inner = new InMemoryAuditTrail();
    const alertSender = makeAlertSender();
    const decorated = new TelegramAlertingAuditTrail(inner, alertSender);

    await decorated.record(makeEvent("TRADE_OPENED", { entryPrice: 100, brokerOrderId: "abc" }));

    expect(alertSender.sendAlert).toHaveBeenCalledOnce();
    expect(alertSender.sent[0]).toContain("Trade opened");
  });

  it("sends no alert for an event type not in the required list", async () => {
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
    const event = makeEvent("TRADING_RUNTIME_STARTED");

    await expect(decorated.record(event)).resolves.toBeUndefined();

    const events = await inner.getEvents();
    expect(events[0]).toEqual(event);
  });

  // Prototype 1.0 — Telegram observability. A delivery failure must be audited, not silently
  // swallowed — but must never throw into the caller (an order may have already succeeded).
  describe("TelegramAlertingAuditTrail — delivery-failure observability", () => {
    it("records a TELEGRAM_NOTIFICATION_FAILED event referencing the original event type and reason", async () => {
      const inner = new InMemoryAuditTrail();
      const alertSender = { sendAlert: vi.fn(async () => { throw new Error("Hermes gateway delivery failed: timeout") }) };
      const decorated = new TelegramAlertingAuditTrail(inner, alertSender);
      const event = makeEvent("TRADE_OPENED", { entryPrice: 100, brokerOrderId: "order-123" });

      await decorated.record(event);

      const events = await inner.getEvents();
      const failure = events.find((e) => e.eventType === "TELEGRAM_NOTIFICATION_FAILED");
      expect(failure).toBeDefined();
      expect(failure?.details.originalEventType).toBe("TRADE_OPENED");
      expect(failure?.details.reason).toContain("timeout");
    });

    it("includes the durable event ID (e.g. brokerOrderId) where the original event carries one", async () => {
      const inner = new InMemoryAuditTrail();
      const alertSender = { sendAlert: vi.fn(async () => { throw new Error("delivery failed") }) };
      const decorated = new TelegramAlertingAuditTrail(inner, alertSender);
      const event = makeEvent("TRADE_OPENED", { entryPrice: 100, brokerOrderId: "order-123" });

      await decorated.record(event);

      const failure = (await inner.getEvents()).find((e) => e.eventType === "TELEGRAM_NOTIFICATION_FAILED");
      expect(failure?.details.durableEventId).toBe("order-123");
    });

    it("never throws into the caller, even when a delivery failure occurs after an order has already succeeded", async () => {
      const inner = new InMemoryAuditTrail();
      const alertSender = { sendAlert: vi.fn(async () => { throw new Error("network unreachable") }) };
      const decorated = new TelegramAlertingAuditTrail(inner, alertSender);

      await expect(decorated.record(makeEvent("TRADE_OPENED", { entryPrice: 100, brokerOrderId: "order-1" }))).resolves.toBeUndefined();
    });

    it("never exposes a credential/token-shaped value in the recorded failure's own reason field", async () => {
      const inner = new InMemoryAuditTrail();
      // Simulates an underlying error whose message happens to be safe/bounded (as
      // HermesGatewayDeliveryError/TelegramApiError both are by construction) — this test
      // documents that the reason recorded here is exactly `error.message`, never anything else
      // (e.g. never the full Error object, its stack, or any raw request/response data).
      const alertSender = { sendAlert: vi.fn(async () => { throw new Error("Hermes gateway delivery failed: non-zero-exit") }) };
      const decorated = new TelegramAlertingAuditTrail(inner, alertSender);

      await decorated.record(makeEvent("TRADE_OPENED", { entryPrice: 100, brokerOrderId: "order-1" }));

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

      await expect(decorated.record(makeEvent("TRADE_OPENED", { entryPrice: 100, brokerOrderId: "order-1" }))).resolves.toBeUndefined();
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
