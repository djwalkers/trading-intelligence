import { createHash } from "node:crypto";

// Phase 4 — Historical Dataset Intake. Binance public spot monthly kline archive support: URL/month
// generation, CHECKSUM parsing, timestamp-unit detection, and Binance-specific row/archive shape
// validation — all PURE, no network, no filesystem I/O (that lives in binance-downloader.ts). Every
// generic dataset-content rule (gaps, duplicates, OHLC validity, the Phase 2 schema itself) is left
// entirely to Phase 4's own `prepareDataset`/Phase 2's `validateCandleDataset` — this module never
// re-implements those; it only checks properties SPECIFIC to a Binance monthly archive that neither
// of those generic validators has any way to know (the archive's own declared calendar month, its
// own expected row count, Binance's 2025 timestamp-unit change).

export const BINANCE_ARCHIVE_BASE_URL = "https://data.binance.vision";

export type BinanceSymbol = "BTCUSDT" | "ETHUSDT" | "SOLUSDT";
// Pre-commit review fix. Runtime-frozen, not just TS-`readonly` — binance-known-market-closures.ts's
// own `ALL_SPOT` expansion iterates this array to decide exactly which symbols a closure applies to;
// a runtime mutation here (accidental or malicious) would silently change that expansion for every
// already-validated registry entry without ever re-validating anything.
export const SUPPORTED_BINANCE_SYMBOLS: readonly BinanceSymbol[] = Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);

export type ResearchInstrument = "BTC" | "ETH" | "SOL";
export const RESEARCH_INSTRUMENTS: readonly ResearchInstrument[] = ["BTC", "ETH", "SOL"];
export const INSTRUMENT_TO_BINANCE_SYMBOL: Record<ResearchInstrument, BinanceSymbol> = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT" };
/** e.g. "BINANCE_SPOT_BTCUSDT" — the dataset `source` label recorded in every prepared document. */
export const SOURCE_LABEL_FOR_INSTRUMENT: Record<ResearchInstrument, string> = { BTC: "BINANCE_SPOT_BTCUSDT", ETH: "BINANCE_SPOT_ETHUSDT", SOL: "BINANCE_SPOT_SOLUSDT" };

export interface ArchiveLocation {
  symbol: BinanceSymbol;
  month: string; // "YYYY-MM"
  zipFileName: string;
  /** The exact filename Binance's own ZIP is expected to contain as its single entry — verified by
   * `extractSingleFileFromZip` (binance-zip.ts) before its content is ever trusted. */
  csvFileName: string;
  checksumFileName: string;
  zipUrl: string;
  checksumUrl: string;
}

/** Official convention only — `data/spot/monthly/klines/<SYMBOL>/1h/<SYMBOL>-1h-YYYY-MM.zip` plus
 * its matching `.CHECKSUM` file. Never an unofficial mirror; the base URL is a single fixed constant. */
export function buildArchiveLocation(symbol: BinanceSymbol, month: string): ArchiveLocation {
  const zipFileName = `${symbol}-1h-${month}.zip`;
  const csvFileName = `${symbol}-1h-${month}.csv`;
  const checksumFileName = `${zipFileName}.CHECKSUM`;
  const path = `/data/spot/monthly/klines/${symbol}/1h/${zipFileName}`;
  return { symbol, month, zipFileName, csvFileName, checksumFileName, zipUrl: `${BINANCE_ARCHIVE_BASE_URL}${path}`, checksumUrl: `${BINANCE_ARCHIVE_BASE_URL}${path}.CHECKSUM` };
}

const YYYY_MM_PATTERN = /^(\d{4})-(\d{2})$/;

export type MonthRangeResult = { ok: true; months: string[] } | { ok: false; detail: string };

/** Inclusive month range, in ascending "YYYY-MM" order. Never crosses into the current calendar
 * month or later relative to `now` — the caller's own `--to` is still bounded further by the CLI
 * (never a full current, possibly-partial month) via a separate, explicit check at the call site. */
export function generateMonthRange(from: string, to: string): MonthRangeResult {
  const fromMatch = YYYY_MM_PATTERN.exec(from);
  const toMatch = YYYY_MM_PATTERN.exec(to);
  if (!fromMatch) return { ok: false, detail: `--from must be in YYYY-MM format (got ${JSON.stringify(from)})` };
  if (!toMatch) return { ok: false, detail: `--to must be in YYYY-MM format (got ${JSON.stringify(to)})` };
  const fromYear = Number(fromMatch[1]);
  const fromMonth = Number(fromMatch[2]);
  const toYear = Number(toMatch[1]);
  const toMonth = Number(toMatch[2]);
  if (fromMonth < 1 || fromMonth > 12) return { ok: false, detail: `--from has an invalid month (got ${JSON.stringify(from)})` };
  if (toMonth < 1 || toMonth > 12) return { ok: false, detail: `--to has an invalid month (got ${JSON.stringify(to)})` };
  const fromIndex = fromYear * 12 + (fromMonth - 1);
  const toIndex = toYear * 12 + (toMonth - 1);
  if (fromIndex > toIndex) return { ok: false, detail: `--from (${from}) must not be after --to (${to})` };

  const months: string[] = [];
  for (let i = fromIndex; i <= toIndex; i++) {
    const year = Math.floor(i / 12);
    const month = (i % 12) + 1;
    months.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  return { ok: true, months };
}

/**
 * Binance `.CHECKSUM` files are plain `sha256sum`-style text: `<64-hex-char sha256>  <filename>`.
 * The filename inside the checksum file must match the archive we actually requested — a checksum
 * file for a DIFFERENT archive silently matched by hash alone would be a meaningless "pass."
 */
export function parseChecksumFile(text: string, expectedFileName: string): { ok: true; sha256: string } | { ok: false; detail: string } {
  const trimmed = text.trim();
  const match = /^([0-9a-fA-F]{64})\s+\**(\S+)$/.exec(trimmed.split("\n")[0] ?? "");
  if (!match) return { ok: false, detail: `checksum file is not in the expected "<sha256>  <filename>" format (got ${JSON.stringify(trimmed.slice(0, 120))})` };
  const [, sha256, fileName] = match;
  if (fileName !== expectedFileName) {
    return { ok: false, detail: `checksum file names "${fileName}", not the expected "${expectedFileName}" — refusing to trust a checksum for a different archive` };
  }
  return { ok: true, sha256: sha256!.toLowerCase() };
}

export function computeSha256Hex(buffer: Buffer | Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export type BinanceTimestampUnit = "MILLISECONDS" | "MICROSECONDS";

// Bounds chosen so realistic dates (roughly year 2001 through 2255) land unambiguously in exactly
// one bucket, with a wide, deliberately-empty gap between them — a seconds-scale value (~1e9-1e10)
// falls below MS_LOWER, a nanoseconds-scale value (~1e18) falls above US_UPPER, and anything landing
// in the gap between MS_UPPER and US_LOWER is genuinely ambiguous and must be rejected, never guessed.
// US_UPPER is deliberately capped at Number.MAX_SAFE_INTEGER, not the naive 1e16-1: a microsecond
// value above ~9.007e15 cannot be represented exactly as a JS `number`, so accepting it here would
// mean silently trusting an already precision-lossy value (see `parseBinanceKlineCsv`'s own
// `Number.isSafeInteger` guard on `openTimeRaw`, which is what actually rejects such a row before its
// value ever reaches this function).
const MS_LOWER = 1_000_000_000_000; // 1e12
const MS_UPPER = 9_999_999_999_999; // 1e13 - 1
const US_LOWER = 1_000_000_000_000_000; // 1e15
const US_UPPER = Number.MAX_SAFE_INTEGER; // 9,007,199,254,740,991

/** Returns `undefined` for a seconds-scale, nanoseconds-scale, or otherwise ambiguous value — never
 * guessed, exactly as Phase 4's own dataset-intake.ts never guesses a bare numeric epoch's unit at
 * all (this module differs only in that Binance's OWN archives are a closed, known numeric-epoch
 * source, so a magnitude rule is meaningful here in a way it deliberately is not for arbitrary
 * operator-supplied CSV/JSON). */
export function detectTimestampUnit(value: number): BinanceTimestampUnit | undefined {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return undefined;
  if (value >= MS_LOWER && value <= MS_UPPER) return "MILLISECONDS";
  if (value >= US_LOWER && value <= US_UPPER) return "MICROSECONDS";
  return undefined;
}

export function convertBinanceTimestampToUtcIso(value: number, unit: BinanceTimestampUnit): string {
  const ms = unit === "MILLISECONDS" ? value : Math.floor(value / 1000);
  return new Date(ms).toISOString();
}

export interface BinanceKlineRow {
  openTimeRaw: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ParseBinanceCsvResult = { ok: true; rows: BinanceKlineRow[] } | { ok: false; reason: string; detail: string };

/**
 * Binance monthly kline CSVs have NO header row and 12 columns per row: open time, open, high, low,
 * close, volume, close time, quote asset volume, number of trades, taker buy base volume, taker buy
 * quote volume, ignore. Only the first six are consumed here — every other column is discarded at
 * this adapter boundary, exactly matching Phase 4's own "unknown fields discarded at the adapter,
 * never carried into final output" convention.
 */
export function parseBinanceKlineCsv(csvText: string): ParseBinanceCsvResult {
  const lines = csvText.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { ok: false, reason: "EMPTY_ARCHIVE", detail: "archive CSV has no non-blank lines" };

  const rows: BinanceKlineRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i]!.split(",");
    if (fields.length < 6) {
      return { ok: false, reason: "MALFORMED_ROW", detail: `row ${i}: has ${fields.length} field(s), expected at least 6` };
    }
    const [openTimeRaw, open, high, low, close, volume] = fields.slice(0, 6).map((f) => Number(f.trim()));
    if (![openTimeRaw, open, high, low, close, volume].every((v) => typeof v === "number" && Number.isFinite(v))) {
      return { ok: false, reason: "MALFORMED_ROW", detail: `row ${i}: non-finite or non-numeric value in one of open time/open/high/low/close/volume` };
    }
    // Open time is an epoch integer (ms or µs) — unlike the OHLCV float columns, it must round-trip
    // through `Number` exactly, or a genuinely-ambiguous/corrupt value could silently land on the
    // wrong side of an hour boundary without ever being flagged (see US_UPPER's own doc comment).
    if (!Number.isSafeInteger(openTimeRaw)) {
      return { ok: false, reason: "MALFORMED_ROW", detail: `row ${i}: open time ${openTimeRaw} is not a safe integer — cannot be trusted to round-trip without precision loss` };
    }
    rows.push({ openTimeRaw: openTimeRaw!, open: open!, high: high!, low: low!, close: close!, volume: volume! });
  }
  return { ok: true, rows };
}

export interface ValidatedMonthlyArchive {
  month: string;
  unit: BinanceTimestampUnit;
  candles: { timestamp: string; open: number; high: number; low: number; close: number; volume: number }[];
  /** Every missing hourly open time (ISO UTC) this archive was permitted to skip — always present,
   * empty when no known closure applied. Never inserted as a candle; recorded purely as evidence that
   * a gap was explained, not filled. Populated only from `knownMissingOpenTimes`, i.e. only from a
   * caller-resolved, committed registry entry — never guessed from the gap itself. */
  appliedKnownMissingOpenTimes: string[];
}

export type ValidateMonthlyArchiveResult = { ok: true; archive: ValidatedMonthlyArchive } | { ok: false; reason: string; detail: string };

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Archive-specific shape checks ONLY — never a re-implementation of Phase 2's own gap/duplicate/OHLC
 * rules (those still run authoritatively later, via `prepareDataset`/`validateCandleDataset`, once
 * this archive's rows are merged into the full assembled dataset). This function checks properties
 * unique to "one Binance monthly archive": the timestamp unit is detected once (from the first row)
 * and every other row must match that SAME unit (a unit change mid-file is rejected as
 * `MIXED_TIMESTAMP_UNITS`, never silently reinterpreted row-by-row); the row count must exactly equal
 * the number of hours in the declared calendar month (less any explained closure — see below); every
 * row's own timestamp must fall inside that month; rows must be strictly ascending with no duplicates
 * and no gap other than exactly one hour — UNLESS every missing hour in a wider gap is present in
 * `knownMissingOpenTimes` (resolved by the caller from the committed
 * binance-known-market-closures.ts registry for this exact symbol/month, never guessed here), in
 * which case the gap is accepted and recorded in `appliedKnownMissingOpenTimes` — no candle is ever
 * inserted for a missing hour, explained or not.
 */
export function validateMonthlyArchiveRows(rows: readonly BinanceKlineRow[], month: string, knownMissingOpenTimes: ReadonlySet<string> = new Set()): ValidateMonthlyArchiveResult {
  const match = YYYY_MM_PATTERN.exec(month);
  if (!match) return { ok: false, reason: "INVALID_MONTH", detail: `month must be in YYYY-MM format (got ${JSON.stringify(month)})` };
  const year = Number(match[1]);
  const monthNum = Number(match[2]);
  const expectedCount = daysInMonth(year, monthNum) * 24;
  const monthStartMs = Date.UTC(year, monthNum - 1, 1, 0, 0, 0);
  const monthEndMs = Date.UTC(year, monthNum, 1, 0, 0, 0); // exclusive

  if (rows.length === 0) return { ok: false, reason: "EMPTY_ARCHIVE", detail: `archive for ${month} has zero rows` };

  const firstUnit = detectTimestampUnit(rows[0]!.openTimeRaw);
  if (firstUnit === undefined) {
    return { ok: false, reason: "AMBIGUOUS_TIMESTAMP_UNIT", detail: `${month}: row 0's open time ${rows[0]!.openTimeRaw} is not recognisable as milliseconds or microseconds — never guessed` };
  }

  const candles: ValidatedMonthlyArchive["candles"] = [];
  const appliedKnownMissingOpenTimes: string[] = [];
  let previousMs: number | undefined;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rowUnit = detectTimestampUnit(row.openTimeRaw);
    if (rowUnit === undefined) {
      return { ok: false, reason: "AMBIGUOUS_TIMESTAMP_UNIT", detail: `${month}: row ${i}'s open time ${row.openTimeRaw} is not recognisable as milliseconds or microseconds` };
    }
    if (rowUnit !== firstUnit) {
      return { ok: false, reason: "MIXED_TIMESTAMP_UNITS", detail: `${month}: row ${i} uses ${rowUnit} but row 0 used ${firstUnit} — a unit change within one archive is never silently reinterpreted` };
    }
    const iso = convertBinanceTimestampToUtcIso(row.openTimeRaw, rowUnit);
    const ms = Date.parse(iso);
    if (ms < monthStartMs || ms >= monthEndMs) {
      return { ok: false, reason: "ROW_OUTSIDE_DECLARED_MONTH", detail: `${month}: row ${i}'s timestamp ${iso} falls outside the archive's own declared calendar month` };
    }
    if (previousMs !== undefined) {
      if (ms <= previousMs) {
        return { ok: false, reason: ms === previousMs ? "DUPLICATE_TIMESTAMP" : "OUT_OF_ORDER_TIMESTAMP", detail: `${month}: row ${i}'s timestamp ${iso} is not strictly after the previous row's` };
      }
      const gapMs = ms - previousMs;
      if (gapMs !== 3_600_000) {
        const explained = explainGapWithKnownClosures(previousMs, gapMs, knownMissingOpenTimes);
        if (explained === undefined) {
          return { ok: false, reason: "GAP_DETECTED", detail: `${month}: gap of ${gapMs}ms before row ${i} (${iso}) does not equal exactly one hour, and is not fully covered by a declared known-closure entry — never filled or interpolated` };
        }
        appliedKnownMissingOpenTimes.push(...explained);
      }
    }
    previousMs = ms;
    candles.push({ timestamp: iso, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume });
  }

  const expectedRowCount = expectedCount - appliedKnownMissingOpenTimes.length;
  if (candles.length !== expectedRowCount) {
    return {
      ok: false,
      reason: "UNEXPECTED_ROW_COUNT",
      detail: `${month}: expected exactly ${expectedRowCount} rows (${daysInMonth(year, monthNum)} days × 24h${appliedKnownMissingOpenTimes.length > 0 ? ` minus ${appliedKnownMissingOpenTimes.length} known-closure hour(s)` : ""}) but got ${candles.length}`,
    };
  }

  return { ok: true, archive: { month, unit: firstUnit, candles, appliedKnownMissingOpenTimes } };
}

/**
 * Returns the list of missing hourly open times (ISO UTC, ascending) between `previousMs` (exclusive)
 * and `previousMs + gapMs` (exclusive) ONLY if the gap spans exact whole 1-hour intervals AND every
 * single one of those missing hours is present in `knownMissingOpenTimes` — `undefined` otherwise
 * (an unknown gap, a partially-covered gap, or a gap that isn't a whole number of hours). Never
 * accepts a gap merely because SOME of its missing hours are known; every missing hour must match.
 */
function explainGapWithKnownClosures(previousMs: number, gapMs: number, knownMissingOpenTimes: ReadonlySet<string>): string[] | undefined {
  if (gapMs <= 0 || gapMs % 3_600_000 !== 0) return undefined;
  const missingCount = gapMs / 3_600_000 - 1;
  if (missingCount <= 0) return undefined;
  const missing: string[] = [];
  for (let k = 1; k <= missingCount; k++) {
    const iso = new Date(previousMs + k * 3_600_000).toISOString();
    if (!knownMissingOpenTimes.has(iso)) return undefined;
    missing.push(iso);
  }
  return missing;
}

/** Verifies every declared month is present exactly once, in ascending order, with no gap or overlap
 * between one month's last candle and the next month's first — i.e. the assembled multi-month
 * sequence is itself perfectly contiguous, never merely "each month individually looks fine." */
export function checkNoMonthOverlap(archives: readonly ValidatedMonthlyArchive[]): { ok: true } | { ok: false; detail: string } {
  for (let i = 1; i < archives.length; i++) {
    const prev = archives[i - 1]!;
    const cur = archives[i]!;
    const prevLastMs = Date.parse(prev.candles[prev.candles.length - 1]!.timestamp);
    const curFirstMs = Date.parse(cur.candles[0]!.timestamp);
    if (curFirstMs - prevLastMs !== 3_600_000) {
      return { ok: false, detail: `${prev.month} -> ${cur.month}: not exactly contiguous (last candle ${prev.candles[prev.candles.length - 1]!.timestamp}, next first candle ${cur.candles[0]!.timestamp})` };
    }
  }
  return { ok: true };
}
