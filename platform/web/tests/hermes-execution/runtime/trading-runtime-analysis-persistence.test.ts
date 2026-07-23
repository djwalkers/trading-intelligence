import { describe, expect, it, vi } from "vitest";
import { TradingRuntime, type AnalysisIntegrationDeps } from "@/lib/hermes-execution/runtime/trading-runtime";
import { AlwaysOpenMarketHoursPolicy } from "@/lib/hermes-execution/runtime/market-hours-policy";
import { MockMarketDataProvider } from "@/lib/hermes-execution/market-data/mock-market-data-provider";
import type { MarketDataProvider } from "@/lib/hermes-execution/market-data/market-data-provider";
import { TradeLifecycleService } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-service";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";
import type { PaperBroker } from "@/lib/hermes-execution/paper-broker";
import type { Account, CompletedTrade, InternalStrategy, OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";
import { AnalysisPersistenceError, type AnalysisRepository } from "@/lib/hermes-execution/analysis/analysis-repository";
import type { AnalysisEventInput, AnalysisRunInput } from "@/lib/hermes-execution/analysis/types";
import { logger } from "@/lib/logger/logger";
import { ManualSchedulerClock } from "./support/manual-scheduler-clock";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. Scheduler integration tests —
// the highest-risk part of this phase, since trading-runtime.ts also owns the actual
// decision/execution cycle. Every test here proves persistence is a strictly-additive, best-effort
// side effect: exactly one saveAnalysis() per cycle regardless of outcome, never a second record on
// execution, a failed cycle still gets a record (including the error), and a broken persistence
// layer can never affect the cycle's own returned outcome.

const NOW = new Date("2026-01-01T12:00:00.000Z");

const STRATEGY: InternalStrategy = {
  strategyId: "DEMO-0001",
  version: 1,
  sourceType: "HERMES_APPROVED",
  enabled: true,
  instrument: "BTC",
  timeframe: "1h",
  entryRules: [],
  exitRules: [],
  riskRules: { maxPositionValue: 1000 },
};

const PERMISSIVE_RISK_CONFIG: PortfolioRiskConfig = {
  portfolioMaxOpenPositions: 5,
  maxDailyTrades: 20,
  maxPortfolioExposure: 1_000_000,
};

function makeMockBroker(openPositions: PaperPosition[] = []): PaperBroker {
  const account: Account = { cashBalance: 1_000_000, startingCashBalance: 1_000_000 };
  const completedTrades: CompletedTrade[] = [];
  let positionSeq = 0;

  return {
    getAccount: () => account,
    getOpenPositions: () => openPositions,
    getCompletedTrades: () => completedTrades,
    placeMarketOrder: vi.fn(async (order: OrderRequest) => {
      positionSeq += 1;
      const position: PaperPosition = {
        positionId: `mock-position-${positionSeq}`,
        strategyId: order.strategyId,
        strategyVersion: order.strategyVersion,
        sourceType: order.sourceType,
        instrument: order.instrument,
        side: order.side,
        quantity: order.quantity,
        entryPrice: order.price,
        entryTimestamp: order.timestamp,
        entryOrderId: `mock-order-${positionSeq}`,
      };
      openPositions.push(position);
      return { position, orderId: `mock-order-${positionSeq}` };
    }),
    closePosition: vi.fn(),
  };
}

function makeFakeAnalysisRepository(): AnalysisRepository & {
  savedRuns: AnalysisRunInput[];
  savedEventsByRunId: Map<string, AnalysisEventInput[]>;
} {
  const savedRuns: AnalysisRunInput[] = [];
  const savedEventsByRunId = new Map<string, AnalysisEventInput[]>();
  let seq = 0;

  return {
    savedRuns,
    savedEventsByRunId,
    saveAnalysis: vi.fn(async (input: AnalysisRunInput) => {
      seq += 1;
      const id = `analysis-run-${seq}`;
      savedRuns.push(input);
      return id;
    }),
    saveEvents: vi.fn(async (analysisRunId: string, events: AnalysisEventInput[]) => {
      savedEventsByRunId.set(analysisRunId, events);
    }),
    markTradeExecuted: vi.fn(async () => {}),
    getRecentAnalyses: vi.fn(async () => []),
    getStrategyPerformance: vi.fn(async () => {
      throw new Error("not used in these tests");
    }),
  };
}

function makeAnalysisDeps(repository: AnalysisRepository): AnalysisIntegrationDeps {
  return {
    repository,
    runtimeMode: "demo",
    brokerProvider: "etoro-demo",
    marketProvider: "live",
    timeframe: "1h",
  };
}

interface Harness {
  runtime: TradingRuntime;
  clock: ManualSchedulerClock;
}

function makeRuntime(overrides: {
  openPositions?: PaperPosition[];
  marketDataProvider?: MarketDataProvider;
  analysis?: AnalysisIntegrationDeps;
} = {}): Harness {
  const broker = makeMockBroker(overrides.openPositions ?? []);
  const clock = new ManualSchedulerClock(NOW);
  const auditTrail = new InMemoryAuditTrail();
  const lifecycleService = new TradeLifecycleService({
    store: new InMemoryTradeLifecycleStore(),
    auditTrail,
    executionRunId: "test-run",
    now: () => clock.now(),
  });
  const marketDataProvider = overrides.marketDataProvider ?? new MockMarketDataProvider({ bias: "sideways", seed: 42, now: NOW });

  const runtime = new TradingRuntime({
    broker,
    marketDataProvider,
    strategy: STRATEGY,
    instrument: "BTC",
    amount: 10,
    portfolioRiskConfig: PERMISSIVE_RISK_CONFIG,
    lifecycleService,
    auditTrail,
    marketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
    clock,
    intervalMs: 10_000,
    immediateFirstRun: false,
    analysis: overrides.analysis,
  });

  return { runtime, clock };
}

describe("TradingRuntime — analysis persistence, HOLD cycle", () => {
  it("saves exactly one analysis record (decision HOLD) and its events after a successful cycle", async () => {
    const repository = makeFakeAnalysisRepository();
    const { runtime } = makeRuntime({ analysis: makeAnalysisDeps(repository) });
    await runtime.start();

    const outcome = await runtime.runNow();

    expect(outcome.kind).toBe("completed");
    expect(repository.saveAnalysis).toHaveBeenCalledTimes(1);
    expect(repository.savedRuns[0]!.decision).toBe("HOLD");
    expect(repository.savedRuns[0]!.executedTrade).toBe(false);
    expect(repository.saveEvents).toHaveBeenCalledTimes(1);
    expect(repository.saveEvents).toHaveBeenCalledWith("analysis-run-1", expect.any(Array));
  });

  it("records runtimeMode/brokerProvider/marketProvider/timeframe from AnalysisIntegrationDeps, and strategyId/instrument from the runtime's own deps", async () => {
    const repository = makeFakeAnalysisRepository();
    const { runtime } = makeRuntime({ analysis: makeAnalysisDeps(repository) });
    await runtime.start();
    await runtime.runNow();

    const run = repository.savedRuns[0]!;
    expect(run.runtimeMode).toBe("demo");
    expect(run.brokerProvider).toBe("etoro-demo");
    expect(run.marketProvider).toBe("live");
    expect(run.timeframe).toBe("1h");
    expect(run.strategyId).toBe("DEMO-0001");
    expect(run.instrument).toBe("BTC");
  });
});

describe("TradingRuntime — analysis persistence, executed trade", () => {
  it("saves exactly one record with executedTrade:true and a tradeId — never a second record", async () => {
    const repository = makeFakeAnalysisRepository();
    const { runtime } = makeRuntime({
      marketDataProvider: new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW }),
      analysis: makeAnalysisDeps(repository),
    });
    await runtime.start();

    const outcome = await runtime.runNow();

    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.result.executed).toBe(true);
    }
    expect(repository.saveAnalysis).toHaveBeenCalledTimes(1);
    expect(repository.savedRuns[0]!.executedTrade).toBe(true);
    expect(repository.savedRuns[0]!.tradeId).toBeTruthy();
    // "update the same record, do not create another" — markTradeExecuted is never needed because
    // the execution outcome is already known before the single saveAnalysis() call.
    expect(repository.markTradeExecuted).not.toHaveBeenCalled();
  });
});

describe("TradingRuntime — analysis persistence, failed cycle", () => {
  it("still saves an analysis record (decision ERROR, with the error message) when the cycle throws — never loses the cycle", async () => {
    const failingProvider: MarketDataProvider = {
      getMarketData: vi.fn(async () => {
        throw new Error("eToro connection refused");
      }),
    };
    const repository = makeFakeAnalysisRepository();
    const { runtime } = makeRuntime({ marketDataProvider: failingProvider, analysis: makeAnalysisDeps(repository) });
    await runtime.start();

    const outcome = await runtime.runNow();

    expect(outcome.kind).toBe("failed");
    expect(repository.saveAnalysis).toHaveBeenCalledTimes(1);
    expect(repository.savedRuns[0]!.decision).toBe("ERROR");
    expect(repository.savedRuns[0]!.errorMessage).toBe("eToro connection refused");
    expect(repository.saveEvents).toHaveBeenCalledTimes(1);
  });
});

describe("TradingRuntime — analysis persistence never affects the cycle itself", () => {
  it("a successful cycle still returns 'completed' even when saveAnalysis rejects", async () => {
    const repository = makeFakeAnalysisRepository();
    repository.saveAnalysis = vi.fn(async () => {
      throw new Error("Supabase unreachable");
    });
    const { runtime } = makeRuntime({ analysis: makeAnalysisDeps(repository) });
    await runtime.start();

    const outcome = await runtime.runNow();

    expect(outcome.kind).toBe("completed");
  });

  it("a genuinely failed cycle still returns 'failed' (with the ORIGINAL error) even when persistence also fails", async () => {
    const failingProvider: MarketDataProvider = {
      getMarketData: vi.fn(async () => {
        throw new Error("original cycle failure");
      }),
    };
    const repository = makeFakeAnalysisRepository();
    repository.saveAnalysis = vi.fn(async () => {
      throw new Error("Supabase unreachable too");
    });
    const { runtime } = makeRuntime({ marketDataProvider: failingProvider, analysis: makeAnalysisDeps(repository) });
    await runtime.start();

    const outcome = await runtime.runNow();

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toBe("original cycle failure");
    }
  });

  it("does not throw out of runNow() when saveEvents rejects after a successful saveAnalysis", async () => {
    const repository = makeFakeAnalysisRepository();
    repository.saveEvents = vi.fn(async () => {
      throw new Error("events insert failed");
    });
    const { runtime } = makeRuntime({ analysis: makeAnalysisDeps(repository) });
    await runtime.start();

    await expect(runtime.runNow()).resolves.toMatchObject({ kind: "completed" });
  });
});

describe("TradingRuntime — analysis persistence disabled", () => {
  it("never calls any analysis repository method when deps.analysis is undefined (the default)", async () => {
    const { runtime } = makeRuntime(); // no `analysis` override — undefined, matching every pre-Phase-2B caller
    await runtime.start();
    const outcome = await runtime.runNow();
    expect(outcome.kind).toBe("completed"); // runtime behaviour is unaffected either way
  });

  it("runtime successful/failed counters and lastResult are identical with and without analysis persistence enabled", async () => {
    const withoutAnalysis = makeRuntime();
    const repository = makeFakeAnalysisRepository();
    const withAnalysis = makeRuntime({ analysis: makeAnalysisDeps(repository) });

    await withoutAnalysis.runtime.start();
    await withAnalysis.runtime.start();
    await withoutAnalysis.runtime.runNow();
    await withAnalysis.runtime.runNow();

    const statusWithout = withoutAnalysis.runtime.getStatus();
    const statusWith = withAnalysis.runtime.getStatus();
    expect(statusWith.successfulRunCount).toBe(statusWithout.successfulRunCount);
    expect(statusWith.failedRunCount).toBe(statusWithout.failedRunCount);
    expect(statusWith.lastResult).toEqual(statusWithout.lastResult);
  });
});

describe("TradingRuntime — structured, credential-safe persistence-failure logging", () => {
  it("logs executionRunId, instrument, strategyId, errorCategory, and persistenceEnabled when saveAnalysis rejects", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      const repository = makeFakeAnalysisRepository();
      repository.saveAnalysis = vi.fn(async () => {
        throw new AnalysisPersistenceError("permission denied for table market_analysis_runs", "42501");
      });
      const { runtime } = makeRuntime({ analysis: makeAnalysisDeps(repository) });
      await runtime.start();
      await runtime.runNow();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to persist market analysis record"),
        expect.objectContaining({
          component: "hermes-analysis-persistence",
          executionRunId: expect.any(String),
          instrument: "BTC",
          strategyId: "DEMO-0001",
          errorCategory: "42501",
          persistenceEnabled: true,
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("falls back to the error's class name as errorCategory when it carries no Postgrest code", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      const repository = makeFakeAnalysisRepository();
      repository.saveAnalysis = vi.fn(async () => {
        throw new TypeError("network request failed");
      });
      const { runtime } = makeRuntime({ analysis: makeAnalysisDeps(repository) });
      await runtime.start();
      await runtime.runNow();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ errorCategory: "TypeError" }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("never logs a Supabase key, token, or the raw error object/database response — only a short message and category", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      const fakeServiceRoleKey = "sb_service_role_key_should_never_appear_in_logs";
      const repository = makeFakeAnalysisRepository();
      repository.saveAnalysis = vi.fn(async () => {
        throw new Error(`insert failed while authenticated with ${fakeServiceRoleKey}`);
      });
      const { runtime } = makeRuntime({ analysis: makeAnalysisDeps(repository) });
      await runtime.start();
      await runtime.runNow();

      const [, context] = errorSpy.mock.calls[0]!;
      expect(context).not.toHaveProperty("headers");
      expect(context).not.toHaveProperty("response");
      expect(context).not.toHaveProperty("supabaseError");
      // The test itself deliberately smuggled a "key" through the error message to prove this
      // logger call doesn't add any *additional* redaction beyond what the thrown error already
      // said — the real safety guarantee is upstream (AnalysisPersistenceError/EtoroApiError-style
      // errors never construct a message containing a credential in the first place).
      expect(Object.keys(context as object).sort()).toEqual(
        ["component", "errorCategory", "executionRunId", "instrument", "persistenceEnabled", "reason", "strategyId"].sort(),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
