import { describe, expect, it } from "vitest";
import { inspectRawRate } from "@/lib/hermes-execution/etoro/etoro-quote-diagnostics";

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
