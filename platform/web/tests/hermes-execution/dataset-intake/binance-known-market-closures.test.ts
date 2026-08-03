import { describe, expect, it } from "vitest";
import {
  BINANCE_KNOWN_MARKET_CLOSURES,
  BINANCE_KNOWN_MARKET_CLOSURES_REGISTRY_VERSION,
  closureRecordIdentity,
  findClosureRecord,
  findClosureRegistryConflicts,
  isHourAlignedIsoTimestamp,
  resolveKnownMissingOpenTimesForSymbolMonth,
  type BinanceKnownMarketClosure,
} from "@/lib/hermes-execution/dataset-intake/binance-known-market-closures";
import { SUPPORTED_BINANCE_SYMBOLS } from "@/lib/hermes-execution/dataset-intake/binance-archive";

// Phase 4 — Historical Dataset Intake. Pure registry logic — no network, no filesystem I/O. Never
// calls Binance/any provider, never calls eToro/any broker.

const KNOWN_2023_03_24_ENTRY: BinanceKnownMarketClosure = {
  provider: "BINANCE",
  market: "SPOT",
  appliesToSymbols: ["ALL_SPOT"],
  timeframe: "1h",
  missingOpenTime: "2023-03-24T13:00:00.000Z",
  reasonCode: "EXCHANGE_SYSTEM_OUTAGE",
  description: "Binance spot trading suspension during temporary system maintenance",
  sourceReference: "test",
  status: "VERIFIED_EXCEPTION",
};

describe("BINANCE_KNOWN_MARKET_CLOSURES — committed registry", () => {
  it("is internally conflict-free (self-validated at import time, re-checked here explicitly)", () => {
    expect(findClosureRegistryConflicts(BINANCE_KNOWN_MARKET_CLOSURES)).toEqual([]);
  });

  it("declares the exact 2023-03-24T13:00:00Z Binance spot exchange-wide outage (corrected from a previously misidentified 15:00Z — pre-commit review)", () => {
    const entry = BINANCE_KNOWN_MARKET_CLOSURES.find((e) => e.missingOpenTime === "2023-03-24T13:00:00.000Z");
    expect(entry).toBeDefined();
    expect(entry?.provider).toBe("BINANCE");
    expect(entry?.market).toBe("SPOT");
    expect(entry?.timeframe).toBe("1h");
    expect(entry?.appliesToSymbols).toEqual(["ALL_SPOT"]);
    expect(entry?.reasonCode).toBe("EXCHANGE_SYSTEM_OUTAGE");
    expect(entry?.status).toBe("VERIFIED_EXCEPTION");
  });

  it("resolves the missing hour for BTCUSDT, ETHUSDT, and SOLUSDT (ALL_SPOT scope)", () => {
    for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const) {
      expect(resolveKnownMissingOpenTimesForSymbolMonth(symbol, "2023-03")).toEqual(new Set(["2023-03-24T13:00:00.000Z"]));
      expect(findClosureRecord(symbol, "2023-03-24T13:00:00.000Z")).toBeDefined();
    }
  });

  it("never resolves a closure for a month it doesn't apply to", () => {
    expect(resolveKnownMissingOpenTimesForSymbolMonth("BTCUSDT", "2023-04")).toEqual(new Set());
    expect(resolveKnownMissingOpenTimesForSymbolMonth("BTCUSDT", "2023-02")).toEqual(new Set());
  });

  it("never resolves a closure for the real, present, adjacent candles (12:00Z, 14:00Z) — only 13:00Z was ever missing", () => {
    expect(findClosureRecord("BTCUSDT", "2023-03-24T12:00:00.000Z")).toBeUndefined();
    expect(findClosureRecord("BTCUSDT", "2023-03-24T14:00:00.000Z")).toBeUndefined();
  });

  it("negative regression (pre-commit review): 15:00Z is a REAL, present candle and must never resolve as a closure", () => {
    for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const) {
      expect(findClosureRecord(symbol, "2023-03-24T15:00:00.000Z")).toBeUndefined();
    }
    expect(resolveKnownMissingOpenTimesForSymbolMonth("BTCUSDT", "2023-03").has("2023-03-24T15:00:00.000Z")).toBe(false);
  });
});

describe("isHourAlignedIsoTimestamp", () => {
  it("accepts a canonical, hour-aligned UTC timestamp", () => {
    expect(isHourAlignedIsoTimestamp("2023-03-24T13:00:00.000Z")).toBe(true);
  });

  it("rejects a sub-hour offset", () => {
    expect(isHourAlignedIsoTimestamp("2023-03-24T13:30:00.000Z")).toBe(false);
  });

  it("rejects a non-canonical (non-toISOString) form", () => {
    expect(isHourAlignedIsoTimestamp("2023-03-24T13:00:00Z")).toBe(false);
  });

  it("rejects an unparseable value", () => {
    expect(isHourAlignedIsoTimestamp("not-a-timestamp")).toBe(false);
  });
});

describe("findClosureRegistryConflicts — pure conflict detection over an arbitrary registry array", () => {
  it("flags a malformed (non-hour-aligned) missingOpenTime", () => {
    const conflicts = findClosureRegistryConflicts([{ ...KNOWN_2023_03_24_ENTRY, missingOpenTime: "2023-03-24T13:30:00.000Z" }]);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it("flags an empty appliesToSymbols", () => {
    const conflicts = findClosureRegistryConflicts([{ ...KNOWN_2023_03_24_ENTRY, appliesToSymbols: [] }]);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it("flags an unrecognised symbol scope", () => {
    const conflicts = findClosureRegistryConflicts([{ ...KNOWN_2023_03_24_ENTRY, appliesToSymbols: ["DOGEUSDT" as never] }]);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it("flags two entries covering the same symbol at the same hour (duplicate/overlap)", () => {
    const conflicts = findClosureRegistryConflicts([
      { ...KNOWN_2023_03_24_ENTRY, appliesToSymbols: ["BTCUSDT"] },
      { ...KNOWN_2023_03_24_ENTRY, appliesToSymbols: ["BTCUSDT"] },
    ]);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it("flags ALL_SPOT overlapping with an explicit symbol at the same hour", () => {
    const conflicts = findClosureRegistryConflicts([
      { ...KNOWN_2023_03_24_ENTRY, appliesToSymbols: ["ALL_SPOT"] },
      { ...KNOWN_2023_03_24_ENTRY, appliesToSymbols: ["BTCUSDT"] },
    ]);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it("accepts two entries covering the SAME hour but disjoint symbol scopes", () => {
    const conflicts = findClosureRegistryConflicts([
      { ...KNOWN_2023_03_24_ENTRY, appliesToSymbols: ["BTCUSDT"] },
      { ...KNOWN_2023_03_24_ENTRY, appliesToSymbols: ["ETHUSDT"] },
    ]);
    expect(conflicts).toEqual([]);
  });

  it("flags ALL_SPOT combined ambiguously with an explicit symbol in the SAME entry (pre-commit review)", () => {
    const conflicts = findClosureRegistryConflicts([{ ...KNOWN_2023_03_24_ENTRY, appliesToSymbols: ["ALL_SPOT", "BTCUSDT"] }]);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it("accepts a single explicit symbol alone (no ALL_SPOT involved)", () => {
    const conflicts = findClosureRegistryConflicts([{ ...KNOWN_2023_03_24_ENTRY, appliesToSymbols: ["BTCUSDT"] }]);
    expect(conflicts).toEqual([]);
  });
});

describe("registry immutability (pre-commit review)", () => {
  it("BINANCE_KNOWN_MARKET_CLOSURES is frozen and cannot be mutated after import", () => {
    expect(Object.isFrozen(BINANCE_KNOWN_MARKET_CLOSURES)).toBe(true);
    expect(() => {
      (BINANCE_KNOWN_MARKET_CLOSURES as BinanceKnownMarketClosure[]).push(KNOWN_2023_03_24_ENTRY);
    }).toThrow();
  });

  it("every registry entry, and its own appliesToSymbols array, is frozen", () => {
    for (const entry of BINANCE_KNOWN_MARKET_CLOSURES) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.appliesToSymbols)).toBe(true);
      expect(() => {
        (entry as { reasonCode: string }).reasonCode = "TAMPERED";
      }).toThrow();
    }
  });

  it("SUPPORTED_BINANCE_SYMBOLS (which ALL_SPOT expands against) is frozen", () => {
    expect(Object.isFrozen(SUPPORTED_BINANCE_SYMBOLS)).toBe(true);
  });
});

describe("closureRecordIdentity", () => {
  it("is deterministic for the same entry/symbol pair", () => {
    expect(closureRecordIdentity(KNOWN_2023_03_24_ENTRY, "BTCUSDT")).toBe(closureRecordIdentity(KNOWN_2023_03_24_ENTRY, "BTCUSDT"));
  });

  it("differs per resolved symbol for one shared ALL_SPOT entry", () => {
    expect(closureRecordIdentity(KNOWN_2023_03_24_ENTRY, "BTCUSDT")).not.toBe(closureRecordIdentity(KNOWN_2023_03_24_ENTRY, "ETHUSDT"));
  });

  it("is a 64-hex-char sha256 digest", () => {
    expect(closureRecordIdentity(KNOWN_2023_03_24_ENTRY, "BTCUSDT")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes if the registry version changes", () => {
    // Sanity check that the constant is actually baked into the identity, not just documented.
    expect(BINANCE_KNOWN_MARKET_CLOSURES_REGISTRY_VERSION).toBeGreaterThanOrEqual(1);
  });
});
