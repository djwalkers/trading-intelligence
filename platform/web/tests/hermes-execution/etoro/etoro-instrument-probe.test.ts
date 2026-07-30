import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EtoroNoInstrumentMatchError,
  EtoroAmbiguousInstrumentError,
  EtoroRateUnavailableError,
  EtoroCandleHistoryUnavailableError,
} from "@/lib/hermes-execution/etoro/etoro-demo-broker";
import { EtoroApiError } from "@/lib/hermes-execution/etoro/etoro-client";
import type { AuditEvent } from "@/lib/hermes-execution/types";

const PROBE_LOG_PATH = path.join(process.cwd(), ".data", "hermes-execution", "etoro-instrument-probe-log.json");
const EVIDENCE_DIR = path.join(process.cwd(), ".data", "hermes-execution", "etoro-capability-evidence");

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("@/lib/hermes-execution/broker-factory", () => ({
  BrokerFactory: { create: createMock },
}));

const TEST_API_KEY = "test-secret-api-key-value";
const TEST_USER_KEY = "test-secret-user-key-value";

vi.mock("@/lib/hermes-execution/config", () => ({
  getHermesExecutionConfig: () => ({
    brokerProvider: "trading212-demo",
    etoro: {
      env: "demo",
      apiKey: "test-secret-api-key-value",
      userKey: "test-secret-user-key-value",
      testInstrument: "BTC",
      testAmount: 50,
      httpTimeoutMs: 10_000,
    },
    marketData: { timeframe: "1h", candleCount: 60, maxCandleAgeSeconds: 7_200 },
    hermesAgent: { instrumentUniverse: ["BTC", "ETH"] },
  }),
}));

import {
  classify,
  classificationReasons,
  type ResolutionOutcome,
  type QuoteOutcome,
  type CandleOutcome,
} from "@/hermes-execution/etoro-instrument-probe";

const QUOTE_STALENESS_THRESHOLD_MS = 60_000;

function freshQuote(overrides: Partial<Extract<QuoteOutcome, { kind: "success" }>> = {}): QuoteOutcome {
  return {
    kind: "success",
    retrievalSucceeded: true,
    bid: 100,
    ask: 101,
    spread: 1,
    date: new Date().toISOString(),
    probeReceivedAt: new Date().toISOString(),
    ageSeconds: 5,
    freshness: "FRESH",
    usableForVerification: true,
    ...overrides,
  };
}

describe("classify", () => {
  const success: ResolutionOutcome = { kind: "success", resolved: { instrumentId: 1, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 } };
  const okQuote: QuoteOutcome = freshQuote();
  const okCandles: CandleOutcome = { kind: "success", candleCount: 60, firstTimestamp: "a", lastTimestamp: "b", lastCandleAgeSeconds: 10 };

  it("classifies a transport-error resolution as NOT_TESTED — never conflated with a genuine negative result", () => {
    expect(classify({ kind: "transport-error", message: "boom" }, undefined, undefined)).toBe("NOT_TESTED");
  });

  it("classifies no-match as UNSUPPORTED", () => {
    expect(classify({ kind: "no-match" }, undefined, undefined)).toBe("UNSUPPORTED");
  });

  it("classifies ambiguous as UNSUPPORTED", () => {
    expect(classify({ kind: "ambiguous", candidateCount: 2 }, undefined, undefined)).toBe("UNSUPPORTED");
  });

  it("classifies a resolved instrument with a fresh, valid quote and valid candles as READ_ONLY_VERIFIED", () => {
    expect(classify(success, okQuote, okCandles)).toBe("READ_ONLY_VERIFIED");
  });

  it("classifies a resolved instrument with an unavailable quote as PARTIALLY_SUPPORTED, even though candles succeeded", () => {
    expect(classify(success, { kind: "unavailable", reason: "absent" }, okCandles)).toBe("PARTIALLY_SUPPORTED");
  });

  it("classifies a resolved instrument with a malformed quote as PARTIALLY_SUPPORTED, never READ_ONLY_VERIFIED", () => {
    expect(classify(success, { kind: "malformed", bid: -1, ask: 1, reason: "non-positive" }, okCandles)).toBe("PARTIALLY_SUPPORTED");
  });

  it("classifies a resolved instrument with invalid candles as PARTIALLY_SUPPORTED, even though the quote succeeded", () => {
    expect(classify(success, okQuote, { kind: "invalid", message: "gap", gapCount: 1 })).toBe("PARTIALLY_SUPPORTED");
  });

  // Live-BTC-run remediation (probe-etoro-1785446881512): a syntactically valid ("kind: success")
  // but stale quote used to satisfy classify()'s old `quote?.kind === "success"` check outright.
  describe("quote freshness gating (live-BTC-run defect fix)", () => {
    it("classifies a STALE quote (kind: success, usableForVerification: false) as PARTIALLY_SUPPORTED, never READ_ONLY_VERIFIED", () => {
      const staleQuote = freshQuote({
        freshness: "STALE",
        usableForVerification: false,
        ageSeconds: 6045,
      });
      expect(classify(success, staleQuote, okCandles)).toBe("PARTIALLY_SUPPORTED");
    });

    it("classifies an INVALID_TIMESTAMP quote as PARTIALLY_SUPPORTED", () => {
      const invalidTimestampQuote = freshQuote({
        freshness: "INVALID_TIMESTAMP",
        usableForVerification: false,
        ageSeconds: undefined,
        date: "not-a-real-date",
      });
      expect(classify(success, invalidTimestampQuote, okCandles)).toBe("PARTIALLY_SUPPORTED");
    });

    it("classifies a quote with a missing timestamp (freshness UNKNOWN) as not READ_ONLY_VERIFIED — a missing timestamp is never treated as fresh", () => {
      const missingTimestampQuote = freshQuote({
        freshness: "UNKNOWN",
        usableForVerification: false,
        ageSeconds: undefined,
        date: undefined,
      });
      expect(classify(success, missingTimestampQuote, okCandles)).not.toBe("READ_ONLY_VERIFIED");
      expect(classify(success, missingTimestampQuote, okCandles)).toBe("PARTIALLY_SUPPORTED");
    });

    it("classifies a quote exactly at the freshness threshold boundary as FRESH (age === threshold is not stale)", () => {
      const boundaryQuote = freshQuote({ freshness: "FRESH", usableForVerification: true, ageSeconds: QUOTE_STALENESS_THRESHOLD_MS / 1000 });
      expect(classify(success, boundaryQuote, okCandles)).toBe("READ_ONLY_VERIFIED");
    });
  });
});

describe("classificationReasons", () => {
  const success: ResolutionOutcome = { kind: "success", resolved: { instrumentId: 1, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 } };
  const okCandles: CandleOutcome = { kind: "success", candleCount: 60, firstTimestamp: "a", lastTimestamp: "b", lastCandleAgeSeconds: 10 };

  it("is empty when the instrument is fully READ_ONLY_VERIFIED", () => {
    expect(classificationReasons(success, freshQuote(), okCandles)).toEqual([]);
  });

  it("includes QUOTE_STALE for a stale quote", () => {
    const staleQuote = freshQuote({ freshness: "STALE", usableForVerification: false, ageSeconds: 6045 });
    expect(classificationReasons(success, staleQuote, okCandles)).toContain("QUOTE_STALE");
  });

  it("includes QUOTE_TIMESTAMP_INVALID for an unparseable timestamp", () => {
    const invalidQuote = freshQuote({ freshness: "INVALID_TIMESTAMP", usableForVerification: false, ageSeconds: undefined });
    expect(classificationReasons(success, invalidQuote, okCandles)).toContain("QUOTE_TIMESTAMP_INVALID");
  });

  it("includes QUOTE_TIMESTAMP_MISSING for a missing timestamp", () => {
    const missingQuote = freshQuote({ freshness: "UNKNOWN", usableForVerification: false, ageSeconds: undefined, date: undefined });
    expect(classificationReasons(success, missingQuote, okCandles)).toContain("QUOTE_TIMESTAMP_MISSING");
  });

  it("includes RESOLUTION_NO_MATCH for an unresolved instrument, with no other reasons appended", () => {
    expect(classificationReasons({ kind: "no-match" }, undefined, undefined)).toEqual(["RESOLUTION_NO_MATCH"]);
  });
});

interface FakeInstrumentBehavior {
  resolve?: () => Promise<{ instrumentId: number; displayName: string; symbol: string; instrumentTypeID: number; exchangeID: number }>;
  rate?: () => Promise<{ bid: number; ask: number; date?: string }>;
  candles?: () => Promise<Array<{ symbol: string; timestamp: string; open: number; high: number; low: number; close: number }>>;
}

// The exact broker capability surface a live EtoroDemoBroker exposes but this probe must never
// touch. Used by the mutation-guard test below to PROVE (not just observe by omission) that the
// probe's own code never references any of these, even indirectly.
const MUTATION_METHOD_NAMES = new Set([
  "placeMarketOrder",
  "closePosition",
  "getOpenPositions",
  "getAccount",
  "getCompletedTrades",
  "getRawPortfolio",
  "adoptPosition",
  "hasResolvedInstrument",
]);

function makeFakeBroker(behaviors: Record<string, FakeInstrumentBehavior>) {
  const resolveInstrument = vi.fn(async (instrument: string) => {
    const behavior = behaviors[instrument];
    if (!behavior?.resolve) throw new EtoroNoInstrumentMatchError(instrument);
    return behavior.resolve();
  });
  const getRate = vi.fn(async (instrument: string) => {
    const behavior = behaviors[instrument];
    if (!behavior?.rate) throw new EtoroRateUnavailableError(1, "absent");
    return behavior.rate();
  });
  const getHistoricalCandles = vi.fn(async (instrument: string) => {
    const behavior = behaviors[instrument];
    if (!behavior?.candles) throw new EtoroCandleHistoryUnavailableError(1, "absent");
    return behavior.candles();
  });
  return { resolveInstrument, getRate, getHistoricalCandles };
}

/** Wraps a fake broker in a Proxy that throws the instant any disallowed (mutation/account/
 * portfolio) method is even accessed — not merely called. If etoro-instrument-probe.ts's own code
 * ever referenced one of these, any test using this wrapper would fail loudly, proving the
 * violation would have been caught. */
function makeMutationGuardedBroker(behaviors: Record<string, FakeInstrumentBehavior>) {
  const real = makeFakeBroker(behaviors);
  return new Proxy(real as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && MUTATION_METHOD_NAMES.has(prop)) {
        throw new Error(`Read-only probe attempted to access disallowed broker method "${prop}"`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function validCandles(count: number, startHour: number): Array<{ symbol: string; timestamp: string; open: number; high: number; low: number; close: number }> {
  const candles = [];
  for (let i = 0; i < count; i++) {
    const hour = startHour + i;
    candles.push({
      symbol: "BTC",
      timestamp: new Date(Date.now() - (count - i) * 3_600_000).toISOString(),
      open: 100 + hour,
      high: 101 + hour,
      low: 99 + hour,
      close: 100 + hour,
    });
  }
  return candles;
}

async function readProbeLog(): Promise<AuditEvent[]> {
  const text = await fs.readFile(PROBE_LOG_PATH, "utf-8");
  return JSON.parse(text) as AuditEvent[];
}

async function readEvidenceFile(filePath: string): Promise<AuditEvent[]> {
  const text = await fs.readFile(filePath, "utf-8");
  return JSON.parse(text) as AuditEvent[];
}

describe("etoro-instrument-probe — main()", () => {
  beforeEach(() => {
    createMock.mockReset();
    process.exitCode = undefined;
    process.argv = ["node", "etoro-instrument-probe.ts"];
  });

  afterEach(async () => {
    process.exitCode = undefined;
    // Deliberately scoped to this tool's own files only — never the whole .data/hermes-execution
    // directory, which other suites' own audit logs also live in.
    await fs.rm(PROBE_LOG_PATH, { force: true });
    await fs.rm(EVIDENCE_DIR, { recursive: true, force: true });
  });

  it("always requests the etoro-demo provider from BrokerFactory, even though config.brokerProvider is trading212-demo", async () => {
    createMock.mockResolvedValue(makeFakeBroker({}));
    process.argv = ["node", "etoro-instrument-probe.ts", "--all"];
    const { main } = await import("@/hermes-execution/etoro-instrument-probe");
    await main();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]?.[3]).toEqual({ provider: "etoro-demo" });
  });

  describe("no-argument (operator scope) behaviour", () => {
    it("does not connect to the broker, does not probe anything, and exits 1 when no instrument argument is given", async () => {
      createMock.mockResolvedValue(makeFakeBroker({}));
      process.argv = ["node", "etoro-instrument-probe.ts"];
      const { main } = await import("@/hermes-execution/etoro-instrument-probe");
      await main();

      expect(createMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      await expect(fs.access(PROBE_LOG_PATH)).rejects.toThrow();
    });

    it("probes only the exact symbols given, never the whole configured universe, for an explicit argument list", async () => {
      const broker = makeFakeBroker({});
      createMock.mockResolvedValue(broker);
      process.argv = ["node", "etoro-instrument-probe.ts", "ETH", "SOL"];
      const { main } = await import("@/hermes-execution/etoro-instrument-probe");
      await main();

      expect(broker.resolveInstrument).toHaveBeenCalledTimes(2);
      expect(broker.resolveInstrument).toHaveBeenCalledWith("ETH");
      expect(broker.resolveInstrument).toHaveBeenCalledWith("SOL");
      expect(broker.resolveInstrument).not.toHaveBeenCalledWith("BTC");
    });

    it("probes the full configured universe only when --all is explicitly given", async () => {
      const broker = makeFakeBroker({});
      createMock.mockResolvedValue(broker);
      process.argv = ["node", "etoro-instrument-probe.ts", "--all"];
      const { main } = await import("@/hermes-execution/etoro-instrument-probe");
      await main();

      expect(broker.resolveInstrument).toHaveBeenCalledWith("BTC");
      expect(broker.resolveInstrument).toHaveBeenCalledWith("ETH");
      expect(broker.resolveInstrument).toHaveBeenCalledTimes(2);
    });
  });

  describe("read-only safety", () => {
    it("never accesses placeMarketOrder, closePosition, or any other mutation/account/portfolio method", async () => {
      const broker = makeMutationGuardedBroker({
        BTC: {
          resolve: () => Promise.resolve({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 }),
          rate: () => Promise.resolve({ bid: 50000, ask: 50010 }),
          candles: () => Promise.resolve(validCandles(60, 0)),
        },
      });
      createMock.mockResolvedValue(broker);
      process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];

      const { main } = await import("@/hermes-execution/etoro-instrument-probe");
      await expect(main()).resolves.not.toThrow();
      expect(process.exitCode).toBe(0);
    });

    it("never calls placeMarketOrder or closePosition — the fake broker doesn't even implement them", async () => {
      const broker = makeFakeBroker({
        BTC: { resolve: () => Promise.resolve({ instrumentId: 1, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 }) },
      });
      createMock.mockResolvedValue(broker);
      process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];
      const { main } = await import("@/hermes-execution/etoro-instrument-probe");
      await expect(main()).resolves.not.toThrow();
      expect(process.exitCode).toBe(0);
    });
  });

  it("classifies BTC as READ_ONLY_VERIFIED end-to-end, records it in the cross-run log, and writes a self-contained evidence document", async () => {
    const broker = makeFakeBroker({
      BTC: {
        resolve: () => Promise.resolve({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 }),
        rate: () => Promise.resolve({ bid: 50000, ask: 50010, date: new Date().toISOString() }),
        candles: () => Promise.resolve(validCandles(60, 0)),
      },
    });
    createMock.mockResolvedValue(broker);
    process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];

    const { main } = await import("@/hermes-execution/etoro-instrument-probe");
    await main();

    expect(process.exitCode).toBe(0);
    const events = await readProbeLog();
    const classified = events.find((e) => e.eventType === "INSTRUMENT_PROBE_CLASSIFIED" && e.instrument === "BTC");
    expect(classified?.details.classification).toBe("READ_ONLY_VERIFIED");
    const evidenceFile = classified?.details.evidenceFile as string;
    expect(evidenceFile).toContain("etoro-capability-evidence");

    const evidenceEvents = await readEvidenceFile(evidenceFile);
    expect(evidenceEvents).toHaveLength(1);
    const doc = evidenceEvents[0]!.details;
    expect(doc.schemaVersion).toBe(2);
    expect(doc.instrument).toBe("BTC");
    expect(doc.classification).toBe("READ_ONLY_VERIFIED");
    expect(doc.classificationReasons).toEqual([]);
    expect(doc.appVersion).toBeTruthy();
    expect((doc.configuration as Record<string, unknown>).currency).toBeNull();
    expect((doc.resolution as Record<string, unknown>).kind).toBe("success");
    const quote = doc.quote as Record<string, unknown>;
    expect(quote.kind).toBe("success");
    expect(quote.freshness).toBe("FRESH");
    expect(quote.usableForVerification).toBe(true);
    expect(typeof quote.ageSeconds).toBe("number");
    expect(quote.probeReceivedAt).toBeTruthy();
    expect((doc.candles as Record<string, unknown>).kind).toBe("success");
  });

  it("classifies an unresolvable instrument as UNSUPPORTED without retrying (no-match is not a transport error)", async () => {
    const broker = makeFakeBroker({});
    createMock.mockResolvedValue(broker);
    process.argv = ["node", "etoro-instrument-probe.ts", "NOPE"];

    const { main } = await import("@/hermes-execution/etoro-instrument-probe");
    await main();

    expect(broker.resolveInstrument).toHaveBeenCalledTimes(1);
    const events = await readProbeLog();
    const classified = events.find((e) => e.eventType === "INSTRUMENT_PROBE_CLASSIFIED" && e.instrument === "NOPE");
    expect(classified?.details.classification).toBe("UNSUPPORTED");
  });

  it("retries exactly once on a generic transport error, then classifies as NOT_TESTED — never conflated with UNSUPPORTED", async () => {
    const resolveInstrument = vi.fn().mockRejectedValue(new Error("simulated transport failure"));
    const broker = { resolveInstrument, getRate: vi.fn(), getHistoricalCandles: vi.fn() };
    createMock.mockResolvedValue(broker);
    process.argv = ["node", "etoro-instrument-probe.ts", "XYZ"];

    const { main } = await import("@/hermes-execution/etoro-instrument-probe");
    await main();

    expect(resolveInstrument).toHaveBeenCalledTimes(2);
    const events = await readProbeLog();
    const classified = events.find((e) => e.eventType === "INSTRUMENT_PROBE_CLASSIFIED" && e.instrument === "XYZ");
    expect(classified?.details.classification).toBe("NOT_TESTED");
  }, 10_000);

  it("retries exactly once on an authentication failure (EtoroApiError, HTTP 401), then classifies as NOT_TESTED, never UNSUPPORTED", async () => {
    const authError = new EtoroApiError("searchInstruments", 401, "req-1", "UNAUTHORIZED", "Invalid credentials");
    const resolveInstrument = vi.fn().mockRejectedValue(authError);
    const broker = { resolveInstrument, getRate: vi.fn(), getHistoricalCandles: vi.fn() };
    createMock.mockResolvedValue(broker);
    process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];

    const { main } = await import("@/hermes-execution/etoro-instrument-probe");
    await main();

    expect(resolveInstrument).toHaveBeenCalledTimes(2);
    const events = await readProbeLog();
    const classified = events.find((e) => e.eventType === "INSTRUMENT_PROBE_CLASSIFIED" && e.instrument === "BTC");
    expect(classified?.details.classification).toBe("NOT_TESTED");
  }, 10_000);

  describe("quote validation", () => {
    it("records a non-finite/non-positive rate as malformed, never as success", async () => {
      const broker = makeFakeBroker({
        BTC: {
          resolve: () => Promise.resolve({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 }),
          rate: () => Promise.resolve({ bid: Number.NaN, ask: 50010 }),
          candles: () => Promise.resolve(validCandles(60, 0)),
        },
      });
      createMock.mockResolvedValue(broker);
      process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];
      const { main } = await import("@/hermes-execution/etoro-instrument-probe");
      await main();

      const events = await readProbeLog();
      const classified = events.find((e) => e.eventType === "INSTRUMENT_PROBE_CLASSIFIED" && e.instrument === "BTC");
      expect(classified?.details.classification).toBe("PARTIALLY_SUPPORTED");
      const evidence = await readEvidenceFile(classified!.details.evidenceFile as string);
      expect((evidence[0]!.details.quote as Record<string, unknown>).kind).toBe("malformed");
    });

    it("records an inverted rate (ask below bid) as malformed", async () => {
      const broker = makeFakeBroker({
        BTC: {
          resolve: () => Promise.resolve({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 }),
          rate: () => Promise.resolve({ bid: 100, ask: 90 }),
          candles: () => Promise.resolve(validCandles(60, 0)),
        },
      });
      createMock.mockResolvedValue(broker);
      process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];
      const { main } = await import("@/hermes-execution/etoro-instrument-probe");
      await main();

      const events = await readProbeLog();
      const classified = events.find((e) => e.eventType === "INSTRUMENT_PROBE_CLASSIFIED" && e.instrument === "BTC");
      const evidence = await readEvidenceFile(classified!.details.evidenceFile as string);
      const quote = evidence[0]!.details.quote as Record<string, unknown>;
      expect(quote.kind).toBe("malformed");
      expect(quote.reason).toMatch(/inverted/);
    });

    it("records an unparseable quote date honestly as INVALID_TIMESTAMP, never silently as fresh or 'no timestamp' — and this is not READ_ONLY_VERIFIED", async () => {
      const broker = makeFakeBroker({
        BTC: {
          resolve: () => Promise.resolve({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 }),
          rate: () => Promise.resolve({ bid: 100, ask: 101, date: "not-a-real-date" }),
          candles: () => Promise.resolve(validCandles(60, 0)),
        },
      });
      createMock.mockResolvedValue(broker);
      process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];
      const { main } = await import("@/hermes-execution/etoro-instrument-probe");
      await main();

      const events = await readProbeLog();
      const classified = events.find((e) => e.eventType === "INSTRUMENT_PROBE_CLASSIFIED" && e.instrument === "BTC");
      expect(classified?.details.classification).toBe("PARTIALLY_SUPPORTED");
      expect(classified?.details.classificationReasons).toContain("QUOTE_TIMESTAMP_INVALID");
      const evidence = await readEvidenceFile(classified!.details.evidenceFile as string);
      const quote = evidence[0]!.details.quote as Record<string, unknown>;
      expect(quote.kind).toBe("success");
      expect(quote.retrievalSucceeded).toBe(true);
      expect(quote.freshness).toBe("INVALID_TIMESTAMP");
      expect(quote.usableForVerification).toBe(false);
      expect(quote.ageSeconds).toBeUndefined();
    });

    it("records a missing quote timestamp honestly as UNKNOWN freshness, never treated as fresh — and this is not READ_ONLY_VERIFIED", async () => {
      const broker = makeFakeBroker({
        BTC: {
          resolve: () => Promise.resolve({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 }),
          rate: () => Promise.resolve({ bid: 100, ask: 101 }), // no `date` field at all
          candles: () => Promise.resolve(validCandles(60, 0)),
        },
      });
      createMock.mockResolvedValue(broker);
      process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];
      const { main } = await import("@/hermes-execution/etoro-instrument-probe");
      await main();

      const events = await readProbeLog();
      const classified = events.find((e) => e.eventType === "INSTRUMENT_PROBE_CLASSIFIED" && e.instrument === "BTC");
      expect(classified?.details.classification).not.toBe("READ_ONLY_VERIFIED");
      expect(classified?.details.classification).toBe("PARTIALLY_SUPPORTED");
      expect(classified?.details.classificationReasons).toContain("QUOTE_TIMESTAMP_MISSING");
      const evidence = await readEvidenceFile(classified!.details.evidenceFile as string);
      const quote = evidence[0]!.details.quote as Record<string, unknown>;
      expect(quote.freshness).toBe("UNKNOWN");
      expect(quote.usableForVerification).toBe(false);
    });

    it("live-BTC-run remediation: a stale quote (age past threshold) + valid candles produces PARTIALLY_SUPPORTED, never READ_ONLY_VERIFIED", async () => {
      const staleDate = new Date(Date.now() - 6_045_000).toISOString(); // ~6045s old, matches the observed defect
      const broker = makeFakeBroker({
        BTC: {
          resolve: () => Promise.resolve({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 }),
          rate: () => Promise.resolve({ bid: 50000, ask: 50010, date: staleDate }),
          candles: () => Promise.resolve(validCandles(60, 0)),
        },
      });
      createMock.mockResolvedValue(broker);
      process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];
      const { main } = await import("@/hermes-execution/etoro-instrument-probe");
      await main();

      const events = await readProbeLog();
      const classified = events.find((e) => e.eventType === "INSTRUMENT_PROBE_CLASSIFIED" && e.instrument === "BTC");
      expect(classified?.details.classification).toBe("PARTIALLY_SUPPORTED");
      expect(classified?.details.classificationReasons).toEqual(["QUOTE_STALE"]);

      const evidence = await readEvidenceFile(classified!.details.evidenceFile as string);
      const doc = evidence[0]!.details;
      const quote = doc.quote as Record<string, unknown>;
      expect(quote.kind).toBe("success");
      expect(quote.freshness).toBe("STALE");
      expect(quote.usableForVerification).toBe(false);
      expect(quote.ageSeconds).toBeGreaterThan(6_000);
      expect(quote.date).toBe(staleDate);
      expect(quote.probeReceivedAt).toBeTruthy();
      expect(doc.classification).toBe("PARTIALLY_SUPPORTED");
      expect(doc.classificationReasons).toEqual(["QUOTE_STALE"]);
      expect((doc.configuration as Record<string, unknown>).quoteStalenessThresholdMs).toBe(60_000);
    });

    it("prints an unmistakable STALE summary line, never a generic success line with only a trailing (STALE) annotation", async () => {
      const staleDate = new Date(Date.now() - 6_045_000).toISOString();
      const broker = makeFakeBroker({
        BTC: {
          resolve: () => Promise.resolve({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 }),
          rate: () => Promise.resolve({ bid: 50000, ask: 50010, date: staleDate }),
          candles: () => Promise.resolve(validCandles(60, 0)),
        },
      });
      createMock.mockResolvedValue(broker);
      process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      let lines: string[];
      try {
        const { main } = await import("@/hermes-execution/etoro-instrument-probe");
        await main();
      } finally {
        // Captured BEFORE mockRestore() — restoring also resets .mock.calls, which would
        // otherwise silently make every assertion below check against an empty array.
        lines = logSpy.mock.calls.map((call) => String(call[0]));
        logSpy.mockRestore();
      }

      const quoteLine = lines.find((line) => line.includes("Stage 2 (quote):"));
      const classificationLine = lines.find((line) => line.includes("Classification:"));

      expect(quoteLine).toBeTruthy();
      expect(quoteLine).toMatch(/STALE/);
      expect(quoteLine).toMatch(/exceeds 60s threshold/);
      expect(quoteLine).not.toMatch(/^\s*Stage 2 \(quote\):\s+bid=.*\(STALE\)\s*$/);

      expect(classificationLine).toBeTruthy();
      expect(classificationLine).toMatch(/PARTIALLY_SUPPORTED/);
      expect(classificationLine).toMatch(/QUOTE_STALE/);
    });

    describe("freshness threshold boundary", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("treats a quote exactly at the configured threshold age as FRESH, contributing to READ_ONLY_VERIFIED", async () => {
        const now = new Date("2026-01-01T00:00:00.000Z");
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const boundaryDate = new Date(now.getTime() - QUOTE_STALENESS_THRESHOLD_MS).toISOString();

        const broker = makeFakeBroker({
          BTC: {
            resolve: () => Promise.resolve({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 }),
            rate: () => Promise.resolve({ bid: 100, ask: 101, date: boundaryDate }),
            candles: () => Promise.resolve(validCandles(60, 0)),
          },
        });
        createMock.mockResolvedValue(broker);
        process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];

        const { main } = await import("@/hermes-execution/etoro-instrument-probe");
        await main();

        const events = await readProbeLog();
        const classified = events.find((e) => e.eventType === "INSTRUMENT_PROBE_CLASSIFIED" && e.instrument === "BTC");
        expect(classified?.details.classification).toBe("READ_ONLY_VERIFIED");
      });

      it("treats a quote 1 second past the configured threshold age as STALE, producing PARTIALLY_SUPPORTED", async () => {
        const now = new Date("2026-01-01T00:00:00.000Z");
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const justPastBoundaryDate = new Date(now.getTime() - QUOTE_STALENESS_THRESHOLD_MS - 1_000).toISOString();

        const broker = makeFakeBroker({
          BTC: {
            resolve: () => Promise.resolve({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 }),
            rate: () => Promise.resolve({ bid: 100, ask: 101, date: justPastBoundaryDate }),
            candles: () => Promise.resolve(validCandles(60, 0)),
          },
        });
        createMock.mockResolvedValue(broker);
        process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];

        const { main } = await import("@/hermes-execution/etoro-instrument-probe");
        await main();

        const events = await readProbeLog();
        const classified = events.find((e) => e.eventType === "INSTRUMENT_PROBE_CLASSIFIED" && e.instrument === "BTC");
        expect(classified?.details.classification).toBe("PARTIALLY_SUPPORTED");
        expect(classified?.details.classificationReasons).toEqual(["QUOTE_STALE"]);
      });
    });

    it("never records a currency assumption — configuration.currency is always null", async () => {
      const broker = makeFakeBroker({
        BTC: {
          resolve: () => Promise.resolve({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 }),
          rate: () => Promise.resolve({ bid: 100, ask: 101 }),
          candles: () => Promise.resolve(validCandles(60, 0)),
        },
      });
      createMock.mockResolvedValue(broker);
      process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];
      const { main } = await import("@/hermes-execution/etoro-instrument-probe");
      await main();

      const events = await readProbeLog();
      const classified = events.find((e) => e.eventType === "INSTRUMENT_PROBE_CLASSIFIED" && e.instrument === "BTC");
      const evidence = await readEvidenceFile(classified!.details.evidenceFile as string);
      const configuration = evidence[0]!.details.configuration as Record<string, unknown>;
      expect(configuration.currency).toBeNull();
      expect(JSON.stringify(evidence)).not.toMatch(/"usd"/i);
    });
  });

  describe("candle evidence", () => {
    it("preserves both the requested and received candle counts, and reports explicit freshness", async () => {
      const broker = makeFakeBroker({
        BTC: {
          resolve: () => Promise.resolve({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 }),
          rate: () => Promise.resolve({ bid: 100, ask: 101 }),
          candles: () => Promise.resolve(validCandles(60, 0)),
        },
      });
      createMock.mockResolvedValue(broker);
      process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];
      const { main } = await import("@/hermes-execution/etoro-instrument-probe");
      await main();

      const events = await readProbeLog();
      const classified = events.find((e) => e.eventType === "INSTRUMENT_PROBE_CLASSIFIED" && e.instrument === "BTC");
      const evidence = await readEvidenceFile(classified!.details.evidenceFile as string);
      const candles = evidence[0]!.details.candles as Record<string, unknown>;
      expect(candles.kind).toBe("success");
      expect(candles.candleCount).toBe(60);
      expect(typeof candles.lastCandleAgeSeconds).toBe("number");
      expect((evidence[0]!.details.configuration as Record<string, unknown>).requestedCandleCount).toBe(60);
    });
  });

  it("defaults to nothing (usage + exit 1) when no CLI instruments and no --all are given, even though a universe is configured", async () => {
    const broker = makeFakeBroker({});
    createMock.mockResolvedValue(broker);

    const { main } = await import("@/hermes-execution/etoro-instrument-probe");
    await main();

    expect(broker.resolveInstrument).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("appends to the existing cross-run pointer log across separate runs rather than overwriting it", async () => {
    const broker = makeFakeBroker({});
    createMock.mockResolvedValue(broker);
    process.argv = ["node", "etoro-instrument-probe.ts", "FIRST"];

    const { main } = await import("@/hermes-execution/etoro-instrument-probe");
    await main();
    const afterFirstRun = await readProbeLog();
    expect(afterFirstRun.some((e) => e.instrument === "FIRST")).toBe(true);

    process.argv = ["node", "etoro-instrument-probe.ts", "SECOND"];
    await main();
    const afterSecondRun = await readProbeLog();
    expect(afterSecondRun.some((e) => e.instrument === "FIRST")).toBe(true);
    expect(afterSecondRun.some((e) => e.instrument === "SECOND")).toBe(true);
    expect(afterSecondRun.length).toBeGreaterThan(afterFirstRun.length);
  });

  it("writes a distinct, separately-named evidence file per instrument per run, never overwriting a prior run's evidence", async () => {
    const broker = makeFakeBroker({});
    createMock.mockResolvedValue(broker);
    process.argv = ["node", "etoro-instrument-probe.ts", "FIRST"];
    const { main } = await import("@/hermes-execution/etoro-instrument-probe");
    await main();
    const firstRunEvents = await readProbeLog();
    const firstEvidencePath = firstRunEvents
      .filter((e) => e.instrument === "FIRST" && e.eventType === "INSTRUMENT_PROBE_CLASSIFIED")
      .at(-1)!.details.evidenceFile as string;

    process.argv = ["node", "etoro-instrument-probe.ts", "FIRST"];
    await main();
    const secondRunEvents = await readProbeLog();
    const secondEvidencePath = secondRunEvents
      .filter((e) => e.instrument === "FIRST" && e.eventType === "INSTRUMENT_PROBE_CLASSIFIED")
      .at(-1)!.details.evidenceFile as string;

    expect(secondEvidencePath).not.toBe(firstEvidencePath);
    await expect(fs.access(firstEvidencePath)).resolves.toBeUndefined();
    await expect(fs.access(secondEvidencePath)).resolves.toBeUndefined();
  });

  describe("evidence safety — secret redaction", () => {
    it("never persists the configured apiKey/userKey, even when an error message would otherwise echo them", async () => {
      const leakyError = new Error(`upstream rejected request with header x-api-key: ${TEST_API_KEY} and x-user-key: ${TEST_USER_KEY}`);
      const resolveInstrument = vi.fn().mockRejectedValue(leakyError);
      const broker = { resolveInstrument, getRate: vi.fn(), getHistoricalCandles: vi.fn() };
      createMock.mockResolvedValue(broker);
      process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];

      const { main } = await import("@/hermes-execution/etoro-instrument-probe");
      await main();

      const probeLogText = await fs.readFile(PROBE_LOG_PATH, "utf-8");
      expect(probeLogText).not.toContain(TEST_API_KEY);
      expect(probeLogText).not.toContain(TEST_USER_KEY);
      expect(probeLogText).toContain("[REDACTED]");

      const events = await readProbeLog();
      const classified = events.find((e) => e.eventType === "INSTRUMENT_PROBE_CLASSIFIED" && e.instrument === "BTC");
      const evidenceText = await fs.readFile(classified!.details.evidenceFile as string, "utf-8");
      expect(evidenceText).not.toContain(TEST_API_KEY);
      expect(evidenceText).not.toContain(TEST_USER_KEY);
    }, 10_000);

    it("redacts a secret leaking through the quote or candle stage too, not only resolution", async () => {
      const broker = makeFakeBroker({
        BTC: {
          resolve: () => Promise.resolve({ instrumentId: 100000, displayName: "Bitcoin", symbol: "BTC", instrumentTypeID: 10, exchangeID: 8 }),
        },
      });
      broker.getRate.mockRejectedValue(new Error(`rate fetch failed, request used x-api-key: ${TEST_API_KEY}`));
      broker.getHistoricalCandles.mockRejectedValue(new Error(`candle fetch failed, request used x-user-key: ${TEST_USER_KEY}`));
      createMock.mockResolvedValue(broker);
      process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];

      const { main } = await import("@/hermes-execution/etoro-instrument-probe");
      await main();

      const probeLogText = await fs.readFile(PROBE_LOG_PATH, "utf-8");
      expect(probeLogText).not.toContain(TEST_API_KEY);
      expect(probeLogText).not.toContain(TEST_USER_KEY);

      const events = await readProbeLog();
      const classified = events.find((e) => e.eventType === "INSTRUMENT_PROBE_CLASSIFIED" && e.instrument === "BTC");
      const evidenceText = await fs.readFile(classified!.details.evidenceFile as string, "utf-8");
      expect(evidenceText).not.toContain(TEST_API_KEY);
      expect(evidenceText).not.toContain(TEST_USER_KEY);
    }, 10_000);
  });

  it("fails closed with exit code 1 and never connects when eToro demo config is invalid", async () => {
    vi.doMock("@/lib/hermes-execution/config", () => ({
      getHermesExecutionConfig: () => ({
        brokerProvider: "trading212-demo",
        etoro: { env: undefined, apiKey: undefined, userKey: undefined, testInstrument: "BTC", testAmount: 50, httpTimeoutMs: 10_000 },
        marketData: { timeframe: "1h", candleCount: 60, maxCandleAgeSeconds: 7_200 },
        hermesAgent: { instrumentUniverse: ["BTC"] },
      }),
    }));
    vi.resetModules();
    process.argv = ["node", "etoro-instrument-probe.ts", "BTC"];
    const { main } = await import("@/hermes-execution/etoro-instrument-probe");
    await main();
    expect(createMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    vi.doUnmock("@/lib/hermes-execution/config");
    vi.resetModules();
  });
});
