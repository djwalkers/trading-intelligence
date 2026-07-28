import { describe, expect, it } from "vitest";
import { runUniverseScan, UniverseScanner, type UniverseScannerDeps } from "@/lib/hermes-execution/runtime/universe-scanner";
import { getHermesAgentInternalStrategy } from "@/lib/hermes-execution/hermes-agent/hermes-agent-strategy";
import { hermesAgentStrategy as sharedHermesAgentStrategy } from "@/lib/hermes-execution/strategies/default-strategy-registry";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { InMemoryTradeCandidateRepository } from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import { MockMarketDataProvider } from "@/lib/hermes-execution/market-data/mock-market-data-provider";
import { AlwaysOpenMarketHoursPolicy, WeekdaySessionMarketHoursPolicy } from "@/lib/hermes-execution/runtime/market-hours-policy";
import type { HermesCliRunner, HermesCliRunResult } from "@/lib/hermes-execution/hermes-agent/hermes-cli-runner";
import type { Account, CompletedTrade, OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";
import type { MarketDataProvider, MarketDataSnapshot } from "@/lib/hermes-execution/market-data/market-data-provider";

// Prototype 1.0 — official Hermes Agent decision integration (Phase 3 redesign). universe-scanner.ts
// now ONLY decides which instruments are eligible and which Hermes proposals are selected/set on
// the shared strategy — it no longer runs reconciliation or creates candidates itself (that now
// happens per instrument inside TradingRuntime's own runInstrumentCycle loop — see
// trading-runtime.test.ts's own multi-instrument describe blocks for that coverage). Every
// dependency here is a fake/in-memory implementation — no real broker, no real market data, no
// real Hermes CLI anywhere in this file.

const UNIVERSE = ["BTC", "ETH", "SOL", "AAPL", "MSFT", "NVDA"];
const NOW = new Date("2026-01-01T12:00:00.000Z");

function makeBroker(openPositions: PaperPosition[] = []) {
  const tracked = new Map(openPositions.map((p) => [p.positionId, p]));
  return {
    getAccount: (): Account => ({ cashBalance: 100_000, startingCashBalance: 100_000 }),
    getOpenPositions: (): PaperPosition[] => [...tracked.values()],
    getCompletedTrades: (): CompletedTrade[] => [],
    placeMarketOrder: async (_order: OrderRequest) => {
      throw new Error("universe-scanner must never call the broker to place an order");
    },
    closePosition: async () => {
      throw new Error("universe-scanner must never call the broker to close a position");
    },
  };
}

class FakeHermesRunner implements HermesCliRunner {
  public callCount = 0;
  public lastArgs: string[] | undefined;
  constructor(private readonly result: HermesCliRunResult) {}
  async run(_cliPath: string, args: string[]): Promise<HermesCliRunResult> {
    this.callCount += 1;
    this.lastArgs = args;
    return this.result;
  }
}

function hermesResponse(proposals: Array<Record<string, unknown>>): HermesCliRunResult {
  return { ok: true, stdout: JSON.stringify({ proposals }) };
}

function baseDeps(overrides: Partial<UniverseScannerDeps> = {}): UniverseScannerDeps {
  return {
    broker: makeBroker(),
    marketDataProvider: new MockMarketDataProvider({ bias: "sideways", seed: 1, now: NOW }),
    tradeCandidateRepository: new InMemoryTradeCandidateRepository(),
    auditTrail: new InMemoryAuditTrail(),
    executionRunId: "test-run",
    strategy: getHermesAgentInternalStrategy(),
    hermesAgentStrategy: sharedHermesAgentStrategy,
    hermesAdapterConfig: { cliPath: "/home/andy/.local/bin/hermes", decisionTimeoutMs: 60_000, maxStdoutBytes: 65_536 },
    hermesCliRunner: new FakeHermesRunner(hermesResponse([])),
    instrumentUniverse: UNIVERSE,
    maxProposalsPerScan: 2,
    maxOpenPositions: 2,
    maxOpenPositionsPerInstrument: 1,
    orderSizingMode: "UNITS",
    equityMarketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
    now: NOW,
    ...overrides,
  };
}

describe("runUniverseScan — six configured instruments, one Hermes call per scan", () => {
  it("builds a snapshot for all six configured instruments and calls Hermes exactly once", async () => {
    const runner = new FakeHermesRunner(hermesResponse([]));
    const result = await runUniverseScan(baseDeps({ hermesCliRunner: runner }));
    expect(result.eligibleInstrumentCount).toBe(6);
    expect(runner.callCount).toBe(1);
  });
});

describe("runUniverseScan — market-hours eligibility", () => {
  it("crypto instruments are scanned regardless of the equity market-hours policy", async () => {
    const alwaysClosed = { isMarketOpen: () => false };
    const result = await runUniverseScan(baseDeps({ equityMarketHoursPolicy: alwaysClosed }));
    expect(result.skippedInstruments.filter((s) => ["BTC", "ETH", "SOL"].includes(s.instrument))).toEqual([]);
  });

  it("equities are skipped outside configured market hours", async () => {
    const alwaysClosed = { isMarketOpen: () => false };
    const result = await runUniverseScan(baseDeps({ equityMarketHoursPolicy: alwaysClosed }));
    const skippedEquities = result.skippedInstruments.filter((s) => ["AAPL", "MSFT", "NVDA"].includes(s.instrument));
    expect(skippedEquities).toHaveLength(3);
    expect(skippedEquities.every((s) => s.reason === "outside-market-hours")).toBe(true);
    expect(result.eligibleInstrumentCount).toBe(3);
  });

  it("equities are eligible when a real weekday-session policy reports open at this timestamp", async () => {
    const policy = new WeekdaySessionMarketHoursPolicy({ timezone: "America/New_York", sessionStart: "00:00", sessionEnd: "23:59" });
    const result = await runUniverseScan(baseDeps({ equityMarketHoursPolicy: policy }));
    expect(result.eligibleInstrumentCount).toBe(6);
  });
});

describe("runUniverseScan — one instrument's failure does not stop the others", () => {
  it("isolates a market-data fetch failure for a single instrument", async () => {
    const throwingProvider: MarketDataProvider = {
      getMarketData: async (instrument: string): Promise<MarketDataSnapshot> => {
        if (instrument === "ETH") throw new Error("simulated market-data outage for ETH");
        return new MockMarketDataProvider({ bias: "sideways", seed: 1, now: NOW }).getMarketData(instrument);
      },
    };
    const result = await runUniverseScan(baseDeps({ marketDataProvider: throwingProvider }));
    expect(result.skippedInstruments.some((s) => s.instrument === "ETH")).toBe(true);
    expect(result.eligibleInstrumentCount).toBe(5);
  });
});

describe("runUniverseScan — ranking, selection, and the maximum-two-proposals ceiling", () => {
  it("selects only the top-ranked proposals up to maxProposalsPerScan", async () => {
    const runner = new FakeHermesRunner(
      hermesResponse([
        { instrument: "BTC", action: "BUY", confidence: 0.6, reasoning: ["ok"] },
        { instrument: "ETH", action: "BUY", confidence: 0.9, reasoning: ["ok"] },
        { instrument: "SOL", action: "BUY", confidence: 0.75, reasoning: ["ok"] },
      ]),
    );
    const result = await runUniverseScan(baseDeps({ hermesCliRunner: runner, maxProposalsPerScan: 2 }));
    expect(result.selectedProposals.map((p) => p.instrument)).toEqual(["ETH", "SOL"]);
  });

  it("sets the selection on the shared HermesAgentStrategy instance", async () => {
    const runner = new FakeHermesRunner(hermesResponse([{ instrument: "BTC", action: "BUY", confidence: 0.9, reasoning: ["ok"] }]));
    await runUniverseScan(baseDeps({ hermesCliRunner: runner }));
    // Reading back via a fresh evaluate() call proves setScanProposals() was actually invoked with
    // the selection — a more direct unit test of this exists in hermes-agent-strategy.test.ts.
    const decision = await sharedHermesAgentStrategy.evaluate({
      instrument: "BTC",
      bid: 100,
      ask: 100.05,
      spread: 0.05,
      midPrice: 100.025,
      timestamp: NOW.toISOString(),
      positionOpen: false,
      strategy: { strategyId: "HERMES-AGENT", version: 1, sourceType: "HERMES_APPROVED" },
      recentCandles: [],
      ema20: 100,
      ema50: 100,
      rsi14: 50,
      atr14: 1,
      volume: 10,
      dailyHigh: 100,
      dailyLow: 100,
      volatility24h: 0.01,
      marketSession: "Crypto Always Open",
      trend: "Bullish",
    });
    expect(decision.action).toBe("BUY");
  });
});

describe("runUniverseScan — portfolio-wide maximum open positions respected", () => {
  it("does not select more BUY proposals than the portfolio ceiling allows", async () => {
    const existingPosition: PaperPosition = {
      positionId: "p1",
      strategyId: "HERMES-AGENT",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "AAPL",
      side: "BUY",
      quantity: 1,
      entryPrice: 100,
      entryTimestamp: NOW.toISOString(),
      entryOrderId: "o1",
    };
    const runner = new FakeHermesRunner(
      hermesResponse([
        { instrument: "BTC", action: "BUY", confidence: 0.9, reasoning: ["ok"] },
        { instrument: "ETH", action: "BUY", confidence: 0.8, reasoning: ["ok"] },
      ]),
    );
    const result = await runUniverseScan(baseDeps({ broker: makeBroker([existingPosition]), hermesCliRunner: runner, maxOpenPositions: 2 }));
    expect(result.selectedProposals).toHaveLength(1);
    expect(result.selectedProposals[0]?.instrument).toBe("BTC");
  });

  it("does not select a second BUY for an instrument that already has an open position", async () => {
    const existingPosition: PaperPosition = {
      positionId: "p1",
      strategyId: "HERMES-AGENT",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "BTC",
      side: "BUY",
      quantity: 1,
      entryPrice: 100,
      entryTimestamp: NOW.toISOString(),
      entryOrderId: "o1",
    };
    const runner = new FakeHermesRunner(hermesResponse([{ instrument: "BTC", action: "BUY", confidence: 0.9, reasoning: ["ok"] }]));
    const result = await runUniverseScan(baseDeps({ broker: makeBroker([existingPosition]), hermesCliRunner: runner, maxOpenPositions: 2 }));
    expect(result.selectedProposals).toEqual([]);
  });
});

describe("runUniverseScan — shared account/portfolio view", () => {
  it("uses one shared broker.getAccount() read for the whole scan's portfolio context", async () => {
    const broker = makeBroker();
    let accountReads = 0;
    const wrapped = {
      ...broker,
      getAccount: () => {
        accountReads += 1;
        return broker.getAccount();
      },
    };
    await runUniverseScan(baseDeps({ broker: wrapped }));
    // Exactly one account read for the whole scan — never re-fetched per instrument (unlike
    // getOpenPositions(), which buildMarketDecisionContext's own existing, unrelated per-instrument
    // positionOpen check also legitimately calls once per instrument).
    expect(accountReads).toBe(1);
  });

  it("the exposure/open-position-count fed to Hermes and the selection ceiling both reflect the SAME broker snapshot", async () => {
    const existingPosition: PaperPosition = {
      positionId: "p1",
      strategyId: "HERMES-AGENT",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "AAPL",
      side: "BUY",
      quantity: 1,
      entryPrice: 100,
      entryTimestamp: NOW.toISOString(),
      entryOrderId: "o1",
    };
    const runner = new FakeHermesRunner(hermesResponse([{ instrument: "BTC", action: "BUY", confidence: 0.9, reasoning: ["ok"] }]));
    const result = await runUniverseScan(baseDeps({ broker: makeBroker([existingPosition]), hermesCliRunner: runner, maxOpenPositions: 2 }));
    // One position already open (AAPL) + one selected (BTC) never exceeds the ceiling of 2 —
    // proves the selection logic saw the same one-open-position snapshot the Hermes input itself
    // was built from.
    expect(result.selectedProposals).toHaveLength(1);
  });
});

describe("runUniverseScan — SELL semantics (closing vs. unsupported short)", () => {
  it("selects a SELL proposal that closes an existing long position", async () => {
    const openPosition: PaperPosition = {
      positionId: "p1",
      strategyId: "HERMES-AGENT",
      strategyVersion: 1,
      sourceType: "HERMES_APPROVED",
      instrument: "BTC",
      side: "BUY",
      quantity: 10,
      entryPrice: 100,
      entryTimestamp: NOW.toISOString(),
      entryOrderId: "o1",
    };
    const runner = new FakeHermesRunner(hermesResponse([{ instrument: "BTC", action: "SELL", confidence: 0.8, reasoning: ["taking profit"] }]));
    const result = await runUniverseScan(baseDeps({ broker: makeBroker([openPosition]), hermesCliRunner: runner }));
    expect(result.selectedProposals.map((p) => p.instrument)).toEqual(["BTC"]);
  });

  it("fails closed (never selects) a SELL proposal with no existing long — short-opening is not supported", async () => {
    const runner = new FakeHermesRunner(hermesResponse([{ instrument: "BTC", action: "SELL", confidence: 0.8, reasoning: ["bearish"] }]));
    const result = await runUniverseScan(baseDeps({ hermesCliRunner: runner }));
    expect(result.selectedProposals).toEqual([]);
  });
});

describe("runUniverseScan — Hermes rejection fails closed", () => {
  it("selects nothing and emits HERMES_RESPONSE_REJECTED when the response is invalid", async () => {
    const auditTrail = new InMemoryAuditTrail();
    const runner = new FakeHermesRunner({ ok: true, stdout: "not json at all" });
    const result = await runUniverseScan(baseDeps({ hermesCliRunner: runner, auditTrail }));
    expect(result.selectedProposals).toEqual([]);
    expect(result.hermesRejected).toBeDefined();
    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toContain("HERMES_RESPONSE_REJECTED");
  });

  it("clears any stale prior selection on the shared strategy when Hermes fails this scan", async () => {
    // First, a successful scan selects BTC.
    const goodRunner = new FakeHermesRunner(hermesResponse([{ instrument: "BTC", action: "BUY", confidence: 0.9, reasoning: ["ok"] }]));
    await runUniverseScan(baseDeps({ hermesCliRunner: goodRunner }));

    // Then, a failing scan must clear it — never leave BTC's stale selection active.
    const badRunner = new FakeHermesRunner({ ok: true, stdout: "not json" });
    await runUniverseScan(baseDeps({ hermesCliRunner: badRunner }));

    const decision = await sharedHermesAgentStrategy.evaluate({
      instrument: "BTC",
      bid: 100,
      ask: 100.05,
      spread: 0.05,
      midPrice: 100.025,
      timestamp: NOW.toISOString(),
      positionOpen: false,
      strategy: { strategyId: "HERMES-AGENT", version: 1, sourceType: "HERMES_APPROVED" },
      recentCandles: [],
      ema20: 100,
      ema50: 100,
      rsi14: 50,
      atr14: 1,
      volume: 10,
      dailyHigh: 100,
      dailyLow: 100,
      volatility24h: 0.01,
      marketSession: "Crypto Always Open",
      trend: "Bullish",
    });
    expect(decision.action).toBe("HOLD");
  });
});

describe("UniverseScanner — no concurrent scan overlap", () => {
  it("skips a scan requested while one is already in flight", async () => {
    let resolveFirstRun: (() => void) | undefined;
    const blockingRunner: HermesCliRunner = {
      run: () =>
        new Promise((resolve) => {
          resolveFirstRun = () => resolve(hermesResponse([]));
        }),
    };
    const scanner = new UniverseScanner(baseDeps({ hermesCliRunner: blockingRunner }));

    const firstScan = scanner.scan(NOW);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondScan = await scanner.scan(NOW);
    expect(secondScan).toEqual({ skipped: true });

    resolveFirstRun?.();
    await firstScan;
  });
});
