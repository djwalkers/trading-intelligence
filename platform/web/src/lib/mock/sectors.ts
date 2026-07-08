// Mock sector/category metadata (Mission 2) — kept separate from the Instrument type and every UI
// component; only the Portfolio Risk Manager (src/lib/bot/portfolio-risk.ts) reads this. A
// prototype categorisation for this fixed 5-instrument mock universe, not sourced from any real
// classification standard (e.g. GICS).
const SECTOR_BY_SYMBOL: Record<string, string> = {
  AAPL: "Technology",
  MSFT: "Technology",
  NVDA: "Technology",
  TSLA: "Consumer Discretionary",
  SPY: "Broad Market ETF",
};

const UNCATEGORISED_SECTOR = "Uncategorised";

export function getSectorForSymbol(symbol: string): string {
  return SECTOR_BY_SYMBOL[symbol] ?? UNCATEGORISED_SECTOR;
}
