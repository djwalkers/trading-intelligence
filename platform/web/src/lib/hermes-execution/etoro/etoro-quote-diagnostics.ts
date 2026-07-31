// Quote-timestamp-semantics investigation (probe-etoro-1785448658984). `EtoroClient.request<T>()`
// (etoro-client.ts) parses every response as `JSON.parse(text) as T` — a compile-time type
// assertion only. The RAW JS object returned at runtime still carries every field eToro's API
// actually sent, including several this adapter's own `EtoroRate` type has never declared
// (`lastExecution`, `conversionRateAsk`/`conversionRateBid`, `unitMargin`/`unitMarginAsk`/
// `unitMarginBid`, `priceRateID`, `bidDiscounted`, `askDiscounted`, `unitMarginBidDiscounted`,
// `unitMarginAskDiscounted` — see EtoroRate's own doc comment). This module exists purely to make
// those already-present-but-invisible fields inspectable, WITHOUT changing `getRate()`'s existing,
// already-shipped return shape or behaviour at all — it is read separately, on demand, by
// EtoroDemoBroker.getRateFieldDiagnostics() (a distinct method, a distinct eToro call), never by the
// production quote/trading path.
//
// Deliberately curated, never a raw dump: only field NAMES (safe — these are eToro's own schema
// field names, never account/credential data) plus VALUES for bid/ask and any field whose NAME
// looks timestamp-like. Every other field's raw value (unitMargin, conversionRate, ...) is never
// persisted, even though its name is visible in `availableFieldNames`.

/** Matches "date"/"time"/"timestamp"/"updated" appearing anywhere in a field name — deliberately a
 * heuristic, not a confirmed classification. A field like `lastExecution` does NOT match this
 * pattern (its name gives no clear signal either way — it could be a price or a timestamp) and is
 * therefore surfaced only in `availableFieldNames`, never in `timestampLikeFields`, until its
 * runtime type is actually inspected. */
const TIMESTAMP_LIKE_NAME_PATTERN = /date|time|timestamp|updated/i;

export interface RawRateFieldInspection {
  requestedInstrumentId: number;
  /** True only when a row matching `requestedInstrumentId` (via the raw, capital-ID `instrumentID`
   * key — mirroring EtoroDemoBroker.getRate()'s own selection logic exactly, so this inspection
   * examines the SAME row the adapter actually uses) was found in the response. */
  selectedRowFound: boolean;
  /** Every key present on the selected row — names only. Lets an operator see, from evidence
   * alone, whether eToro's response shape has changed (a new/renamed field) without ever
   * persisting the full row. */
  availableFieldNames: string[];
  bid: unknown;
  ask: unknown;
  /** Every field on the selected row whose NAME matches TIMESTAMP_LIKE_NAME_PATTERN, together with
   * its raw value. This is the only per-field VALUE data (beyond bid/ask) this inspection ever
   * surfaces. */
  timestampLikeFields: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Multi-sample rate comparison (probe-etoro-1785449795206 follow-up). The single-shot
// inspectRawRate() above deliberately never surfaces VALUES for non-timestamp-named fields
// (lastExecution, priceRateID, conversionRateBid/Ask, bidDiscounted/askDiscounted) — this section
// is a separate, explicitly-scoped extension that DOES capture those specific, named fields'
// values, only for the opt-in `--diagnose-quote-samples` mode, and only those exact fields —
// still never a raw dump, never any OTHER field's value, never a field-name inventory the way
// inspectRawRate's `availableFieldNames` is.

/** A field whose real type is not yet confirmed (lastExecution, priceRateID, ...) is captured as
 * whichever JSON primitive it actually is — never forced into a guessed type, and never a nested
 * object/array (toCuratedPrimitive rejects those outright), so an unexpected shape is evidence
 * (this field is not primitive), not a crash or a silent type coercion. */
export type CuratedPrimitive = string | number | boolean | null;

function toCuratedPrimitive(value: unknown): CuratedPrimitive {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return null; // never pass through an object/array — see this section's own top-of-file note.
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface CuratedRateSample {
  sampleNumber: number;
  requestStartedAt: string;
  responseReceivedAt: string;
  instrumentID: number | null;
  bid: number | null;
  ask: number | null;
  /** `ask - bid`, only when both are present numbers — never computed from a partial pair. */
  spread: number | null;
  date: string | null;
  /** Seconds between `date` and `responseReceivedAt` — null whenever `date` is absent or fails to
   * parse (never silently treated as 0 / fresh). Computed against `responseReceivedAt`, never
   * `probeReceivedAt` from the single-shot quote path or any other clock, so every sample's age is
   * self-contained and reproducible from this one record alone. */
  parsedDateAgeSeconds: number | null;
  lastExecution: CuratedPrimitive;
  priceRateID: CuratedPrimitive;
  conversionRateBid: CuratedPrimitive;
  conversionRateAsk: CuratedPrimitive;
  bidDiscounted: CuratedPrimitive;
  askDiscounted: CuratedPrimitive;
}

/**
 * Pure, side-effect-free, never throws — mirrors inspectRawRate's own defensive-fallback
 * convention (a malformed/unexpected response shape yields an all-null sample, never a crash).
 * `context` timestamps are supplied by the caller (EtoroDemoBroker.getRateSample), captured
 * immediately around its own single network call, so this function itself never touches the
 * clock.
 */
export function extractCuratedRateSample(
  rawResponse: unknown,
  requestedInstrumentId: number,
  context: { sampleNumber: number; requestStartedAt: string; responseReceivedAt: string },
): CuratedRateSample {
  const base: CuratedRateSample = {
    sampleNumber: context.sampleNumber,
    requestStartedAt: context.requestStartedAt,
    responseReceivedAt: context.responseReceivedAt,
    instrumentID: null,
    bid: null,
    ask: null,
    spread: null,
    date: null,
    parsedDateAgeSeconds: null,
    lastExecution: null,
    priceRateID: null,
    conversionRateBid: null,
    conversionRateAsk: null,
    bidDiscounted: null,
    askDiscounted: null,
  };

  if (!isRecord(rawResponse) || !Array.isArray(rawResponse.rates)) return base;
  const row = rawResponse.rates.find((r): r is Record<string, unknown> => isRecord(r) && r.instrumentID === requestedInstrumentId);
  if (!row) return base;

  const bid = toNumberOrNull(row.bid);
  const ask = toNumberOrNull(row.ask);
  const date = typeof row.date === "string" ? row.date : null;

  let parsedDateAgeSeconds: number | null = null;
  if (date !== null) {
    const parsedMs = Date.parse(date);
    const receivedMs = Date.parse(context.responseReceivedAt);
    if (Number.isFinite(parsedMs) && Number.isFinite(receivedMs)) {
      parsedDateAgeSeconds = Math.max(0, (receivedMs - parsedMs) / 1000);
    }
  }

  return {
    ...base,
    instrumentID: toNumberOrNull(row.instrumentID),
    bid,
    ask,
    spread: bid !== null && ask !== null ? ask - bid : null,
    date,
    parsedDateAgeSeconds,
    lastExecution: toCuratedPrimitive(row.lastExecution),
    priceRateID: toCuratedPrimitive(row.priceRateID),
    conversionRateBid: toCuratedPrimitive(row.conversionRateBid),
    conversionRateAsk: toCuratedPrimitive(row.conversionRateAsk),
    bidDiscounted: toCuratedPrimitive(row.bidDiscounted),
    askDiscounted: toCuratedPrimitive(row.askDiscounted),
  };
}

export interface QuoteSampleComparison {
  sampleCount: number;
  bidChangedAcrossSamples: boolean;
  askChangedAcrossSamples: boolean;
  dateChangedAcrossSamples: boolean;
  lastExecutionChangedAcrossSamples: boolean;
  priceRateIdChangedAcrossSamples: boolean;
  uniqueBidAskPairCount: number;
  uniqueDateCount: number;
  uniquePriceRateIdCount: number;
  firstReceiptTimestamp: string | undefined;
  lastReceiptTimestamp: string | undefined;
  /** Milliseconds between the first and last sample's own `responseReceivedAt` — undefined only
   * when there are no samples at all. */
  elapsedMs: number | undefined;
  /**
   * Deterministic, evidence-only observation codes — see this module's own top-of-file note.
   * NEVER a conclusion about the provider or an instruction to change classification; the caller
   * (etoro-instrument-probe.ts) never reads these to decide READ_ONLY_VERIFIED eligibility.
   */
  observations: string[];
}

function distinctValueCount(samples: readonly CuratedRateSample[], selector: (sample: CuratedRateSample) => unknown): number {
  return new Set(samples.map((sample) => JSON.stringify(selector(sample)))).size;
}

function valueChangedAcross(samples: readonly CuratedRateSample[], selector: (sample: CuratedRateSample) => unknown): boolean {
  return distinctValueCount(samples, selector) > 1;
}

/**
 * Pure. Produces a deterministic summary + a set of named observation codes from an already-
 * captured sample sequence — computes nothing from a live source, draws no conclusion about
 * WHY any field did or didn't change (that is left to a human reviewing the evidence, per this
 * investigation's own explicit "do not draw the conclusion in code" instruction).
 */
export function compareQuoteSamples(samples: readonly CuratedRateSample[], freshnessThresholdMs: number): QuoteSampleComparison {
  const bidChangedAcrossSamples = valueChangedAcross(samples, (s) => s.bid);
  const askChangedAcrossSamples = valueChangedAcross(samples, (s) => s.ask);
  const dateChangedAcrossSamples = valueChangedAcross(samples, (s) => s.date);
  const lastExecutionChangedAcrossSamples = valueChangedAcross(samples, (s) => s.lastExecution);
  const priceRateIdChangedAcrossSamples = valueChangedAcross(samples, (s) => s.priceRateID);

  const observations: string[] = [];
  if ((bidChangedAcrossSamples || askChangedAcrossSamples) && !dateChangedAcrossSamples) {
    observations.push("BID_ASK_CHANGED_DATE_UNCHANGED");
  }
  if (priceRateIdChangedAcrossSamples && !dateChangedAcrossSamples) {
    observations.push("PRICE_RATE_ID_CHANGED_DATE_UNCHANGED");
  }
  if (dateChangedAcrossSamples && (bidChangedAcrossSamples || askChangedAcrossSamples)) {
    observations.push("DATE_CHANGED_WITH_RATE");
  }
  if (lastExecutionChangedAcrossSamples) {
    observations.push("LAST_EXECUTION_CHANGED");
  }
  if (
    !bidChangedAcrossSamples &&
    !askChangedAcrossSamples &&
    !dateChangedAcrossSamples &&
    !lastExecutionChangedAcrossSamples &&
    !priceRateIdChangedAcrossSamples
  ) {
    observations.push("NO_FIELDS_CHANGED");
  }
  if (samples.length > 0 && samples.every((s) => s.parsedDateAgeSeconds !== null && s.parsedDateAgeSeconds * 1000 > freshnessThresholdMs)) {
    observations.push("PROVIDER_DATE_REMAINS_STALE");
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  const firstReceiptTimestamp = first?.responseReceivedAt;
  const lastReceiptTimestamp = last?.responseReceivedAt;
  const elapsedMs =
    firstReceiptTimestamp !== undefined && lastReceiptTimestamp !== undefined
      ? Date.parse(lastReceiptTimestamp) - Date.parse(firstReceiptTimestamp)
      : undefined;

  return {
    sampleCount: samples.length,
    bidChangedAcrossSamples,
    askChangedAcrossSamples,
    dateChangedAcrossSamples,
    lastExecutionChangedAcrossSamples,
    priceRateIdChangedAcrossSamples,
    uniqueBidAskPairCount: distinctValueCount(samples, (s) => [s.bid, s.ask]),
    uniqueDateCount: distinctValueCount(samples, (s) => s.date),
    uniquePriceRateIdCount: distinctValueCount(samples, (s) => s.priceRateID),
    firstReceiptTimestamp,
    lastReceiptTimestamp,
    elapsedMs,
    observations,
  };
}

/**
 * Pure, side-effect-free, never throws. Accepts the ALREADY-FETCHED rates response (typed as
 * `EtoroRatesResponse` by callers, but passed here as `unknown` — this function's whole point is to
 * look past that type assertion at the real runtime object) and the instrument id whose row should
 * be inspected. Returns a best-effort inspection even for a malformed/unexpected shape
 * (`selectedRowFound: false`, empty field lists) rather than throwing — a genuinely new response
 * shape from eToro is exactly the kind of thing this function exists to surface safely, never crash
 * on.
 */
export function inspectRawRate(rawResponse: unknown, requestedInstrumentId: number): RawRateFieldInspection {
  const empty: RawRateFieldInspection = {
    requestedInstrumentId,
    selectedRowFound: false,
    availableFieldNames: [],
    bid: undefined,
    ask: undefined,
    timestampLikeFields: {},
  };

  if (!isRecord(rawResponse) || !Array.isArray(rawResponse.rates)) return empty;

  const selectedRow = rawResponse.rates.find((row): row is Record<string, unknown> => isRecord(row) && row.instrumentID === requestedInstrumentId);
  if (!selectedRow) return empty;

  const availableFieldNames = Object.keys(selectedRow);
  const timestampLikeFields: Record<string, unknown> = {};
  for (const key of availableFieldNames) {
    if (TIMESTAMP_LIKE_NAME_PATTERN.test(key)) timestampLikeFields[key] = selectedRow[key];
  }

  return {
    requestedInstrumentId,
    selectedRowFound: true,
    availableFieldNames,
    bid: selectedRow.bid,
    ask: selectedRow.ask,
    timestampLikeFields,
  };
}
