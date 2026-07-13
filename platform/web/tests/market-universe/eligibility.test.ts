import { describe, expect, it } from "vitest";
import {
  computeEligibility,
  computeListingExclusion,
  MINIMUM_ELIGIBLE_PRICE,
} from "@/lib/market-universe/eligibility";

describe("computeListingExclusion", () => {
  it("returns null when nothing is wrong at the listing level", () => {
    expect(
      computeListingExclusion({ isActive: true, isTestIssue: false, instrumentType: "equity" }),
    ).toBeNull();
  });

  it("reports delisted first, even when other reasons also apply", () => {
    expect(
      computeListingExclusion({ isActive: false, isTestIssue: true, instrumentType: "unsupported" }),
    ).toBe("delisted");
  });

  it("reports a test issue", () => {
    expect(
      computeListingExclusion({ isActive: true, isTestIssue: true, instrumentType: "equity" }),
    ).toBe("test_issue");
  });

  it("reports an unsupported instrument type", () => {
    expect(
      computeListingExclusion({ isActive: true, isTestIssue: false, instrumentType: "unsupported" }),
    ).toBe("unsupported_instrument_type");
  });
});

describe("computeEligibility", () => {
  it("is eligible when listing-clean, checked, and priced at or above the minimum", () => {
    expect(
      computeEligibility({ listingExclusionReason: null, priceAssessmentStatus: "checked", lastPrice: 10 }),
    ).toEqual({ isEligible: true, exclusionReason: null });
    expect(
      computeEligibility({
        listingExclusionReason: null,
        priceAssessmentStatus: "checked",
        lastPrice: MINIMUM_ELIGIBLE_PRICE,
      }),
    ).toEqual({ isEligible: true, exclusionReason: null });
  });

  it("a listing-level exclusion always wins, regardless of price-assessment status", () => {
    expect(
      computeEligibility({
        listingExclusionReason: "delisted",
        priceAssessmentStatus: "checked",
        lastPrice: 10,
      }),
    ).toEqual({ isEligible: false, exclusionReason: "delisted" });
  });

  it("a symbol awaiting its first price check is not eligible, but is NOT reported as excluded", () => {
    expect(
      computeEligibility({ listingExclusionReason: null, priceAssessmentStatus: "awaiting_check", lastPrice: null }),
    ).toEqual({ isEligible: false, exclusionReason: null });
  });

  it("excludes a checked symbol below the minimum price", () => {
    expect(
      computeEligibility({ listingExclusionReason: null, priceAssessmentStatus: "checked", lastPrice: 0.5 }),
    ).toEqual({ isEligible: false, exclusionReason: "price_below_minimum" });
  });
});
