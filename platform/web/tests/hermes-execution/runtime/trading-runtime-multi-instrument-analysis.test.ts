import { describe, expect, it, vi } from "vitest";
import { TradingRuntime, type AnalysisIntegrationDeps } from "@/lib/hermes-execution/runtime/trading-runtime";
import { AlwaysOpenMarketHoursPolicy } from "@/lib/hermes-execution/runtime/market-hours-policy";
import { MockMarketDataProvider } from "@/lib/hermes-execution/market-data/mock-market-data-provider";
import { TradeLifecycleService } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-service";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { InMemoryTradeCandidateRepository } from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";
import type { PaperBroker } from "@/lib/hermes-execution/paper-broker";
import type { Account, CompletedTrade, InternalStrategy, OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";
import type { AnalysisEventInput, AnalysisRunInput } from "@/lib/hermes-execution/analysis/types";
import type { AnalysisRepository } from "@/lib/hermes-execution/analysis/analysis-repository";
import { ManualSchedulerClock } from "./support/manual-scheduler-clock";
import { getHermesAgentInternalStrategy } from "@/lib/hermes-execution/hermes-agent/hermes-agent-strategy";
import { hermesAgentStrategy as sharedHermesAgentStrategy } from "@/lib/hermes-execution/strategies/default-strategy-registry";
import type { HermesCliRunner, HermesCliRunResult } from "@/lib/hermes-execution/hermes-agent/hermes-cli-runner";
import type { HermesAgentAdapterConfig } from "@/lib/hermes-execution/hermes-agent/hermes-agent-adapter";
import type { TradingRuntimeUniverseScanDeps } from "@/lib/hermes-execution/runtime/trading-runtime";

// Prototype 1.0 — multi-instrument correctness fix. persistAnalysis used to record
// `this.deps.instrument` (the single, originally-configured instrument) for EVERY analysis row,
// regardless of which instrument runInstrumentPhaseB was actually processing that iteration — so
// in multi-instrument mode, every instrument's own analysis row was mislabelled with whatever
// `deps.instrument` happened to be (e.g. every row showing "BTC" even for ETH/SOL/AAPL). These
// tests prove the fix: each per-instrument analysis row is labelled with the instrument it
// actually concerns, a Hermes proposal's own analysis row links correctly, no cross-instrument
// mislabelling occurs across a full universe, and single-instrument callers are unaffected.

const NOW = new Date("2026-01-01T12:00:00.000Z");

const DEMO_STRATEGY: InternalStrategy = {
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

const HERMES_STRATEGY: InternalStrategy = getHermesAgentInternalStrategy();

const PERMISSIVE_RISK_CONFIG: PortfolioRiskConfig = {
  portfolioMaxOpenPositions: 5,
  maxDailyTrades: 20,
  maxPortfolioExposure: 1_000_000,
};

const HERMES_ADAPTER_CONFIG: HermesAgentAdapterConfig = {
  cliPath: "/home/andy/.local/bin/hermes",
  decisionTimeoutMs: 60_000,
  maxStdoutBytes: 65_536,
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

/** Tracks saved runs BOTH as an insertion-ordered list (for "how many rows, in what order") and
 * keyed by the id saveAnalysis() itself returns (for "which row does THIS analysisRunId point
 * to" — needed to prove a candidate's own analysisRunId links to the correctly-labelled row). */
function makeFakeAnalysisRepository(): AnalysisRepository & {
  savedRuns: AnalysisRunInput[];
  savedRunsById: Map<string, AnalysisRunInput>;
} {
  const savedRuns: AnalysisRunInput[] = [];
  const savedRunsById = new Map<string, AnalysisRunInput>();
  let seq = 0;

  return {
    savedRuns,
    savedRunsById,
    saveAnalysis: vi.fn(async (input: AnalysisRunInput) => {
      seq += 1;
      const id = `analysis-run-${seq}`;
      savedRuns.push(input);
      savedRunsById.set(id, input);
      return id;
    }),
    saveEvents: vi.fn(async (_analysisRunId: string, _events: AnalysisEventInput[]) => {}),
    markTradeExecuted: vi.fn(async () => {}),
    getRecentAnalyses: vi.fn(async () => []),
    getStrategyPerformance: vi.fn(async () => {
      throw new Error("not used in these tests");
    }),
  };
}

function makeAnalysisDeps(repository: AnalysisRepository): AnalysisIntegrationDeps {
  return { repository, runtimeMode: "demo", brokerProvider: "etoro-demo", marketProvider: "live", timeframe: "1h" };
}

class FakeHermesRunner implements HermesCliRunner {
  public callCount = 0;
  constructor(private readonly result: HermesCliRunResult) {}
  async run(_cliPath: string, _args: string[]): Promise<HermesCliRunResult> {
    this.callCount += 1;
    return this.result;
  }
}

function hermesResponse(proposals: Array<Record<string, unknown>>): HermesCliRunResult {
  return { ok: true, stdout: JSON.stringify({ proposals }) };
}

describe("Multi-instrument analysis persistence — per-instrument labelling", () => {
  it("records BTC and ETH as separate, correctly-labelled analysis rows in the same cycle", async () => {
    const broker = makeMockBroker();
    const clock = new ManualSchedulerClock(NOW);
    const auditTrail = new InMemoryAuditTrail();
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const lifecycleService = new TradeLifecycleService({ store: lifecycleStore, auditTrail, executionRunId: "test-run", now: () => clock.now() });
    const marketDataProvider = new MockMarketDataProvider({ bias: "sideways", seed: 7, now: NOW });
    const tradeCandidateRepository = new InMemoryTradeCandidateRepository();
    const analysisRepository = makeFakeAnalysisRepository();

    const runtime = new TradingRuntime({
      broker,
      marketDataProvider,
      strategy: DEMO_STRATEGY,
      instrument: "BTC",
      instruments: ["BTC", "ETH"],
      amount: 10,
      orderSizingMode: "UNITS",
      brokerProvider: "etoro-demo",
      portfolioRiskConfig: PERMISSIVE_RISK_CONFIG,
      lifecycleService,
      lifecycleStore,
      auditTrail,
      marketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
      clock,
      intervalMs: 10_000,
      immediateFirstRun: true,
      tradeCandidateRepository,
      tradeCandidateExpiryMs: 20 * 60_000,
      approvalMode: "MANUAL",
      autoDemoMinConfidence: 0.75,
      killSwitchEnabled: false,
      recoveryThresholdMs: 5 * 60_000,
      analysis: makeAnalysisDeps(analysisRepository),
    });

    await runtime.start();
    await clock.advance(0);

    expect(analysisRepository.savedRuns).toHaveLength(2);
    const instruments = analysisRepository.savedRuns.map((r) => r.instrument).sort();
    expect(instruments).toEqual(["BTC", "ETH"]);
    // The bug this fixes: every row used to say "BTC" (deps.instrument) regardless of which
    // instrument was actually being processed — explicitly rule that out.
    expect(analysisRepository.savedRuns.filter((r) => r.instrument === "BTC")).toHaveLength(1);
    expect(analysisRepository.savedRuns.filter((r) => r.instrument === "ETH")).toHaveLength(1);

    await runtime.stop();
  });
});

describe("Multi-instrument analysis persistence — Hermes proposal links to the correct instrument's analysis run", () => {
  it("an ETH BUY candidate's own analysisRunId points to a row labelled ETH, never BTC", async () => {
    const broker = makeMockBroker();
    const clock = new ManualSchedulerClock(NOW);
    const auditTrail = new InMemoryAuditTrail();
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const lifecycleService = new TradeLifecycleService({ store: lifecycleStore, auditTrail, executionRunId: "test-run", now: () => clock.now() });
    const marketDataProvider = new MockMarketDataProvider({ bias: "bullish", seed: 42, now: NOW });
    const tradeCandidateRepository = new InMemoryTradeCandidateRepository();
    const analysisRepository = makeFakeAnalysisRepository();
    const hermesRunner = new FakeHermesRunner(hermesResponse([{ instrument: "ETH", action: "BUY", confidence: 0.9, reasoning: ["strong ETH setup"] }]));

    const universeScan: TradingRuntimeUniverseScanDeps = {
      hermesAgentStrategy: sharedHermesAgentStrategy,
      hermesAdapterConfig: HERMES_ADAPTER_CONFIG,
      hermesCliRunner: hermesRunner,
      maxProposalsPerScan: 2,
      maxOpenPositions: 5,
      maxOpenPositionsPerInstrument: 1,
      equityMarketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
    };

    const runtime = new TradingRuntime({
      broker,
      marketDataProvider,
      strategy: HERMES_STRATEGY,
      instrument: "BTC",
      instruments: ["BTC", "ETH"],
      amount: 10,
      orderSizingMode: "UNITS",
      brokerProvider: "etoro-demo",
      portfolioRiskConfig: PERMISSIVE_RISK_CONFIG,
      lifecycleService,
      lifecycleStore,
      auditTrail,
      marketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
      clock,
      intervalMs: 10_000,
      immediateFirstRun: true,
      tradeCandidateRepository,
      tradeCandidateExpiryMs: 20 * 60_000,
      approvalMode: "MANUAL",
      autoDemoMinConfidence: 0.75,
      killSwitchEnabled: false,
      recoveryThresholdMs: 5 * 60_000,
      analysis: makeAnalysisDeps(analysisRepository),
      universeScan,
    });

    await runtime.start();
    await clock.advance(0);

    const ethCandidate = (await tradeCandidateRepository.list({ instrument: "ETH" }))[0];
    expect(ethCandidate).toBeDefined();
    expect(ethCandidate!.analysisRunId).toBeDefined();

    const linkedRun = analysisRepository.savedRunsById.get(ethCandidate!.analysisRunId!);
    expect(linkedRun).toBeDefined();
    expect(linkedRun!.instrument).toBe("ETH");
    expect(linkedRun!.instrument).not.toBe("BTC");

    await runtime.stop();
  });
});

describe("Multi-instrument analysis persistence — no cross-instrument mislabelling across a full universe", () => {
  it("BTC/ETH/SOL/AAPL/MSFT/NVDA each persist their own analysis row, never one mislabelled as another", async () => {
    const universe = ["BTC", "ETH", "SOL", "AAPL", "MSFT", "NVDA"];
    const broker = makeMockBroker();
    const clock = new ManualSchedulerClock(NOW);
    const auditTrail = new InMemoryAuditTrail();
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const lifecycleService = new TradeLifecycleService({ store: lifecycleStore, auditTrail, executionRunId: "test-run", now: () => clock.now() });
    const marketDataProvider = new MockMarketDataProvider({ bias: "sideways", seed: 3, now: NOW });
    const tradeCandidateRepository = new InMemoryTradeCandidateRepository();
    const analysisRepository = makeFakeAnalysisRepository();

    const runtime = new TradingRuntime({
      broker,
      marketDataProvider,
      strategy: DEMO_STRATEGY,
      instrument: "BTC",
      instruments: universe,
      amount: 10,
      orderSizingMode: "UNITS",
      brokerProvider: "etoro-demo",
      portfolioRiskConfig: PERMISSIVE_RISK_CONFIG,
      lifecycleService,
      lifecycleStore,
      auditTrail,
      marketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
      clock,
      intervalMs: 10_000,
      immediateFirstRun: true,
      tradeCandidateRepository,
      tradeCandidateExpiryMs: 20 * 60_000,
      approvalMode: "MANUAL",
      autoDemoMinConfidence: 0.75,
      killSwitchEnabled: false,
      recoveryThresholdMs: 5 * 60_000,
      analysis: makeAnalysisDeps(analysisRepository),
    });

    await runtime.start();
    await clock.advance(0);

    expect(analysisRepository.savedRuns).toHaveLength(universe.length);
    expect(analysisRepository.savedRuns.map((r) => r.instrument).sort()).toEqual([...universe].sort());
    // None of the non-BTC instruments were ever persisted as BTC.
    const btcRows = analysisRepository.savedRuns.filter((r) => r.instrument === "BTC");
    expect(btcRows).toHaveLength(1);
    for (const other of ["ETH", "SOL", "AAPL", "MSFT", "NVDA"]) {
      expect(analysisRepository.savedRuns.filter((r) => r.instrument === other)).toHaveLength(1);
    }

    await runtime.stop();
  });
});

describe("Multi-instrument analysis persistence — single-instrument callers unaffected", () => {
  it("a single-instrument runtime (no deps.instruments configured) still persists the configured instrument", async () => {
    const broker = makeMockBroker();
    const clock = new ManualSchedulerClock(NOW);
    const auditTrail = new InMemoryAuditTrail();
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const lifecycleService = new TradeLifecycleService({ store: lifecycleStore, auditTrail, executionRunId: "test-run", now: () => clock.now() });
    const marketDataProvider = new MockMarketDataProvider({ bias: "sideways", seed: 7, now: NOW });
    const tradeCandidateRepository = new InMemoryTradeCandidateRepository();
    const analysisRepository = makeFakeAnalysisRepository();

    const runtime = new TradingRuntime({
      broker,
      marketDataProvider,
      strategy: { ...DEMO_STRATEGY, instrument: "ETH" },
      instrument: "ETH",
      // Deliberately no `instruments` override — exercises the pre-existing single-instrument path.
      amount: 10,
      orderSizingMode: "UNITS",
      brokerProvider: "etoro-demo",
      portfolioRiskConfig: PERMISSIVE_RISK_CONFIG,
      lifecycleService,
      lifecycleStore,
      auditTrail,
      marketHoursPolicy: new AlwaysOpenMarketHoursPolicy(),
      clock,
      intervalMs: 10_000,
      immediateFirstRun: true,
      tradeCandidateRepository,
      tradeCandidateExpiryMs: 20 * 60_000,
      approvalMode: "MANUAL",
      autoDemoMinConfidence: 0.75,
      killSwitchEnabled: false,
      recoveryThresholdMs: 5 * 60_000,
      analysis: makeAnalysisDeps(analysisRepository),
    });

    await runtime.start();
    await clock.advance(0);

    expect(analysisRepository.savedRuns).toHaveLength(1);
    expect(analysisRepository.savedRuns[0]?.instrument).toBe("ETH");

    await runtime.stop();
  });
});
