// Pure, reusable technical indicator calculations (Mission 9) — every function here is a plain
// function of the numbers passed in, nothing else: no instrument lookups, no provider calls, no
// randomness, no dates. Each takes the full closes/volumes series (oldest first) and a period, and
// returns the indicator's most recent value, or null when the series is too short for that period
// — the caller (buildStrategyContextFromHistory, src/lib/strategy-engine/build-context.ts) decides
// what "not enough data" means for its own fallback logic, this module just reports it honestly
// rather than guessing or padding.

// Internal only: `noUncheckedIndexedAccess` means every array index access is `T | undefined` —
// this centralises the "prove it's in range" step so every function below can read a specific
// index without repeating the same undefined-guard. Throws rather than returning a sentinel
// because every call site here only ever indexes within a length it already checked; a throw
// means the calling function's own bounds check was wrong, not that the input data was bad.
function at(values: number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`indicator index ${index} out of range`);
  return value;
}

// Simple moving average of the last `period` values.
export function calculateSMA(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const window = values.slice(values.length - period);
  return window.reduce((sum, value) => sum + value, 0) / period;
}

// Exponential moving average, seeded with the SMA of the first `period` values then smoothed
// forward across the rest of the series — the standard EMA construction, not a shortcut.
export function calculateEMA(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const smoothing = 2 / (period + 1);

  let ema = calculateSMA(values.slice(0, period), period);
  if (ema === null) return null;

  for (let i = period; i < values.length; i++) {
    ema = at(values, i) * smoothing + ema * (1 - smoothing);
  }
  return ema;
}

// Wilder's RSI (the standard construction the 70/30 overbought/oversold thresholds already coded
// in rsi-reversal.ts assume) — average gain/loss over the first `period` changes, then smoothed
// forward, exactly like calculateEMA's seed-then-smooth shape but tracking two running averages
// instead of one.
export function calculateRSI(closes: number[], period = 14): number | null {
  if (period <= 0 || closes.length < period + 1) return null;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = at(closes, i) - at(closes, i - 1);
    if (change >= 0) gainSum += change;
    else lossSum += -change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = at(closes, i) - at(closes, i - 1);
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const relativeStrength = avgGain / avgLoss;
  return 100 - 100 / (1 + relativeStrength);
}

// Percent price change over the last `period` sessions — a short-window relative of the
// long-window trend read, both derived from the same closes series (see build-context.ts).
export function calculateMomentumPercent(closes: number[], period: number): number | null {
  if (period <= 0 || closes.length < period + 1) return null;
  const current = at(closes, closes.length - 1);
  const past = at(closes, closes.length - 1 - period);
  if (past === 0) return null;
  return ((current - past) / past) * 100;
}

// Today's volume against the average of the `period` sessions before it — deliberately excludes
// today's own volume from its own baseline, so a single unusually large session doesn't inflate
// the average it's being compared against.
export function calculateVolumeRatio(volumes: number[], period: number): number | null {
  if (period <= 0 || volumes.length < period + 1) return null;
  const latest = at(volumes, volumes.length - 1);
  const priorWindow = volumes.slice(volumes.length - 1 - period, volumes.length - 1);
  const average = priorWindow.reduce((sum, value) => sum + value, 0) / priorWindow.length;
  if (average === 0) return null;
  return latest / average;
}

// Annualisation-free volatility: the standard deviation of daily percent returns over the last
// `period` sessions, expressed as a percent — a read of how choppy the series has been, not a
// forecast.
export function calculateVolatility(closes: number[], period: number): number | null {
  if (period <= 0 || closes.length < period + 1) return null;

  const returns: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    const previous = at(closes, i - 1);
    if (previous === 0) continue;
    returns.push((at(closes, i) - previous) / previous);
  }
  if (returns.length === 0) return null;

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100;
}
