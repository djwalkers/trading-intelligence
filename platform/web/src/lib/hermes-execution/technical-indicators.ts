import type { Candle } from "./types";

// Milestone 3 — Rich Market Context for the Market Decision Engine. Plain, standard-formula technical indicators —
// genuinely computed from candle data, never hard-coded constants standing in for a real value.
// Each function degrades to a clearly-documented, safe default when given less history than its
// period requires, rather than throwing — callers (MarketIntelligenceBuilder) may reasonably be
// given a short candle history and still need a usable (if less meaningful) number back.

export type TrendClassification = "Bullish" | "Bearish" | "Sideways";

/** Exponential moving average over `values` (oldest first), seeded with a simple average of the
 * first `period` values, then smoothed forward. Returns the current (latest) EMA. If fewer than
 * `period` values are available, falls back to a plain average of everything given. */
export function calculateEma(values: number[], period: number): number {
  if (values.length === 0) return 0;
  if (values.length < period) {
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i]! * k + ema * (1 - k);
  }
  return ema;
}

/** Wilder's RSI over `values` (oldest first). Returns 50 (neutral) when there isn't enough
 * history for even one period of gains/losses, and 100 when there have been no losses at all
 * (avoids a division by zero rather than returning NaN/Infinity). */
export function calculateRsi(values: number[], period: number): number {
  if (values.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Wilder's Average True Range over `candles` (oldest first, needs at least 2 to compute any true
 * range at all — returns 0 for a single candle or an empty array, since there's nothing to
 * measure a range against yet). */
export function calculateAtr(candles: Candle[], period: number): number {
  if (candles.length < 2) return 0;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i]!;
    const prev = candles[i - 1]!;
    trueRanges.push(
      Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)),
    );
  }

  if (trueRanges.length < period) {
    return trueRanges.reduce((sum, tr) => sum + tr, 0) / trueRanges.length;
  }
  let atr = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]!) / period;
  }
  return atr;
}

/** Standard deviation of log returns over the most recent 24 candles — a simple, defensible proxy
 * for "24h volatility" assuming roughly hourly candles (this milestone's own mock data uses that
 * interval; a real hourly feed would carry the same meaning). Returns undefined ("if available",
 * per this milestone's own spec) when there's too little history to compute any return at all,
 * rather than a misleading 0. */
export function calculateVolatility24h(candles: Candle[]): number | undefined {
  const window = candles.slice(-24);
  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const prevClose = window[i - 1]!.close;
    if (prevClose <= 0) continue;
    returns.push(Math.log(window[i]!.close / prevClose));
  }
  if (returns.length < 2) return undefined;

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance);
}

// Within this band (as a fraction of EMA50), the two averages are considered too close together to
// call a clear direction — an illustrative, fixed tolerance, not a tuned trading parameter.
const TREND_TOLERANCE_RATIO = 0.001;

/** Classifies the relationship between a short and long EMA into one of three plain buckets. Pure
 * and deterministic — the same two numbers always produce the same classification. */
export function classifyTrend(emaShort: number, emaLong: number): TrendClassification {
  if (emaLong === 0) return "Sideways";
  const gapRatio = (emaShort - emaLong) / emaLong;
  if (gapRatio > TREND_TOLERANCE_RATIO) return "Bullish";
  if (gapRatio < -TREND_TOLERANCE_RATIO) return "Bearish";
  return "Sideways";
}
