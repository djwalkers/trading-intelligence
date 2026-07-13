import "server-only";

// Mirrors src/worker/logger.ts's exact shape — one greppable line per lifecycle event, no logging
// framework. Kept separate from the worker's logger (rather than reusing its closed WorkerLogEvent
// union) since this module is shared by both the standalone refresh CLI and the worker's read path,
// independent of the worker's own event vocabulary.
export type MarketUniverseLogEvent =
  | "refresh_started"
  | "listing_source_downloaded"
  | "universe_diffed"
  | "price_check_batch_selected"
  | "price_check_completed"
  | "refresh_completed"
  | "refresh_failed"
  | "universe_empty";

export function log(event: MarketUniverseLogEvent, details?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const detail = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[market-universe] ${timestamp} ${event}${detail}`);
}
