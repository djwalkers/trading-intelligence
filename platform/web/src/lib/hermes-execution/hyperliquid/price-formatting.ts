/**
 * Hyperliquid rejects orders whose price/size don't match its own rounding rules, so these must be
 * applied before submitting anything — not just "nice to have" formatting.
 *
 * Rule (perpetuals), per Hyperliquid's API docs
 * (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size):
 *   - Prices: at most 5 significant figures, AND at most (6 - szDecimals) decimal places.
 *     Integer prices are always allowed regardless of the significant-figure limit.
 *   - Sizes: at most szDecimals decimal places (from the asset's meta().universe entry).
 */

const MAX_PERP_PRICE_DECIMALS_BASE = 6;
const PRICE_SIGNIFICANT_FIGURES = 5;

function roundToSignificantFigures(value: number, sigFigs: number): number {
  if (value === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = Math.pow(10, sigFigs - 1 - magnitude);
  return Math.round(value * factor) / factor;
}

function trimTrailingZeros(numeric: string): string {
  if (!numeric.includes(".")) return numeric;
  return numeric.replace(/0+$/, "").replace(/\.$/, "");
}

/** Formats a price for a perp order, honoring both the 5-sig-fig and the szDecimals-derived
 * decimal-place limits. Returns a string (Hyperliquid's API expects decimal strings, not numbers). */
export function formatPerpPrice(price: number, szDecimals: number): string {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Price must be a positive finite number, got ${price}`);
  }
  if (Number.isInteger(price)) return String(price);

  const maxDecimals = Math.max(0, MAX_PERP_PRICE_DECIMALS_BASE - szDecimals);
  const sigFigRounded = roundToSignificantFigures(price, PRICE_SIGNIFICANT_FIGURES);
  const decimalClamped = Number(sigFigRounded.toFixed(maxDecimals));
  if (Number.isInteger(decimalClamped)) return String(decimalClamped);
  return trimTrailingZeros(decimalClamped.toFixed(maxDecimals));
}

/** Formats an order size to the asset's szDecimals. Returns a string. */
export function formatPerpSize(size: number, szDecimals: number): string {
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Size must be a positive finite number, got ${size}`);
  }
  return trimTrailingZeros(size.toFixed(szDecimals));
}
