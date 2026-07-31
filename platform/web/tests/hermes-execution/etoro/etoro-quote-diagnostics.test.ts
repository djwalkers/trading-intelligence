import { describe, expect, it } from "vitest";
import { inspectRawRate, extractCuratedRateSample, compareQuoteSamples, type CuratedRateSample } from "@/lib/hermes-execution/etoro/etoro-quote-diagnostics";

// Quote-timestamp-semantics investigation (probe-etoro-1785448658984). Pure, structural-fixture-only
// tests — never a live call. inspectRawRate() looks PAST EtoroRate's own declared fields (see its
// own top-of-file comment: EtoroClient.request<T>() only ever does `JSON.parse(text) as T`, so the
// raw runtime object still carries every field eToro actually sent).

describe("inspectRawRate", () => {
  it("maps the genuine bid/ask/date fields off the selected row correctly", () => {
    const raw = { rates: [{ instrumentID: 100000, bid: 64712.47, ask: 64712.48, date: "2026-07-30T19:57:23.1261349Z" }] };
    const result = inspectRawRate(raw, 100000);
    expect(result.selectedRowFound).toBe(true);
    expect(result.bid).toBe(64712.47);
    expect(result.ask).toBe(64712.48);
    expect(result.timestampLikeFields).toEqual({ date: "2026-07-30T19:57:23.1261349Z" });
  });

  it("surfaces multiple timestamp-like fields present on the same row, not only `date`", () => {
    const raw = {
      rates: [
        {
          instrumentID: 100000,
          bid: 100,
          ask: 101,
          date: "2026-07-30T19:57:23.1261349Z",
          lastUpdate: "2026-07-30T19:57:00.0000000Z",
          lastUpdated: "2026-07-30T19:56:00.0000000Z",
          updatedAt: "2026-07-30T19:55:00.0000000Z",
          marketTime: "2026-07-30T19:54:00.0000000Z",
          serverTime: "2026-07-30T19:53:00.0000000Z",
        },
      ],
    };
    const result = inspectRawRate(raw, 100000);
    expect(result.timestampLikeFields).toEqual({
      date: "2026-07-30T19:57:23.1261349Z",
      lastUpdate: "2026-07-30T19:57:00.0000000Z",
      lastUpdated: "2026-07-30T19:56:00.0000000Z",
      updatedAt: "2026-07-30T19:55:00.0000000Z",
      marketTime: "2026-07-30T19:54:00.0000000Z",
      serverTime: "2026-07-30T19:53:00.0000000Z",
    });
  });

  it("the selected instrument row's own timestamp wins — never a different row's, and never a parent-level field", () => {
    const raw = {
      // A hypothetical parent-level timestamp some other provider shape might carry — must never
      // be confused with a per-row quote timestamp even if present alongside `rates`.
      date: "1999-01-01T00:00:00.0000000Z",
      rates: [
        { instrumentID: 100681, bid: 1, ask: 2, date: "2020-01-01T00:00:00.0000000Z" },
        { instrumentID: 100000, bid: 64712.47, ask: 64712.48, date: "2026-07-30T19:57:23.1261349Z" },
        { instrumentID: 555555, bid: 3, ask: 4, date: "2021-01-01T00:00:00.0000000Z" },
      ],
    };
    const result = inspectRawRate(raw, 100000);
    expect(result.selectedRowFound).toBe(true);
    expect(result.bid).toBe(64712.47);
    expect(result.timestampLikeFields.date).toBe("2026-07-30T19:57:23.1261349Z");
  });

  it("preserves a variable-precision fractional-second UTC timestamp verbatim, never truncating or reparsing it", () => {
    const raw = { rates: [{ instrumentID: 100000, bid: 1, ask: 2, date: "2026-07-30T19:57:23.1261349Z" }] };
    const result = inspectRawRate(raw, 100000);
    expect(result.timestampLikeFields.date).toBe("2026-07-30T19:57:23.1261349Z");
  });

  it("reports an empty timestampLikeFields object when the row has no timestamp-like field at all", () => {
    const raw = { rates: [{ instrumentID: 100000, bid: 1, ask: 2 }] };
    const result = inspectRawRate(raw, 100000);
    expect(result.selectedRowFound).toBe(true);
    expect(result.timestampLikeFields).toEqual({});
    expect(result.availableFieldNames.sort()).toEqual(["instrumentID", "bid", "ask"].sort());
  });

  it("reports selectedRowFound: false, never throws, when the requested instrument id is absent", () => {
    const raw = { rates: [{ instrumentID: 999999, bid: 1, ask: 2, date: "2026-01-01T00:00:00Z" }] };
    const result = inspectRawRate(raw, 100000);
    expect(result.selectedRowFound).toBe(false);
    expect(result.availableFieldNames).toEqual([]);
    expect(result.timestampLikeFields).toEqual({});
  });

  it("reports selectedRowFound: false, never throws, for a malformed/unexpected response shape", () => {
    expect(inspectRawRate(null, 100000).selectedRowFound).toBe(false);
    expect(inspectRawRate(undefined, 100000).selectedRowFound).toBe(false);
    expect(inspectRawRate("not an object", 100000).selectedRowFound).toBe(false);
    expect(inspectRawRate({ rates: "not an array" }, 100000).selectedRowFound).toBe(false);
    expect(inspectRawRate({}, 100000).selectedRowFound).toBe(false);
  });

  it("never surfaces the VALUE of a non-timestamp-like field, even though its name is listed", () => {
    const raw = {
      rates: [
        {
          instrumentID: 100000,
          bid: 1,
          ask: 2,
          date: "2026-01-01T00:00:00Z",
          unitMargin: 12345,
          priceRateID: 987654,
        },
      ],
    };
    const result = inspectRawRate(raw, 100000);
    expect(result.availableFieldNames).toContain("unitMargin");
    expect(result.availableFieldNames).toContain("priceRateID");
    expect(JSON.stringify(result.timestampLikeFields)).not.toContain("12345");
    expect(JSON.stringify(result.timestampLikeFields)).not.toContain("987654");
    expect(result).not.toHaveProperty("unitMargin");
    expect(result).not.toHaveProperty("priceRateID");
  });
});

// Multi-sample rate comparison (probe-etoro-1785449795206 follow-up). Pure, structural-fixture-only
// tests — never a live call.

function sampleContext(sampleNumber: number, requestStartedAt = "2026-07-31T00:00:00.000Z", responseReceivedAt = "2026-07-31T00:00:00.100Z") {
  return { sampleNumber, requestStartedAt, responseReceivedAt };
}

describe("extractCuratedRateSample", () => {
  it("captures every explicitly-curated field, including ones inspectRawRate would only ever list the NAME of", () => {
    const raw = {
      rates: [
        {
          instrumentID: 100000,
          bid: 64712.47,
          ask: 64712.48,
          date: "2026-07-30T19:57:23.1261349Z",
          lastExecution: 64712.475,
          priceRateID: 987654,
          conversionRateBid: 1,
          conversionRateAsk: 1,
          bidDiscounted: 64712.4,
          askDiscounted: 64712.5,
        },
      ],
    };
    const sample = extractCuratedRateSample(raw, 100000, sampleContext(1));
    expect(sample).toEqual({
      sampleNumber: 1,
      requestStartedAt: "2026-07-31T00:00:00.000Z",
      responseReceivedAt: "2026-07-31T00:00:00.100Z",
      instrumentID: 100000,
      bid: 64712.47,
      ask: 64712.48,
      spread: expect.closeTo(0.01, 5),
      date: "2026-07-30T19:57:23.1261349Z",
      parsedDateAgeSeconds: expect.any(Number),
      lastExecution: 64712.475,
      priceRateID: 987654,
      conversionRateBid: 1,
      conversionRateAsk: 1,
      bidDiscounted: 64712.4,
      askDiscounted: 64712.5,
    });
  });

  it("reports lastExecution/priceRateID as null, never crashing, when the row does not include them", () => {
    const raw = { rates: [{ instrumentID: 100000, bid: 100, ask: 101, date: "2026-07-31T00:00:00.000Z" }] };
    const sample = extractCuratedRateSample(raw, 100000, sampleContext(1));
    expect(sample.lastExecution).toBeNull();
    expect(sample.priceRateID).toBeNull();
    expect(sample.conversionRateBid).toBeNull();
    expect(sample.bidDiscounted).toBeNull();
  });

  it("never passes through a nested object/array value for an unconfirmed-type field — treats it as null instead", () => {
    const raw = { rates: [{ instrumentID: 100000, bid: 100, ask: 101, lastExecution: { nested: "unexpected-shape" } }] };
    const sample = extractCuratedRateSample(raw, 100000, sampleContext(1));
    expect(sample.lastExecution).toBeNull();
  });

  it("correctly parses a variable-precision fractional-second UTC date into a non-negative age in seconds", () => {
    const raw = { rates: [{ instrumentID: 100000, bid: 100, ask: 101, date: "2026-07-31T19:57:23.1261349Z" }] };
    const sample = extractCuratedRateSample(raw, 100000, sampleContext(1, "2026-07-31T00:00:00.000Z", "2026-07-31T22:00:00.000Z"));
    // Exactly 2h02m36.874s between the quote date (fractional seconds truncated to millisecond
    // precision by JS's Date, as documented) and the receipt time used for this sample's own age.
    expect(sample.parsedDateAgeSeconds).toBeCloseTo(7_356.874, 0);
  });

  it("reports parsedDateAgeSeconds as null, never 0 or a guess, when date is absent", () => {
    const raw = { rates: [{ instrumentID: 100000, bid: 100, ask: 101 }] };
    const sample = extractCuratedRateSample(raw, 100000, sampleContext(1));
    expect(sample.date).toBeNull();
    expect(sample.parsedDateAgeSeconds).toBeNull();
  });

  it("reports parsedDateAgeSeconds as null when date is present but unparseable", () => {
    const raw = { rates: [{ instrumentID: 100000, bid: 100, ask: 101, date: "not-a-real-date" }] };
    const sample = extractCuratedRateSample(raw, 100000, sampleContext(1));
    expect(sample.date).toBe("not-a-real-date");
    expect(sample.parsedDateAgeSeconds).toBeNull();
  });

  it("returns an all-null sample, never throws, for a malformed/unexpected response shape", () => {
    const sample = extractCuratedRateSample(null, 100000, sampleContext(1));
    expect(sample.instrumentID).toBeNull();
    expect(sample.bid).toBeNull();
    expect(sample.lastExecution).toBeNull();
  });
});

function sample(overrides: Partial<CuratedRateSample> = {}): CuratedRateSample {
  return {
    sampleNumber: 1,
    requestStartedAt: "2026-07-31T00:00:00.000Z",
    responseReceivedAt: "2026-07-31T00:00:00.100Z",
    instrumentID: 100000,
    bid: 100,
    ask: 101,
    spread: 1,
    date: "2026-07-31T00:00:00.000Z",
    parsedDateAgeSeconds: 7_000,
    lastExecution: 100.5,
    priceRateID: 1,
    conversionRateBid: 1,
    conversionRateAsk: 1,
    bidDiscounted: 99,
    askDiscounted: 102,
    ...overrides,
  };
}

const FRESHNESS_THRESHOLD_MS = 60_000;

describe("compareQuoteSamples", () => {
  it("observes BID_ASK_CHANGED_DATE_UNCHANGED when bid/ask move but date stays fixed", () => {
    const samples = [sample({ sampleNumber: 1, bid: 100 }), sample({ sampleNumber: 2, bid: 101 })];
    const comparison = compareQuoteSamples(samples, FRESHNESS_THRESHOLD_MS);
    expect(comparison.bidChangedAcrossSamples).toBe(true);
    expect(comparison.dateChangedAcrossSamples).toBe(false);
    expect(comparison.observations).toContain("BID_ASK_CHANGED_DATE_UNCHANGED");
    expect(comparison.observations).not.toContain("DATE_CHANGED_WITH_RATE");
  });

  it("observes PRICE_RATE_ID_CHANGED_DATE_UNCHANGED when priceRateID moves but date stays fixed", () => {
    const samples = [sample({ sampleNumber: 1, priceRateID: 1 }), sample({ sampleNumber: 2, priceRateID: 2 })];
    const comparison = compareQuoteSamples(samples, FRESHNESS_THRESHOLD_MS);
    expect(comparison.priceRateIdChangedAcrossSamples).toBe(true);
    expect(comparison.observations).toContain("PRICE_RATE_ID_CHANGED_DATE_UNCHANGED");
  });

  it("observes DATE_CHANGED_WITH_RATE when both date and bid/ask change across the sample set", () => {
    const samples = [
      sample({ sampleNumber: 1, bid: 100, date: "2026-07-31T00:00:00.000Z" }),
      sample({ sampleNumber: 2, bid: 105, date: "2026-07-31T00:00:05.000Z" }),
    ];
    const comparison = compareQuoteSamples(samples, FRESHNESS_THRESHOLD_MS);
    expect(comparison.dateChangedAcrossSamples).toBe(true);
    expect(comparison.bidChangedAcrossSamples).toBe(true);
    expect(comparison.observations).toContain("DATE_CHANGED_WITH_RATE");
    expect(comparison.observations).not.toContain("BID_ASK_CHANGED_DATE_UNCHANGED");
  });

  it("observes NO_FIELDS_CHANGED when bid/ask/date/lastExecution/priceRateID are all identical across samples", () => {
    const samples = [sample({ sampleNumber: 1 }), sample({ sampleNumber: 2 }), sample({ sampleNumber: 3 })];
    const comparison = compareQuoteSamples(samples, FRESHNESS_THRESHOLD_MS);
    expect(comparison.observations).toEqual(["NO_FIELDS_CHANGED", "PROVIDER_DATE_REMAINS_STALE"]);
  });

  it("observes LAST_EXECUTION_CHANGED independently of bid/ask/date", () => {
    const samples = [sample({ sampleNumber: 1, lastExecution: 100 }), sample({ sampleNumber: 2, lastExecution: 105 })];
    const comparison = compareQuoteSamples(samples, FRESHNESS_THRESHOLD_MS);
    expect(comparison.lastExecutionChangedAcrossSamples).toBe(true);
    expect(comparison.observations).toContain("LAST_EXECUTION_CHANGED");
  });

  it("observes PROVIDER_DATE_REMAINS_STALE only when EVERY sample's parsed age exceeds the threshold", () => {
    const staleSamples = [sample({ sampleNumber: 1, parsedDateAgeSeconds: 7_000 }), sample({ sampleNumber: 2, parsedDateAgeSeconds: 7_100 })];
    expect(compareQuoteSamples(staleSamples, FRESHNESS_THRESHOLD_MS).observations).toContain("PROVIDER_DATE_REMAINS_STALE");

    const mixedSamples = [sample({ sampleNumber: 1, parsedDateAgeSeconds: 7_000 }), sample({ sampleNumber: 2, parsedDateAgeSeconds: 5 })];
    expect(compareQuoteSamples(mixedSamples, FRESHNESS_THRESHOLD_MS).observations).not.toContain("PROVIDER_DATE_REMAINS_STALE");
  });

  it("computes uniqueBidAskPairCount/uniqueDateCount/uniquePriceRateIdCount correctly", () => {
    const samples = [
      sample({ sampleNumber: 1, bid: 100, ask: 101, date: "2026-07-31T00:00:00.000Z", priceRateID: 1 }),
      sample({ sampleNumber: 2, bid: 100, ask: 101, date: "2026-07-31T00:00:00.000Z", priceRateID: 1 }),
      sample({ sampleNumber: 3, bid: 102, ask: 103, date: "2026-07-31T00:00:05.000Z", priceRateID: 2 }),
    ];
    const comparison = compareQuoteSamples(samples, FRESHNESS_THRESHOLD_MS);
    expect(comparison.uniqueBidAskPairCount).toBe(2);
    expect(comparison.uniqueDateCount).toBe(2);
    expect(comparison.uniquePriceRateIdCount).toBe(2);
  });

  it("reports first/last receipt timestamps and elapsed duration", () => {
    const samples = [
      sample({ sampleNumber: 1, responseReceivedAt: "2026-07-31T00:00:00.000Z" }),
      sample({ sampleNumber: 2, responseReceivedAt: "2026-07-31T00:00:05.000Z" }),
      sample({ sampleNumber: 3, responseReceivedAt: "2026-07-31T00:00:10.000Z" }),
    ];
    const comparison = compareQuoteSamples(samples, FRESHNESS_THRESHOLD_MS);
    expect(comparison.firstReceiptTimestamp).toBe("2026-07-31T00:00:00.000Z");
    expect(comparison.lastReceiptTimestamp).toBe("2026-07-31T00:00:10.000Z");
    expect(comparison.elapsedMs).toBe(10_000);
  });

  it("never draws a conclusion — only ever returns deterministic booleans/counts/named observation codes", () => {
    const samples = [sample({ sampleNumber: 1 }), sample({ sampleNumber: 2, bid: 105 })];
    const comparison = compareQuoteSamples(samples, FRESHNESS_THRESHOLD_MS);
    const allowedKeys = [
      "sampleCount",
      "bidChangedAcrossSamples",
      "askChangedAcrossSamples",
      "dateChangedAcrossSamples",
      "lastExecutionChangedAcrossSamples",
      "priceRateIdChangedAcrossSamples",
      "uniqueBidAskPairCount",
      "uniqueDateCount",
      "uniquePriceRateIdCount",
      "firstReceiptTimestamp",
      "lastReceiptTimestamp",
      "elapsedMs",
      "observations",
    ];
    expect(Object.keys(comparison).sort()).toEqual(allowedKeys.sort());
    for (const observation of comparison.observations) {
      expect(typeof observation).toBe("string");
    }
  });
});
