import { describe, expect, it } from "vitest";
import {
  filterToLearningEligibleData,
  filterToVerifiedLiveData,
  isLearningEligible,
  isVerifiedLiveData,
} from "@/lib/analytics/production-data-filter";
import type { DataProvenance } from "@/lib/types";

describe("isVerifiedLiveData", () => {
  it("is true only for verified_external_data", () => {
    expect(isVerifiedLiveData("verified_external_data")).toBe(true);
    expect(isVerifiedLiveData("sample_data")).toBe(false);
    expect(isVerifiedLiveData("fallback_sample_data")).toBe(false);
    expect(isVerifiedLiveData("backtest")).toBe(false);
  });
});

describe("isLearningEligible", () => {
  it("is true for verified_external_data and backtest, false for the two sample-ish values", () => {
    expect(isLearningEligible("verified_external_data")).toBe(true);
    expect(isLearningEligible("backtest")).toBe(true);
    expect(isLearningEligible("sample_data")).toBe(false);
    expect(isLearningEligible("fallback_sample_data")).toBe(false);
  });
});

interface Fixture {
  id: string;
  dataProvenance: DataProvenance;
}

const fixtures: Fixture[] = [
  { id: "a", dataProvenance: "sample_data" },
  { id: "b", dataProvenance: "verified_external_data" },
  { id: "c", dataProvenance: "fallback_sample_data" },
  { id: "d", dataProvenance: "backtest" },
];

describe("filterToVerifiedLiveData", () => {
  it("keeps only verified_external_data records — backtest is excluded by default too", () => {
    expect(filterToVerifiedLiveData(fixtures).map((f) => f.id)).toEqual(["b"]);
  });
});

describe("filterToLearningEligibleData", () => {
  it("keeps verified_external_data and backtest, excludes both sample-ish values", () => {
    expect(filterToLearningEligibleData(fixtures).map((f) => f.id)).toEqual(["b", "d"]);
  });
});
