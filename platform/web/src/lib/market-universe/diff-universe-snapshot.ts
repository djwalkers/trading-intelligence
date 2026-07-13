import type { RawListingRow, UniverseSymbolRow } from "./types";
import { classifyInstrumentType } from "./classify-instrument";
import { computeEligibility, computeListingExclusion } from "./eligibility";

export interface DiffBuckets {
  // Rows to upsert (insert-shaped: a genuinely new symbol, or a previously-delisted one relisting).
  newRows: UniverseSymbolRow[];
  // Rows to upsert (existing, active, but name/exchange/type/flags changed).
  changedRows: UniverseSymbolRow[];
  // Symbols to bulk-mark delisted (existing, active, absent from today's snapshot).
  delistedSymbols: string[];
  // Symbols present in both, byte-identical — only a cheap last_seen_at touch, never a full rewrite.
  unchangedSymbols: string[];
}

function buildRow(
  raw: RawListingRow,
  now: string,
  dataSource: string,
  sourceTimestamp: string,
  existing: UniverseSymbolRow | undefined,
): UniverseSymbolRow {
  const classification = classifyInstrumentType(raw.securityName, raw.isEtf, raw.symbol);
  const listingExclusionReason = computeListingExclusion({
    isActive: true,
    isTestIssue: raw.isTestIssue,
    instrumentType: classification.type,
  });
  // A symbol's price-assessment state persists across metadata refreshes — re-checking price is a
  // separate, incremental process (see price-eligibility.ts), not something a metadata-only
  // refresh should reset. A genuinely new row always starts awaiting_check.
  const priceAssessmentStatus = existing?.priceAssessmentStatus ?? "awaiting_check";
  const lastPrice = existing?.lastPrice ?? null;
  const eligibility = computeEligibility({ listingExclusionReason, priceAssessmentStatus, lastPrice });

  return {
    symbol: raw.symbol,
    companyName: raw.securityName,
    exchange: raw.exchange,
    instrumentType: classification.type,
    classificationMethod: classification.method,
    isEtf: raw.isEtf,
    isTestIssue: raw.isTestIssue,
    isActive: true,
    priceAssessmentStatus,
    lastPrice,
    lastPriceCheckedAt: existing?.lastPriceCheckedAt ?? null,
    lastChangeAbsolute: existing?.lastChangeAbsolute ?? null,
    lastChangePercent: existing?.lastChangePercent ?? null,
    lastDayHigh: existing?.lastDayHigh ?? null,
    lastDayLow: existing?.lastDayLow ?? null,
    priceProvider: existing?.priceProvider ?? null,
    isEligible: eligibility.isEligible,
    exclusionReason: eligibility.exclusionReason,
    dataSource,
    sourceTimestamp,
    firstSeenAt: existing && existing.isActive ? existing.firstSeenAt : (existing?.firstSeenAt ?? now),
    lastSeenAt: now,
    delistedAt: null,
  };
}

function isUnchanged(raw: RawListingRow, existing: UniverseSymbolRow): boolean {
  return (
    existing.isActive &&
    existing.companyName === raw.securityName &&
    existing.exchange === raw.exchange &&
    existing.isEtf === raw.isEtf &&
    existing.isTestIssue === raw.isTestIssue &&
    existing.instrumentType === classifyInstrumentType(raw.securityName, raw.isEtf, raw.symbol).type
  );
}

// Pure — no Supabase access, so this is unit-testable in isolation (universe-store.ts is the only
// caller, and only it touches the database). Given the full existing state and today's downloaded
// snapshot, computes exactly what needs to change: a genuinely new listing or a relisting goes to
// newRows; real metadata drift on an already-known active symbol goes to changedRows; a symbol that
// no longer appears in today's snapshot but was active goes to delistedSymbols; everything else
// (present, active, byte-identical) goes to unchangedSymbols, which only ever needs a cheap
// last_seen_at bump. Running this twice with the same snapshot and the same existing state (i.e.
// after the first run's writes have applied) produces empty newRows/changedRows/delistedSymbols —
// the idempotency property the refresh CLI is expected to demonstrate live.
export function diffUniverseSnapshot(params: {
  existingRows: UniverseSymbolRow[];
  snapshot: Map<string, RawListingRow>;
  now: string;
  dataSource: string;
  sourceTimestamp: string;
}): DiffBuckets {
  const { snapshot, now, dataSource, sourceTimestamp } = params;
  const existingBySymbol = new Map(params.existingRows.map((row) => [row.symbol, row]));

  const newRows: UniverseSymbolRow[] = [];
  const changedRows: UniverseSymbolRow[] = [];
  const unchangedSymbols: string[] = [];

  for (const [symbol, raw] of snapshot) {
    const existing = existingBySymbol.get(symbol);
    if (!existing || !existing.isActive) {
      newRows.push(buildRow(raw, now, dataSource, sourceTimestamp, existing));
      continue;
    }
    if (isUnchanged(raw, existing)) {
      unchangedSymbols.push(symbol);
      continue;
    }
    changedRows.push(buildRow(raw, now, dataSource, sourceTimestamp, existing));
  }

  const delistedSymbols = params.existingRows
    .filter((row) => row.isActive && !snapshot.has(row.symbol))
    .map((row) => row.symbol);

  return { newRows, changedRows, delistedSymbols, unchangedSymbols };
}
