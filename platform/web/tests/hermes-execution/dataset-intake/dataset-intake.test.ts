import { describe, expect, it } from "vitest";
import { prepareDataset, sliceCandlesByDateRange, isSupportedTimezoneAssumption, type PrepareDatasetInput } from "@/lib/hermes-execution/dataset-intake/dataset-intake";
import type { DatasetKnownClosure } from "@/lib/hermes-execution/backtest/backtest-dataset";

// Phase 4 — Historical Dataset Intake. Pure conversion/validation/slicing — no filesystem I/O, no
// provider/broker import anywhere. Every rejection reason exercised here mirrors a real, offline
// failure mode (malformed export, ambiguous columns, wrong timezone assumption) — never a network
// or exchange failure, since this module can't reach either.

const BASE: Omit<PrepareDatasetInput, "rawText" | "format"> = {
  instrument: "BTC",
  timeframe: "1h",
  source: "test-source",
  timezone: "UTC",
  inputFileLabel: "input.csv",
  importedAt: "2026-01-01T00:00:00.000Z",
};

function csvRows(rows: string[]): string {
  return ["timestamp,open,high,low,close,volume", ...rows].join("\n");
}

const VALID_ROWS = ["2026-01-01T00:00:00Z,100,101,99,100.5,10", "2026-01-01T01:00:00Z,100.5,102,100,101.5,12", "2026-01-01T02:00:00Z,101.5,103,101,102.5,11"];

describe("prepareDataset — valid imports", () => {
  it("accepts a valid CSV import and produces the exact Phase 2 schema", () => {
    const result = prepareDataset({ ...BASE, rawText: csvRows(VALID_ROWS), format: "csv" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document).toEqual({
        schemaVersion: 1,
        instrument: "BTC",
        timeframe: "1h",
        source: "test-source",
        candles: [
          { timestamp: "2026-01-01T00:00:00.000Z", open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
          { timestamp: "2026-01-01T01:00:00.000Z", open: 100.5, high: 102, low: 100, close: 101.5, volume: 12 },
          { timestamp: "2026-01-01T02:00:00.000Z", open: 101.5, high: 103, low: 101, close: 102.5, volume: 11 },
        ],
      });
      expect(result.report.validationStatus).toBe("VALID");
      expect(result.report.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("accepts a valid JSON import (array of row objects) with equivalent output to the CSV form", () => {
    const jsonRows = VALID_ROWS.map((row) => {
      const [timestamp, open, high, low, close, volume] = row.split(",");
      return { timestamp, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
    });
    const csvResult = prepareDataset({ ...BASE, rawText: csvRows(VALID_ROWS), format: "csv" });
    const jsonResult = prepareDataset({ ...BASE, rawText: JSON.stringify(jsonRows), format: "json", inputFileLabel: "input.json" });
    expect(jsonResult.ok).toBe(true);
    if (csvResult.ok && jsonResult.ok) {
      expect(jsonResult.document.candles).toEqual(csvResult.document.candles);
      expect(jsonResult.datasetHash).toBe(csvResult.datasetHash);
    }
  });

  it("discards unrecognised columns at the input-adapter level and reports them as a warning, never carrying them into the output", () => {
    const rawText = ["timestamp,open,high,low,close,exchange_id", "2026-01-01T00:00:00Z,100,101,99,100.5,XYZ", "2026-01-01T01:00:00Z,100.5,102,100,101.5,XYZ"].join("\n");
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.document)).not.toContain("exchange_id");
      expect(JSON.stringify(result.document)).not.toContain("XYZ");
      expect(result.report.warnings.some((w) => w.includes("exchange_id"))).toBe(true);
    }
  });

  it("preserves exact numeric values without rounding", () => {
    const rawText = csvRows(["2026-01-01T00:00:00Z,100.123456789,101.1,99.1,100.500001,10", "2026-01-01T01:00:00Z,100.5,102,100,101.5,12"]);
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.candles[0]!.open).toBe(100.123456789);
  });
});

describe("prepareDataset — timezone handling", () => {
  it("applies the declared UTC assumption to a naive (offset-less) timestamp", () => {
    const rawText = csvRows(["2026-01-01 00:00:00,100,101,99,100.5,10", "2026-01-01 01:00:00,100.5,102,100,101.5,12"]);
    const result = prepareDataset({ ...BASE, rawText, format: "csv", timezone: "UTC" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.candles[0]!.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });

  it("applies a declared fixed-offset assumption to a naive timestamp, converting it to UTC", () => {
    const rawText = csvRows(["2026-01-01 02:00:00,100,101,99,100.5,10", "2026-01-01 03:00:00,100.5,102,100,101.5,12"]);
    const result = prepareDataset({ ...BASE, rawText, format: "csv", timezone: "+02:00" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.candles[0]!.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });

  it("parses a timestamp with its own explicit offset as-is, ignoring a conflicting --timezone assumption", () => {
    const rawText = csvRows(["2026-01-01T05:00:00+05:00,100,101,99,100.5,10", "2026-01-01T06:00:00+05:00,100.5,102,100,101.5,12"]);
    const result = prepareDataset({ ...BASE, rawText, format: "csv", timezone: "UTC" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.candles[0]!.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });

  it("isSupportedTimezoneAssumption accepts UTC and fixed offsets, rejects named zones", () => {
    expect(isSupportedTimezoneAssumption("UTC")).toBe(true);
    expect(isSupportedTimezoneAssumption("+02:00")).toBe(true);
    expect(isSupportedTimezoneAssumption("-05:00")).toBe(true);
    expect(isSupportedTimezoneAssumption("America/New_York")).toBe(false);
  });

  it("isSupportedTimezoneAssumption rejects an offset outside the real-world -12:00..+14:00 range", () => {
    expect(isSupportedTimezoneAssumption("+25:00")).toBe(false);
    expect(isSupportedTimezoneAssumption("-20:00")).toBe(false);
  });

  it("isSupportedTimezoneAssumption rejects an invalid minute component", () => {
    expect(isSupportedTimezoneAssumption("+02:99")).toBe(false);
  });

  it("applies a NEGATIVE fixed-offset assumption to a naive timestamp, converting it to UTC", () => {
    const rawText = csvRows(["2025-12-31T19:00:00,100,101,99,100.5,10", "2025-12-31T20:00:00,100.5,102,100,101.5,12"]);
    const result = prepareDataset({ ...BASE, rawText, format: "csv", timezone: "-05:00" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.candles[0]!.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });

  it("day, month, and year rollovers convert correctly under a fixed offset", () => {
    // 2026-01-01T00:00:00+05:00 is 2025-12-31T19:00:00Z — crosses year, month, and day boundaries at once.
    const rawText = csvRows(["2026-01-01T00:00:00+05:00,100,101,99,100.5,10", "2026-01-01T01:00:00+05:00,100.5,102,100,101.5,12"]);
    const result = prepareDataset({ ...BASE, rawText, format: "csv", timezone: "UTC" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.candles[0]!.timestamp).toBe("2025-12-31T19:00:00.000Z");
  });

  it("equivalent instants expressed via different explicit offsets produce identical canonical UTC output", () => {
    const viaPlus2 = prepareDataset({ ...BASE, rawText: csvRows(["2026-01-01T02:00:00+02:00,100,101,99,100.5,10", "2026-01-01T03:00:00+02:00,100.5,102,100,101.5,12"]), format: "csv" });
    const viaPlus5 = prepareDataset({ ...BASE, rawText: csvRows(["2026-01-01T05:00:00+05:00,100,101,99,100.5,10", "2026-01-01T06:00:00+05:00,100.5,102,100,101.5,12"]), format: "csv" });
    expect(viaPlus2.ok && viaPlus5.ok).toBe(true);
    if (viaPlus2.ok && viaPlus5.ok) {
      expect(viaPlus2.document.candles[0]!.timestamp).toBe("2026-01-01T00:00:00.000Z");
      expect(viaPlus2.document.candles[0]!.timestamp).toBe(viaPlus5.document.candles[0]!.timestamp);
    }
  });

  it("rejects an invalid calendar date (2026-02-30 does not exist) rather than silently rolling it over to March", () => {
    const rawText = csvRows(["2026-02-30T00:00:00Z,100,101,99,100.5,10", "2026-02-30T01:00:00Z,100.5,102,100,101.5,12"]);
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_ROWS");
  });

  it("rejects Feb 29 in a non-leap year but accepts it in a leap year", () => {
    const nonLeap = prepareDataset({ ...BASE, rawText: csvRows(["2026-02-29T00:00:00Z,100,101,99,100.5,10", "2026-02-29T01:00:00Z,100.5,102,100,101.5,12"]), format: "csv" });
    expect(nonLeap.ok).toBe(false);
    if (!nonLeap.ok) expect(nonLeap.reason).toBe("INVALID_ROWS");
    const leap = prepareDataset({ ...BASE, rawText: csvRows(["2028-02-29T00:00:00Z,100,101,99,100.5,10", "2028-02-29T01:00:00Z,100.5,102,100,101.5,12"]), format: "csv" });
    expect(leap.ok).toBe(true);
  });

  it("detects a duplicate timestamp only visible AFTER UTC normalisation (same instant, two different explicit offsets)", () => {
    const rawText = ["timestamp,open,high,low,close", "2026-01-01T00:00:00Z,100,101,99,100.5", "2026-01-01T02:00:00+02:00,100.5,102,100,101.5"].join("\n");
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DUPLICATE_TIMESTAMP");
    expect(result.report.duplicateCount).toBe(1);
  });
});

describe("prepareDataset — duplicate/ambiguous column names", () => {
  it("rejects two headers that normalise to the same logical column (Timestamp and timestamp)", () => {
    const rawText = ["Timestamp,timestamp,open,high,low,close", "2026-01-01T00:00:00Z,2026-01-01T00:00:00Z,100,101,99,100.5"].join("\n");
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("AMBIGUOUS_INPUT_COLUMN");
  });

  it("rejects two headers that normalise to the same OHLC column (Open and open)", () => {
    const rawText = ["timestamp,Open,open,high,low,close", "2026-01-01T00:00:00Z,100,100,101,99,100.5"].join("\n");
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("AMBIGUOUS_INPUT_COLUMN");
  });
});

describe("prepareDataset — CSV quoting", () => {
  it("correctly parses a quoted field containing a comma, never miscounting the row's own field count", () => {
    const rawText = ["timestamp,open,high,low,close,volume,note", '2026-01-01T00:00:00Z,100,101,99,100.5,10,"contains, a comma"', "2026-01-01T01:00:00Z,100.5,102,100,101.5,12,plain"].join("\n");
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.candles).toHaveLength(2);
  });

  it("correctly unescapes a doubled double-quote inside a quoted field", () => {
    const rawText = ["timestamp,open,high,low,close,instrument", '2026-01-01T00:00:00Z,100,101,99,100.5,"BT""C"', '2026-01-01T01:00:00Z,100.5,102,100,101.5,"BT""C"'].join("\n");
    const result = prepareDataset({ ...BASE, rawText, format: "csv", instrument: 'BT"C' });
    expect(result.ok).toBe(true);
  });
});

describe("prepareDataset — hash boundary", () => {
  it("input file hash differs across two byte-different-but-logically-identical inputs, while the dataset hash stays identical", () => {
    const compact = csvRows(VALID_ROWS);
    const withExtraWhitespace = csvRows(VALID_ROWS.map((row) => row.split(",").map((f) => ` ${f} `).join(",")));
    const a = prepareDataset({ ...BASE, rawText: compact, format: "csv" });
    const b = prepareDataset({ ...BASE, rawText: withExtraWhitespace, format: "csv" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.provenance.inputFileHash).not.toBe(b.provenance.inputFileHash);
      expect(a.datasetHash).toBe(b.datasetHash);
    }
  });
});

describe("prepareDataset — rejections", () => {
  it("rejects an ambiguous timestamp column (both timestamp and time present)", () => {
    const rawText = ["timestamp,time,open,high,low,close", "2026-01-01T00:00:00Z,2026-01-01T00:00:00Z,100,101,99,100.5"].join("\n");
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("AMBIGUOUS_TIMESTAMP_COLUMN");
  });

  it("rejects missing required columns", () => {
    const rawText = ["timestamp,open,high,close", "2026-01-01T00:00:00Z,100,101,100.5"].join("\n");
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MISSING_REQUIRED_COLUMNS");
  });

  it("rejects duplicate timestamps (delegated to Phase 2's own validator)", () => {
    const rawText = csvRows(["2026-01-01T00:00:00Z,100,101,99,100.5,10", "2026-01-01T00:00:00Z,100,101,99,100.5,10"]);
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DUPLICATE_TIMESTAMP");
    expect(result.report.duplicateCount).toBe(1);
  });

  it("rejects out-of-order timestamps", () => {
    const rawText = csvRows(["2026-01-01T01:00:00Z,100,101,99,100.5,10", "2026-01-01T00:00:00Z,100,101,99,100.5,10"]);
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("OUT_OF_ORDER_TIMESTAMP");
    expect(result.report.outOfOrderCount).toBe(1);
  });

  it("rejects a gap that does not exactly equal the declared timeframe's interval — never filled", () => {
    const rawText = csvRows(["2026-01-01T00:00:00Z,100,101,99,100.5,10", "2026-01-01T03:00:00Z,100,101,99,100.5,10"]);
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
    expect(result.report.gapCount).toBe(1);
  });

  it("rejects invalid OHLC ordering (high below low)", () => {
    const rawText = csvRows(["2026-01-01T00:00:00Z,100,90,99,95,10", "2026-01-01T01:00:00Z,100,101,99,100.5,10"]);
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_OHLC");
  });

  it("rejects a zero/negative OHLC value", () => {
    const rawText = csvRows(["2026-01-01T00:00:00Z,0,101,99,100.5,10", "2026-01-01T01:00:00Z,100,101,99,100.5,10"]);
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-finite/malformed numeric value as an invalid row, never silently dropping it", () => {
    const rawText = csvRows(["2026-01-01T00:00:00Z,not-a-number,101,99,100.5,10", "2026-01-01T01:00:00Z,100,101,99,100.5,10"]);
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("INVALID_ROWS");
      expect(result.report.invalidRowCount).toBe(1);
    }
  });

  it("rejects a malformed/partial row (wrong field count)", () => {
    const rawText = ["timestamp,open,high,low,close,volume", "2026-01-01T00:00:00Z,100,101,99", "2026-01-01T01:00:00Z,100,101,99,100.5,10"].join("\n");
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_INPUT_SHAPE");
  });

  it("rejects a bare numeric epoch timestamp (ambiguous seconds vs. milliseconds — never guessed)", () => {
    const rawText = csvRows(["1767225600,100,101,99,100.5,10", "1767229200,100.5,102,100,101.5,12"]);
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_ROWS");
  });

  it("rejects a file whose own instrument/symbol column disagrees with the declared --instrument", () => {
    const rawText = ["timestamp,open,high,low,close,instrument", "2026-01-01T00:00:00Z,100,101,99,100.5,ETH", "2026-01-01T01:00:00Z,100,101,99,100.5,ETH"].join("\n");
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MIXED_INSTRUMENT");
  });

  it("rejects a file whose own instrument column mixes multiple values", () => {
    const rawText = ["timestamp,open,high,low,close,instrument", "2026-01-01T00:00:00Z,100,101,99,100.5,BTC", "2026-01-01T01:00:00Z,100,101,99,100.5,ETH"].join("\n");
    const result = prepareDataset({ ...BASE, rawText, format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MIXED_INSTRUMENT");
  });
});

describe("prepareDataset — determinism", () => {
  it("produces an identical dataset hash across repeated runs of the same input", () => {
    const a = prepareDataset({ ...BASE, rawText: csvRows(VALID_ROWS), format: "csv" });
    const b = prepareDataset({ ...BASE, rawText: csvRows(VALID_ROWS), format: "csv" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.datasetHash).toBe(b.datasetHash);
  });

  it("changes the dataset hash when any candle value changes", () => {
    const a = prepareDataset({ ...BASE, rawText: csvRows(VALID_ROWS), format: "csv" });
    const mutatedRows = [...VALID_ROWS];
    mutatedRows[0] = mutatedRows[0]!.replace("100.5", "100.6");
    const b = prepareDataset({ ...BASE, rawText: csvRows(mutatedRows), format: "csv" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.datasetHash).not.toBe(b.datasetHash);
  });
});

describe("sliceCandlesByDateRange — IS/OOS slicing", () => {
  const candles = VALID_ROWS.map((row) => {
    const [timestamp, open, high, low, close, volume] = row.split(",");
    return { timestamp: new Date(timestamp!).toISOString(), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });

  it("dateFrom is inclusive, dateTo is exclusive", () => {
    const slice = sliceCandlesByDateRange(candles, candles[1]!.timestamp, undefined);
    expect(slice.map((c) => c.timestamp)).toEqual([candles[1]!.timestamp, candles[2]!.timestamp]);
    const upper = sliceCandlesByDateRange(candles, undefined, candles[1]!.timestamp);
    expect(upper.map((c) => c.timestamp)).toEqual([candles[0]!.timestamp]);
  });

  it("adjacent IS/OOS slices sharing a boundary have no overlap and no candle duplicated across them", () => {
    const boundary = candles[1]!.timestamp;
    const inSample = sliceCandlesByDateRange(candles, undefined, boundary);
    const outOfSample = sliceCandlesByDateRange(candles, boundary, undefined);
    const inSampleTimestamps = new Set(inSample.map((c) => c.timestamp));
    for (const c of outOfSample) expect(inSampleTimestamps.has(c.timestamp)).toBe(false);
    expect(inSample.length + outOfSample.length).toBe(candles.length);
  });

  it("each slice independently re-validates through prepareDataset, and a slice's hash differs from the full-history hash", () => {
    const full = prepareDataset({ ...BASE, rawText: csvRows(VALID_ROWS), format: "csv" });
    const sliced = prepareDataset({ ...BASE, rawText: csvRows(VALID_ROWS), format: "csv", dateTo: candles[2]!.timestamp });
    expect(full.ok && sliced.ok).toBe(true);
    if (full.ok && sliced.ok) {
      expect(sliced.document.candles.length).toBe(2);
      expect(sliced.datasetHash).not.toBe(full.datasetHash);
      expect(sliced.report.sliceRequested).toBe(true);
      expect(sliced.report.sliceCandleCount).toBe(2);
    }
  });

  it("rejects a slice that leaves fewer than 2 candles (re-validated independently, never fabricated)", () => {
    const result = prepareDataset({ ...BASE, rawText: csvRows(VALID_ROWS), format: "csv", dateTo: candles[1]!.timestamp });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("SLICE_INVALID");
  });

  it("rejects a completely empty slice (bounds entirely outside the source dataset's range), never fabricating a candle", () => {
    const beforeAll = prepareDataset({ ...BASE, rawText: csvRows(VALID_ROWS), format: "csv", dateTo: "2020-01-01T00:00:00Z" });
    expect(beforeAll.ok).toBe(false);
    if (!beforeAll.ok) expect(beforeAll.reason).toBe("SLICE_INVALID");
    const afterAll = prepareDataset({ ...BASE, rawText: csvRows(VALID_ROWS), format: "csv", dateFrom: "2030-01-01T00:00:00Z" });
    expect(afterAll.ok).toBe(false);
    if (!afterAll.ok) expect(afterAll.reason).toBe("SLICE_INVALID");
  });

  it("a boundary exactly on a candle's own timestamp places exactly that candle on the dateTo-exclusive side, never dropping or duplicating it", () => {
    const fourRows = ["2026-01-01T00:00:00Z,100,101,99,100.5,10", "2026-01-01T01:00:00Z,100,101,99,100.5,10", "2026-01-01T02:00:00Z,100,101,99,100.5,10", "2026-01-01T03:00:00Z,100,101,99,100.5,10"];
    const boundary = "2026-01-01T02:00:00.000Z"; // exactly candle[2]'s own timestamp
    const before = prepareDataset({ ...BASE, rawText: csvRows(fourRows), format: "csv", dateTo: boundary });
    const atAndAfter = prepareDataset({ ...BASE, rawText: csvRows(fourRows), format: "csv", dateFrom: boundary });
    expect(before.ok && atAndAfter.ok).toBe(true);
    if (before.ok && atAndAfter.ok) {
      // Exactly one candle on each side of the boundary itself: the one immediately before it, and
      // the one exactly at it (dateTo excludes the boundary candle; dateFrom includes it).
      expect(before.document.candles.map((c) => c.timestamp)).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z"]);
      expect(atAndAfter.document.candles.map((c) => c.timestamp)).toEqual(["2026-01-01T02:00:00.000Z", "2026-01-01T03:00:00.000Z"]);
      expect(before.document.candles.some((c) => c.timestamp === boundary)).toBe(false);
      expect(atAndAfter.document.candles.some((c) => c.timestamp === boundary)).toBe(true);
    }
  });
});

describe("prepareDataset — known market closures passthrough", () => {
  const CLOSURE: DatasetKnownClosure = {
    provider: "BINANCE",
    market: "SPOT",
    symbol: "BTC",
    timeframe: "1h",
    missingOpenTime: "2023-03-24T15:00:00.000Z",
    reasonCode: "EXCHANGE_SYSTEM_OUTAGE",
    description: "Binance spot trading suspension during temporary system maintenance",
    sourceReference: "test citation",
    status: "VERIFIED_EXCEPTION",
    registryVersion: 1,
    closureId: "test-closure-id",
  };

  const GAP_ROWS = [
    "2023-03-24T13:00:00Z,100,101,99,100.5,10",
    "2023-03-24T14:00:00Z,100.5,102,100,101.5,12",
    "2023-03-24T16:00:00Z,101.5,103,101,102.5,11",
    "2023-03-24T17:00:00Z,102.5,104,102,103.5,9",
  ];

  it("accepts a gap covered by an explicit knownClosures entry and threads it through report/provenance", () => {
    const result = prepareDataset({ ...BASE, rawText: csvRows(GAP_ROWS), format: "csv", knownClosures: [CLOSURE] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.candles.some((c) => c.timestamp === "2023-03-24T15:00:00.000Z")).toBe(false);
      expect(result.document.knownClosures).toEqual([CLOSURE]);
      expect(result.report.knownClosureCount).toBe(1);
      expect(result.provenance.appliedKnownClosures).toEqual([CLOSURE]);
    }
  });

  it("still rejects the identical gap when knownClosures is not supplied", () => {
    const result = prepareDataset({ ...BASE, rawText: csvRows(GAP_ROWS), format: "csv" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
  });

  it("a knownClosures entry survives a --date-from/--date-to slice that still contains the gap", () => {
    const result = prepareDataset({
      ...BASE,
      rawText: csvRows(GAP_ROWS),
      format: "csv",
      knownClosures: [CLOSURE],
      dateFrom: "2023-03-24T13:00:00.000Z",
      dateTo: "2023-03-24T18:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provenance.appliedKnownClosures).toEqual([CLOSURE]);
  });

  it("the prepared dataset hash changes when closure metadata changes, with the identical real gap explained both times", () => {
    // Same GAP_ROWS (identical candles) both times — only the closure's own reasonCode differs, and
    // both variants actually explain the same real 15:00 gap (an unused/unrelated closure is now
    // rejected outright — see the pre-commit review test below — so this can no longer compare an
    // "applied" vs. "merely declared" variant).
    const withClosure = prepareDataset({ ...BASE, rawText: csvRows(GAP_ROWS), format: "csv", knownClosures: [CLOSURE] });
    const withDifferentReason = prepareDataset({ ...BASE, rawText: csvRows(GAP_ROWS), format: "csv", knownClosures: [{ ...CLOSURE, reasonCode: "OTHER_REASON" }] });
    expect(withClosure.ok && withDifferentReason.ok).toBe(true);
    if (withClosure.ok && withDifferentReason.ok) expect(withClosure.datasetHash).not.toBe(withDifferentReason.datasetHash);
  });

  it("rejects a declared closure that never explains any actual gap (pre-commit review)", () => {
    const rows = ["2026-01-01T00:00:00Z,100,101,99,100.5,10", "2026-01-01T01:00:00Z,100.5,102,100,101.5,12"]; // perfectly contiguous, no gap
    const result = prepareDataset({ ...BASE, rawText: csvRows(rows), format: "csv", knownClosures: [{ ...CLOSURE, missingOpenTime: "2026-02-01T00:00:00.000Z" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNAPPLIED_CLOSURE_ENTRY");
  });

  it("rejects a closure whose missingOpenTime lies outside the dataset's own date range (pre-commit review)", () => {
    const result = prepareDataset({
      ...BASE,
      rawText: csvRows(GAP_ROWS),
      format: "csv",
      knownClosures: [CLOSURE, { ...CLOSURE, missingOpenTime: "2020-01-01T00:00:00.000Z", closureId: "far-outside-range" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNAPPLIED_CLOSURE_ENTRY");
  });
});
