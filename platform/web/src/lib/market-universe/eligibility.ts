import type { ExclusionReason, InstrumentType, PriceAssessmentStatus } from "./types";
import { isSupportedInstrumentType } from "./classify-instrument";

// Phase 2A stage-1 eligibility only — price floor, active listing, supported instrument type.
// Liquidity filtering (volume/ADV thresholds) is explicitly out of scope; see "Recommended Phase
// 2B" in docs/product/PHASE-2A-MARKET-UNIVERSE.md.
export const MINIMUM_ELIGIBLE_PRICE = 1;

export interface ListingInput {
  isActive: boolean;
  isTestIssue: boolean;
  instrumentType: InstrumentType;
}

// The settled, listing-level exclusion reasons — everything knowable from the source file alone,
// with no price check involved. Deliberately separate from computeEligibility below: a symbol can
// be listing-excluded immediately on classification (no point ever price-checking it), while
// "awaiting its first price check" is a different, non-exclusionary, temporary state (see
// PriceAssessmentStatus, types.ts).
export function computeListingExclusion(input: ListingInput): ExclusionReason | null {
  if (!input.isActive) return "delisted";
  if (input.isTestIssue) return "test_issue";
  if (!isSupportedInstrumentType(input.instrumentType)) return "unsupported_instrument_type";
  return null;
}

export interface EligibilityInput {
  listingExclusionReason: ExclusionReason | null;
  priceAssessmentStatus: PriceAssessmentStatus;
  // Non-null whenever priceAssessmentStatus === "checked" (a successful check always records a
  // price; a failed one leaves the status at "awaiting_check" for a later retry — see
  // price-eligibility.ts).
  lastPrice: number | null;
}

export interface EligibilityResult {
  isEligible: boolean;
  exclusionReason: ExclusionReason | null;
}

// The single source of truth for what "eligible" means — first-match-wins. A listing-level
// exclusion always wins (a delisted test issue reports "delisted", not "test_issue"). A symbol
// still awaiting_check is NOT eligible, but also NOT "excluded" — exclusionReason stays null,
// since we genuinely don't know yet, not because we've ruled it out. Called both when a row is
// first classified and again after every price-check update, so is_eligible and exclusion_reason
// are always persisted, never recomputed on read.
export function computeEligibility(input: EligibilityInput): EligibilityResult {
  if (input.listingExclusionReason) {
    return { isEligible: false, exclusionReason: input.listingExclusionReason };
  }
  if (input.priceAssessmentStatus === "awaiting_check") {
    return { isEligible: false, exclusionReason: null };
  }
  if (input.lastPrice === null || input.lastPrice < MINIMUM_ELIGIBLE_PRICE) {
    return { isEligible: false, exclusionReason: "price_below_minimum" };
  }
  return { isEligible: true, exclusionReason: null };
}
