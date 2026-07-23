import { describe, expect, it, vi } from "vitest";
import { runStrategyResearch } from "@/lib/hermes-execution/research/run-strategy-research";
import { researchStrategyRegistry } from "@/lib/hermes-execution/research/research-strategy-registry";
import { InMemoryStrategyRegistry } from "@/lib/hermes-execution/strategies/strategy-registry";
import { UnknownStrategyError } from "@/lib/hermes-execution/strategies/strategy-registry";
import type { AnalysisRepository } from "@/lib/hermes-execution/analysis/analysis-repository";
import type { AnalysisFilter, AnalysisRun } from "@/lib/hermes-execution/analysis/types";

function makeRun(overrides: Partial<AnalysisRun>): AnalysisRun {
  return {
    id: `run-${Math.random()}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    runtimeMode: "demo",
    brokerProvider: "etoro-demo",
    marketProvider: "live",
    instrument: "BTC",
    timeframe: "1h",
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    currentBid: 100,
    currentAsk: 100.05,
    ema20: 100,
    ema50: 100,
    rsi14: 50,
    atr14: 1,
    trend: "Sideways",
    confidence: 0.5,
    decision: "HOLD",
    executedTrade: false,
    validationOk: true,
    fallbackUsed: false,
    runtimeDurationMs: 100,
    metadata: {},
    ...overrides,
  };
}

/** A hand-built historical sequence: sideways, then a clean bullish setup (EMA20 above EMA50, RSI
 * healthy, Bullish trend — should trigger a BUY for both DEMO-0001 and RESEARCH-0001, since 55 is
 * within both of their entry bands), then price drifts up (still no exit signal — Bullish/Sideways
 * trend never triggers a SELL), then a Bearish reversal (should trigger a SELL, closing the
 * position, for whichever strategy entered). Rows are handed to the fake repository in REVERSE
 * (newest-first) order, matching getRecentAnalyses' own real, documented ordering — the runner
 * itself is responsible for re-sorting to chronological order before replay.
 */
function buildHistoricalSequence(): AnalysisRun[] {
  const rows: AnalysisRun[] = [
    makeRun({ id: "r1", createdAt: "2026-01-01T00:00:00.000Z", ema20: 99, ema50: 100, rsi14: 50, trend: "Sideways", decision: "HOLD" }),
    makeRun({
      id: "r2",
      createdAt: "2026-01-01T01:00:00.000Z",
      currentBid: 100,
      currentAsk: 100.05,
      ema20: 110,
      ema50: 100,
      rsi14: 55,
      trend: "Bullish",
      decision: "BUY",
    }),
    makeRun({
      id: "r3",
      createdAt: "2026-01-01T02:00:00.000Z",
      currentBid: 106,
      currentAsk: 106.05,
      ema20: 112,
      ema50: 101,
      rsi14: 56,
      trend: "Bullish",
      decision: "HOLD",
    }),
    makeRun({
      id: "r4",
      createdAt: "2026-01-01T03:00:00.000Z",
      currentBid: 112,
      currentAsk: 112.05,
      ema20: 105,
      ema50: 111,
      rsi14: 40,
      trend: "Bearish",
      decision: "SELL",
    }),
  ];
  return [...rows].reverse(); // simulate getRecentAnalyses' own newest-first ordering
}

function makeFakeRepository(rows: AnalysisRun[]): AnalysisRepository {
  return {
    saveAnalysis: vi.fn(),
    saveEvents: vi.fn(),
    markTradeExecuted: vi.fn(),
    getRecentAnalyses: vi.fn(async (_filter?: AnalysisFilter) => rows),
    getStrategyPerformance: vi.fn(),
  } as unknown as AnalysisRepository;
}

describe("runStrategyResearch", () => {
  it("replays historical analysis rows chronologically and simulates a BUY-then-SELL trade", async () => {
    const repository = makeFakeRepository(buildHistoricalSequence());

    const result = await runStrategyResearch({
      repository,
      registry: researchStrategyRegistry,
      params: { strategyId: "DEMO-0001", instrument: "BTC", since: "2026-01-01T00:00:00.000Z", until: "2026-01-01T04:00:00.000Z" },
    });

    expect(result.decisionPoints).toHaveLength(4);
    expect(result.decisionPoints.map((p) => p.analysisRunId)).toEqual(["r1", "r2", "r3", "r4"]); // chronological, not fetch order

    expect(result.trades).toHaveLength(1);
    const [trade] = result.trades;
    expect(trade!.entryPrice).toBe(100.05); // entered at ask
    expect(trade!.exitPrice).toBe(112); // exited at bid
    expect(trade!.grossPnl).toBeCloseTo((112 - 100.05) * 10);
    expect(trade!.holdingTimeMs).toBe(2 * 3_600_000); // r2 -> r4

    expect(result.metrics.tradeCount).toBe(1);
    expect(result.metrics.opportunityCount).toBe(4);
    expect(result.metrics.skippedCount).toBe(2); // r1 and r3 are HOLD once positionOpen is simulated correctly
  });

  it("never mutates or writes anything — repository is only ever read from (getRecentAnalyses), never written to", async () => {
    const repository = makeFakeRepository(buildHistoricalSequence());
    await runStrategyResearch({
      repository,
      registry: researchStrategyRegistry,
      params: { strategyId: "DEMO-0001", instrument: "BTC", since: "2026-01-01T00:00:00.000Z", until: "2026-01-01T04:00:00.000Z" },
    });
    expect(repository.saveAnalysis).not.toHaveBeenCalled();
    expect(repository.saveEvents).not.toHaveBeenCalled();
    expect(repository.markTradeExecuted).not.toHaveBeenCalled();
  });

  it("two different strategies over the identical historical window can produce different decisions (RESEARCH-0001's narrower RSI band)", async () => {
    // RSI 55 is inside DEMO-0001's 45-65 band AND RESEARCH-0001's 48-58 band — both enter here.
    // Use a value inside DEMO-0001's band but outside RESEARCH-0001's (e.g. 62) to force a real
    // divergence.
    const rows = buildHistoricalSequence();
    const buyRow = rows.find((r) => r.id === "r2")!;
    buyRow.rsi14 = 62;

    const repository = makeFakeRepository(rows);
    const demo = await runStrategyResearch({
      repository,
      registry: researchStrategyRegistry,
      params: { strategyId: "DEMO-0001", instrument: "BTC", since: "2026-01-01T00:00:00.000Z", until: "2026-01-01T04:00:00.000Z" },
    });
    const research = await runStrategyResearch({
      repository,
      registry: researchStrategyRegistry,
      params: { strategyId: "RESEARCH-0001", instrument: "BTC", since: "2026-01-01T00:00:00.000Z", until: "2026-01-01T04:00:00.000Z" },
    });

    expect(demo.trades).toHaveLength(1); // DEMO-0001's wider band enters at r2 (RSI 62)
    expect(demo.trades[0]!.entryPrice).toBe(100.05);
    // RESEARCH-0001's narrower band skips r2 (RSI 62 is outside 48-58) but still enters one bar
    // later at r3 (RSI 56, inside its band) — a genuinely different entry, proving real divergence
    // rather than merely "traded or not."
    expect(research.trades).toHaveLength(1);
    expect(research.trades[0]!.entryPrice).toBe(106.05);
    expect(research.trades[0]!.entryPrice).not.toBe(demo.trades[0]!.entryPrice);
  });

  it("throws UnknownStrategyError for an unregistered strategyId — fails closed, same convention as the live engine", async () => {
    const repository = makeFakeRepository([]);
    const emptyRegistry = new InMemoryStrategyRegistry();
    await expect(
      runStrategyResearch({
        repository,
        registry: emptyRegistry,
        params: { strategyId: "NO-SUCH-STRATEGY", instrument: "BTC", since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z" },
      }),
    ).rejects.toBeInstanceOf(UnknownStrategyError);
  });

  it("filters out ERROR rows and rows missing required indicator fields, without crashing", async () => {
    const rows = [
      makeRun({ id: "err", decision: "ERROR", ema20: undefined }),
      makeRun({ id: "incomplete", rsi14: undefined }),
      ...buildHistoricalSequence(),
    ];
    const repository = makeFakeRepository(rows);
    const result = await runStrategyResearch({
      repository,
      registry: researchStrategyRegistry,
      params: { strategyId: "DEMO-0001", instrument: "BTC", since: "2026-01-01T00:00:00.000Z", until: "2026-01-01T04:00:00.000Z" },
    });
    expect(result.decisionPoints.map((p) => p.analysisRunId)).not.toContain("err");
    expect(result.decisionPoints.map((p) => p.analysisRunId)).not.toContain("incomplete");
    expect(result.decisionPoints).toHaveLength(4);
  });
});
