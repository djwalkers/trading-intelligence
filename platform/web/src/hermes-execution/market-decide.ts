import * as path from "node:path";
import { getHermesExecutionConfig, type HermesExecutionConfig } from "@/lib/hermes-execution/config";
import { FileSystemRegistryClient } from "@/lib/hermes-execution/registry-client";
import { loadEnabledStrategies } from "@/lib/hermes-execution/strategy-loader";
import { BrokerFactory } from "@/lib/hermes-execution/broker-factory";
import { EtoroDemoBroker } from "@/lib/hermes-execution/etoro/etoro-demo-broker";
import { MarketIntelligenceBuilder } from "@/lib/hermes-execution/market-intelligence-builder";
import { buildMarketDecisionContext } from "@/lib/hermes-execution/build-market-decision-context";
import type { CandleBias } from "@/lib/hermes-execution/mock-candle-generator";
import { MarketDataProviderFactory } from "@/lib/hermes-execution/market-data/market-data-provider-factory";
import type { MarketDataProvider } from "@/lib/hermes-execution/market-data/market-data-provider";
import { runMarketDecisionCycleWithLifecycle } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-runner";
import { TradeLifecycleService } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-service";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";
import { JsonFileAuditTrail } from "@/lib/hermes-execution/json-file-audit-trail";
import type { EtoroResolvedInstrument } from "@/lib/hermes-execution/etoro/etoro-demo-broker";
import { selectStrategy } from "@/lib/hermes-execution/runtime-config/strategy-selection";

// Milestones 2/3 — Market Decision Integration + Rich Market Context. Proves, end to end, against
// the already-validated eToro demo broker:
//   Market Data Provider -> Market Intelligence Builder -> MarketDecisionContext
//   -> MarketDecisionEngine -> MarketDecision -> (runner) -> existing validated broker -> audit
// This is a new command, not a replacement for broker-etoro-smoke.ts or any other existing smoke
// test — none of those are touched by this milestone. A separate audit log from every other CLI's,
// so none of their histories clobber each other on disk.
const AUDIT_LOG_PATH = path.join(process.cwd(), ".data", "hermes-execution", "market-decision-audit-log.json");

// Milestone 5 — Live Market Data Integration. Candle sizing for the mock provider path only —
// LiveMarketDataProvider has its own equivalent defaults (live-market-data-provider.ts) since it's
// constructed independently of this CLI's own options.
const CANDLE_COUNT = 60;
const CANDLE_INTERVAL_MINUTES = 60;

// Milestone 4 — Portfolio & Risk Engine. This CLI's own demo-scale governance thresholds, kept
// local (not added to HermesExecutionConfig — this milestone doesn't call for env-configurable
// portfolio risk limits, only for the engine and its wiring to exist and be exercised end to end).
// portfolioMaxOpenPositions is a distinct, separately-configured ceiling from
// HermesExecutionConfig.strategyMaxOpenPositions (config.ts) / RiskEngineConfig used by the older
// pipeline — not the same limit, deliberately not sourced from the same place.
const PORTFOLIO_RISK_CONFIG: PortfolioRiskConfig = {
  portfolioMaxOpenPositions: 5,
  maxDailyTrades: 10,
  maxPortfolioExposure: 10_000,
};

function printMarketContext(
  resolved: EtoroResolvedInstrument,
  context: Awaited<ReturnType<(typeof MarketIntelligenceBuilder)["build"]>>,
): void {
  console.log("");
  console.log(`${resolved.displayName} (${resolved.symbol})`);
  console.log(`  Bid: ${context.bid}`);
  console.log(`  Ask: ${context.ask}`);
  console.log(`  Spread: ${context.spread.toFixed(4)}  Mid: ${context.midPrice.toFixed(2)}`);
  console.log(`  EMA20: ${context.ema20.toFixed(2)}`);
  console.log(`  EMA50: ${context.ema50.toFixed(2)}`);
  console.log(`  RSI14: ${context.rsi14.toFixed(1)}`);
  console.log(`  ATR14: ${context.atr14.toFixed(2)}`);
  console.log(`  Volume: ${context.volume.toFixed(1)}`);
  console.log(`  Daily range: ${context.dailyLow.toFixed(2)} - ${context.dailyHigh.toFixed(2)}`);
  console.log(`  24h volatility: ${context.volatility24h !== undefined ? context.volatility24h.toFixed(5) : "n/a"}`);
  console.log(`  Session: ${context.marketSession}`);
  console.log(`  Trend: ${context.trend}`);
  console.log(`  Position open: ${context.positionOpen}`);
}

function printDecision(result: Awaited<ReturnType<typeof runMarketDecisionCycleWithLifecycle>>): void {
  console.log("");
  console.log(`Decision: ${result.decision.action}`);
  console.log(`Confidence: ${result.decision.confidence.toFixed(2)}`);
  console.log("Reasoning:");
  for (const reason of result.decision.reasoning) console.log(`  - ${reason}`);
  console.log(`Execution: ${result.executed ? "TRIGGERED" : "SKIPPED"}`);
  if (result.position) {
    console.log(`Position opened: ${result.position.positionId} @ entryPrice=${result.position.entryPrice}`);
  }
  if (result.trade) {
    console.log(
      `Position closed: ${result.trade.positionId}, exitPrice=${result.trade.exitPrice}, realisedPnl=${result.trade.realisedPnl.toFixed(4)}`,
    );
  }
  if (result.blockedReasons) {
    console.log("Blocked by PortfolioRiskEngine:");
    for (const reason of result.blockedReasons) console.log(`  - ${reason}`);
  }
  // Milestone 6 — Trade Lifecycle & Performance Tracking.
  if (result.lifecycleRecord) {
    const record = result.lifecycleRecord;
    console.log(`Lifecycle record: ${record.id} -> ${record.status}`);
    if (record.status === "CLOSED") {
      console.log(
        `  realisedPnl=${record.realisedPnl?.toFixed(4)} (${record.realisedPnlPercent?.toFixed(2)}%), ` +
          `holdingDurationMs=${record.holdingDurationMs}, MFE=${record.maximumFavourableExcursion?.toFixed(4)}, ` +
          `MAE=${record.maximumAdverseExcursion?.toFixed(4)}`,
      );
    }
  }
}

/** Milestone 5 — selects MockMarketDataProvider or LiveMarketDataProvider per
 * `config.marketDataProvider` (HERMES_MARKET_DATA_PROVIDER), exactly like BrokerFactory.create
 * selects a broker. `bias` only affects the mock path (it forces a fresh, freely-biased
 * MockMarketDataProvider per cycle so the demo can show BUY-then-SELL deterministically); the live
 * path ignores it entirely — a real market can't be told which direction to move. */
function resolveMarketDataProvider(
  config: HermesExecutionConfig,
  broker: EtoroDemoBroker,
  bias: CandleBias,
): MarketDataProvider {
  return MarketDataProviderFactory.create(config.marketDataProvider, {
    mock: { bias, count: CANDLE_COUNT, intervalMinutes: CANDLE_INTERVAL_MINUTES },
    // EtoroDemoBroker.getRate already satisfies RateSource structurally — passed as-is, never
    // wrapped or subclassed, so LiveMarketDataProvider never depends on the concrete broker type.
    live: { rateSource: broker },
  });
}

export async function main(): Promise<void> {
  console.log("Market Decision Integration — Rich Market Context");
  console.log("==================================================");

  const executionRunId = `market-decide-${Date.now()}`;
  console.log(`Execution run id: ${executionRunId}`);

  const config = getHermesExecutionConfig();

  // Safety: only ever a demo broker. This command hard-codes "etoro-demo" the same way every
  // broker smoke test does — BROKER_PROVIDER is never consulted, and BrokerFactory's own provider
  // registry has no live/real value for anything to accidentally select.
  if (config.etoro.env !== "demo") {
    console.error('ETORO_ENV must be exactly "demo" — this command never routes to a live/real endpoint.');
    process.exitCode = 1;
    return;
  }
  if (!config.etoro.apiKey || !config.etoro.userKey) {
    console.error("ETORO_API_KEY and ETORO_USER_KEY must both be set.");
    process.exitCode = 1;
    return;
  }
  if (config.etoro.testAmount === undefined) {
    console.error("ETORO_DEMO_TEST_AMOUNT must be set.");
    process.exitCode = 1;
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
  console.log("Configuration valid (demo-only, no live route reachable).");

  const auditTrail = await JsonFileAuditTrail.createFresh(AUDIT_LOG_PATH);

  // Reuses the existing, unmodified strategy-loading pipeline — same STRATEGY_LOADED/
  // STRATEGY_REJECTED events execution-demo.ts already produces, not duplicated here.
  const registryClient = new FileSystemRegistryClient(config.registryPath);
  const loadResult = await loadEnabledStrategies({
    registryClient,
    demoExecutionModeEnabled: config.demoExecutionModeEnabled,
    executionRunId,
  });
  for (const event of loadResult.events) await auditTrail.record(event);

  console.log(`${loadResult.hermesApprovedCount} Hermes-approved strategies loaded`);
  console.log(`Demo strategy loaded: ${loadResult.demoModeActive}`);

  // Milestone 8 — shares strategy-selection with the continuous runtime: HERMES_STRATEGY_ID
  // unset preserves this command's original behaviour exactly (prefer HERMES_APPROVED, fall back
  // to DEMO_ONLY); set explicitly, an unknown or disabled id fails clearly instead of silently
  // falling back.
  const selection = selectStrategy(loadResult.strategies, config.runtimeTrading.strategyId);
  if (!selection.found) {
    console.error(selection.reason);
    process.exitCode = 1;
    return;
  }
  const strategy = selection.strategy;
  console.log(`Using strategy: ${strategy.strategyId} v${strategy.version} (${strategy.sourceType})`);

  // BrokerFactory.create's "etoro-demo" entry constructs EtoroDemoBroker and calls connect() before
  // returning — the cast is safe because an explicit `provider` was requested, so the concrete
  // type is guaranteed (same pattern broker-etoro-smoke.ts uses, untouched by this milestone).
  const broker = (await BrokerFactory.create(config, auditTrail, executionRunId, {
    provider: "etoro-demo",
  })) as EtoroDemoBroker;
  console.log("Connected to eToro (credentials verified via demo portfolio read).");

  const instrument = config.etoro.testInstrument;
  const resolved = await broker.resolveInstrument(instrument);
  console.log(`Resolved instrument: ${resolved.displayName} (${resolved.symbol}), instrumentId=${resolved.instrumentId}`);
  console.log(`Market data provider: ${config.marketDataProvider}`);

  // Milestone 6 — Trade Lifecycle & Performance Tracking. In-memory only for this CLI demo, per
  // this milestone's own "no filesystem/database persistence yet" constraint — a real deployment
  // would inject a persistent TradeLifecycleStore here without changing anything else.
  const lifecycleService = new TradeLifecycleService({ store: new InMemoryTradeLifecycleStore(), auditTrail, executionRunId });

  // Cycle 1: under "mock", a bullish market context — the scenario this milestone's example
  // ruleset (EMA20>EMA50, healthy RSI, Bullish trend, no position) is designed to satisfy. Under
  // "live", `bias` is passed but ignored (LiveMarketDataProvider only ever reports real bid/ask) —
  // whether this cycle produces a BUY depends on the real market at the moment this runs.
  const firstProvider = resolveMarketDataProvider(config, broker, "bullish");
  const { snapshot: firstSnapshot, context: firstContext } = await buildMarketDecisionContext(
    firstProvider,
    broker,
    instrument,
    strategy,
  );
  printMarketContext(resolved, firstContext);
  const firstResult = await runMarketDecisionCycleWithLifecycle({
    broker,
    auditTrail,
    executionRunId,
    marketContext: firstContext,
    amount: config.etoro.testAmount,
    // brokerAvailable: true — the connect() + resolveInstrument() calls above already succeeded,
    // so the broker is known-reachable at this point in the cycle. dailyTradeCount: this run's own
    // completed-trade count so far — this demo CLI has no persistent cross-run trade counter.
    portfolioRisk: {
      config: PORTFOLIO_RISK_CONFIG,
      dailyTradeCount: broker.getCompletedTrades().length,
      brokerAvailable: true,
    },
    lifecycleService,
    marketDataSnapshot: firstSnapshot,
  });
  printDecision(firstResult);

  // EtoroDemoBroker only tracks positions opened through this specific instance (a pre-existing,
  // unmodified broker behaviour — not this milestone's concern), so a position cycle 1 just opened
  // is only visible to a second cycle within this same process. To demonstrate the SELL path
  // honestly (the new ruleset requires a genuinely Bearish trend, not merely "a position exists"),
  // cycle 2 below deliberately feeds a bearish-biased mock context, clearly labeled as a simulated
  // later market shift — not a claim that real conditions changed within this same run.
  if (firstResult.decision.action === "BUY" && firstResult.executed) {
    console.log("");
    console.log(
      config.marketDataProvider === "mock"
        ? "--- Simulating a later bearish market shift, to demonstrate the SELL path ---"
        : "--- Re-checking the live market for a second decision cycle (bias not controllable under live data) ---",
    );
    const secondProvider = resolveMarketDataProvider(config, broker, "bearish");
    const { snapshot: secondSnapshot, context: secondContext } = await buildMarketDecisionContext(
      secondProvider,
      broker,
      instrument,
      strategy,
    );
    printMarketContext(resolved, secondContext);
    const secondResult = await runMarketDecisionCycleWithLifecycle({
      broker,
      auditTrail,
      executionRunId,
      marketContext: secondContext,
      amount: config.etoro.testAmount,
      portfolioRisk: {
        config: PORTFOLIO_RISK_CONFIG,
        dailyTradeCount: broker.getCompletedTrades().length,
        brokerAvailable: true,
      },
      lifecycleService,
      marketDataSnapshot: secondSnapshot,
    });
    printDecision(secondResult);
  }
}

// Only auto-runs when this file is executed directly (`tsx market-decide.ts`), not when imported
// elsewhere (e.g. its own test file).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Market decision cycle crashed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
