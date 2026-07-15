import "server-only";

// Mirrors market-universe/logger.ts's exact shape and rationale: kept separate from
// src/worker/logger.ts's closed WorkerLogEvent union, since this service's own refresh cycle (a
// future, standalone job — Sprint 294 §1) and the worker's read path will both need to log these
// events, independent of the worker's own event vocabulary. Sprint 295 only ever emits the first
// two events below — no shortlist data is emitted because none exists yet.
export type MarketScreeningLogEvent = "market_screening_disabled" | "market_screening_provider_unavailable";

export function log(event: MarketScreeningLogEvent, details?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const detail = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[market-screening] ${timestamp} ${event}${detail}`);
}
