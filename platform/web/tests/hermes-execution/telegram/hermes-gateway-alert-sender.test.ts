import { describe, expect, it } from "vitest";
import { HermesGatewayAlertSender, HermesGatewayDeliveryError } from "@/lib/hermes-execution/telegram/hermes-gateway-alert-sender";
import { TelegramAlertingAuditTrail } from "@/lib/hermes-execution/telegram/telegram-alerting-audit-trail";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { AuditEvent } from "@/lib/hermes-execution/types";
import type { HermesCliRunner, HermesCliRunResult } from "@/lib/hermes-execution/hermes-agent/hermes-cli-runner";

// Prototype 1.0 — Hermes Telegram gateway bridge. Every test uses a FAKE HermesCliRunner — no real
// `hermes send` call, no real Telegram message, ever, in this file.

const CONFIG = { cliPath: "/home/andy/.local/bin/hermes", telegramTarget: 'telegram:Andrew Walker', sendTimeoutMs: 15_000 };

class FakeRunner implements HermesCliRunner {
  public calls: Array<{ cliPath: string; args: string[] }> = [];
  constructor(private readonly result: HermesCliRunResult = { ok: true, stdout: '{"delivered":true}' }) {}
  async run(cliPath: string, args: string[]): Promise<HermesCliRunResult> {
    this.calls.push({ cliPath, args });
    return this.result;
  }
}

describe("HermesGatewayAlertSender — uses the exact confirmed gateway invocation", () => {
  it("calls `hermes send --to \"<target>\" \"<message>\" --json`", async () => {
    const runner = new FakeRunner();
    const sender = new HermesGatewayAlertSender(CONFIG, runner);
    await sender.sendAlert("Trade opened: BTC @ 50000 (order abc). [DEMO]");

    expect(runner.calls).toHaveLength(1);
    const [call] = runner.calls;
    expect(call?.cliPath).toBe(CONFIG.cliPath);
    expect(call?.args).toEqual(["send", "--to", "telegram:Andrew Walker", "Trade opened: BTC @ 50000 (order abc). [DEMO]", "--json"]);
  });
});

describe("HermesGatewayAlertSender — no credentials in payload or args", () => {
  it("never includes a bot token or credential-shaped value in the arguments it constructs", async () => {
    const runner = new FakeRunner();
    const sender = new HermesGatewayAlertSender(CONFIG, runner);
    await sender.sendAlert("Broker error: connection failed — 401 Unauthorized. [DEMO]");

    const allArgsJoined = runner.calls.flatMap((c) => c.args).join(" ");
    expect(allArgsJoined).not.toMatch(/bot\d+:[A-Za-z0-9_-]{20,}/);
    expect(allArgsJoined).not.toMatch(/api[_-]?key/i);
  });
});

describe("HermesGatewayAlertSender — duplicate suppression", () => {
  it("does not resend an exact-duplicate message within the same process lifetime", async () => {
    const runner = new FakeRunner();
    const sender = new HermesGatewayAlertSender(CONFIG, runner);
    await sender.sendAlert("Position closed: BTC. [DEMO]");
    await sender.sendAlert("Position closed: BTC. [DEMO]");
    expect(runner.calls).toHaveLength(1);
  });

  it("still sends a genuinely different message", async () => {
    const runner = new FakeRunner();
    const sender = new HermesGatewayAlertSender(CONFIG, runner);
    await sender.sendAlert("Position closed: BTC. [DEMO]");
    await sender.sendAlert("Position closed: ETH. [DEMO]");
    expect(runner.calls).toHaveLength(2);
  });
});

describe("HermesGatewayAlertSender — fails observably (throws a clear, bounded error) rather than being silently swallowed", () => {
  it("throws a HermesGatewayDeliveryError when the CLI call times out", async () => {
    const runner = new FakeRunner({ ok: false, reason: "timeout", stderrExcerpt: "" });
    const sender = new HermesGatewayAlertSender(CONFIG, runner);
    await expect(sender.sendAlert("Runtime started. [DEMO]")).rejects.toBeInstanceOf(HermesGatewayDeliveryError);
  });

  it("throws a HermesGatewayDeliveryError when the CLI exits non-zero", async () => {
    const runner = new FakeRunner({ ok: false, reason: "non-zero-exit", exitCode: 1, stderrExcerpt: "gateway not running" });
    const sender = new HermesGatewayAlertSender(CONFIG, runner);
    await expect(sender.sendAlert("Runtime started. [DEMO]")).rejects.toBeInstanceOf(HermesGatewayDeliveryError);
  });

  it("never includes raw stderr/credential-shaped content in the thrown error's own message", async () => {
    const runner = new FakeRunner({ ok: false, reason: "non-zero-exit", exitCode: 1, stderrExcerpt: "some internal detail, never surfaced" });
    const sender = new HermesGatewayAlertSender(CONFIG, runner);
    try {
      await sender.sendAlert("Runtime started. [DEMO]");
      throw new Error("expected sendAlert to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HermesGatewayDeliveryError);
      expect((error as Error).message).not.toContain("some internal detail");
    }
  });

  it("a failed send is not remembered — a later retry of the same text is still attempted", async () => {
    let attempt = 0;
    const flakyRunner: HermesCliRunner = {
      run: async () => {
        attempt += 1;
        return attempt === 1 ? { ok: false, reason: "timeout", stderrExcerpt: "" } : { ok: true, stdout: "{}" };
      },
    };
    const sender = new HermesGatewayAlertSender(CONFIG, flakyRunner);
    await expect(sender.sendAlert("Kill switch active: entry blocked. [DEMO]")).rejects.toThrow();
    await sender.sendAlert("Kill switch active: entry blocked. [DEMO]");
    expect(attempt).toBe(2);
  });
});

// Telegram alert-activation design fix. Wires the REAL production path — TelegramAlertingAuditTrail
// + HermesGatewayAlertSender, exactly as market-runtime.ts constructs it when
// config.hermesAgent.telegramGatewayAlertsEnabled is true — never config.telegram.enabled, and never
// any bot token or chat id, proving the outbound alert path genuinely needs no direct Telegram Bot
// API credential of any kind.
function makeEvent(eventType: AuditEvent["eventType"], details: Record<string, unknown> = {}): AuditEvent {
  return { timestamp: "2026-01-01T00:00:00.000Z", eventType, executionRunId: "test-run", instrument: "BTC", details };
}

describe("TelegramAlertingAuditTrail + HermesGatewayAlertSender — the real gateway-alerts wiring (Telegram alert-activation design fix)", () => {
  const TRADE_OPENED_DETAILS = {
    entryPrice: 50_000,
    brokerOrderId: "order-123",
    brokerPositionId: "pos-123",
    side: "BUY",
    quantity: 10,
    sizingMode: "NOTIONAL",
    openedAt: "2026-01-01T00:00:00.000Z",
  };
  const TRADE_CLOSED_DETAILS = {
    entryPrice: 46_000,
    exitPrice: 50_000,
    realisedPnl: 42.5,
    realisedPnlPercent: 8.5,
    exitReason: "automatic-exit-take_profit",
    closedAt: "2026-01-01T01:00:00.000Z",
  };

  it("TRADE_OPENED triggers exactly one `hermes send` call through the gateway sender", async () => {
    const runner = new FakeRunner();
    const alertSender = new HermesGatewayAlertSender(CONFIG, runner);
    const auditTrail = new TelegramAlertingAuditTrail(new InMemoryAuditTrail(), alertSender);

    await auditTrail.record(makeEvent("TRADE_OPENED", TRADE_OPENED_DETAILS));

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.args.join(" ")).toContain("TRADE OPENED");
  });

  it("TRADE_CLOSED triggers exactly one `hermes send` call through the gateway sender", async () => {
    const runner = new FakeRunner();
    const alertSender = new HermesGatewayAlertSender(CONFIG, runner);
    const auditTrail = new TelegramAlertingAuditTrail(new InMemoryAuditTrail(), alertSender);

    await auditTrail.record(makeEvent("TRADE_CLOSED", TRADE_CLOSED_DETAILS));

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.args.join(" ")).toContain("TRADE CLOSED");
  });

  it("a gateway delivery failure never blocks or throws into the caller — the original event is still durably recorded", async () => {
    const failingRunner: HermesCliRunner = {
      run: async () => ({ ok: false, reason: "non-zero-exit", exitCode: 1, stderrExcerpt: "gateway not running" }),
    };
    const alertSender = new HermesGatewayAlertSender(CONFIG, failingRunner);
    const inner = new InMemoryAuditTrail();
    const auditTrail = new TelegramAlertingAuditTrail(inner, alertSender);

    await expect(
      auditTrail.record(makeEvent("TRADE_OPENED", { ...TRADE_OPENED_DETAILS, brokerOrderId: "order-456", brokerPositionId: "pos-456" })),
    ).resolves.toBeUndefined();

    const events = await inner.getEvents();
    expect(events.find((e) => e.eventType === "TRADE_OPENED")).toBeDefined();
    const failure = events.find((e) => e.eventType === "TELEGRAM_NOTIFICATION_FAILED");
    expect(failure).toBeDefined();
    expect(failure?.details.durableEventId).toBe("order-456");
  });
});
