// Phase 2A — Market Universe Foundation. See docs/product/PHASE-2A-MARKET-UNIVERSE.md.
//
// Correctly identified, but never excluded on their own — "equity" is the default for anything
// that isn't an ETF, ADR, or REIT. Only "unsupported" (warrants, rights, units, preferred shares —
// see classify-instrument.ts) is excluded on instrument-type grounds.
export type InstrumentType = "equity" | "etf" | "adr" | "reit" | "unsupported";

// Data-lineage field (Acceptance Remediation for Phase 2A) — whether an instrument_type
// classification came from a real, sourced field ("source_flag", only ever true for ETF, which
// NASDAQ Trader's files flag directly) or was inferred from a company-name pattern
// ("name_pattern_inferred" — ADR, REIT, unsupported, and the equity default all fall here, since
// the source has no real ADR/REIT column at all). Never treat a name_pattern_inferred
// classification as authoritative — see classify-instrument.ts and
// docs/product/PHASE-2A-MARKET-UNIVERSE.md's documented REIT false-negative finding.
export type ClassificationMethod = "source_flag" | "name_pattern_inferred";

// First-match-wins, *settled* reasons a symbol is excluded (see eligibility.ts's
// computeListingExclusion/computeEligibility). Persisted alongside is_eligible so a symbol's
// history of why it was excluded survives a later refresh, not just its current state. Does NOT
// include "not yet price-checked" — that is a distinct, non-exclusionary state, see
// PriceAssessmentStatus below.
export type ExclusionReason =
  | "test_issue"
  | "unsupported_instrument_type"
  | "price_below_minimum"
  | "delisted";

// Whether a symbol's price has ever been successfully checked — deliberately separate from
// ExclusionReason. A symbol awaiting its first check is not "ordinarily excluded," it is "not yet
// knowable" — conflating the two made "not_yet_price_checked" look like a settled business
// exclusion rather than a temporary, converging state. See price-eligibility.ts for the
// capped/incremental batch design this status drives.
export type PriceAssessmentStatus = "awaiting_check" | "checked";

export type UniverseExchange = "NASDAQ" | "NYSE" | "NYSE American";

// One row parsed from either NASDAQ Trader source file, before classification — a faithful,
// lossless transcription of the real fields that file provides. Test issues are included here
// (isTestIssue: true), not dropped — filtering happens later, in eligibility.ts, so
// total_downloaded in the refresh log reflects everything the source actually listed.
export interface RawListingRow {
  symbol: string;
  securityName: string;
  exchange: UniverseExchange;
  isEtf: boolean;
  isTestIssue: boolean;
}

// Mirrors the market_universe_symbols columns (0018_market_universe_symbols.sql).
export interface UniverseSymbolRow {
  symbol: string;
  companyName: string;
  exchange: UniverseExchange;
  instrumentType: InstrumentType;
  classificationMethod: ClassificationMethod;
  isEtf: boolean;
  isTestIssue: boolean;
  isActive: boolean;
  priceAssessmentStatus: PriceAssessmentStatus;
  lastPrice: number | null;
  lastPriceCheckedAt: string | null;
  // Genuinely real when present (read from the same Finnhub /quote response as lastPrice, at no
  // extra API cost) — never fabricated as 0 when absent. See price-eligibility.ts.
  lastChangeAbsolute: number | null;
  lastChangePercent: number | null;
  lastDayHigh: number | null;
  lastDayLow: number | null;
  priceProvider: string | null;
  isEligible: boolean;
  exclusionReason: ExclusionReason | null;
  dataSource: string;
  sourceTimestamp: string;
  firstSeenAt: string;
  lastSeenAt: string;
  delistedAt: string | null;
}

// Mirrors the market_universe_refresh_log columns (0019_market_universe_refresh_log.sql) — one
// row per refresh run, the durable record "provide operational evidence" (Phase 2A spec) points to.
export interface RefreshRunStats {
  totalDownloaded: number;
  newListingsCount: number;
  delistingsCount: number;
  metadataChangesCount: number;
  priceChecksPerformed: number;
  priceCheckFailures: number;
  eligibleCount: number;
  // Settled, genuine business-rule exclusions only — does not include symbols still
  // awaiting_check (see awaitingPriceCheckCount below), so "excluded" never conflates "we know
  // this symbol doesn't qualify" with "we don't know yet."
  excludedCount: number;
  exclusionReasonBreakdown: Record<ExclusionReason, number>;
  awaitingPriceCheckCount: number;
  durationMs: number;
}
