import type { ClassificationMethod, InstrumentType } from "./types";

// Deterministic classification derived from the real Security Name field (and the source's own
// real ETF flag) — not a fetched or invented field, a pure function of data the source genuinely
// provides. NASDAQ Trader's listing files have no explicit ADR/REIT column, so identifying them
// means pattern-matching the company name, the same way this codebase already derives a sector
// label from a symbol (src/lib/mock/sectors.ts) rather than fetching one.
const ADR_PATTERN = /\b(ADR|American Depositary (Receipt|Share)s?)\b/i;
const REIT_PATTERN = /\b(REIT|Real Estate Investment Trust)\b/i;
const UNSUPPORTED_PATTERN =
  /\b(Warrants?|Rights?|Units?|Preferred|Pfd\.?|When[\s-]?Issued|Depositary Shares?)\b/i;

// NASDAQ's own symbol convention appends a 5th character for non-common-share issue types (W =
// warrant, U = unit, R = right) on NASDAQ-listed (5-character) symbols specifically — this
// convention doesn't apply to otherlisted.txt's NYSE-style symbols. It's a secondary, belt-and-
// braces check: the Security Name regex above already catches most of these by name, but a small
// number carry only the suffix with an otherwise ordinary-looking name. This has real exceptions
// (some genuine 5-letter equity tickers end in these letters too) — documented as a known,
// residual false-negative/false-positive source in docs/product/PHASE-2A-MARKET-UNIVERSE.md, not a
// hard rule to rely on alone.
const NASDAQ_SUFFIX_PATTERN = /^[A-Z]{4}[WUR]$/;

export interface InstrumentClassification {
  type: InstrumentType;
  method: ClassificationMethod;
}

// Only ETF ever comes from a real, sourced field (NASDAQ Trader's own ETF Y/N column) — every
// other classification is inferred from a company-name pattern and must never be presented as
// authoritative. See ClassificationMethod's own doc comment (types.ts) and the documented,
// live-data-confirmed REIT false-negative finding in docs/product/PHASE-2A-MARKET-UNIVERSE.md.
export function classifyInstrumentType(
  securityName: string,
  isEtf: boolean,
  symbol: string,
): InstrumentClassification {
  // The source's own ETF flag is real, sourced data — trust it over any name-based guess. ADR/REIT
  // are checked before the unsupported pattern since "American Depositary Shares" (a genuine ADR
  // name) would otherwise also match the unsupported pattern's "Depositary Shares" clause (meant
  // for preferred depositary shares, not ADRs).
  if (isEtf) return { type: "etf", method: "source_flag" };
  if (ADR_PATTERN.test(securityName)) return { type: "adr", method: "name_pattern_inferred" };
  if (REIT_PATTERN.test(securityName)) return { type: "reit", method: "name_pattern_inferred" };
  if (UNSUPPORTED_PATTERN.test(securityName)) {
    return { type: "unsupported", method: "name_pattern_inferred" };
  }
  if (NASDAQ_SUFFIX_PATTERN.test(symbol)) {
    return { type: "unsupported", method: "name_pattern_inferred" };
  }
  return { type: "equity", method: "name_pattern_inferred" };
}

// Only "unsupported" is excluded on instrument-type grounds — ETFs, ADRs, and REITs are correctly
// identified but remain ordinarily-tradeable, eligible instrument types (see eligibility.ts).
export function isSupportedInstrumentType(type: InstrumentType): boolean {
  return type !== "unsupported";
}
