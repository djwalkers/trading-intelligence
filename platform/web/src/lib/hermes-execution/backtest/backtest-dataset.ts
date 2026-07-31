import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { SUPPORTED_MARKET_TIMEFRAMES, TIMEFRAME_DURATIONS_MS, type MarketTimeframe } from "../market-data/candle-validation";
import { canonicalStringify } from "../strategy-definitions/strategy-definition";
import type { Candle } from "../types";

// Phase 2 — Deterministic Backtesting Foundation. Fixed, local, JSON candle datasets ONLY: no
// provider/broker import anywhere in this file, no network call, no live market-data dependency.
// This is a deliberately NEW, self-contained dataset format — never the live MarketDataSnapshot/
// MarketDataProvider shape (market-data/market-data-provider.ts), which this module does not import
// at all. Reuses only two pure, provider-agnostic pieces of the existing codebase: the
// TIMEFRAME_DURATIONS_MS lookup table (candle-validation.ts — a values table, not its gap-tolerance/
// staleness/equity-session behaviour, which this module deliberately does not inherit) and
// canonicalStringify (strategy-definition.ts — the same canonical-JSON technique already used for
// strategy content hashing, so this module never reimplements a second, parallel canonicalisation).

export const BACKTEST_DATASET_SCHEMA_VERSION = 1;

// Pre-commit review fix. The exact, closed set of keys a dataset document / candle row may have —
// mirrors Phase 1's own `ROOT_KEYS`/`INDICATOR_KEYS` closed-key philosophy (strategy-definition.ts):
// an unrecognised field (a misspelling, or an attempt to smuggle in something like a `"leverage"` or
// `"positionSize"` value this schema has no business carrying at all) is rejected outright, never
// silently ignored.
const DATASET_ROOT_KEYS = ["schemaVersion", "instrument", "timeframe", "source", "candles"] as const;
const CANDLE_KEYS = ["timestamp", "open", "high", "low", "close", "volume"] as const;

// Pre-commit review fix. This engine's own indicator computation is O(n²) in candle count (each bar
// re-slices the whole causal history — see rule-evaluator.ts's own doc comment) — deliberately
// simple for a first version, but that means an unbounded dataset size is a genuine hang/OOM risk,
// not just a theoretical one. Rejected outright, well before any indicator work begins. 20,000
// hourly candles is already ~2.3 years of contiguous history, generously more than this phase's own
// target use case needs.
export const MAX_DATASET_CANDLES = 20_000;

/** One OHLCV row in a dataset file — deliberately its own type, not `Candle` (types.ts): a dataset
 * file never repeats the instrument symbol on every row (see `CandleDatasetDocument.instrument`
 * below), and volume is optional here for the identical reason it's optional on `Candle` itself
 * (a real historical source can genuinely lack it) — see `toCandles()` below for the one place a
 * dataset row is converted into a full `Candle` for reuse with the existing indicator functions. */
export interface DatasetCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** The exact on-disk shape of a fixed local backtest dataset file — plain JSON, hand-authored or
 * exported once from a trusted source, never fetched live. */
export interface CandleDatasetDocument {
  schemaVersion: number;
  instrument: string;
  timeframe: MarketTimeframe;
  /** Free-text description of where this data came from (e.g. "eToro historical export,
   * 2026-01-01..2026-03-01" or "synthetic fixture for regression tests") — provenance only, never
   * hashed as part of the dataset's own content identity (see `computeDatasetHash` below), exactly
   * mirroring strategy-definition.ts's own contentHash-excludes-filePath/loadedAt precedent. */
  source: string;
  candles: DatasetCandle[];
}

export type DatasetRejectionReason =
  | "READ_ERROR"
  | "INVALID_JSON"
  | "UNEXPECTED_SHAPE"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_TIMEFRAME"
  | "INSUFFICIENT_CANDLES"
  | "UNPARSEABLE_TIMESTAMP"
  | "OUT_OF_ORDER_TIMESTAMP"
  | "DUPLICATE_TIMESTAMP"
  | "GAP_DETECTED"
  | "NON_FINITE_VALUE"
  | "INVALID_OHLC"
  | "PROHIBITED_FIELD"
  | "TOO_MANY_CANDLES";

export interface ValidatedCandleDataset {
  document: CandleDatasetDocument;
  /** SHA-256 over the canonicalised `{schemaVersion, instrument, timeframe, candles}` — the
   * dataset's own content identity. Never includes `source`/`filePath`/`loadedAt` (provenance,
   * recorded separately — see `DatasetProvenance` below) — the exact same content-vs-provenance
   * separation strategy-definition.ts's own `computeContentHash` already establishes. */
  datasetHash: string;
  datasetHashAlgorithm: "sha256";
  provenance: DatasetProvenance;
}

export interface DatasetProvenance {
  filePath: string;
  source: string;
  loadedAt: string;
  candleCount: number;
  firstTimestamp: string;
  lastTimestamp: string;
}

export type DatasetValidationResult = { ok: true; dataset: ValidatedCandleDataset } | { ok: false; reason: DatasetRejectionReason; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** SHA-256 over the dataset's own content only — `source`/filePath/loadedAt are provenance, never
 * part of this hash (see `CandleDatasetDocument.source`'s own doc comment for why). Two files with
 * byte-for-byte identical candle data but different key order, whitespace, or `source` text hash
 * identically; a single changed OHLC value, added/removed candle, or different instrument/timeframe
 * hashes differently. */
export function computeDatasetHash(document: Pick<CandleDatasetDocument, "schemaVersion" | "instrument" | "timeframe" | "candles">): string {
  return createHash("sha256")
    .update(canonicalStringify({ schemaVersion: document.schemaVersion, instrument: document.instrument, timeframe: document.timeframe, candles: document.candles }))
    .digest("hex");
}

/**
 * Pure, synchronous validation of an already-parsed JSON value as a fixed local candle dataset.
 * Rejects explicitly (never silently repairs, trims, sorts, or fills a gap) on: unexpected shape,
 * an unsupported/missing timeframe, fewer than 2 candles (ordering/gap checks are meaningless
 * below that), an unparseable timestamp, out-of-order timestamps, duplicate timestamps, a gap that
 * doesn't exactly equal the declared timeframe's own duration (deliberately strict — a FIXED,
 * already-captured dataset has no live-feed jitter to tolerate, unlike candle-validation.ts's own
 * GAP_TOLERANCE_RATIO for a real-time feed), a non-finite OHLCV value, or malformed OHLC ordering
 * (high below low, open/close outside [low, high]), an unrecognised top-level or per-candle field,
 * or more than `MAX_DATASET_CANDLES` rows.
 *
 * Known, documented limitation: this validator does NOT detect duplicate JSON object keys (e.g.
 * `{"close": 1, "close": 2}`) — `JSON.parse` itself silently keeps only the last occurrence before
 * this function ever sees the value, and the original raw text (where the duplicate would still be
 * visible) is not retained. If that distinction matters for an evidence trail, pre-validate the raw
 * file with a JSON linter that flags duplicate keys before passing it to this CLI.
 */
export function validateCandleDataset(raw: unknown, filePath: string, loadedAt: string): DatasetValidationResult {
  if (!isRecord(raw)) {
    return { ok: false, reason: "UNEXPECTED_SHAPE", detail: "expected a JSON object at the document root" };
  }

  const extraRootKeys = Object.keys(raw).filter((k) => !(DATASET_ROOT_KEYS as readonly string[]).includes(k));
  if (extraRootKeys.length > 0) {
    return { ok: false, reason: "PROHIBITED_FIELD", detail: `unsupported top-level field(s): ${extraRootKeys.join(", ")} — never silently ignored` };
  }

  const schemaVersion = raw.schemaVersion;
  if (typeof schemaVersion !== "number") {
    return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "schemaVersion missing or not a number" };
  }

  const instrument = raw.instrument;
  if (typeof instrument !== "string" || instrument.trim().length === 0) {
    return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "instrument missing or not a non-empty string" };
  }

  const timeframe = raw.timeframe;
  if (typeof timeframe !== "string" || !(SUPPORTED_MARKET_TIMEFRAMES as readonly string[]).includes(timeframe)) {
    return { ok: false, reason: "INVALID_TIMEFRAME", detail: `timeframe must be one of ${SUPPORTED_MARKET_TIMEFRAMES.join(", ")} (got ${JSON.stringify(timeframe)})` };
  }

  const source = typeof raw.source === "string" ? raw.source : "";

  if (!Array.isArray(raw.candles) || raw.candles.length < 2) {
    return { ok: false, reason: "INSUFFICIENT_CANDLES", detail: "candles must be an array of at least 2 rows (ordering/gap checks require at least 2)" };
  }
  if (raw.candles.length > MAX_DATASET_CANDLES) {
    return { ok: false, reason: "TOO_MANY_CANDLES", detail: `candles has ${raw.candles.length} rows, exceeding the maximum of ${MAX_DATASET_CANDLES} this engine's own O(n²) indicator computation is bounded for` };
  }

  const candles: DatasetCandle[] = [];
  for (const [index, rawCandle] of raw.candles.entries()) {
    if (!isRecord(rawCandle)) {
      return { ok: false, reason: "UNEXPECTED_SHAPE", detail: `candles[${index}]: not an object` };
    }
    const extraCandleKeys = Object.keys(rawCandle).filter((k) => !(CANDLE_KEYS as readonly string[]).includes(k));
    if (extraCandleKeys.length > 0) {
      return { ok: false, reason: "PROHIBITED_FIELD", detail: `candles[${index}]: unsupported field(s) ${extraCandleKeys.join(", ")} — never silently ignored` };
    }
    const { timestamp, open, high, low, close, volume } = rawCandle;
    if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
      return { ok: false, reason: "UNPARSEABLE_TIMESTAMP", detail: `candles[${index}]: unparseable timestamp ${JSON.stringify(timestamp)}` };
    }
    for (const [name, value] of [
      ["open", open],
      ["high", high],
      ["low", low],
      ["close", close],
    ] as const) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: "NON_FINITE_VALUE", detail: `candles[${index}].${name}: must be a finite number (got ${JSON.stringify(value)})` };
      }
      if (value <= 0) {
        return { ok: false, reason: "INVALID_OHLC", detail: `candles[${index}].${name}: must be positive (got ${value})` };
      }
    }
    if (volume !== undefined && (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0)) {
      return { ok: false, reason: "NON_FINITE_VALUE", detail: `candles[${index}].volume: must be a finite, non-negative number when present (got ${JSON.stringify(volume)})` };
    }
    const o = open as number;
    const h = high as number;
    const l = low as number;
    const c = close as number;
    if (h < l) {
      return { ok: false, reason: "INVALID_OHLC", detail: `candles[${index}]: high (${h}) below low (${l})` };
    }
    if (o > h || o < l || c > h || c < l) {
      return { ok: false, reason: "INVALID_OHLC", detail: `candles[${index}]: open/close outside the [low, high] range (open=${o}, close=${c}, low=${l}, high=${h})` };
    }
    candles.push({ timestamp, open: o, high: h, low: l, close: c, ...(volume !== undefined ? { volume: volume as number } : {}) });
  }

  const expectedIntervalMs = TIMEFRAME_DURATIONS_MS[timeframe as MarketTimeframe];
  const seenTimestamps = new Set<string>();
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    if (seenTimestamps.has(candle.timestamp)) {
      return { ok: false, reason: "DUPLICATE_TIMESTAMP", detail: `candles[${i}]: duplicate timestamp "${candle.timestamp}"` };
    }
    seenTimestamps.add(candle.timestamp);
    if (i === 0) continue;
    const prev = candles[i - 1]!;
    const gapMs = Date.parse(candle.timestamp) - Date.parse(prev.timestamp);
    if (gapMs <= 0) {
      return { ok: false, reason: "OUT_OF_ORDER_TIMESTAMP", detail: `candles[${i}]: timestamp "${candle.timestamp}" is not strictly after candles[${i - 1}]'s "${prev.timestamp}"` };
    }
    if (gapMs !== expectedIntervalMs) {
      return {
        ok: false,
        reason: "GAP_DETECTED",
        detail: `candles[${i}]: gap of ${gapMs}ms between "${prev.timestamp}" and "${candle.timestamp}" does not exactly equal the declared ${timeframe} interval (${expectedIntervalMs}ms) — fixed backtest datasets must be perfectly contiguous, with no tolerance for jitter or missing bars`,
      };
    }
  }

  const document: CandleDatasetDocument = { schemaVersion, instrument, timeframe: timeframe as MarketTimeframe, source, candles };
  const datasetHash = computeDatasetHash(document);

  return {
    ok: true,
    dataset: {
      document,
      datasetHash,
      datasetHashAlgorithm: "sha256",
      provenance: {
        filePath,
        source,
        loadedAt,
        candleCount: candles.length,
        firstTimestamp: candles[0]!.timestamp,
        lastTimestamp: candles[candles.length - 1]!.timestamp,
      },
    },
  };
}

/** The only I/O in this module — reads exactly one local JSON file, never a directory scan, never a
 * network call. Read/parse failures are reported the same explicit way as a content validation
 * failure (never thrown), so a CLI caller has one uniform error-handling path. */
export async function loadCandleDataset(filePath: string, now: () => string = () => new Date().toISOString()): Promise<DatasetValidationResult> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    return { ok: false, reason: "READ_ERROR", detail: toErrorMessage(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: "INVALID_JSON", detail: toErrorMessage(error) };
  }
  return validateCandleDataset(parsed, filePath, now());
}

/** Converts validated dataset rows into `Candle[]` (types.ts) for reuse with the existing,
 * already-tested calculateEma/calculateRsi/calculateAtr functions (technical-indicators.ts) —
 * `symbol` is stamped from the dataset's own top-level `instrument` field, never invented. */
export function toCandles(dataset: CandleDatasetDocument): Candle[] {
  return dataset.candles.map((c) => ({ symbol: dataset.instrument, timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
}
