import { BrokerFactory } from "@/lib/hermes-execution/broker-factory";
import { EtoroDemoBroker } from "@/lib/hermes-execution/etoro/etoro-demo-broker";
import type { AuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { HermesExecutionConfig } from "@/lib/hermes-execution/config";

// Phase 0 — eToro instrument capability probe. Small, shared piece pulled out of
// broker-etoro-smoke.ts (Stage 4) so it and etoro-instrument-probe.ts (read-only Stages 1-3) never
// drift on the one thing both genuinely need identically: "is this process even safely allowed to
// talk to eToro Demo at all." Deliberately narrow — testInstrument/testAmount validation stays in
// broker-etoro-smoke.ts alone, since a read-only probe needs neither.

export interface EtoroDemoConfigCheck {
  ok: boolean;
  /** Present only when `ok` is false — a human-readable reason safe to print directly. */
  reason?: string;
}

/**
 * The two checks every eToro CLI tool needs before even attempting to connect: demo-only, and
 * credentials present. `BrokerFactory.create` re-validates both of these itself regardless (see its
 * own "etoro-demo" constructor) — this exists purely so a misconfigured run fails with a clear,
 * dedicated message before a generic thrown error, not as the only enforcement of either rule.
 */
export function checkEtoroDemoConfig(config: HermesExecutionConfig): EtoroDemoConfigCheck {
  if (config.etoro.env !== "demo") {
    return { ok: false, reason: 'ETORO_ENV must be exactly "demo" — no live/real route is ever selected by any eToro CLI tool.' };
  }
  if (!config.etoro.apiKey || !config.etoro.userKey) {
    return { ok: false, reason: "ETORO_API_KEY and ETORO_USER_KEY must both be set." };
  }
  return { ok: true };
}

/**
 * Connects to eToro Demo via the shared BrokerFactory path — identical to how every eToro CLI tool
 * has always done it. The cast is safe because an explicit `provider` is requested, so the concrete
 * type BrokerFactory returns is guaranteed to be EtoroDemoBroker.
 */
export async function connectEtoroDemoBroker(
  config: HermesExecutionConfig,
  auditTrail: AuditTrail,
  executionRunId: string,
): Promise<EtoroDemoBroker> {
  return (await BrokerFactory.create(config, auditTrail, executionRunId, { provider: "etoro-demo" })) as EtoroDemoBroker;
}
