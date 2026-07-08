import type { Instrument, MarketRegime, StrategyContext } from "@/lib/types";

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
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
