import type { RawListingRow } from "./types";

// NASDAQ Trader's symbol directory files (http://www.nasdaqtrader.com/dynamic/SymDir/) — the
// official, free, no-API-key source for every NASDAQ/NYSE/NYSE American listed security. Both
// files are pipe-delimited with a header row and a trailing "File Creation Time..." footer row.
// These two functions are pure, faithful transcriptions of the real columns — no filtering beyond
// what's described in each function's own comment, no invented fields. Test issues are parsed
// through, not dropped here; eligibility.ts is the one place exclusion decisions get made.

const FOOTER_PREFIX = "File Creation Time";

function stripHeaderAndFooter(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  // Drop the header (line 0) and any blank/footer lines. Matching the footer by content, not by
  // position, means a truncated or corrupt download (no footer at all) still parses every real
  // data line rather than silently eating the last one.
  return lines.slice(1).filter((line) => line.trim().length > 0 && !line.startsWith(FOOTER_PREFIX));
}

// nasdaqlisted.txt columns: Symbol|Security Name|Market Category|Test Issue|Financial Status|
// Round Lot Size|ETF|NextShares — every NASDAQ-listed security, all market tiers.
export function parseNasdaqListedFile(raw: string): RawListingRow[] {
  return stripHeaderAndFooter(raw).map((line) => {
    const columns = line.split("|");
    return {
      symbol: columns[0]?.trim() ?? "",
      securityName: columns[1]?.trim() ?? "",
      exchange: "NASDAQ",
      isEtf: columns[6]?.trim() === "Y",
      isTestIssue: columns[3]?.trim() === "Y",
    };
  });
}

// otherlisted.txt columns: ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|
// Test Issue|NASDAQ Symbol. Exchange is one of N (NYSE), A (NYSE American), P (NYSE Arca),
// Z (BATS Global), V (IEXG) — filtered here to N/A only, since the phase spec names exactly
// NASDAQ/NYSE/NYSE American; Arca/BATS/IEXG rows are dropped.
export function parseOtherListedFile(raw: string): RawListingRow[] {
  const rows: RawListingRow[] = [];
  for (const line of stripHeaderAndFooter(raw)) {
    const columns = line.split("|");
    const exchangeCode = columns[2]?.trim();
    const exchange = exchangeCode === "N" ? "NYSE" : exchangeCode === "A" ? "NYSE American" : null;
    if (!exchange) continue;

    rows.push({
      symbol: columns[0]?.trim() ?? "",
      securityName: columns[1]?.trim() ?? "",
      exchange,
      isEtf: columns[4]?.trim() === "Y",
      isTestIssue: columns[6]?.trim() === "Y",
    });
  }
  return rows;
}

// Combines both files' rows into one snapshot keyed by symbol. otherlisted.txt's own "NASDAQ
// Symbol" column exists because a small number of symbols legitimately appear in both files (a
// cross-listing reference, not a competing primary listing) — nasdaqlisted.txt is the more
// authoritative source for a NASDAQ-primary listing, so on a collision the first-seen
// (nasdaqlisted.txt, inserted first) row wins and the collision is reported back to the caller for
// logging, rather than silently dropped.
export function combineListingSnapshot(
  nasdaqRows: RawListingRow[],
  otherRows: RawListingRow[],
): { snapshot: Map<string, RawListingRow>; collisions: { symbol: string; kept: RawListingRow; dropped: RawListingRow }[] } {
  const snapshot = new Map<string, RawListingRow>();
  const collisions: { symbol: string; kept: RawListingRow; dropped: RawListingRow }[] = [];

  for (const row of nasdaqRows) {
    if (!row.symbol) continue;
    snapshot.set(row.symbol, row);
  }
  for (const row of otherRows) {
    if (!row.symbol) continue;
    const existing = snapshot.get(row.symbol);
    if (existing) {
      collisions.push({ symbol: row.symbol, kept: existing, dropped: row });
      continue;
    }
    snapshot.set(row.symbol, row);
  }

  return { snapshot, collisions };
}
