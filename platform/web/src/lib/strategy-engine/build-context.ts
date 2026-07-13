import type { Instrument, MarketRegime, OHLCVCandle, StrategyContext } from "@/lib/types";
import {
  calculateEMA,
  calculateMomentumPercent,
  calculateRSI,
  calculateSMA,
  calculateVolumeRatio,
} from "@/lib/indicators";

// This prototype has no historical price series for any instrument — only a single current
// snapshot (price, changeAbsolute, changePercent, volume). Rather than inventing a synthetic
// time series, every derived indicator below is a deterministic function of that same snapshot:
// same instrument in, same context out, every time, with no randomness anywhere.
//
// - Short/long moving average: proxied from price minus a multiple of today's absolute change —
//   if the instrument moved up today, the short average sits closer to price than the long
//   average does (and vice versa for a down day), which is what a real short/long MA pair looks
//   like mid-trend.
// - RSI: proxied by mapping today's percent change onto the 0-100 RSI scale around a neutral 50.
// - Volume ratio: today's volume against a fixed 60M-share baseline, clamped to a sane range —
//   independent of price change, so Momentum's volume confirmation isn't just a restatement of
//   its own price-change input.
// - Trend: the existing MarketRegime classification, using the same +/-1% thresholds already
//   used elsewhere in this app's mock data.
const SHORT_MA_DRIFT_MULTIPLIER = 0.5;
const LONG_MA_DRIFT_MULTIPLIER = 2.5;
const RSI_PERCENT_CHANGE_MULTIPLIER = 12;
const VOLUME_BASELINE = 60_000_000;
const VOLUME_RATIO_MIN = 0.3;
const VOLUME_RATIO_MAX = 3;
const TREND_THRESHOLD_PERCENT = 1;

export function buildStrategyContext(instrument: Instrument): StrategyContext {
  const shortMovingAverage = round2(
    instrument.price - instrument.changeAbsolute * SHORT_MA_DRIFT_MULTIPLIER,
  );
  const longMovingAverage = round2(
    instrument.price - instrument.changeAbsolute * LONG_MA_DRIFT_MULTIPLIER,
  );
  const rsi = clamp(50 + instrument.changePercent * RSI_PERCENT_CHANGE_MULTIPLIER, 0, 100);
  const volumeRatio = clamp(
    instrument.volume / VOLUME_BASELINE,
    VOLUME_RATIO_MIN,
    VOLUME_RATIO_MAX,
  );
  const trend: MarketRegime =
    instrument.changePercent > TREND_THRESHOLD_PERCENT
      ? "Bullish"
      : instrument.changePercent < -TREND_THRESHOLD_PERCENT
        ? "Bearish"
        : "Neutral";

  return {
    instrument,
    shortMovingAverage,
    longMovingAverage,
    rsi: round2(rsi),
    volumeRatio: round2(volumeRatio),
    trend,
    momentumPercent: instrument.changePercent,
    historicalDataAvailable: false,
  };
}

// Mission 9 — periods for each indicator computed from real OHLCV history. Short/long deliberately
// mix EMA and SMA rather than using the same average type for both: EMA(12) for the short side
// (more reactive to recent closes, appropriate for the side meant to react to a crossover first)
// and SMA(30) for the long side (a smoother anchor the short average crosses against) — a
// classic-adjacent pairing, not a literal textbook MACD 12/26, chosen so both calculateSMA and
// calculateEMA are genuinely exercised by the one strategy that needs a moving-average pair.
const SHORT_EMA_PERIOD = 12;
const LONG_SMA_PERIOD = 30;
const RSI_LOOKBACK_PERIOD = 14;
const VOLUME_RATIO_LOOKBACK_PERIOD = 20;
const MOMENTUM_LOOKBACK_PERIOD = 5;
const TREND_MOMENTUM_LOOKBACK_PERIOD = 10;

// The longest lookback (LONG_SMA_PERIOD) plus one extra day, since calculateMomentumPercent and
// calculateVolumeRatio each look one additional day further back than their own period. Below
// this, buildStrategyContextFromHistory returns null rather than a context built from a
// too-short/noisy window — the caller (StrategyEngine.evaluateInstrumentWithHistory) falls back to
// buildStrategyContext(instrument) in that case, same as an unconfigured/failed provider.
export const MIN_CANDLES_FOR_HISTORY = LONG_SMA_PERIOD + 1;

// The real-data counterpart to buildStrategyContext() above — same output shape, calculated from
// actual OHLCV candles (src/lib/indicators/) instead of proxied from a single day's snapshot.
// Returns null when there isn't enough history yet (a fresh external provider connection, a
// symbol without enough trading days, etc.), so the caller can fall back to the snapshot proxy
// rather than run indicators over a window too short to mean anything.
export function buildStrategyContextFromHistory(
  instrument: Instrument,
  candles: OHLCVCandle[],
): StrategyContext | null {
  if (candles.length < MIN_CANDLES_FOR_HISTORY) return null;

  const sorted = [...candles].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const closes = sorted.map((candle) => candle.close);
  const volumes = sorted.map((candle) => candle.volume);

  const shortMovingAverage = calculateEMA(closes, SHORT_EMA_PERIOD);
  const longMovingAverage = calculateSMA(closes, LONG_SMA_PERIOD);
  const rsi = calculateRSI(closes, RSI_LOOKBACK_PERIOD);
  const volumeRatio = calculateVolumeRatio(volumes, VOLUME_RATIO_LOOKBACK_PERIOD);
  const momentumPercent = calculateMomentumPercent(closes, MOMENTUM_LOOKBACK_PERIOD);
  const trendMomentum = calculateMomentumPercent(closes, TREND_MOMENTUM_LOOKBACK_PERIOD);

  if (
    shortMovingAverage === null ||
    longMovingAverage === null ||
    rsi === null ||
    volumeRatio === null ||
    momentumPercent === null ||
    trendMomentum === null
  ) {
    return null;
  }

  const trend: MarketRegime =
    trendMomentum > TREND_THRESHOLD_PERCENT
      ? "Bullish"
      : trendMomentum < -TREND_THRESHOLD_PERCENT
        ? "Bearish"
        : "Neutral";

  // Acceptance Remediation (Finding 2) — movingAverageCrossoverStrategy compares instrument.price
  // against shortMovingAverage/longMovingAverage, both computed from these same candles. The
  // caller-supplied instrument's own .price is a separate snapshot (the worker's is a static mock
  // value; see src/worker/process-schedule.ts) that can silently drift from the candle series a
  // symbol's real indicators were just computed from — comparing the two was mixing two different
  // sources for what should be one internally consistent read of "current price." The latest
  // candle's close is the same series every other field on this context was derived from, so
  // substituting it here (only .price; nothing else on Instrument feeds any strategy in this
  // history path) makes that comparison internally consistent. This exactly reproduces
  // instrument.price for MockHistoricalMarketDataProvider (its final candle is deliberately scaled
  // to land on instrument.price — see its own comment), so browser behaviour is unchanged; it only
  // changes the value where the worker's real Alpha Vantage candles and its static mock instrument
  // price had been able to diverge.
  const latestClose = closes[closes.length - 1];
  const liveConsistentInstrument: Instrument =
    latestClose === undefined ? instrument : { ...instrument, price: round2(latestClose) };

  return {
    instrument: liveConsistentInstrument,
    shortMovingAverage: round2(shortMovingAverage),
    longMovingAverage: round2(longMovingAverage),
    rsi: round2(clamp(rsi, 0, 100)),
    volumeRatio: round2(clamp(volumeRatio, VOLUME_RATIO_MIN, VOLUME_RATIO_MAX)),
    trend,
    momentumPercent: round2(momentumPercent),
    historicalDataAvailable: true,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
