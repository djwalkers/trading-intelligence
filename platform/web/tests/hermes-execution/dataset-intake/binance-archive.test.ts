import { describe, expect, it } from "vitest";
import {
  buildArchiveLocation,
  checkNoMonthOverlap,
  computeSha256Hex,
  detectTimestampUnit,
  convertBinanceTimestampToUtcIso,
  generateMonthRange,
  INSTRUMENT_TO_BINANCE_SYMBOL,
  parseBinanceKlineCsv,
  parseChecksumFile,
  validateMonthlyArchiveRows,
  type BinanceKlineRow,
} from "@/lib/hermes-execution/dataset-intake/binance-archive";

// Phase 4 — Historical Dataset Intake. Pure Binance archive logic — no network, no filesystem I/O.

describe("buildArchiveLocation — official source convention and symbol mapping", () => {
  it("builds the exact official URL convention", () => {
    const location = buildArchiveLocation("BTCUSDT", "2023-05");
    expect(location.zipUrl).toBe("https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2023-05.zip");
    expect(location.checksumUrl).toBe("https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2023-05.zip.CHECKSUM");
    expect(location.zipFileName).toBe("BTCUSDT-1h-2023-05.zip");
  });

  it("maps BTC/ETH/SOL to their official USDT spot symbols", () => {
    expect(INSTRUMENT_TO_BINANCE_SYMBOL.BTC).toBe("BTCUSDT");
    expect(INSTRUMENT_TO_BINANCE_SYMBOL.ETH).toBe("ETHUSDT");
    expect(INSTRUMENT_TO_BINANCE_SYMBOL.SOL).toBe("SOLUSDT");
  });
});

describe("generateMonthRange", () => {
  it("generates an inclusive, ascending month list", () => {
    const result = generateMonthRange("2023-11", "2024-02");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.months).toEqual(["2023-11", "2023-12", "2024-01", "2024-02"]);
  });

  it("rejects an invalid format", () => {
    expect(generateMonthRange("2023-1", "2023-12").ok).toBe(false);
    expect(generateMonthRange("2023-13", "2023-12").ok).toBe(false);
  });

  it("rejects from after to", () => {
    expect(generateMonthRange("2024-01", "2023-01").ok).toBe(false);
  });

  it("accepts from equal to to (single month)", () => {
    const result = generateMonthRange("2023-06", "2023-06");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.months).toEqual(["2023-06"]);
  });
});

describe("parseChecksumFile", () => {
  it("parses a valid sha256sum-style checksum line", () => {
    const result = parseChecksumFile(`${"a".repeat(64)}  BTCUSDT-1h-2023-05.zip\n`, "BTCUSDT-1h-2023-05.zip");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sha256).toBe("a".repeat(64));
  });

  it("rejects a checksum file naming a different archive", () => {
    const result = parseChecksumFile(`${"a".repeat(64)}  BTCUSDT-1h-2023-06.zip`, "BTCUSDT-1h-2023-05.zip");
    expect(result.ok).toBe(false);
  });

  it("rejects malformed checksum text", () => {
    expect(parseChecksumFile("not a checksum", "BTCUSDT-1h-2023-05.zip").ok).toBe(false);
  });
});

describe("computeSha256Hex", () => {
  it("matches node:crypto's own sha256 for known content", () => {
    expect(computeSha256Hex(Buffer.from("hello"))).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});

describe("detectTimestampUnit", () => {
  it("detects milliseconds for a realistic ms-epoch value", () => {
    expect(detectTimestampUnit(Date.parse("2024-06-01T00:00:00Z"))).toBe("MILLISECONDS");
  });

  it("detects microseconds for a realistic us-epoch value", () => {
    expect(detectTimestampUnit(Date.parse("2025-06-01T00:00:00Z") * 1000)).toBe("MICROSECONDS");
  });

  it("rejects a seconds-scale value", () => {
    expect(detectTimestampUnit(Math.floor(Date.parse("2024-06-01T00:00:00Z") / 1000))).toBeUndefined();
  });

  it("rejects a nanoseconds-scale value", () => {
    expect(detectTimestampUnit(Date.parse("2024-06-01T00:00:00Z") * 1_000_000)).toBeUndefined();
  });

  it("rejects a value in the ambiguous gap between milliseconds and microseconds ranges", () => {
    expect(detectTimestampUnit(1e14)).toBeUndefined();
  });

  it("rejects a negative or non-integer value", () => {
    expect(detectTimestampUnit(-1)).toBeUndefined();
    expect(detectTimestampUnit(1_700_000_000_000.5)).toBeUndefined();
  });
});

describe("convertBinanceTimestampToUtcIso", () => {
  it("converts milliseconds and microseconds representations of the same instant identically", () => {
    const ms = Date.parse("2025-03-01T05:00:00Z");
    expect(convertBinanceTimestampToUtcIso(ms, "MILLISECONDS")).toBe("2025-03-01T05:00:00.000Z");
    expect(convertBinanceTimestampToUtcIso(ms * 1000, "MICROSECONDS")).toBe("2025-03-01T05:00:00.000Z");
  });
});

describe("parseBinanceKlineCsv", () => {
  it("consumes only the first six columns, ignoring the rest", () => {
    const row = "1704067200000,100,101,99,100.5,10,1704070799999,1005,50,5,502.5,0";
    const result = parseBinanceKlineCsv(row);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toEqual([{ openTimeRaw: 1704067200000, open: 100, high: 101, low: 99, close: 100.5, volume: 10 }]);
    }
  });

  it("rejects a row with fewer than six columns", () => {
    const result = parseBinanceKlineCsv("1704067200000,100,101,99");
    expect(result.ok).toBe(false);
  });

  it("rejects a non-numeric value", () => {
    const result = parseBinanceKlineCsv("1704067200000,not-a-number,101,99,100.5,10");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty archive", () => {
    expect(parseBinanceKlineCsv("").ok).toBe(false);
  });

  it("rejects an open time value that is not a safe integer (precision-unsafe)", () => {
    // 9999999999999999 exceeds Number.MAX_SAFE_INTEGER; Number() silently rounds it, which would
    // otherwise let a corrupt/adversarial row be accepted with a wrong, precision-lossy timestamp.
    const result = parseBinanceKlineCsv("9999999999999999,100,101,99,100.5,10");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MALFORMED_ROW");
  });
});

function makeMonthRows(year: number, month: number, unit: "MILLISECONDS" | "MICROSECONDS" = "MILLISECONDS"): BinanceKlineRow[] {
  const hours = new Date(Date.UTC(year, month, 0)).getUTCDate() * 24;
  const rows: BinanceKlineRow[] = [];
  for (let i = 0; i < hours; i++) {
    const ms = Date.UTC(year, month - 1, 1, 0, 0, 0) + i * 3_600_000;
    const openTimeRaw = unit === "MILLISECONDS" ? ms : ms * 1000;
    rows.push({ openTimeRaw, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10 });
  }
  return rows;
}

describe("validateMonthlyArchiveRows", () => {
  it("accepts a well-formed, complete month of hourly rows", () => {
    const result = validateMonthlyArchiveRows(makeMonthRows(2024, 2), "2024-02"); // leap year February
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.archive.candles).toHaveLength(29 * 24);
      expect(result.archive.unit).toBe("MILLISECONDS");
    }
  });

  it("accepts microsecond-unit rows (the 2025 Binance transition)", () => {
    const result = validateMonthlyArchiveRows(makeMonthRows(2025, 3, "MICROSECONDS"), "2025-03");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.archive.unit).toBe("MICROSECONDS");
  });

  it("rejects a missing hour (row count short of expected)", () => {
    const rows = makeMonthRows(2024, 1);
    rows.splice(5, 1);
    const result = validateMonthlyArchiveRows(rows, "2024-01");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
  });

  it("rejects a duplicate hour", () => {
    const rows = makeMonthRows(2024, 1);
    rows[1] = { ...rows[0]! };
    const result = validateMonthlyArchiveRows(rows, "2024-01");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DUPLICATE_TIMESTAMP");
  });

  it("rejects out-of-order rows", () => {
    const rows = makeMonthRows(2024, 1);
    [rows[0], rows[1]] = [rows[1]!, rows[0]!];
    const result = validateMonthlyArchiveRows(rows, "2024-01");
    expect(result.ok).toBe(false);
  });

  it("rejects mixed timestamp units within one archive", () => {
    const rows = makeMonthRows(2024, 1);
    rows[10] = { ...rows[10]!, openTimeRaw: rows[10]!.openTimeRaw * 1000 };
    const result = validateMonthlyArchiveRows(rows, "2024-01");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MIXED_TIMESTAMP_UNITS");
  });

  it("rejects an ambiguous timestamp unit", () => {
    const rows = makeMonthRows(2024, 1);
    rows[0] = { ...rows[0]!, openTimeRaw: 1e14 };
    const result = validateMonthlyArchiveRows(rows, "2024-01");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("AMBIGUOUS_TIMESTAMP_UNIT");
  });

  it("rejects a row falling outside the archive's own declared calendar month", () => {
    const rows = makeMonthRows(2024, 1);
    rows[0] = { ...rows[0]!, openTimeRaw: Date.UTC(2023, 11, 31, 23) };
    const result = validateMonthlyArchiveRows(rows, "2024-01");
    expect(result.ok).toBe(false);
  });

  it("produces the exact expected row count for the declared month", () => {
    const result = validateMonthlyArchiveRows(makeMonthRows(2023, 4), "2023-04"); // 30-day month
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.archive.candles).toHaveLength(30 * 24);
  });
});

describe("validateMonthlyArchiveRows — known market closures", () => {
  it("accepts the exact real gap (13:00Z missing, 12:00Z/14:00Z present) and never inserts a candle for it — corrected from a previously misidentified 15:00Z (pre-commit review)", () => {
    const rows = makeMonthRows(2023, 3);
    const missingIndex = rows.findIndex((r) => r.openTimeRaw === Date.UTC(2023, 2, 24, 13));
    expect(missingIndex).toBeGreaterThan(0);
    rows.splice(missingIndex, 1);
    const result = validateMonthlyArchiveRows(rows, "2023-03", new Set(["2023-03-24T13:00:00.000Z"]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.archive.candles).toHaveLength(31 * 24 - 1);
      expect(result.archive.candles.some((c) => c.timestamp === "2023-03-24T13:00:00.000Z")).toBe(false);
      expect(result.archive.appliedKnownMissingOpenTimes).toEqual(["2023-03-24T13:00:00.000Z"]);
      // 12:00Z and 14:00Z (the real, present neighbours) and 15:00Z (also real, present, and NOT
      // declared as a closure) all remain ordinary candles in the output.
      expect(result.archive.candles.some((c) => c.timestamp === "2023-03-24T12:00:00.000Z")).toBe(true);
      expect(result.archive.candles.some((c) => c.timestamp === "2023-03-24T14:00:00.000Z")).toBe(true);
      expect(result.archive.candles.some((c) => c.timestamp === "2023-03-24T15:00:00.000Z")).toBe(true);
    }
  });

  it("rejects the identical gap when no knownMissingOpenTimes are supplied", () => {
    const rows = makeMonthRows(2023, 3);
    const missingIndex = rows.findIndex((r) => r.openTimeRaw === Date.UTC(2023, 2, 24, 13));
    rows.splice(missingIndex, 1);
    const result = validateMonthlyArchiveRows(rows, "2023-03");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
  });

  it("rejects an extra, unexplained adjacent missing hour", () => {
    const rows = makeMonthRows(2023, 3);
    const idx13 = rows.findIndex((r) => r.openTimeRaw === Date.UTC(2023, 2, 24, 13));
    rows.splice(idx13, 2); // also removes 14:00, only 13:00 is declared known
    const result = validateMonthlyArchiveRows(rows, "2023-03", new Set(["2023-03-24T13:00:00.000Z"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
  });

  it("rejects partial coverage of a two-hour gap", () => {
    const rows = makeMonthRows(2023, 3);
    const idx13 = rows.findIndex((r) => r.openTimeRaw === Date.UTC(2023, 2, 24, 13));
    rows.splice(idx13, 2); // removes 13:00 and 14:00
    const result = validateMonthlyArchiveRows(rows, "2023-03", new Set(["2023-03-24T13:00:00.000Z"])); // only 13:00 declared
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
  });

  it("rejects a gap containing one known and one unknown missing hour (pre-commit review)", () => {
    const rows = makeMonthRows(2023, 3);
    const idx13 = rows.findIndex((r) => r.openTimeRaw === Date.UTC(2023, 2, 24, 13));
    rows.splice(idx13, 2); // removes 13:00 (known) and 14:00 (unknown)
    const result = validateMonthlyArchiveRows(rows, "2023-03", new Set(["2023-03-24T13:00:00.000Z", "2023-03-24T20:00:00.000Z"])); // 14:00 never declared
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
  });

  it("rejects an archive missing its very first hour of the month, even with an unrelated known closure active (pre-commit review)", () => {
    const rows = makeMonthRows(2023, 3);
    rows.shift(); // drop the 00:00 row — no adjacent-pair gap ever sees this, only the row-count check can catch it
    const result = validateMonthlyArchiveRows(rows, "2023-03", new Set(["2023-03-24T13:00:00.000Z"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNEXPECTED_ROW_COUNT");
  });

  it("rejects an archive missing its very last hour of the month, even with an unrelated known closure active (pre-commit review)", () => {
    const rows = makeMonthRows(2023, 3);
    rows.pop(); // drop the 23:00 row on the last day
    const result = validateMonthlyArchiveRows(rows, "2023-03", new Set(["2023-03-24T13:00:00.000Z"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNEXPECTED_ROW_COUNT");
  });

  it("a wrong (irrelevant) known-missing entry never explains a real gap", () => {
    const rows = makeMonthRows(2023, 3);
    const missingIndex = rows.findIndex((r) => r.openTimeRaw === Date.UTC(2023, 2, 24, 13));
    rows.splice(missingIndex, 1);
    const result = validateMonthlyArchiveRows(rows, "2023-03", new Set(["2023-06-01T00:00:00.000Z"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
  });

  it("negative regression (pre-commit review): removing the REAL, present 15:00Z candle is still rejected as an ordinary unexplained gap", () => {
    const rows = makeMonthRows(2023, 3);
    const idx15 = rows.findIndex((r) => r.openTimeRaw === Date.UTC(2023, 2, 24, 15));
    rows.splice(idx15, 1);
    // Even with the (correct, corrected) 13:00Z closure declared, removing 15:00Z — never declared —
    // must still be rejected; 15:00Z was never the closure and must never be silently excused.
    const result = validateMonthlyArchiveRows(rows, "2023-03", new Set(["2023-03-24T13:00:00.000Z"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAP_DETECTED");
  });
});

describe("checkNoMonthOverlap", () => {
  it("accepts perfectly contiguous months", () => {
    const jan = validateMonthlyArchiveRows(makeMonthRows(2024, 1), "2024-01");
    const feb = validateMonthlyArchiveRows(makeMonthRows(2024, 2), "2024-02");
    expect(jan.ok && feb.ok).toBe(true);
    if (jan.ok && feb.ok) expect(checkNoMonthOverlap([jan.archive, feb.archive]).ok).toBe(true);
  });

  it("rejects an overlapping or non-contiguous month boundary", () => {
    const jan = validateMonthlyArchiveRows(makeMonthRows(2024, 1), "2024-01");
    const mar = validateMonthlyArchiveRows(makeMonthRows(2024, 3), "2024-03"); // skips february
    expect(jan.ok && mar.ok).toBe(true);
    if (jan.ok && mar.ok) expect(checkNoMonthOverlap([jan.archive, mar.archive]).ok).toBe(false);
  });
});
