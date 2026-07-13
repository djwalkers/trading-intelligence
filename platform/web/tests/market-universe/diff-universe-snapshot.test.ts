import { describe, expect, it } from "vitest";
import { diffUniverseSnapshot } from "@/lib/market-universe/diff-universe-snapshot";
import type { RawListingRow, UniverseSymbolRow } from "@/lib/market-universe/types";

const NOW = "2026-07-13T00:00:00.000Z";
const DATA_SOURCE = "NasdaqTrader";
const SOURCE_TIMESTAMP = "2026-07-13T00:00:00.000Z";

function rawRow(overrides: Partial<RawListingRow> = {}): RawListingRow {
  return {
    symbol: "AAPL",
    securityName: "Apple Inc. - Common Stock",
    exchange: "NASDAQ",
    isEtf: false,
    isTestIssue: false,
    ...overrides,
  };
}

function existingRow(overrides: Partial<UniverseSymbolRow> = {}): UniverseSymbolRow {
  return {
    symbol: "AAPL",
    companyName: "Apple Inc. - Common Stock",
    exchange: "NASDAQ",
    instrumentType: "equity",
    classificationMethod: "name_pattern_inferred",
    isEtf: false,
    isTestIssue: false,
    isActive: true,
    priceAssessmentStatus: "checked",
    lastPrice: 150,
    lastPriceCheckedAt: "2026-07-01T00:00:00.000Z",
    lastChangeAbsolute: 1.5,
    lastChangePercent: 1.0,
    lastDayHigh: 152,
    lastDayLow: 148,
    priceProvider: "Finnhub",
    isEligible: true,
    exclusionReason: null,
    dataSource: DATA_SOURCE,
    sourceTimestamp: "2026-07-06T00:00:00.000Z",
    firstSeenAt: "2020-01-01T00:00:00.000Z",
    lastSeenAt: "2026-07-06T00:00:00.000Z",
    delistedAt: null,
    ...overrides,
  };
}

describe("diffUniverseSnapshot", () => {
  it("classifies a genuinely new symbol as newRows, starting awaiting_check with no prior price data", () => {
    const snapshot = new Map([["AAPL", rawRow()]]);
    const result = diffUniverseSnapshot({
      existingRows: [],
      snapshot,
      now: NOW,
      dataSource: DATA_SOURCE,
      sourceTimestamp: SOURCE_TIMESTAMP,
    });

    expect(result.newRows).toHaveLength(1);
    expect(result.newRows[0]).toMatchObject({
      symbol: "AAPL",
      isActive: true,
      priceAssessmentStatus: "awaiting_check",
      lastPrice: null,
      lastChangeAbsolute: null,
      lastChangePercent: null,
      lastDayHigh: null,
      lastDayLow: null,
      priceProvider: null,
      isEligible: false,
      exclusionReason: null, // awaiting_check is not eligible, but not "excluded" either
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });
    expect(result.changedRows).toHaveLength(0);
    expect(result.delistedSymbols).toHaveLength(0);
    expect(result.unchangedSymbols).toHaveLength(0);
  });

  it("treats a relisting (previously delisted) as newRows, preserving first_seen_at and any prior price-check state", () => {
    const snapshot = new Map([["AAPL", rawRow()]]);
    const delisted = existingRow({ isActive: false, delistedAt: "2026-06-01T00:00:00.000Z" });
    const result = diffUniverseSnapshot({
      existingRows: [delisted],
      snapshot,
      now: NOW,
      dataSource: DATA_SOURCE,
      sourceTimestamp: SOURCE_TIMESTAMP,
    });

    expect(result.newRows).toHaveLength(1);
    expect(result.newRows[0]).toMatchObject({
      isActive: true,
      delistedAt: null,
      firstSeenAt: delisted.firstSeenAt,
      priceAssessmentStatus: delisted.priceAssessmentStatus,
      lastPrice: delisted.lastPrice,
      lastChangeAbsolute: delisted.lastChangeAbsolute,
    });
  });

  it("leaves a byte-identical active symbol in unchangedSymbols only", () => {
    const snapshot = new Map([["AAPL", rawRow()]]);
    const result = diffUniverseSnapshot({
      existingRows: [existingRow()],
      snapshot,
      now: NOW,
      dataSource: DATA_SOURCE,
      sourceTimestamp: SOURCE_TIMESTAMP,
    });

    expect(result.unchangedSymbols).toEqual(["AAPL"]);
    expect(result.newRows).toHaveLength(0);
    expect(result.changedRows).toHaveLength(0);
    expect(result.delistedSymbols).toHaveLength(0);
  });

  it("classifies a real metadata change (company name) as changedRows, preserving price-check state", () => {
    const snapshot = new Map([["AAPL", rawRow({ securityName: "Apple Inc. - New Name" })]]);
    const result = diffUniverseSnapshot({
      existingRows: [existingRow()],
      snapshot,
      now: NOW,
      dataSource: DATA_SOURCE,
      sourceTimestamp: SOURCE_TIMESTAMP,
    });

    expect(result.changedRows).toHaveLength(1);
    expect(result.changedRows[0]).toMatchObject({
      companyName: "Apple Inc. - New Name",
      priceAssessmentStatus: "checked",
      lastPrice: 150,
      lastChangeAbsolute: 1.5,
      isEligible: true,
    });
    expect(result.unchangedSymbols).toHaveLength(0);
  });

  it("classifies an active symbol absent from today's snapshot as delisted", () => {
    const result = diffUniverseSnapshot({
      existingRows: [existingRow()],
      snapshot: new Map(),
      now: NOW,
      dataSource: DATA_SOURCE,
      sourceTimestamp: SOURCE_TIMESTAMP,
    });

    expect(result.delistedSymbols).toEqual(["AAPL"]);
  });

  it("is idempotent: re-running with the post-write existing state produces no new/changed/delisted entries", () => {
    const snapshot = new Map([["AAPL", rawRow()]]);
    const first = diffUniverseSnapshot({
      existingRows: [],
      snapshot,
      now: NOW,
      dataSource: DATA_SOURCE,
      sourceTimestamp: SOURCE_TIMESTAMP,
    });

    // Simulate the write having applied: the new row from run 1 is now the existing state for run 2.
    const second = diffUniverseSnapshot({
      existingRows: first.newRows,
      snapshot,
      now: "2026-07-14T00:00:00.000Z",
      dataSource: DATA_SOURCE,
      sourceTimestamp: SOURCE_TIMESTAMP,
    });

    expect(second.newRows).toHaveLength(0);
    expect(second.changedRows).toHaveLength(0);
    expect(second.delistedSymbols).toHaveLength(0);
    expect(second.unchangedSymbols).toEqual(["AAPL"]);
  });
});
