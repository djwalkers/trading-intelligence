export type MarketSession = "Asia" | "Europe" | "US" | "Crypto Always Open";

// A small, illustrative allow-list, not an exhaustive instrument-metadata lookup — this milestone
// only ever actually drives BTC through eToro, so anything beyond "is this a crypto ticker" is
// deliberately out of scope. Checked against the instrument identifier this pipeline already uses
// (e.g. "BTC", the eToro search term / internal instrument key — see EtoroResolvedInstrument).
const CRYPTO_SYMBOLS = new Set(["BTC", "ETH", "LTC", "XRP", "BCH", "ADA", "SOL", "DOGE", "DOT", "AVAX"]);

/**
 * A simple, deterministic session classifier: crypto trades around the clock regardless of hour,
 * so it always wins outright; anything else is bucketed into one of three non-overlapping UTC-hour
 * ranges. This is intentionally coarse (real session hours overlap and vary by exchange/DST) — a
 * fixed, always-reachable classification for this milestone's market context, not a trading-hours
 * authority (see Trading212's own confirmed exchange schedules for that level of precision).
 */
export function resolveMarketSession(instrument: string, now: Date): MarketSession {
  if (CRYPTO_SYMBOLS.has(instrument.toUpperCase())) return "Crypto Always Open";

  const hourUtc = now.getUTCHours();
  if (hourUtc >= 0 && hourUtc < 8) return "Asia";
  if (hourUtc >= 8 && hourUtc < 14) return "Europe";
  return "US";
}
