import "server-only";

// Simple structured logging only, per the mission spec — one line per lifecycle event, not a
// logging framework. Each line is human-readable (timestamp + event name) with an optional JSON
// details blob, so it's greppable in a plain VPS log file (journalctl, pm2 logs, a redirected
// stdout file) without needing a log aggregator to make sense of it.
export type WorkerLogEvent =
  | "worker_started"
  | "poll_started"
  | "no_schedules_due"
  | "schedule_found"
  | "lock_acquired"
  | "lock_skipped"
  | "scan_executed"
  | "trade_opened"
  | "decision_records_stored"
  | "lock_released"
  | "scan_failed"
  | "poll_failed"
  | "outcomes_reconciled"
  | "reconcile_failed"
  | "historical_data_status"
  | "market_universe_summary"
  | "market_universe_summary_failed"
  | "worker_finished";

export function log(event: WorkerLogEvent, details?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const detail = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[worker] ${timestamp} ${event}${detail}`);
}
