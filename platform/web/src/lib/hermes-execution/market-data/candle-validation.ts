import type { Candle } from "../types";
import { MarketDataProviderError } from "./market-data-provider";

// Phase 2A — Real Historical Candles for Live Market Data. The single source of truth for "what
// timeframes does this pipeline's one historical-candle source (eToro) support" and "is a candle
// history returned by that source trustworthy enough to feed indicators." Deliberately provider-
// agnostic in *name* (nothing here mentions eToro) even though the granularity list is chosen to
// match eToro's own documented interval enum today — a future second historical-candle provider
// would need this list to grow, not a parallel one to appear.

export const SUPPORTED_MARKET_TIMEFRAMES = ["1m", "5m", "10m", "15m", "30m", "1h", "4h", "1d", "1w"] as const;
export type MarketTimeframe = (typeof SUPPORTED_MARKET_TIMEFRAMES)[number];

export const TIMEFRAME_DURATIONS_MS: Record<MarketTimeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "10m": 10 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 3_600_000,
  "4h": 4 * 3_600_000,
  "1d": 24 * 3_600_000,
  "1w": 7 * 24 * 3_600_000,
};

// The longest period any indicator in technical-indicators.ts computes today is EMA50
// (market-intelligence-builder.ts's EMA_LONG_PERIOD) — this floor is set to match it so a candle
// history that validation lets through is always at least long enough to seed a genuine EMA50
// (calculateEma's own documented fallback — a plain average of everything given — only kicks in
// below the requested period). Deliberately not imported from market-intelligence-builder.ts: a
// hard-coded, documented number here is simpler and avoids a coupling this module doesn't
// otherwise need. Also enforced at config-build time (config.ts's own HERMES_MARKET_CANDLE_COUNT
// minimum), so a misconfiguration fails at startup, not on the first live trading cycle.
export const MIN_REQUIRED_CANDLES = 50;

// A real feed's candle boundaries are never exact to the millisecond — this tolerance absorbs
// that jitter before a gap is called a genuine missing candle, without being so loose it would
// miss an actually-missing bar (e.g. a whole skipped hourly candle is still >150% of its own
// expected interval).
const GAP_TOLERANCE_RATIO = 1.5;

export interface ValidateHistoricalCandlesOptions {
  timeframe: MarketTimeframe;
  /** Upper bound (seconds) on how old the latest candle may be — see config.ts's own
   * LiveMarketDataConfig.maxCandleAgeSeconds doc comment for how this is derived/defaulted. */
  maxCandleAgeSeconds: number;
  /** Injectable for deterministic tests; defaults to the real current time. */
  now?: Date;
}

function fail(instrument: string, detail: string): never {
  throw new MarketDataProviderError(`Invalid historical candle history for "${instrument}": ${detail}`, "malformed-data");
}

/**
 * Rejects (throws MarketDataProviderError) rather than silently dropping, trimming, or repairing
 * anything — a caller (LiveMarketDataProvider) that receives no error back may trust the candles
 * completely. Checks, in order: minimum count, per-candle NaN/non-finite/non-positive OHLC,
 * malformed OHLC (high < low, or open/close outside [low, high]), per-candle volume (only when
 * present — see below), duplicate timestamps, missing candles (a gap between consecutive candles
 * wider than the selected timeframe tolerates), and staleness (the latest candle older than
 * maxCandleAgeSeconds).
 *
 * Volume is deliberately NOT in the same always-required bucket as OHLC/timestamp (Phase 2A
 * follow-up — Volume Nullability): CONFIRMED live that eToro's historical-candle endpoint can
 * return a null volume despite its own documented schema declaring the field required/numeric.
 * Candle.volume is `undefined` for "genuinely unknown" (see its own doc comment) — this function
 * validates it only when present (finite, non-negative), and never rejects a candle for volume
 * being absent, and never substitutes a value for it.
 */
export function validateHistoricalCandles(candles: Candle[], instrument: string, options: ValidateHistoricalCandlesOptions): void {
  const now = options.now ?? new Date();

  if (candles.length < MIN_REQUIRED_CANDLES) {
    fail(instrument, `received ${candles.length} candle(s), need at least ${MIN_REQUIRED_CANDLES}.`);
  }

  const seenTimestamps = new Set<string>();
  for (const candle of candles) {
    const { timestamp, open, high, low, close, volume } = candle;

    if (seenTimestamps.has(timestamp)) {
      fail(instrument, `duplicate candle timestamp "${timestamp}".`);
    }
    seenTimestamps.add(timestamp);

    // OHLC — always mandatory and finite, unlike volume below.
    for (const [name, value] of [
      ["open", open],
      ["high", high],
      ["low", low],
      ["close", close],
    ] as const) {
      if (!Number.isFinite(value)) {
        fail(instrument, `non-finite ${name} (${value}) at ${timestamp}.`);
      }
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
      fail(instrument, `non-positive OHLC price at ${timestamp} (open=${open}, high=${high}, low=${low}, close=${close}).`);
    }
    if (high < low) {
      fail(instrument, `high (${high}) below low (${low}) at ${timestamp}.`);
    }
    if (open > high || open < low || close > high || close < low) {
      fail(instrument, `open/close outside the [low, high] range at ${timestamp} (open=${open}, close=${close}, low=${low}, high=${high}).`);
    }

    // Volume — optional. Only validated when present; absence is never an error and is never
    // filled in with a substitute value (see this function's own doc comment above).
    if (volume !== undefined) {
      if (!Number.isFinite(volume)) {
        fail(instrument, `non-finite volume (${volume}) at ${timestamp}.`);
      }
      if (volume < 0) {
        fail(instrument, `negative volume (${volume}) at ${timestamp}.`);
      }
    }
  }

  // Everything below reads the candles in chronological order regardless of what order the source
  // returned them in — sorting here never repairs the data itself (an out-of-order response with
  // otherwise-valid candles is not an error condition this function flags), it only makes the gap/
  // staleness checks meaningful.
  const sorted = [...candles].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const expectedIntervalMs = TIMEFRAME_DURATIONS_MS[options.timeframe];
  for (let i = 1; i < sorted.length; i++) {
    const prevTimestamp = sorted[i - 1]!.timestamp;
    const currTimestamp = sorted[i]!.timestamp;
    const gapMs = Date.parse(currTimestamp) - Date.parse(prevTimestamp);
    if (gapMs > expectedIntervalMs * GAP_TOLERANCE_RATIO) {
      fail(
        instrument,
        `missing candle(s) — a ${gapMs}ms gap between ${prevTimestamp} and ${currTimestamp} exceeds the expected ${options.timeframe} interval (${expectedIntervalMs}ms).`,
      );
    }
  }

  const latest = sorted[sorted.length - 1]!;
  const ageSeconds = (now.getTime() - Date.parse(latest.timestamp)) / 1000;
  if (ageSeconds > options.maxCandleAgeSeconds) {
    fail(
      instrument,
      `stale data — the latest candle (${latest.timestamp}) is ${Math.round(ageSeconds)}s old, exceeding the configured max age of ${options.maxCandleAgeSeconds}s.`,
    );
  }
}
