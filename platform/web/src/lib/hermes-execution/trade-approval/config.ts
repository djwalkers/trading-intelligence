import { parseInteger } from "@/lib/config/env";

// Phase 3.5 — Trade Review & Approval. Its own small config module, same "independently removable
// pipeline concern" reasoning analysis-persistence-config.ts and config.ts's own top-of-file
// comment already give for staying separate from the main HermesExecutionConfig.

export interface TradeApprovalConfig {
  /** How long a PENDING or APPROVED-but-not-yet-executed candidate remains valid before the next
   * runtime cycle marks it EXPIRED instead of executing it at a now-stale entryPrice. Defaults to
   * 20 minutes — long enough for a human to notice and act, short enough that an approved order
   * never fires against a materially stale market snapshot. */
  expiryMs: number;
}

const DEFAULT_EXPIRY_MINUTES = 20;

export function buildTradeApprovalConfig(
  env: { HERMES_TRADE_CANDIDATE_EXPIRY_MINUTES: string | undefined } = {
    HERMES_TRADE_CANDIDATE_EXPIRY_MINUTES: process.env.HERMES_TRADE_CANDIDATE_EXPIRY_MINUTES,
  },
): TradeApprovalConfig {
  const expiryMinutes = parseInteger(env.HERMES_TRADE_CANDIDATE_EXPIRY_MINUTES, DEFAULT_EXPIRY_MINUTES, { min: 1 });
  return { expiryMs: expiryMinutes * 60_000 };
}
