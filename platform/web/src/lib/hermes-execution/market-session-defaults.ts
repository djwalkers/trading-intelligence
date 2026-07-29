// Remediation pass (senior review finding M5) — the single source of truth for "what is a standard
// US equities regular session, when nothing more specific is configured." Both config.ts (the
// runtime's own HERMES_MARKET_HOURS_* env var defaults) and market-data/candle-validation.ts (the
// default equityMarketHoursPolicy used to judge whether a gap between candles is fully explained by
// an ordinary market closure) need exactly this same timezone/start/end — previously each hard-
// coded its own identical literals, a drift risk if one were ever edited without the other.
//
// Deliberately its own standalone module with no imports from either config.ts or
// candle-validation.ts: config.ts already imports several candle-validation.ts exports
// (MIN_REQUIRED_CANDLES, SUPPORTED_MARKET_TIMEFRAMES, TIMEFRAME_DURATIONS_MS, MarketTimeframe), so
// candle-validation.ts importing FROM config.ts (or vice versa gaining a new edge) would create a
// circular import. This module sits below both.

export const DEFAULT_EQUITY_SESSION_TIMEZONE = "America/New_York";
export const DEFAULT_EQUITY_SESSION_START = "09:30";
export const DEFAULT_EQUITY_SESSION_END = "16:00";
