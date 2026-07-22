import type { MarketDecisionAction } from "@/lib/hermes-execution/market-decision-engine";

// Hermes Integration API v1. Pure, dependency-free query-parameter validators — reject-with-a-
// reason rather than silently coercing a bad value to a default, matching this codebase's existing
// config-parsing convention (parseInteger/parseEnum in lib/config/env.ts) applied to request query
// parameters instead of environment variables.

export type QueryValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

export const DEFAULT_DECISIONS_LIMIT = 20;
export const MAX_DECISIONS_LIMIT = 100;

export function parseLimitParam(raw: string | null): QueryValidationResult<number> {
  if (raw === null || raw === "") return { ok: true, value: DEFAULT_DECISIONS_LIMIT };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, message: `"limit" must be a positive integer, received "${raw}".` };
  }
  if (parsed > MAX_DECISIONS_LIMIT) {
    return { ok: false, message: `"limit" must not exceed ${MAX_DECISIONS_LIMIT}, received ${parsed}.` };
  }
  return { ok: true, value: parsed };
}

/** Normalises to a full-precision UTC ISO string (`Date.prototype.toISOString()`) so it can be
 * compared as a plain string against audit-event timestamps — see HermesDecisionFilters' own doc
 * comment in audit-derivations.ts for why that's safe. */
export function parseSinceParam(raw: string | null): QueryValidationResult<string | undefined> {
  if (raw === null || raw === "") return { ok: true, value: undefined };
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, message: `"since" must be a valid ISO 8601 date/time, received "${raw}".` };
  }
  return { ok: true, value: date.toISOString() };
}

const VALID_OUTCOMES: readonly MarketDecisionAction[] = ["BUY", "SELL", "HOLD"];

export function parseOutcomeParam(raw: string | null): QueryValidationResult<MarketDecisionAction | undefined> {
  if (raw === null || raw === "") return { ok: true, value: undefined };
  const upper = raw.toUpperCase();
  if (!(VALID_OUTCOMES as readonly string[]).includes(upper)) {
    return { ok: false, message: `"outcome" must be one of ${VALID_OUTCOMES.join(", ")}, received "${raw}".` };
  }
  return { ok: true, value: upper as MarketDecisionAction };
}

export function parseSymbolParam(raw: string | null): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}
