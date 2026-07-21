import * as path from "node:path";
import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { FileSystemRegistryClient } from "@/lib/hermes-execution/registry-client";
import { loadEnabledStrategies } from "@/lib/hermes-execution/strategy-loader";
import { BrokerFactory } from "@/lib/hermes-execution/broker-factory";
import { MarketDataProviderFactory } from "@/lib/hermes-execution/market-data/market-data-provider-factory";
import { TradeLifecycleService } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-service";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import { JsonFileAuditTrail } from "@/lib/hermes-execution/json-file-audit-trail";
import { SystemSchedulerClock } from "@/lib/hermes-execution/runtime/scheduler-clock";
import { MarketHoursPolicyFactory } from "@/lib/hermes-execution/runtime/market-hours-policy-factory";
import { TradingRuntime } from "@/lib/hermes-execution/runtime/trading-runtime";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";

// Milestone 7 — 24/7 Scheduler & Runtime Control. The continuous counterpart to market-decide.ts's
// one-shot cycle (untouched by this milestone — both remain independently runnable): loads the same
// kind of dependencies, then hands them to TradingRuntime instead of calling
// runMarketDecisionCycleWithLifecycle directly. Nothing about decision/risk/execution/lifecycle
// logic is reimplemented here — this file only ever assembles dependencies and calls existing,
// unmodified constructors/factories.
//
// Deliberately scoped to BROKER_PROVIDER=local for this milestone (a fixed, explicit override
// below, not read from config.brokerProvider) — every other broker (Hyperliquid/Trading212/eToro)
// needs its own extra setup dance before it's usable (at minimum eToro's resolveInstrument() call),
// which this prototype's continuous runtime doesn't orchestrate yet. LocalPaperBroker needs no such
// step, so it's the only broker this command can run against today. Extending this to the other
// brokers is a natural, separate follow-up — not this milestone's concern (see the mission report's
// Limitations section).
const AUDIT_LOG_PATH = path.join(process.cwd(), ".data", "hermes-execution", "market-runtime-audit-log.json");

// Kept local rather than env-configurable, same reasoning as market-decide.ts's own
// PORTFOLIO_RISK_CONFIG: this milestone doesn't call for env-configurable instrument/position-
// sizing/portfolio-risk values, only for the scheduler/runtime machinery around them to exist and
// be exercised end to end.
const INSTRUMENT = "BTC";
const AMOUNT = 10;
const PORTFOLIO_RISK_CONFIG: PortfolioRiskConfig = {
  portfolioMaxOpenPositions: 5,
  maxDailyTrades: 10,
  maxPortfolioExposure: 10_000,
};

function printStartupSummary(intervalMs: number, immediateFirstRun: boolean, marketHoursPolicy: string): void {
  console.log("");
  console.log(`Instrument: ${INSTRUMENT}  Amount: ${AMOUNT}`);
  console.log(`Interval: ${intervalMs}ms  Immediate first run: ${immediateFirstRun}`);
  console.log(`Market hours policy: ${marketHoursPolicy}`);
  console.log("");
  console.log("Runtime started. Press Ctrl+C (SIGINT) to stop gracefully.");
}

function printFinalStatus(runtime: TradingRuntime): void {
  const status = runtime.getStatus();
  console.log("");
  console.log("Final runtime status");
  console.log("---------------------");
  console.log(JSON.stringify(status, null, 2));
}

export async function main(): Promise<void> {
  console.log("Hermes Trading Runtime — 24/7 Scheduler & Runtime Control");
  console.log("===========================================================");

  const config = getHermesExecutionConfig();

  if (!config.scheduler.enabled) {
    console.log(
      "HERMES_SCHEDULER_ENABLED is not set — nothing to run. Set it to true to start the continuous runtime. " +
        "This is the correct, expected state of a default configuration, not a failure.",
    );
    return;
  }

  if (!config.registryPath) {
    console.error(
      "HERMES_STRATEGY_REGISTRY_PATH is not set — cannot load an approved strategy. Set it to an " +
        "absolute path, e.g. HERMES_STRATEGY_REGISTRY_PATH=/path/to/hermes-lab/strategy-registry",
    );
    process.exitCode = 1;
    return;
  }

  const executionRunId = `market-runtime-${Date.now()}`;
  console.log(`Execution run id: ${executionRunId}`);

  const auditTrail = await JsonFileAuditTrail.createFresh(AUDIT_LOG_PATH);

  const registryClient = new FileSystemRegistryClient(config.registryPath);
  const loadResult = await loadEnabledStrategies({
    registryClient,
    demoExecutionModeEnabled: config.demoExecutionModeEnabled,
    executionRunId,
  });
  for (const event of loadResult.events) await auditTrail.record(event);

  console.log(`${loadResult.hermesApprovedCount} Hermes-approved strategies loaded`);
  console.log(`Demo strategy loaded: ${loadResult.demoModeActive}`);

  const strategy =
    loadResult.strategies.find((s) => s.sourceType === "HERMES_APPROVED") ??
    loadResult.strategies.find((s) => s.sourceType === "DEMO_ONLY");

  if (!strategy) {
    console.error(
      "No approved strategy available to evaluate. Set DEMO_EXECUTION_MODE=true to use the DEMO_ONLY " +
        "strategy, or add a real strategy to the Hermes Strategy Registry.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Using strategy: ${strategy.strategyId} v${strategy.version} (${strategy.sourceType})`);

  // resetState: false — unlike market-decide.ts's byte-for-byte-reproducible demo replay, a
  // continuous runtime is meant to persist its paper account/positions across restarts.
  const broker = await BrokerFactory.create(config, auditTrail, executionRunId, { provider: "local", resetState: false });

  // No `live` rateSource is ever supplied here — LocalPaperBroker has no getRate() capability, so
  // HERMES_MARKET_DATA_PROVIDER=live fails closed with MarketDataProviderFactory's own clear error
  // ("requires options.live.rateSource") rather than this file inventing a fake one.
  const marketDataProvider = MarketDataProviderFactory.create(config.marketDataProvider, {});

  const marketHoursPolicy = MarketHoursPolicyFactory.create(config.scheduler.marketHoursPolicy, config.scheduler);

  const lifecycleService = new TradeLifecycleService({
    store: new InMemoryTradeLifecycleStore(),
    auditTrail,
    executionRunId,
  });

  const runtime = new TradingRuntime({
    broker,
    marketDataProvider,
    strategy,
    instrument: INSTRUMENT,
    amount: AMOUNT,
    portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
    lifecycleService,
    auditTrail,
    marketHoursPolicy,
    clock: new SystemSchedulerClock(),
    intervalMs: config.scheduler.intervalMs,
    immediateFirstRun: config.scheduler.immediateFirstRun,
  });

  await runtime.start();
  printStartupSummary(config.scheduler.intervalMs, config.scheduler.immediateFirstRun, config.scheduler.marketHoursPolicy);

  // Signal handling deliberately lives here, outside TradingRuntime itself, so the runtime stays
  // testable with zero knowledge of process signals. `shuttingDown` de-duplicates: SIGINT and
  // SIGTERM (or the same signal delivered twice, e.g. an impatient double Ctrl+C) both funnel
  // through the same guarded shutdown exactly once — a second signal while shutdown is already in
  // progress is a no-op here, not a second concurrent runtime.stop() call (which would throw, since
  // STOPPING has no valid transition to itself).
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal} — stopping gracefully (waiting for any active cycle to finish)...`);
    runtime
      .stop()
      .then(() => {
        printFinalStatus(runtime);
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error("Error during graceful shutdown:", error instanceof Error ? error.message : error);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Only auto-runs when this file is executed directly (`tsx market-runtime.ts`), not when imported
// elsewhere.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Trading runtime crashed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
