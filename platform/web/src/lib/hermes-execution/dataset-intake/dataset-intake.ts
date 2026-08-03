import { createHash } from "node:crypto";
import { SUPPORTED_MARKET_TIMEFRAMES, TIMEFRAME_DURATIONS_MS, type MarketTimeframe } from "../market-data/candle-validation";
import { computeDatasetHash, validateCandleDataset, type CandleDatasetDocument, type DatasetCandle, type DatasetKnownClosure, type DatasetRejectionReason } from "../backtest/backtest-dataset";

// Phase 4 — Historical Dataset Intake. Converts an EXTERNALLY OBTAINED, ALREADY-LOCAL candle file
// (CSV or JSON) into the exact Phase 2 `CandleDatasetDocument` schema and runs it through Phase 2's
// OWN, UNMODIFIED `validateCandleDataset` (never a second, parallel validator) as the sole authority
// on dataset correctness. This module never fetches anything — its only input is the raw text of a
// file the caller already has on disk — and never fabricates, interpolates, or fills a missing
// candle: every row either survives byte-for-byte (as a parsed number/ISO timestamp) or the whole
// import is rejected with an explicit reason.

export const DATASET_INTAKE_CONVERTER_VERSION = 1;

export const SUPPORTED_INPUT_FORMATS = ["csv", "json"] as const;
export type InputFormat = (typeof SUPPORTED_INPUT_FORMATS)[number];

/** Only two timezone assumption shapes are supported — an explicit UTC assumption, or a fixed
 * numeric offset. Deliberately excludes named zones (e.g. "America/New_York"): those require a
 * timezone database and DST handling this deliberately small, offline module does not carry. A
 * timestamp that already carries its own explicit offset/`Z` is parsed as-is regardless of this
 * setting — this assumption is only ever applied to a NAIVE (offset-less) timestamp value. */
export const UTC_TIMEZONE = "UTC";
const FIXED_OFFSET_PATTERN = /^([+-])(\d{2}):(\d{2})$/;
/** Real-world UTC offsets range from -12:00 to +14:00 — anything outside that (e.g. "+25:00", or a
 * minute component >= 60 such as "+02:99") is not a timezone offset at all, never merely "unusual." */
const MIN_OFFSET_MINUTES = -12 * 60;
const MAX_OFFSET_MINUTES = 14 * 60;
export function isSupportedTimezoneAssumption(value: string): boolean {
  if (value === UTC_TIMEZONE) return true;
  const match = FIXED_OFFSET_PATTERN.exec(value);
  if (!match) return false;
  const [, sign, hourStr, minuteStr] = match;
  const minutes = Number(minuteStr);
  if (minutes > 59) return false;
  const totalMinutes = (sign === "-" ? -1 : 1) * (Number(hourStr) * 60 + minutes);
  return totalMinutes >= MIN_OFFSET_MINUTES && totalMinutes <= MAX_OFFSET_MINUTES;
}

const TIMESTAMP_FIELD_SYNONYMS = ["timestamp", "time", "datetime"] as const;
const INSTRUMENT_FIELD_SYNONYMS = ["instrument", "symbol"] as const;
const REQUIRED_OHLC_FIELDS = ["open", "high", "low", "close"] as const;
const VOLUME_FIELD = "volume";

export type DatasetIntakeRejectionReason =
  | "EMPTY_INPUT"
  | "INVALID_INPUT_SHAPE"
  | "MISSING_REQUIRED_COLUMNS"
  | "AMBIGUOUS_INPUT_COLUMN"
  | "AMBIGUOUS_TIMESTAMP_COLUMN"
  | "AMBIGUOUS_INSTRUMENT_COLUMN"
  | "MIXED_INSTRUMENT"
  | "INVALID_ROWS"
  | "SLICE_INVALID"
  | DatasetRejectionReason; // Phase 2's own reasons, reused verbatim — never re-derived in parallel.

export interface DatasetInspectionReport {
  instrument: string;
  timeframe: string;
  source: string;
  inputFile: string;
  rowCount: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  durationMs: number | null;
  expectedIntervalMs: number;
  duplicateCount: number;
  gapCount: number;
  outOfOrderCount: number;
  invalidRowCount: number;
  timezoneHandling: string;
  /** The hash of the document actually produced by this run (post-slice, if a slice was
   * requested) — `null` when validation failed before a document could be finalised. */
  datasetHash: string | null;
  validationStatus: "VALID" | "REJECTED";
  rejectionReason?: string;
  rejectionDetail?: string;
  sliceRequested: boolean;
  sliceCandleCount: number | null;
  /** Count of `knownClosures` entries the caller supplied (declared, not necessarily all exercised —
   * see `DatasetIntakeProvenance.appliedKnownClosures` for exactly which ones actually explained a
   * real gap). Zero for an ordinary import with no closure metadata. */
  knownClosureCount: number;
  warnings: string[];
  limitations: string[];
}

export interface DatasetIntakeProvenance {
  /** Basename only — never an absolute path (see this module's own top-of-file doc comment and
   * requirement 7's own "exclude absolute paths from identity"). */
  inputFile: string;
  source: string;
  timezoneAssumption: string;
  importedAt: string;
  converterVersion: number;
  datasetHash: string;
  inputFileHash: string;
  rowCounts: { total: number; valid: number; invalid: number };
  validationResult: "VALID" | "REJECTED";
  /** Exactly the `knownClosures` entries that were actually exercised to explain a real gap in the
   * final document — passed straight through from Phase 2's own `DatasetProvenance.appliedKnownClosures`
   * (never re-derived here). Empty for an ordinary import. */
  appliedKnownClosures: DatasetKnownClosure[];
}

export interface PrepareDatasetInput {
  rawText: string;
  format: InputFormat;
  instrument: string;
  timeframe: MarketTimeframe;
  source: string;
  /** Pre-validated by the caller via `isSupportedTimezoneAssumption` — this function trusts it. */
  timezone: string;
  /** Basename only — the caller (the CLI) is responsible for stripping any directory portion
   * before this is recorded in the report/provenance. */
  inputFileLabel: string;
  /** Inclusive lower bound. */
  dateFrom?: string;
  /** Exclusive upper bound — see this module's own `sliceCandlesByDateRange` doc comment. */
  dateTo?: string;
  importedAt: string;
  /** OPTIONAL, pre-resolved evidence for a genuine, verified market closure (e.g. a provider-specific
   * registry such as binance-known-market-closures.ts) — passed straight through to Phase 2's own
   * `validateCandleDataset` as `knownClosures` on the assembled document, never modified or
   * re-derived here. Absent for an ordinary import, which stays exactly as strict as before this
   * field existed: any gap in the assembled candles is rejected outright. */
  knownClosures?: DatasetKnownClosure[];
}

export type PrepareDatasetResult =
  | { ok: true; document: CandleDatasetDocument; datasetHash: string; provenance: DatasetIntakeProvenance; report: DatasetInspectionReport }
  | { ok: false; reason: DatasetIntakeRejectionReason; detail: string; report: DatasetInspectionReport };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface RawInputRow {
  index: number;
  values: Record<string, unknown>;
}

type ParseInputResult = { ok: true; rows: RawInputRow[]; headerFieldNames: string[] } | { ok: false; reason: DatasetIntakeRejectionReason; detail: string };

/**
 * Splits ONE CSV line into fields — comma-separated, with support for a double-quoted field
 * (whose own commas never act as separators) and the standard CSV `""` escape for a literal quote
 * character inside a quoted field. Still a deliberately small parser for a deliberately small
 * supported-input surface: it does NOT support a quoted field spanning multiple physical lines
 * (an embedded literal newline inside quotes), never a general-purpose RFC 4180 implementation. An
 * unquoted field is trimmed of surrounding whitespace; a quoted field's own inner content is kept
 * exactly as written (only the escape/closing-quote mechanics are interpreted).
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;
  for (;;) {
    while (i < n && (line[i] === " " || line[i] === "\t")) i++; // skip leading whitespace, never inside quotes
    let field: string;
    if (line[i] === '"') {
      i++; // consume opening quote
      let content = "";
      while (i < n) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            content += '"';
            i += 2;
          } else {
            i++; // consume closing quote
            break;
          }
        } else {
          content += line[i];
          i++;
        }
      }
      while (i < n && line[i] !== ",") i++; // tolerate trailing whitespace/garbage after the closing quote
      field = content;
    } else {
      const start = i;
      while (i < n && line[i] !== ",") i++;
      field = line.slice(start, i).trim();
    }
    fields.push(field);
    if (i >= n) break;
    i++; // skip the comma separator
  }
  return fields;
}

/** Minimal CSV parsing for simple numeric/timestamp exports: comma-separated, one header row, plain
 * or double-quoted fields (see `parseCsvLine`'s own doc comment for exactly what's supported). A row
 * with a different field count than the header is a malformed row, not silently realigned or
 * truncated. */
function parseCsv(rawText: string): ParseInputResult {
  const lines = rawText.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { ok: false, reason: "EMPTY_INPUT", detail: "input file has no non-blank lines" };
  const headerFieldNames = parseCsvLine(lines[0]!);
  if (lines.length < 2) return { ok: false, reason: "EMPTY_INPUT", detail: "input file has a header row but no data rows" };

  const rows: RawInputRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]!);
    if (fields.length !== headerFieldNames.length) {
      return { ok: false, reason: "INVALID_INPUT_SHAPE", detail: `row ${i}: has ${fields.length} field(s), expected ${headerFieldNames.length} (matching the header row) — a malformed/partial row is rejected, never realigned or truncated` };
    }
    const values: Record<string, unknown> = {};
    headerFieldNames.forEach((name, columnIndex) => {
      values[name] = fields[columnIndex];
    });
    rows.push({ index: i - 1, values });
  }
  return { ok: true, rows, headerFieldNames };
}

/** JSON input must be a top-level array of row objects — the same row shape CSV produces after
 * parsing, just with native JSON types (numbers may already be numbers, not numeric strings). */
function parseJson(rawText: string): ParseInputResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return { ok: false, reason: "INVALID_INPUT_SHAPE", detail: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "INVALID_INPUT_SHAPE", detail: "expected a top-level JSON array of row objects" };
  }
  if (parsed.length === 0) return { ok: false, reason: "EMPTY_INPUT", detail: "input file has zero rows" };

  const headerFieldNames = new Set<string>();
  const rows: RawInputRow[] = [];
  parsed.forEach((rawRow, index) => {
    if (!isRecord(rawRow)) throw new Error(`row ${index}: not an object`); // caught below
    Object.keys(rawRow).forEach((k) => headerFieldNames.add(k));
    rows.push({ index, values: rawRow });
  });
  return { ok: true, rows, headerFieldNames: [...headerFieldNames] };
}

interface ColumnMapping {
  timestampField: string;
  openField: string;
  highField: string;
  lowField: string;
  closeField: string;
  volumeField?: string;
  instrumentField?: string;
  discardedColumns: string[];
}

type ResolveColumnsResult = { ok: true; mapping: ColumnMapping } | { ok: false; reason: DatasetIntakeRejectionReason; detail: string };

function resolveColumnMapping(headerFieldNames: readonly string[]): ResolveColumnsResult {
  // Group by NORMALISED name first — two headers that normalise to the same logical column (e.g.
  // "Timestamp" and "timestamp", or "Open" and "OPEN") must never be silently collapsed to
  // whichever one a plain Map.set() last-write-wins happened to keep; that would silently discard
  // one column's entire data without ever telling the caller.
  const byNormalisedName = new Map<string, string[]>();
  for (const original of headerFieldNames) {
    const key = original.trim().toLowerCase();
    const list = byNormalisedName.get(key) ?? [];
    list.push(original);
    byNormalisedName.set(key, list);
  }
  const RECOGNISED_CANONICAL_NAMES = [...TIMESTAMP_FIELD_SYNONYMS, ...REQUIRED_OHLC_FIELDS, VOLUME_FIELD, ...INSTRUMENT_FIELD_SYNONYMS];
  for (const name of RECOGNISED_CANONICAL_NAMES) {
    const originals = byNormalisedName.get(name);
    if (originals && originals.length > 1) {
      return { ok: false, reason: "AMBIGUOUS_INPUT_COLUMN", detail: `column "${name}" appears more than once in the input (as: ${originals.join(", ")}) — supply exactly one` };
    }
  }
  const normalised = new Map<string, string>(); // normalised name -> its single original header text
  for (const [key, originals] of byNormalisedName) normalised.set(key, originals[0]!);

  const timestampMatches = TIMESTAMP_FIELD_SYNONYMS.filter((s) => normalised.has(s));
  if (timestampMatches.length === 0) {
    return { ok: false, reason: "MISSING_REQUIRED_COLUMNS", detail: `no recognised timestamp column found — expected one of: ${TIMESTAMP_FIELD_SYNONYMS.join(", ")}` };
  }
  if (timestampMatches.length > 1) {
    return { ok: false, reason: "AMBIGUOUS_TIMESTAMP_COLUMN", detail: `multiple recognised timestamp columns present (${timestampMatches.join(", ")}) — supply exactly one` };
  }

  const missingOhlc = REQUIRED_OHLC_FIELDS.filter((f) => !normalised.has(f));
  if (missingOhlc.length > 0) {
    return { ok: false, reason: "MISSING_REQUIRED_COLUMNS", detail: `missing required column(s): ${missingOhlc.join(", ")}` };
  }

  const instrumentMatches = INSTRUMENT_FIELD_SYNONYMS.filter((s) => normalised.has(s));
  if (instrumentMatches.length > 1) {
    return { ok: false, reason: "AMBIGUOUS_INSTRUMENT_COLUMN", detail: `multiple recognised instrument columns present (${instrumentMatches.join(", ")}) — supply at most one` };
  }

  const hasVolume = normalised.has(VOLUME_FIELD);
  const recognised = new Set<string>([...timestampMatches, ...REQUIRED_OHLC_FIELDS, ...(hasVolume ? [VOLUME_FIELD] : []), ...instrumentMatches]);
  const discardedColumns = headerFieldNames.filter((h) => !recognised.has(h.trim().toLowerCase()));

  return {
    ok: true,
    mapping: {
      timestampField: normalised.get(timestampMatches[0]!)!,
      openField: normalised.get("open")!,
      highField: normalised.get("high")!,
      lowField: normalised.get("low")!,
      closeField: normalised.get("close")!,
      volumeField: hasVolume ? normalised.get(VOLUME_FIELD) : undefined,
      instrumentField: instrumentMatches.length === 1 ? normalised.get(instrumentMatches[0]!) : undefined,
      discardedColumns,
    },
  };
}

function coerceFiniteNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

const ISO_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/** Rejects a calendar date/time that doesn't actually exist (e.g. "2026-02-30", "2026-04-31", or
 * "2026-02-29" in a non-leap year) — native `Date.parse`/`Date` silently ROLL OVER an out-of-range
 * day-of-month into the following month instead of rejecting it (e.g. "2026-02-30" quietly becomes
 * "2026-03-02"), which would otherwise let a typo'd date corrupt a dataset's own timestamps without
 * any error at all. Hour/minute/second overflow is included for completeness even though
 * `Date.parse` already rejects those (returns `NaN`) rather than rolling over. */
function isValidCalendarDateTime(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day >= 1 && day <= daysInMonth;
}

/**
 * Only accepts string timestamps — a bare numeric epoch (seconds vs. milliseconds is genuinely
 * ambiguous with no reliable heuristic) is deliberately unsupported, never guessed. A timestamp
 * carrying its own explicit `Z`/offset is parsed as-is; a naive (offset-less) one is combined with
 * the caller's declared `timezone` assumption. Exported so the CLI can apply the IDENTICAL,
 * explicit, non-guessing timezone handling to `--date-from`/`--date-to` — using raw `Date.parse` on
 * a naive date-time string there would silently fall back to the HOST MACHINE's own local timezone
 * (a real, environment-dependent determinism bug this module exists specifically to avoid), never a
 * second, parallel timestamp parser.
 */
export function coerceTimestampToUtcIso(raw: unknown, timezone: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const normalised = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const offsetMatch = /(Z|[+-]\d{2}:?\d{2})$/i.exec(normalised);
  const hasExplicitOffset = offsetMatch !== null;
  const dateTimePart = hasExplicitOffset ? normalised.slice(0, normalised.length - offsetMatch[0].length) : normalised;

  const parts = ISO_DATE_TIME_PATTERN.exec(dateTimePart);
  if (!parts) return undefined;
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = parts;
  if (!isValidCalendarDateTime(Number(yearStr), Number(monthStr), Number(dayStr), Number(hourStr), Number(minuteStr), Number(secondStr ?? "0"))) {
    return undefined;
  }

  const candidate = hasExplicitOffset ? normalised : `${normalised}${timezone === UTC_TIMEZONE ? "Z" : timezone}`;
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

interface RowConversionOutcome {
  candles: DatasetCandle[];
  invalidRows: { index: number; detail: string }[];
  instrumentColumnValues: Set<string>;
}

function convertRows(rows: readonly RawInputRow[], mapping: ColumnMapping, timezone: string): RowConversionOutcome {
  const candles: DatasetCandle[] = [];
  const invalidRows: { index: number; detail: string }[] = [];
  const instrumentColumnValues = new Set<string>();

  for (const row of rows) {
    const timestamp = coerceTimestampToUtcIso(row.values[mapping.timestampField], timezone);
    if (timestamp === undefined) {
      invalidRows.push({ index: row.index, detail: `unparseable timestamp ${JSON.stringify(row.values[mapping.timestampField])}` });
      continue;
    }
    const open = coerceFiniteNumber(row.values[mapping.openField]);
    const high = coerceFiniteNumber(row.values[mapping.highField]);
    const low = coerceFiniteNumber(row.values[mapping.lowField]);
    const close = coerceFiniteNumber(row.values[mapping.closeField]);
    if (open === undefined || high === undefined || low === undefined || close === undefined) {
      invalidRows.push({ index: row.index, detail: "non-numeric or malformed OHLC value" });
      continue;
    }
    const rawVolume = mapping.volumeField !== undefined ? row.values[mapping.volumeField] : undefined;
    let volume: number | undefined;
    if (rawVolume !== undefined && !(typeof rawVolume === "string" && rawVolume.trim().length === 0)) {
      const coerced = coerceFiniteNumber(rawVolume);
      if (coerced === undefined) {
        invalidRows.push({ index: row.index, detail: `non-numeric volume value ${JSON.stringify(rawVolume)}` });
        continue;
      }
      volume = coerced;
    }
    if (mapping.instrumentField !== undefined) {
      const rawInstrument = row.values[mapping.instrumentField];
      if (typeof rawInstrument === "string" && rawInstrument.trim().length > 0) instrumentColumnValues.add(rawInstrument.trim());
    }
    candles.push({ timestamp, open, high, low, close, ...(volume !== undefined ? { volume } : {}) });
  }

  return { candles, invalidRows, instrumentColumnValues };
}

function computeOrderingStats(candles: readonly DatasetCandle[], expectedIntervalMs: number): { duplicateCount: number; outOfOrderCount: number; gapCount: number } {
  const seen = new Set<string>();
  let duplicateCount = 0;
  let outOfOrderCount = 0;
  let gapCount = 0;
  for (let i = 0; i < candles.length; i++) {
    const ts = candles[i]!.timestamp;
    if (seen.has(ts)) duplicateCount++;
    seen.add(ts);
    if (i === 0) continue;
    const prevMs = Date.parse(candles[i - 1]!.timestamp);
    const curMs = Date.parse(ts);
    if (curMs <= prevMs) {
      outOfOrderCount++;
      continue;
    }
    if (curMs - prevMs !== expectedIntervalMs) gapCount++;
  }
  return { duplicateCount, outOfOrderCount, gapCount };
}

/**
 * Chronological slicing only — a plain, inclusive-lower/exclusive-upper timestamp-range filter over
 * an ALREADY-VALIDATED candle array, in the SAME order (never re-sorted, never deduplicated: those
 * are validator-level concerns, already settled before slicing runs). `dateFrom` inclusive, `dateTo`
 * exclusive: adjacent slices declared with the same boundary value (one's `dateTo` equal to the
 * next's `dateFrom`) are contiguous with no overlap and no candle counted twice. No indicator or
 * strategy module is imported by, or reachable from, this function.
 */
export function sliceCandlesByDateRange(candles: readonly DatasetCandle[], dateFrom: string | undefined, dateTo: string | undefined): DatasetCandle[] {
  const fromMs = dateFrom !== undefined ? Date.parse(dateFrom) : undefined;
  const toMs = dateTo !== undefined ? Date.parse(dateTo) : undefined;
  return candles.filter((c) => {
    const ms = Date.parse(c.timestamp);
    if (fromMs !== undefined && ms < fromMs) return false;
    if (toMs !== undefined && ms >= toMs) return false;
    return true;
  });
}

function emptyReport(input: PrepareDatasetInput, expectedIntervalMs: number): DatasetInspectionReport {
  return {
    instrument: input.instrument,
    timeframe: input.timeframe,
    source: input.source,
    inputFile: input.inputFileLabel,
    rowCount: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    durationMs: null,
    expectedIntervalMs,
    duplicateCount: 0,
    gapCount: 0,
    outOfOrderCount: 0,
    invalidRowCount: 0,
    timezoneHandling: describeTimezoneHandling(input.timezone),
    datasetHash: null,
    validationStatus: "REJECTED",
    sliceRequested: input.dateFrom !== undefined || input.dateTo !== undefined,
    sliceCandleCount: null,
    knownClosureCount: input.knownClosures?.length ?? 0,
    warnings: [],
    limitations: [...STANDING_INTAKE_LIMITATIONS],
  };
}

function describeTimezoneHandling(timezone: string): string {
  return timezone === UTC_TIMEZONE
    ? "Declared assumption: UTC. Applied only to timestamps with no explicit offset/Z; timestamps already carrying an explicit offset were parsed as-is."
    : `Declared assumption: fixed offset ${timezone}. Applied only to timestamps with no explicit offset/Z; timestamps already carrying an explicit offset were parsed as-is.`;
}

/** Never claims completeness or exchange authority — this module only ever reports what its own
 * mechanical checks actually proved (requirement 3's own "do not claim quality beyond what the
 * checks prove"). */
export const STANDING_INTAKE_LIMITATIONS: readonly string[] = [
  "This report only reflects mechanical validation (shape, types, ordering, contiguity against the declared timeframe) — it never verifies the data is complete, accurate, or authoritative for any exchange or venue.",
  "No forward/backward fill of missing candles is ever performed — a genuine gap in the source data rejects the import outright.",
  "Timezone handling is based solely on the caller's declared --timezone assumption for naive timestamps — never auto-detected or guessed.",
  "A bare numeric epoch timestamp is not supported (seconds vs. milliseconds is ambiguous) — only ISO-8601-style date-time strings are accepted.",
];

/**
 * The one pure entry point: converts already-read-into-memory input text into the exact Phase 2
 * `CandleDatasetDocument` shape, or rejects explicitly. No filesystem I/O in this function — the CLI
 * owns reading the input file and writing any output. Every accepted document is additionally run
 * through Phase 2's own `validateCandleDataset` (never a second, parallel content validator) as the
 * final, authoritative gate — this function's own checks are limited to concerns `validateCandleDataset`
 * cannot see at all: input FORMAT parsing, column-name recognition, and timezone conversion.
 */
function reject(report: DatasetInspectionReport, reason: DatasetIntakeRejectionReason, detail: string): PrepareDatasetResult {
  return { ok: false, reason, detail, report: { ...report, validationStatus: "REJECTED", rejectionReason: reason, rejectionDetail: detail } };
}

export function prepareDataset(input: PrepareDatasetInput): PrepareDatasetResult {
  const expectedIntervalMs = TIMEFRAME_DURATIONS_MS[input.timeframe];
  const inputFileHash = createHash("sha256").update(input.rawText).digest("hex");

  const parsed = input.format === "csv" ? parseCsv(input.rawText) : safeParseJson(input.rawText);
  if (!parsed.ok) {
    return reject(emptyReport(input, expectedIntervalMs), parsed.reason, parsed.detail);
  }

  const columns = resolveColumnMapping(parsed.headerFieldNames);
  if (!columns.ok) {
    const report = emptyReport(input, expectedIntervalMs);
    report.rowCount = parsed.rows.length;
    return reject(report, columns.reason, columns.detail);
  }

  const { candles, invalidRows, instrumentColumnValues } = convertRows(parsed.rows, columns.mapping, input.timezone);
  const orderingStats = computeOrderingStats(candles, expectedIntervalMs);

  const warnings: string[] = [];
  if (columns.mapping.discardedColumns.length > 0) {
    warnings.push(`discarded unrecognised input column(s), never carried into the output dataset: ${columns.mapping.discardedColumns.join(", ")}`);
  }

  const baseReport: DatasetInspectionReport = {
    instrument: input.instrument,
    timeframe: input.timeframe,
    source: input.source,
    inputFile: input.inputFileLabel,
    rowCount: parsed.rows.length,
    firstTimestamp: candles[0]?.timestamp ?? null,
    lastTimestamp: candles[candles.length - 1]?.timestamp ?? null,
    durationMs: candles.length > 0 ? Date.parse(candles[candles.length - 1]!.timestamp) - Date.parse(candles[0]!.timestamp) : null,
    expectedIntervalMs,
    duplicateCount: orderingStats.duplicateCount,
    gapCount: orderingStats.gapCount,
    outOfOrderCount: orderingStats.outOfOrderCount,
    invalidRowCount: invalidRows.length,
    timezoneHandling: describeTimezoneHandling(input.timezone),
    datasetHash: null,
    validationStatus: "REJECTED",
    sliceRequested: input.dateFrom !== undefined || input.dateTo !== undefined,
    sliceCandleCount: null,
    knownClosureCount: input.knownClosures?.length ?? 0,
    warnings,
    limitations: [...STANDING_INTAKE_LIMITATIONS],
  };

  if (instrumentColumnValues.size > 0 && (instrumentColumnValues.size > 1 || !instrumentColumnValues.has(input.instrument))) {
    return reject(
      baseReport,
      "MIXED_INSTRUMENT",
      `input's own instrument/symbol column contains value(s) ${[...instrumentColumnValues].join(", ")}, which do not consist solely of the declared --instrument "${input.instrument}"`,
    );
  }

  if (invalidRows.length > 0) {
    const preview = invalidRows.slice(0, 5).map((r) => `row ${r.index}: ${r.detail}`).join("; ");
    return reject(baseReport, "INVALID_ROWS", `${invalidRows.length} row(s) failed to parse — no row is silently dropped or repaired: ${preview}${invalidRows.length > 5 ? "; …" : ""}`);
  }

  const fullDocumentCandidate = { schemaVersion: 1 as const, instrument: input.instrument, timeframe: input.timeframe, source: input.source, candles, ...(input.knownClosures !== undefined ? { knownClosures: input.knownClosures } : {}) };
  const fullValidation = validateCandleDataset(fullDocumentCandidate, input.inputFileLabel, input.importedAt);
  if (!fullValidation.ok) {
    return reject(baseReport, fullValidation.reason, fullValidation.detail);
  }

  let finalCandles = fullValidation.dataset.document.candles;
  let appliedKnownClosures = fullValidation.dataset.provenance.appliedKnownClosures;
  if (baseReport.sliceRequested) {
    finalCandles = sliceCandlesByDateRange(finalCandles, input.dateFrom, input.dateTo);
    const sliceValidation = validateCandleDataset({ ...fullDocumentCandidate, candles: finalCandles }, input.inputFileLabel, input.importedAt);
    if (!sliceValidation.ok) {
      return reject(baseReport, "SLICE_INVALID", `[--date-from/--date-to] slice failed independent validation: [${sliceValidation.reason}] ${sliceValidation.detail}`);
    }
    finalCandles = sliceValidation.dataset.document.candles;
    appliedKnownClosures = sliceValidation.dataset.provenance.appliedKnownClosures;
  }

  const finalDocument: CandleDatasetDocument = {
    schemaVersion: 1,
    instrument: input.instrument,
    timeframe: input.timeframe,
    source: input.source,
    candles: finalCandles,
    ...(input.knownClosures !== undefined ? { knownClosures: input.knownClosures } : {}),
  };
  const datasetHash = computeDatasetHash(finalDocument);

  const report: DatasetInspectionReport = {
    ...baseReport,
    firstTimestamp: finalCandles[0]?.timestamp ?? null,
    lastTimestamp: finalCandles[finalCandles.length - 1]?.timestamp ?? null,
    durationMs: finalCandles.length > 0 ? Date.parse(finalCandles[finalCandles.length - 1]!.timestamp) - Date.parse(finalCandles[0]!.timestamp) : null,
    datasetHash,
    validationStatus: "VALID",
    sliceCandleCount: baseReport.sliceRequested ? finalCandles.length : null,
  };

  const provenance: DatasetIntakeProvenance = {
    inputFile: input.inputFileLabel,
    source: input.source,
    timezoneAssumption: input.timezone,
    importedAt: input.importedAt,
    converterVersion: DATASET_INTAKE_CONVERTER_VERSION,
    datasetHash,
    inputFileHash,
    rowCounts: { total: parsed.rows.length, valid: candles.length, invalid: invalidRows.length },
    validationResult: "VALID",
    appliedKnownClosures,
  };

  return { ok: true, document: finalDocument, datasetHash, provenance, report };
}

function safeParseJson(rawText: string): ParseInputResult {
  try {
    return parseJson(rawText);
  } catch (error) {
    return { ok: false, reason: "INVALID_INPUT_SHAPE", detail: error instanceof Error ? error.message : String(error) };
  }
}

export { SUPPORTED_MARKET_TIMEFRAMES };
export type { MarketTimeframe };
