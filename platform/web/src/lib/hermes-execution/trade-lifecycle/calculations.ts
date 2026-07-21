import type { OrderSide } from "../types";

// Milestone 6 — Trade Lifecycle & Performance Tracking. Every function here is pure — no clock, no
// randomness, no I/O — deliberately, so P/L/duration/excursion math can be unit-tested directly
// without a store, service, or audit trail in play at all.
//
// MFE/MAE convention (documented once, here, as the single source of truth): stored in the SAME
// absolute-currency units as realisedPnl — (price movement) x quantity, side-adjusted — NOT a
// percentage and NOT a raw price delta. This keeps them directly comparable/subtractable against
// realisedPnl (e.g. "this trade captured $40 of the $65 it was up at its best point"). Sign
// convention: maximumFavourableExcursion is always >= 0 (0 if price never moved in the trade's
// favour), maximumAdverseExcursion is always <= 0 (0 if price never moved against it) — both are
// simply the running max/min of the trade's own *unrealised* P/L (calculateUnrealizedPnl below,
// which reuses calculateRealisedPnl's exact formula against a live price instead of an exit price).

function assertValidTradeNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number, got ${value}.`);
  }
}

function assertPositiveTradeNumber(value: number, label: string): void {
  assertValidTradeNumber(value, label);
  if (value <= 0) {
    throw new Error(`${label} must be a positive number, got ${value}.`);
  }
}

/**
 * For a long (side "BUY"): (exitPrice - entryPrice) x quantity.
 * For a short (side "SELL"): (entryPrice - exitPrice) x quantity.
 * Same direction convention `LocalPaperBroker.closePosition`/`EtoroDemoBroker.closePosition`
 * already use internally (`direction = side === "BUY" ? 1 : -1`) — not a new formula, just made
 * directly callable and testable outside a broker.
 */
export function calculateRealisedPnl(side: OrderSide, entryPrice: number, exitPrice: number, quantity: number): number {
  assertPositiveTradeNumber(entryPrice, "entryPrice");
  assertPositiveTradeNumber(exitPrice, "exitPrice");
  assertPositiveTradeNumber(quantity, "quantity");
  const direction = side === "BUY" ? 1 : -1;
  return (exitPrice - entryPrice) * quantity * direction;
}

/** realisedPnl expressed as a percentage of the absolute entry notional (entryPrice x quantity).
 * Delegates to calculateRealisedPnl for both the P/L figure and its validation, so entryNotional
 * can never be zero/negative here — entryPrice and quantity are already required positive above,
 * which is this function's explicit handling of the "zero or invalid" case the mission calls for:
 * it fails closed via a clear thrown error rather than returning Infinity/NaN. */
export function calculateRealisedPnlPercent(side: OrderSide, entryPrice: number, exitPrice: number, quantity: number): number {
  const realisedPnl = calculateRealisedPnl(side, entryPrice, exitPrice, quantity);
  const entryNotional = entryPrice * quantity;
  return (realisedPnl / entryNotional) * 100;
}

/** Milliseconds between two ISO 8601 timestamps. Throws on an unparseable timestamp or a negative
 * duration (closedAt before openedAt) — both are data-integrity problems worth surfacing loudly,
 * not clamping to 0 or NaN. */
export function calculateHoldingDurationMs(openedAt: string, closedAt: string): number {
  const openedMs = Date.parse(openedAt);
  const closedMs = Date.parse(closedAt);
  if (Number.isNaN(openedMs)) throw new Error(`openedAt is not a valid ISO 8601 timestamp: "${openedAt}".`);
  if (Number.isNaN(closedMs)) throw new Error(`closedAt is not a valid ISO 8601 timestamp: "${closedAt}".`);
  if (closedMs < openedMs) {
    throw new Error(`closedAt ("${closedAt}") is before openedAt ("${openedAt}") — negative holding duration.`);
  }
  return closedMs - openedMs;
}

/** The same P/L formula as calculateRealisedPnl, applied to a live/current price instead of an
 * exit price — "realised P/L if the position were closed right now." The one building block MFE/MAE
 * tracking is built from. */
export function calculateUnrealizedPnl(side: OrderSide, entryPrice: number, currentPrice: number, quantity: number): number {
  return calculateRealisedPnl(side, entryPrice, currentPrice, quantity);
}

export interface ExcursionValues {
  maximumFavourableExcursion: number;
  maximumAdverseExcursion: number;
}

/**
 * Given the running MFE/MAE and a new current price, returns the updated (monotonic) MFE/MAE —
 * MFE only ever grows (or stays the same), MAE only ever shrinks (grows more negative, or stays the
 * same), matching "maximum" excursion over the trade's whole life so far, never a snapshot of just
 * the latest price. Both are clamped at 0 (see this file's top-of-file convention note): a trade
 * that has only ever been favourable has maximumAdverseExcursion === 0, and vice versa.
 */
export function updateExcursionValues(
  side: OrderSide,
  entryPrice: number,
  currentPrice: number,
  quantity: number,
  previous: ExcursionValues,
): ExcursionValues {
  const unrealisedPnl = calculateUnrealizedPnl(side, entryPrice, currentPrice, quantity);
  return {
    maximumFavourableExcursion: Math.max(previous.maximumFavourableExcursion, unrealisedPnl, 0),
    maximumAdverseExcursion: Math.min(previous.maximumAdverseExcursion, unrealisedPnl, 0),
  };
}
