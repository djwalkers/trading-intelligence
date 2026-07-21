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
    expect(formatAlert(makeEvent("TRADING_RUNTIME_STARTED"))).toBe("Runtime started.");
  });

  it("TRADING_RUNTIME_STOPPED — plain stop", () => {
    expect(formatAlert(makeEvent("TRADING_RUNTIME_STOPPED", { timedOut: false }))).toBe("Runtime stopped.");
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

    expect(await inner.getEvents()).toEqual([event]);
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
