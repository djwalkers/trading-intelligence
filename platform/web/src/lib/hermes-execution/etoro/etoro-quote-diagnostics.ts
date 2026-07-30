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
