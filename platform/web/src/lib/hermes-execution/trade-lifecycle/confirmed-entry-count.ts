import type { TradeLifecycleRecord, TradeLifecycleStatus } from "./types";

// Egress-containment fix (production incident: Supabase egress ~800% over the Free-plan quota,
// traced to countConfirmedEntriesForUtcDay's callers downloading the ENTIRE trade_lifecycle_records
// table — every JSONB `detail` blob included — on every runtime cycle just to compute a UTC-day
// count). This module is the single source of truth for BOTH the pure, records-based semantics
// (still used directly by InMemoryTradeLifecycleStore and by trade-lifecycle-service.ts's own
// backward-compatible free function) and the UTC-day boundary math a bounded, server-side
// count/filter query needs to express the identical window. Extracted to its own file (rather than
// living in trade-lifecycle-store.ts or trade-lifecycle-service.ts) specifically so
// trade-lifecycle-store.ts can import it without a circular dependency back onto
// trade-lifecycle-service.ts (which itself imports TradeLifecycleStore's type).

/** A record whose `status` durably proves it reached (or passed through) a confirmed OPEN position
 * at some point — the ONLY records `openedAt` is ever set on (see TradeLifecycleService.recordOpened).
 * A later terminal status (CLOSED/CLOSE_FAILED/CLOSED_UNRECONCILED) never erases the fact that
 * today's new-entry allowance was already spent opening it. */
export const EVER_REACHED_OPEN_STATUSES: readonly TradeLifecycleStatus[] = ["OPEN", "CLOSE_REQUESTED", "CLOSED", "CLOSE_FAILED", "CLOSED_UNRECONCILED"];

export interface ConfirmedEntryCountScope {
  strategyId: string;
}

/** The bounded, store-level equivalent of ConfirmedEntryCountScope + a `now` — an explicit,
 * already-computed UTC-day window a store implementation can push straight into a WHERE clause
 * (`opened_at >= startInclusive AND opened_at < endExclusive`), never re-deriving "today" from its
 * own clock. */
export interface ConfirmedEntryCountRangeScope {
  strategyId: string;
  /** ISO 8601, inclusive — this UTC day's own midnight. */
  startInclusive: string;
  /** ISO 8601, exclusive — the NEXT UTC day's own midnight. */
  endExclusive: string;
}

/** Start inclusive at `now`'s own UTC midnight, end exclusive at the NEXT UTC midnight — the exact
 * window countConfirmedEntriesForUtcDay has always used, now exposed standalone so a runtime/CLI
 * caller can compute it once and hand it to a store's bounded query, rather than the store (or a
 * pure records array) ever needing its own notion of "now". */
export function utcDayBoundaries(now: Date): { startInclusive: string; endExclusive: string } {
  const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  return { startInclusive: new Date(dayStartMs).toISOString(), endExclusive: new Date(dayEndMs).toISOString() };
}

/**
 * Records-based core of countConfirmedEntriesForUtcDay, taking an already-computed [startInclusive,
 * endExclusive) window instead of `now` — see trade-lifecycle-service.ts's own countConfirmedEntries-
 * ForUtcDay for the full semantics doc (identical here; that function now delegates to this one via
 * utcDayBoundaries). Used directly by InMemoryTradeLifecycleStore, which has no egress cost to
 * bound — it can always afford to filter its own in-process records.
 *
 * Fails closed: a record whose `status` PROVES it reached OPEN (EVER_REACHED_OPEN_STATUSES) but has
 * a missing or unparseable `openedAt` throws immediately rather than silently under-counting.
 */
export function countConfirmedEntriesForUtcDayFromRecords(
  records: readonly TradeLifecycleRecord[],
  scope: ConfirmedEntryCountRangeScope,
): number {
  const startMs = Date.parse(scope.startInclusive);
  const endMs = Date.parse(scope.endExclusive);

  let count = 0;
  for (const record of records) {
    if (record.strategyId !== scope.strategyId) continue;

    if (record.openedAt === undefined) {
      if (EVER_REACHED_OPEN_STATUSES.includes(record.status)) {
        throw new Error(
          `TradeLifecycleRecord "${record.id}" has status "${record.status}" (which requires having reached a confirmed OPEN ` +
            `position) but no openedAt — cannot safely compute today's confirmed-entry count. Refusing to silently under-count.`,
        );
      }
      continue; // never reached OPEN — correctly excluded, not an error.
    }

    const openedMs = Date.parse(record.openedAt);
    if (!Number.isFinite(openedMs)) {
      throw new Error(
        `TradeLifecycleRecord "${record.id}" has an unparseable openedAt "${record.openedAt}" — cannot safely compute today's ` +
          `confirmed-entry count. Refusing to silently under-count.`,
      );
    }

    if (openedMs >= startMs && openedMs < endMs) count++;
  }
  return count;
}
