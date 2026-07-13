import { describe, expect, it } from "vitest";
import {
  combineListingSnapshot,
  parseNasdaqListedFile,
  parseOtherListedFile,
} from "@/lib/market-universe/parse-nasdaq-listing-files";

const NASDAQ_FIXTURE = [
  "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares",
  "AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N",
  "QQQ|Invesco QQQ Trust|G|N|N|100|Y|N",
  "ZWZZT|Test Company - Common Stock|G|Y|N|100|N|N",
  "File Creation Time: 0713202608:00|||||||",
].join("\n");

const OTHER_FIXTURE = [
  "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol",
  "IBM|International Business Machines Corp|N|IBM|N|100|N|IBM",
  "SPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY",
  "BAC|Bank of America Corp|N|BAC|N|100|N|BAC",
  "AAPL|Apple Inc. cross-listing ref|A|AAPL|N|100|N|AAPL",
  "File Creation Time: 0713202608:00|||||||",
].join("\n");

describe("parseNasdaqListedFile", () => {
  it("parses real rows and strips the header and footer", () => {
    const rows = parseNasdaqListedFile(NASDAQ_FIXTURE);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      symbol: "AAPL",
      securityName: "Apple Inc. - Common Stock",
      exchange: "NASDAQ",
      isEtf: false,
      isTestIssue: false,
    });
  });

  it("reads the real ETF flag", () => {
    const rows = parseNasdaqListedFile(NASDAQ_FIXTURE);
    expect(rows.find((r) => r.symbol === "QQQ")?.isEtf).toBe(true);
  });

  it("reads the real test-issue flag without filtering it out", () => {
    const rows = parseNasdaqListedFile(NASDAQ_FIXTURE);
    const testRow = rows.find((r) => r.symbol === "ZWZZT");
    expect(testRow?.isTestIssue).toBe(true);
  });

  it("does not drop real data when there is no footer line at all", () => {
    const truncated = NASDAQ_FIXTURE.split("\n").slice(0, -1).join("\n");
    expect(parseNasdaqListedFile(truncated)).toHaveLength(3);
  });
});

describe("parseOtherListedFile", () => {
  it("keeps NYSE (N) and NYSE American (A) rows", () => {
    const rows = parseOtherListedFile(OTHER_FIXTURE);
    expect(rows.find((r) => r.symbol === "IBM")?.exchange).toBe("NYSE");
    expect(rows.find((r) => r.symbol === "AAPL")?.exchange).toBe("NYSE American");
  });

  it("drops Arca (P) and other non-N/A exchange rows", () => {
    const rows = parseOtherListedFile(OTHER_FIXTURE);
    expect(rows.find((r) => r.symbol === "SPY")).toBeUndefined();
  });
});

describe("combineListingSnapshot", () => {
  it("keeps the nasdaqlisted.txt row on a symbol collision and reports it", () => {
    const nasdaqRows = parseNasdaqListedFile(NASDAQ_FIXTURE);
    const otherRows = parseOtherListedFile(OTHER_FIXTURE);
    const { snapshot, collisions } = combineListingSnapshot(nasdaqRows, otherRows);

    expect(snapshot.get("AAPL")?.securityName).toBe("Apple Inc. - Common Stock");
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.symbol).toBe("AAPL");
    expect(collisions[0]?.dropped.securityName).toBe("Apple Inc. cross-listing ref");
  });

  it("includes every non-colliding symbol from both sources", () => {
    const nasdaqRows = parseNasdaqListedFile(NASDAQ_FIXTURE);
    const otherRows = parseOtherListedFile(OTHER_FIXTURE);
    const { snapshot } = combineListingSnapshot(nasdaqRows, otherRows);

    expect(snapshot.has("IBM")).toBe(true);
    expect(snapshot.has("BAC")).toBe(true);
    expect(snapshot.has("QQQ")).toBe(true);
    expect(snapshot.has("SPY")).toBe(false);
  });
});
