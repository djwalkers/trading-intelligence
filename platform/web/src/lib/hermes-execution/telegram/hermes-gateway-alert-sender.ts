import { buildHermesCliEnv, buildHermesNeutralCwd } from "../hermes-agent/build-hermes-cli-isolation";
import type { HermesCliRunner } from "../hermes-agent/hermes-cli-runner";
import type { AlertSender } from "./telegram-alerting-audit-trail";

// Prototype 1.0 — Hermes Telegram gateway bridge. Reuses the ALREADY-PROVEN, already-configured
// official Hermes Agent Telegram gateway (running as `hermes-gateway.service` on the VPS) for
// every outbound trading notification, instead of a second Telegram bot. Confirmed exact
// invocation:
//
//     <cliPath> send --to "<target>" "<message>" --json
//
// `hermes send` is documented as a thin, no-LLM, no-agent-loop wrapper that reuses the gateway's
// own already-configured platform credentials — this app never holds a Telegram bot token or
// chat id of its own for this path. Implements the EXISTING `AlertSender` interface
// (telegram-alerting-audit-trail.ts) unchanged — TelegramAlertingAuditTrail's own event-formatting
// logic (formatAlert) is reused verbatim; only which AlertSender it is constructed with changes.
// Spawned with the same isolation discipline as the decision adapter (neutral cwd, minimal env
// allow-list, no shell) — this app's own broker/Supabase/integration-token secrets must never
// reach ANY subprocess it spawns, not only the decision one.

export interface HermesGatewayAlertSenderConfig {
  cliPath: string;
  telegramTarget: string;
  sendTimeoutMs: number;
}

const MAX_STDOUT_BYTES_FOR_SEND = 8_192; // `hermes send --json` returns a small confirmation payload
const DEDUPE_CACHE_MAX_ENTRIES = 500;

/** Thrown by sendAlert() on any delivery failure — deliberately a clear, bounded, own-constructed
 * message (never the raw stderr/child_process error verbatim), matching AlertSender's own existing
 * "a failure is signalled by throwing" convention (see TelegramBot.sendAlert(), which throws
 * identically on a transport failure) — TelegramAlertingAuditTrail's own record() already wraps
 * every sendAlert() call in a try/catch for exactly this reason, and now additionally records a
 * redacted failure fact rather than silently swallowing it (see that file's own doc comment). */
export class HermesGatewayDeliveryError extends Error {
  constructor(reason: string) {
    super(`Hermes gateway delivery failed: ${reason}`);
    this.name = "HermesGatewayDeliveryError";
  }
}

/**
 * Sends one outbound alert through the official Hermes Agent gateway via a bounded `hermes send`
 * subprocess call. A delivery failure THROWS a HermesGatewayDeliveryError (never a raw
 * child_process/CLI error) — the caller (TelegramAlertingAuditTrail) already catches this and
 * never lets it propagate into broker execution; this class does not need a second safety net of
 * its own, but never silently discards the failure either.
 *
 * In-process, best-effort duplicate suppression: an exact repeat of a message already sent this
 * process's lifetime is skipped rather than re-sent — covers retries within a single run. This is
 * NOT durable across a restart (no persisted dedupe store exists without a migration — see the
 * mission's own "prefer no migration" instruction); a genuine restart may re-send a message whose
 * underlying event fired again after the previous process's own audit trail was lost. Documented,
 * not silently assumed away.
 */
export class HermesGatewayAlertSender implements AlertSender {
  private readonly sentMessages = new Set<string>();

  constructor(
    private readonly config: HermesGatewayAlertSenderConfig,
    private readonly runner: HermesCliRunner,
  ) {}

  async sendAlert(text: string): Promise<void> {
    if (this.sentMessages.has(text)) return;

    const result = await this.runner.run(this.config.cliPath, ["send", "--to", this.config.telegramTarget, text, "--json"], {
      timeoutMs: this.config.sendTimeoutMs,
      maxStdoutBytes: MAX_STDOUT_BYTES_FOR_SEND,
      cwd: buildHermesNeutralCwd(),
      env: buildHermesCliEnv(),
    });

    if (!result.ok) {
      throw new HermesGatewayDeliveryError(result.reason);
    }

    this.rememberSent(text);
  }

  private rememberSent(text: string): void {
    if (this.sentMessages.size >= DEDUPE_CACHE_MAX_ENTRIES) {
      // Bounded, simple eviction — oldest-inserted entry first (Map/Set iteration order is
      // insertion order in JS) — never lets this cache grow unbounded across a long-running
      // process.
      const oldest = this.sentMessages.values().next().value;
      if (oldest !== undefined) this.sentMessages.delete(oldest);
    }
    this.sentMessages.add(text);
  }
}
