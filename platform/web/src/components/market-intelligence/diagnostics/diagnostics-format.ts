import type { MarketDataProviderType } from "@/lib/hermes-execution/config";
import type { TrendClassification } from "@/lib/hermes-execution/technical-indicators";

// Phase 2A.1 — Internal Market Diagnostics UI. Pure presentation helpers only — no data fetching,
// no state. Kept local to this feature (not lib/utils/format.ts) since every one of these is
// specific to the diagnostics page's own fields; nothing here is reused elsewhere in the app.

export function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

export function formatSpread(value: number): string {
  return value.toFixed(4);
}

export function formatVolume(value: number | undefined): string {
  return value === undefined ? "n/a (not reported by eToro)" : new Intl.NumberFormat("en-US").format(value);
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3_600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

export function providerLabel(provider: MarketDataProviderType): string {
  return provider === "live" ? "Live" : "Mock";
}

export type DataFreshnessLevel = "fresh" | "aging" | "critical";

/** "critical" only ever means "close to candle-validation.ts's own stale-data rejection threshold"
 * — a result actually past that threshold never reaches the UI at all (see
 * MarketDiagnosticsValidation's own doc comment on the service side); this is an early-warning
 * classification for a result that DID pass, not a report of a failure that already happened. */
export function dataFreshnessLevel(dataAgeSeconds: number, maxCandleAgeSeconds: number): DataFreshnessLevel {
  if (maxCandleAgeSeconds <= 0) return "fresh";
  const ratio = dataAgeSeconds / maxCandleAgeSeconds;
  if (ratio >= 0.9) return "critical";
  if (ratio >= 0.6) return "aging";
  return "fresh";
}

const FRESHNESS_BADGE_CLASSES: Record<DataFreshnessLevel, string> = {
  fresh: "border-accent-teal/30 bg-accent-teal/10 text-accent-teal",
  aging: "border-accent-amber/30 bg-accent-amber/10 text-accent-amber",
  critical: "border-accent-red/30 bg-accent-red/10 text-accent-red",
};

export function freshnessBadgeClasses(level: DataFreshnessLevel): string {
  return FRESHNESS_BADGE_CLASSES[level];
}

export function providerBadgeClasses(provider: MarketDataProviderType): string {
  return provider === "live"
    ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
    : "border-accent-amber/30 bg-accent-amber/10 text-accent-amber";
}

export function trendBadgeClasses(trend: TrendClassification): string {
  switch (trend) {
    case "Bullish":
      return "border-accent-teal/30 bg-accent-teal/10 text-accent-teal";
    case "Bearish":
      return "border-accent-red/30 bg-accent-red/10 text-accent-red";
    case "Sideways":
      return "border-base-600 bg-base-800 text-ink-300";
  }
}

/** Plain-English, non-advisory explanations for the indicator cards — descriptive only ("what this
 * number means"), never a recommendation ("what to do about it"). */
export const INDICATOR_EXPLANATIONS = {
  ema20: "The average closing price over the most recent ~20 candles, weighted toward recent data. A short-term trend reference.",
  ema50: "The average closing price over the most recent ~50 candles, weighted toward recent data. A longer-term trend reference.",
  emaRelationship: "EMA20 above EMA50 indicates short-term price is above the longer-term average.",
  rsi14: "Relative Strength Index over 14 periods — measures how fast and how much price has recently moved, on a 0-100 scale.",
  rsiNeutral: "RSI near 50 is neutral. Above 70 is often read as overbought, below 30 as oversold — neither is a signal on its own.",
  atr14: "Average True Range over 14 periods — measures recent price movement (volatility), not direction.",
  trend: "A simple classification of whether EMA20 sits above, below, or close to EMA50.",
} as const;
