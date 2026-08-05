import { logger } from "@/lib/logger/logger";

// Egress-containment fix — lightweight, non-sensitive observability for the exact query shapes the
// production incident investigation needed and didn't have: per-call operation name, table, duration,
// returned row count (where available), whether it was a count-only query, and error status. Never
// logs credentials, access tokens, row contents, market snapshots, or trade reasoning — every field
// below is metadata ABOUT a query, never data FROM one. Reuses the existing logger (src/lib/logger)
// rather than introducing a second logging mechanism — "debug" for successful calls (visible in dev/
// test, intentionally dropped in production by logger.ts's own convention, keeping this genuinely
// lightweight), "warn" for failures (always visible — an unexpected persistence error is never
// routine noise).

export interface QueryTelemetryEvent {
  /** e.g. "countConfirmedEntriesForUtcDay", "listActiveLifecycleRecords". */
  operation: string;
  table: string;
  durationMs: number;
  /** Number of rows returned/matched, where known. Omitted (not 0) when not applicable, e.g. a
   * write that returns no rows. */
  rowCount?: number;
  /** True for a `count: "exact", head: true` query — no rows were ever transferred, only a count. */
  countOnly: boolean;
  ok: boolean;
  errorCode?: string;
}

export function recordQueryTelemetry(event: QueryTelemetryEvent): void {
  const context = {
    component: "supabase-query",
    table: event.table,
    durationMs: event.durationMs,
    rowCount: event.rowCount,
    countOnly: event.countOnly,
    errorCode: event.errorCode,
  };
  if (event.ok) {
    logger.debug(`Supabase query "${event.operation}" completed`, context);
  } else {
    logger.warn(`Supabase query "${event.operation}" failed`, context);
  }
}

/** Wraps a single Supabase call with duration timing and telemetry emission — `fn` reports its own
 * rowCount (a `.select("*")`'s data.length, a `count: exact` head query's own `count`, etc.) since
 * that shape differs per call; this helper only owns timing + success/failure + emission. */
export async function withQueryTelemetry<T>(
  meta: { operation: string; table: string; countOnly?: boolean },
  fn: () => Promise<{ result: T; rowCount?: number }>,
): Promise<T> {
  const startedAtMs = Date.now();
  try {
    const { result, rowCount } = await fn();
    recordQueryTelemetry({
      operation: meta.operation,
      table: meta.table,
      durationMs: Date.now() - startedAtMs,
      rowCount,
      countOnly: meta.countOnly ?? false,
      ok: true,
    });
    return result;
  } catch (error) {
    recordQueryTelemetry({
      operation: meta.operation,
      table: meta.table,
      durationMs: Date.now() - startedAtMs,
      countOnly: meta.countOnly ?? false,
      ok: false,
      errorCode: error instanceof Error ? error.name : undefined,
    });
    throw error;
  }
}
