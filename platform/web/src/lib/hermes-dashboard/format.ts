import { formatCurrencyUSD, formatDateTime } from "@/lib/utils/format";

// Main Dashboard Hermes/eToro fix — requirement 3 (currency handling). The Hermes Integration API
// (/api/hermes/portfolio, /positions) reports every monetary figure as a plain number with NO
// currency field at all — never confirmed as GBP, USD, or anything else. Assuming GBP (as the rest
// of this app's own legacy paper-portfolio UI already does via formatCurrencyGBP) would be an
// invented fact this dashboard has no basis for. Until the API itself is extended with a real
// currency field, every broker-native amount here is shown with a "$"/"USD" marker instead — a
// neutral, explicitly-provisional label, never a silent, confident GBP claim. No FX conversion is
// ever performed here.

/** A broker-native monetary amount whose real currency is not confirmed by the API — see this
 * file's own top-of-file doc comment. Never used for a value already known to be a plain count
 * (quantity, position count). */
export function formatBrokerAmount(value: number): string {
  return formatCurrencyUSD(value);
}

/** "Unavailable" for null/undefined — NEVER "£0.00"/"$0.00" for a field the broker genuinely did
 * not supply (requirement 3's own explicit rule). A real, computed zero (e.g. "no trades closed
 * today") is a different case entirely and must never route through this function. */
export function formatMaybeBrokerAmount(value: number | null | undefined): string {
  return value === null || value === undefined ? "Unavailable" : formatBrokerAmount(value);
}

export function formatMaybeNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "Unavailable" : String(value);
}

export function formatMaybeTimestamp(value: string | null | undefined): string {
  return value === null || value === undefined ? "Unavailable" : formatDateTime(value);
}
