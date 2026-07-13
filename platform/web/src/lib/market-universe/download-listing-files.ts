import "server-only";

// The two official NASDAQ Trader symbol directory files — free, no API key, no manually
// maintained list. See docs/product/PHASE-2A-MARKET-UNIVERSE.md, "Data source selection".
const NASDAQ_LISTED_URL = "http://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt";
const OTHER_LISTED_URL = "http://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt";

export interface ListingSourceFiles {
  nasdaqListed: string;
  otherListed: string;
  fetchedAt: string;
}

async function fetchFile(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Market Universe listing download failed for ${url}: HTTP ${response.status}`);
  }
  const text = await response.text();
  if (!text || text.trim().length === 0) {
    throw new Error(`Market Universe listing download returned an empty file for ${url}`);
  }
  return text;
}

// Deliberately no fallback and no partial-success handling — a failed download must never touch
// already-persisted market_universe_symbols rows (see refresh-market-universe.ts), so there is
// nothing sensible to gracefully degrade to here. Throwing plainly is the correct behaviour: the
// refresh run records the failure and the existing universe stays exactly as it was.
export async function downloadListingSource(): Promise<ListingSourceFiles> {
  const [nasdaqListed, otherListed] = await Promise.all([
    fetchFile(NASDAQ_LISTED_URL),
    fetchFile(OTHER_LISTED_URL),
  ]);
  return { nasdaqListed, otherListed, fetchedAt: new Date().toISOString() };
}
