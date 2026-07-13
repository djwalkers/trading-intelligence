import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RawListingRow, UniverseSymbolRow } from "./types";
import { diffUniverseSnapshot, type DiffBuckets } from "./diff-universe-snapshot";
import { computeEligibility, computeListingExclusion } from "./eligibility";
import { STALE_PRICE_CHECK_DAYS, getPriceProviderName } from "./price-eligibility";
import type { PriceCheckResult } from "./price-eligibility";

// Bulk writes are chunked at this size — a conservative default (no hard documented row cap on
// Supabase/PostgREST upserts, but no existing precedent in this codebase for writes at this scale
// either) that also bounds how much work a mid-run failure loses: already-committed chunks stay
// committed, and a refresh re-run is idempotent by design, so a partial failure self-heals on the
// next scheduled run rather than needing special recovery code.
const WRITE_CHUNK_SIZE = 500;

const TABLE = "market_universe_symbols";

interface SymbolRowDb {
  symbol: string;
  company_name: string;
  exchange: string;
  instrument_type: string;
  classification_method: string;
  is_etf: boolean;
  is_test_issue: boolean;
  is_active: boolean;
  price_assessment_status: string;
  last_price: number | null;
  last_price_checked_at: string | null;
  last_change_absolute: number | null;
  last_change_percent: number | null;
  last_day_high: number | null;
  last_day_low: number | null;
  price_provider: string | null;
  is_eligible: boolean;
  exclusion_reason: string | null;
  data_source: string;
  source_timestamp: string;
  first_seen_at: string;
  last_seen_at: string;
  delisted_at: string | null;
}

function toDbRow(row: UniverseSymbolRow): SymbolRowDb {
  return {
    symbol: row.symbol,
    company_name: row.companyName,
    exchange: row.exchange,
    instrument_type: row.instrumentType,
    classification_method: row.classificationMethod,
    is_etf: row.isEtf,
    is_test_issue: row.isTestIssue,
    is_active: row.isActive,
    price_assessment_status: row.priceAssessmentStatus,
    last_price: row.lastPrice,
    last_price_checked_at: row.lastPriceCheckedAt,
    last_change_absolute: row.lastChangeAbsolute,
    last_change_percent: row.lastChangePercent,
    last_day_high: row.lastDayHigh,
    last_day_low: row.lastDayLow,
    price_provider: row.priceProvider,
    is_eligible: row.isEligible,
    exclusion_reason: row.exclusionReason,
    data_source: row.dataSource,
    source_timestamp: row.sourceTimestamp,
    first_seen_at: row.firstSeenAt,
    last_seen_at: row.lastSeenAt,
    delisted_at: row.delistedAt,
  };
}

function fromDbRow(row: SymbolRowDb): UniverseSymbolRow {
  return {
    symbol: row.symbol,
    companyName: row.company_name,
    exchange: row.exchange as UniverseSymbolRow["exchange"],
    instrumentType: row.instrument_type as UniverseSymbolRow["instrumentType"],
    classificationMethod: row.classification_method as UniverseSymbolRow["classificationMethod"],
    isEtf: row.is_etf,
    isTestIssue: row.is_test_issue,
    isActive: row.is_active,
    priceAssessmentStatus: row.price_assessment_status as UniverseSymbolRow["priceAssessmentStatus"],
    lastPrice: row.last_price === null ? null : Number(row.last_price),
    lastPriceCheckedAt: row.last_price_checked_at,
    lastChangeAbsolute: row.last_change_absolute === null ? null : Number(row.last_change_absolute),
    lastChangePercent: row.last_change_percent === null ? null : Number(row.last_change_percent),
    lastDayHigh: row.last_day_high === null ? null : Number(row.last_day_high),
    lastDayLow: row.last_day_low === null ? null : Number(row.last_day_low),
    priceProvider: row.price_provider,
    isEligible: row.is_eligible,
    exclusionReason: row.exclusion_reason as UniverseSymbolRow["exclusionReason"],
    dataSource: row.data_source,
    sourceTimestamp: row.source_timestamp,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    delistedAt: row.delisted_at,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// PostgREST caps any single response at a project-configured max-rows limit (confirmed live: this
// project's default silently truncates an unqualified `.select("*")` to 1,000 rows, well below the
// full ~8,800-symbol universe) — an unbounded select here would corrupt exactly the property this
// whole module depends on: diffUniverseSnapshot needs every existing row to correctly distinguish
// "new" from "already known," and a truncated read would make most of the universe look new on
// every single refresh, silently breaking idempotency. `.range()` in a loop, one PAGE_SIZE page at
// a time until a short page signals the end, is what makes an unbounded-row-count read genuinely
// unbounded, regardless of what the project's PostgREST config happens to be.
const PAGE_SIZE = 1000;

export async function getAllUniverseRows(client: SupabaseClient): Promise<UniverseSymbolRow[]> {
  const rows: SymbolRowDb[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client.from(TABLE).select("*").range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as SymbolRowDb[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows.map(fromDbRow);
}

export async function getEligibleUniverseRows(client: SupabaseClient): Promise<UniverseSymbolRow[]> {
  const rows: SymbolRowDb[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from(TABLE)
      .select("*")
      .eq("is_eligible", true)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as SymbolRowDb[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows.map(fromDbRow);
}

// Applies a full refresh: fetches the current state, diffs it against today's downloaded snapshot
// (diff-universe-snapshot.ts, pure and independently unit-tested), then executes exactly the
// writes that diff calls for — the expensive multi-column upsert only ever touches rows that
// genuinely changed; unchanged rows get a single cheap bulk last_seen_at touch, never a full
// rewrite. Returns the same DiffBuckets the caller needs for refresh-log statistics.
export async function upsertUniverseSnapshot(
  client: SupabaseClient,
  snapshot: Map<string, RawListingRow>,
  now: string,
  dataSource: string,
  sourceTimestamp: string,
): Promise<DiffBuckets> {
  const existingRows = await getAllUniverseRows(client);
  const diff = diffUniverseSnapshot({ existingRows, snapshot, now, dataSource, sourceTimestamp });

  for (const batch of chunk(diff.newRows, WRITE_CHUNK_SIZE)) {
    const { error } = await client
      .from(TABLE)
      .upsert(
        batch.map((row) => ({ ...toDbRow(row), updated_at: now })),
        { onConflict: "symbol" },
      );
    if (error) throw new Error(error.message);
  }

  for (const batch of chunk(diff.changedRows, WRITE_CHUNK_SIZE)) {
    const { error } = await client
      .from(TABLE)
      .upsert(
        batch.map((row) => ({ ...toDbRow(row), updated_at: now })),
        { onConflict: "symbol" },
      );
    if (error) throw new Error(error.message);
  }

  for (const batch of chunk(diff.delistedSymbols, WRITE_CHUNK_SIZE)) {
    const { error } = await client
      .from(TABLE)
      .update({
        is_active: false,
        delisted_at: now,
        is_eligible: false,
        exclusion_reason: "delisted",
        updated_at: now,
      })
      .in("symbol", batch);
    if (error) throw new Error(error.message);
  }

  for (const batch of chunk(diff.unchangedSymbols, WRITE_CHUNK_SIZE)) {
    const { error } = await client.from(TABLE).update({ last_seen_at: now }).in("symbol", batch);
    if (error) throw new Error(error.message);
  }

  return diff;
}

// New-listings-first, then the longest-unchecked — the batch-selection strategy behind the
// confirmed capped/incremental price-check design (see price-eligibility.ts). Only ever selects
// rows with no listing-level exclusion (exclusion_reason is null) — a delisted, test-issue, or
// unsupported-type symbol is never worth an API call, since its eligibility is already settled
// regardless of price ("avoid unnecessary API requests"). Two plain queries composed in
// application code rather than one clever ORDER BY CASE, matching this codebase's existing
// preference for simple, explicit queries.
export async function selectPriceCheckBatch(
  client: SupabaseClient,
  limit: number,
): Promise<UniverseSymbolRow[]> {
  const { data: neverChecked, error: neverCheckedError } = await client
    .from(TABLE)
    .select("*")
    .is("exclusion_reason", null)
    .eq("price_assessment_status", "awaiting_check")
    .order("first_seen_at", { ascending: true })
    .limit(limit);
  if (neverCheckedError) throw new Error(neverCheckedError.message);

  const rows = ((neverChecked ?? []) as SymbolRowDb[]).map(fromDbRow);
  const remaining = limit - rows.length;
  if (remaining <= 0) return rows;

  const staleCutoff = new Date(Date.now() - STALE_PRICE_CHECK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: stale, error: staleError } = await client
    .from(TABLE)
    .select("*")
    .is("exclusion_reason", null)
    .eq("price_assessment_status", "checked")
    .lt("last_price_checked_at", staleCutoff)
    .order("last_price_checked_at", { ascending: true })
    .limit(remaining);
  if (staleError) throw new Error(staleError.message);

  return [...rows, ...((stale ?? []) as SymbolRowDb[]).map(fromDbRow)];
}

// Persists price-check results and recomputes eligibility for exactly the rows just checked —
// eligibility is always a persisted column, never recomputed on read, so the worker's read query
// can never disagree with what this just wrote. A failed check leaves price_assessment_status at
// "awaiting_check" (retried on a later run) and touches nothing else on that row.
export async function recordPriceCheckResults(
  client: SupabaseClient,
  rows: UniverseSymbolRow[],
  results: PriceCheckResult[],
): Promise<void> {
  const rowsBySymbol = new Map(rows.map((row) => [row.symbol, row]));

  for (const result of results) {
    if (result.failed) continue;
    const row = rowsBySymbol.get(result.symbol);
    if (!row) continue;

    const listingExclusionReason = computeListingExclusion({
      isActive: row.isActive,
      isTestIssue: row.isTestIssue,
      instrumentType: row.instrumentType,
    });
    const eligibility = computeEligibility({
      listingExclusionReason,
      priceAssessmentStatus: "checked",
      lastPrice: result.price,
    });

    const { error } = await client
      .from(TABLE)
      .update({
        price_assessment_status: "checked",
        last_price: result.price,
        last_price_checked_at: result.checkedAt,
        last_change_absolute: result.changeAbsolute,
        last_change_percent: result.changePercent,
        last_day_high: result.dayHigh,
        last_day_low: result.dayLow,
        price_provider: getPriceProviderName(),
        is_eligible: eligibility.isEligible,
        exclusion_reason: eligibility.exclusionReason,
        updated_at: result.checkedAt,
      })
      .eq("symbol", result.symbol);
    if (error) throw new Error(error.message);
  }
}
