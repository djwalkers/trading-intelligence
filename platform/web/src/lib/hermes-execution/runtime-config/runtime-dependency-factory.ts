import { FileSystemRegistryClient } from "../registry-client";
import { loadEnabledStrategies } from "../strategy-loader";
import { BrokerFactory } from "../broker-factory";
import { MarketDataProviderFactory } from "../market-data/market-data-provider-factory";
import { MarketHoursPolicyFactory } from "../runtime/market-hours-policy-factory";
import { TradeLifecycleService } from "../trade-lifecycle/trade-lifecycle-service";
import { InMemoryTradeLifecycleStore } from "../trade-lifecycle/trade-lifecycle-store";
import type { TradeLifecycleStore } from "../trade-lifecycle/trade-lifecycle-store";
import type { AuditTrail } from "../audit-trail";
import type { BrokerProvider, HermesExecutionConfig, RuntimeMode } from "../config";
import type { MarketDataProvider } from "../market-data/market-data-provider";
import type { MarketHoursPolicy } from "../runtime/market-hours-policy";
import type { PaperBroker } from "../paper-broker";
import type { PortfolioRiskConfig } from "../portfolio-risk-engine";
import type { Candle, InternalStrategy, OrderSizingMode } from "../types";
import { BROKER_CAPABILITIES } from "./broker-capabilities";
import { validateStartup, type StartupValidationProblem } from "./startup-validation";
import { HERMES_AGENT_STRATEGY_ID, HermesAgentStrategy } from "../hermes-agent/hermes-agent-strategy";
import { defaultStrategyRegistry } from "../strategies/default-strategy-registry";
import type { StrategyRegistry } from "../strategies/strategy-registry";
import { ChildProcessHermesCliRunner, type HermesCliRunner } from "../hermes-agent/hermes-cli-runner";
import type { HermesAgentAdapterConfig } from "../hermes-agent/hermes-agent-adapter";
import type { TradingRuntimeUniverseScanDeps } from "../runtime/trading-runtime";

// Milestone 8 — Deployment-Ready Runtime Configuration. THE single dependency-construction layer —
// used by both market:runtime and (via an override, see BuildRuntimeDependenciesOptions below)
// market:decide. Not a service locator: this is one function taking explicit, typed options and
// returning one explicit, typed bundle — nothing global, nothing mutable, nothing hidden behind a
// container lookup. Every piece it builds is built by calling an existing, unmodified
// factory/constructor (BrokerFactory, MarketDataProviderFactory, MarketHoursPolicyFactory,
// TradeLifecycleService, loadEnabledStrategies) — this file assembles, it never reimplements.

/** Duck-typed, not imported from etoro-demo-broker.ts — this factory is generic over all four
 * brokers and must never import a concrete adapter class (same "depend on the narrowest shape
 * needed" convention LiveMarketDataProvider's own RateSource already established). Only
 * EtoroDemoBroker happens to satisfy either of these today. */
interface SymbolResolvableBroker {
  resolveInstrument(term: string): Promise<unknown>;
}
interface RateSourceBroker {
  getRate(instrument: string): Promise<{ bid: number; ask: number }>;
  // Phase 2A — Real Historical Candles for Live Market Data. Widened alongside getRate above —
  // still duck-typed (never a concrete EtoroDemoBroker import), still only EtoroDemoBroker
  // satisfies this structurally today (see broker-capabilities.ts's own canSupplyLiveRates).
  getHistoricalCandles(instrument: string, timeframe: string, count: number): Promise<Candle[]>;
}

/** Prototype 1.0 — official Hermes Agent multi-instrument wiring. Only the pieces market-runtime.ts
 * cannot already assemble itself from `config`/other RuntimeDependencies fields — `maxOpenPositions`
 * (portfolio-wide) and `maxOpenPositionsPerInstrument` are deliberately NOT here: they belong to
 * the caller's own portfolio-risk configuration and a fixed mission-level invariant respectively,
 * not to this factory (see market-runtime.ts's own TradingRuntimeUniverseScanDeps assembly). */
export interface HermesMultiInstrumentDependencies {
  /** THE exact shared HermesAgentStrategy singleton instance MarketDecisionEngine's own default
   * registry (defaultStrategyRegistry, strategies/default-strategy-registry.ts) resolves for
   * HERMES_AGENT_STRATEGY_ID — verified here (via defaultStrategyRegistry.require + an instanceof
   * check), never merely assumed from the module import graph alone. Passing this exact object as
   * TradingRuntimeUniverseScanDeps.hermesAgentStrategy is what guarantees the universe scanner's own
   * setScanProposals() calls land on the SAME instance MarketDecisionEngine.evaluate() reads from. */
  strategyInstance: HermesAgentStrategy;
  instrumentUniverse: string[];
  hermesAdapterConfig: HermesAgentAdapterConfig;
  hermesCliRunner: HermesCliRunner;
  maxProposalsPerScan: number;
}

export interface RuntimeDependencies {
  strategy: InternalStrategy;
  broker: PaperBroker;
  marketDataProvider: MarketDataProvider;
  marketHoursPolicy: MarketHoursPolicy;
  lifecycleService: TradeLifecycleService;
  /** Prototype V1 — the same store instance lifecycleService was constructed with, exposed
   * directly for read-only reporting (e.g. the Telegram bot's /positions, /trades, /pnl commands)
   * that need to list/query records — a concern TradeLifecycleService itself doesn't expose a
   * pass-through for, and shouldn't need to grow one just for this. */
  lifecycleStore: TradeLifecycleStore;
  symbol: string;
  quantity: number;
  /** Broker Sizing Semantic Fix. This broker's own declared sizing mode (BROKER_CAPABILITIES[
   * brokerProvider].orderSizingMode) — computed once, here, from the same registry
   * broker-capabilities.ts already maintains, so every caller of this factory gets it for free
   * instead of re-deriving it from `brokerProvider` itself. */
  orderSizingMode: OrderSizingMode;
  portfolioRiskConfig: PortfolioRiskConfig;
  /** Prototype 1.0 — official Hermes Agent multi-instrument wiring. Present if and only if the
   * selected strategy (`strategy.strategyId`) is the official Hermes Agent — undefined for every
   * other strategy (e.g. DEMO-0001), which preserves the existing single-instrument runtime path
   * exactly (market-runtime.ts only configures TradingRuntimeDeps.instruments/universeScan when
   * this is present). Startup fails closed (see buildRuntimeDependencies below) rather than leaving
   * this undefined by accident whenever HERMES-AGENT is selected but something about the Hermes
   * wiring cannot be safely constructed. */
  hermes?: HermesMultiInstrumentDependencies;
}

export type BuildRuntimeDependenciesResult =
  | { ok: true; dependencies: RuntimeDependencies }
  | { ok: false; problems: StartupValidationProblem[] };

export interface BuildRuntimeDependenciesOptions {
  config: HermesExecutionConfig;
  auditTrail: AuditTrail;
  executionRunId: string;
  /** Overrides config.brokerProvider/config.runtimeTrading.mode. market-decide.ts's own escape
   * hatch: it has always hard-coded "etoro-demo" regardless of BROKER_PROVIDER as a deliberate
   * safety/determinism choice (see its own top-of-file comment) — passing both overrides here lets
   * it keep that exact behaviour while still sharing this factory's strategy-selection,
   * compatibility validation, and broker/provider construction, instead of duplicating them. */
  brokerOverride?: BrokerProvider;
  runtimeModeOverride?: RuntimeMode;
  /** LocalPaperBroker only — forwarded to BrokerFactory.create verbatim. */
  resetBrokerState?: boolean;
  /** Portfolio-risk thresholds remain CLI-local, unchanged since Milestone 4 (this milestone does
   * not call for env-configurable portfolio risk limits) — supplied by the caller, not sourced from
   * HermesExecutionConfig. */
  portfolioRiskConfig: PortfolioRiskConfig;
  /** Restart-Resilient Autonomy Phase — Phase 2 (durable trade lifecycle persistence). Defaults to
   * a fresh InMemoryTradeLifecycleStore (this factory's own pre-existing behaviour, unchanged —
   * market-decide.ts never passes this) when omitted. market-runtime.ts (the production, continuous
   * runtime) passes a SupabaseTradeLifecycleStore here instead — see that file's own doc comment on
   * why it fails closed rather than silently falling back to memory when Supabase isn't configured. */
  lifecycleStoreOverride?: TradeLifecycleStore;
  /** Prototype 1.0 — official Hermes Agent multi-instrument wiring. Test-only escape hatch —
   * defaults to the real `defaultStrategyRegistry` (strategies/default-strategy-registry.ts), the
   * SAME registry MarketDecisionEngine.evaluate() itself resolves against by default. Production
   * code never passes this; tests use it to exercise the "registered strategy is not actually a
   * HermesAgentStrategy" fail-closed path without needing to modify the real shared registry. */
  strategyRegistryOverride?: StrategyRegistry;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function buildRuntimeDependencies(options: BuildRuntimeDependenciesOptions): Promise<BuildRuntimeDependenciesResult> {
  const { config } = options;
  const brokerProvider = options.brokerOverride ?? config.brokerProvider;
  const runtimeMode = options.runtimeModeOverride ?? config.runtimeTrading.mode;

  if (!config.registryPath) {
    return {
      ok: false,
      problems: [{ field: "registryPath", message: "HERMES_STRATEGY_REGISTRY_PATH is not set — cannot load a strategy." }],
    };
  }

  // Reuses the existing, unmodified strategy-loading pipeline — same STRATEGY_LOADED/
  // STRATEGY_REJECTED events every other CLI already produces.
  const registryClient = new FileSystemRegistryClient(config.registryPath);
  const loadResult = await loadEnabledStrategies({
    registryClient,
    demoExecutionModeEnabled: config.demoExecutionModeEnabled,
    executionRunId: options.executionRunId,
  });
  for (const event of loadResult.events) await options.auditTrail.record(event);

  // Every check here is static (no I/O) — evaluated, and can fail, entirely before any broker is
  // ever constructed or connected.
  const validation = validateStartup({
    runtimeMode,
    brokerProvider,
    marketDataProvider: config.marketDataProvider,
    strategyId: config.runtimeTrading.strategyId,
    availableStrategies: loadResult.strategies,
    approvalMode: config.approvalMode,
  });
  if (!validation.valid) {
    return { ok: false, problems: validation.problems };
  }

  let broker: PaperBroker;
  try {
    broker = await BrokerFactory.create(config, options.auditTrail, options.executionRunId, {
      provider: brokerProvider,
      resetState: options.resetBrokerState ?? false,
    });
  } catch (error) {
    return {
      ok: false,
      problems: [{ field: "broker", message: `Failed to construct/connect broker "${brokerProvider}": ${toErrorMessage(error)}` }],
    };
  }

  const capabilities = BROKER_CAPABILITIES[brokerProvider];

  // The one check that genuinely cannot happen before a broker connection exists — eToro's own
  // instrument-search endpoint. Still happens here, before the scheduler ever starts, and still
  // reported through the same problem shape as every static check above.
  if (capabilities.requiresSymbolResolution) {
    try {
      await (broker as unknown as SymbolResolvableBroker).resolveInstrument(config.runtimeTrading.symbol);
    } catch (error) {
      return {
        ok: false,
        problems: [
          {
            field: "symbol",
            message: `Broker "${brokerProvider}" could not resolve symbol "${config.runtimeTrading.symbol}": ${toErrorMessage(error)}`,
          },
        ],
      };
    }
  }

  let marketDataProvider: MarketDataProvider;
  try {
    marketDataProvider = MarketDataProviderFactory.create(config.marketDataProvider, {
      live: capabilities.canSupplyLiveRates
        ? {
            rateSource: broker as unknown as RateSourceBroker,
            timeframe: config.marketData.timeframe,
            candleCount: config.marketData.candleCount,
            maxCandleAgeSeconds: config.marketData.maxCandleAgeSeconds,
          }
        : undefined,
    });
  } catch (error) {
    return { ok: false, problems: [{ field: "marketDataProvider", message: toErrorMessage(error) }] };
  }

  const marketHoursPolicy = MarketHoursPolicyFactory.create(config.scheduler.marketHoursPolicy, config.scheduler);

  const lifecycleStore = options.lifecycleStoreOverride ?? new InMemoryTradeLifecycleStore();
  const lifecycleService = new TradeLifecycleService({
    store: lifecycleStore,
    auditTrail: options.auditTrail,
    executionRunId: options.executionRunId,
  });

  // Prototype 1.0 — official Hermes Agent multi-instrument wiring. Only ever attempted when the
  // official Hermes Agent is the SELECTED strategy — every other strategy (e.g. DEMO-0001) leaves
  // `hermes` undefined, preserving the existing single-instrument path exactly. Fails startup
  // closed (never silently falls back to single-instrument mode) on any of: the registered
  // instance under HERMES_AGENT_STRATEGY_ID not actually being a HermesAgentStrategy, an empty
  // configured instrument universe, or an unexpected construction failure.
  let hermes: HermesMultiInstrumentDependencies | undefined;
  if (validation.strategy.strategyId === HERMES_AGENT_STRATEGY_ID) {
    const strategyRegistry = options.strategyRegistryOverride ?? defaultStrategyRegistry;
    let resolvedInstance;
    try {
      resolvedInstance = strategyRegistry.require(HERMES_AGENT_STRATEGY_ID);
    } catch (error) {
      return {
        ok: false,
        problems: [
          {
            field: "hermesAgentStrategy",
            message:
              `The official Hermes Agent strategy ("${HERMES_AGENT_STRATEGY_ID}") is selected but could not be ` +
              `resolved from the default strategy registry: ${toErrorMessage(error)}`,
          },
        ],
      };
    }

    if (!(resolvedInstance instanceof HermesAgentStrategy)) {
      return {
        ok: false,
        problems: [
          {
            field: "hermesAgentStrategy",
            message:
              `The official Hermes Agent strategy ("${HERMES_AGENT_STRATEGY_ID}") is selected, but the strategy ` +
              `registered under that id is not a HermesAgentStrategy instance (found: ${resolvedInstance.constructor.name}). ` +
              "Refusing to start the multi-instrument universe scan against an incompatible strategy implementation.",
          },
        ],
      };
    }

    if (config.hermesAgent.instrumentUniverse.length === 0) {
      return {
        ok: false,
        problems: [
          {
            field: "hermesAgent.instrumentUniverse",
            message:
              "HERMES_INSTRUMENT_UNIVERSE resolved to an empty instrument list — the official Hermes Agent " +
              "strategy requires at least one configured instrument to scan.",
          },
        ],
      };
    }

    try {
      hermes = {
        strategyInstance: resolvedInstance,
        instrumentUniverse: config.hermesAgent.instrumentUniverse,
        hermesAdapterConfig: {
          cliPath: config.hermesAgent.cliPath,
          decisionTimeoutMs: config.hermesAgent.decisionTimeoutMs,
          maxStdoutBytes: config.hermesAgent.maxStdoutBytes,
        },
        hermesCliRunner: new ChildProcessHermesCliRunner(),
        maxProposalsPerScan: config.hermesAgent.maxProposalsPerScan,
      };
    } catch (error) {
      return {
        ok: false,
        problems: [{ field: "hermesAgent", message: `Failed to construct Hermes Agent adapter dependencies: ${toErrorMessage(error)}` }],
      };
    }
  }

  return {
    ok: true,
    dependencies: {
      strategy: validation.strategy,
      broker,
      marketDataProvider,
      marketHoursPolicy,
      lifecycleService,
      hermes,
      lifecycleStore,
      symbol: config.runtimeTrading.symbol,
      quantity: config.runtimeTrading.quantity,
      orderSizingMode: capabilities.orderSizingMode,
      portfolioRiskConfig: options.portfolioRiskConfig,
    },
  };
}

/** Prototype 1.0 — official Hermes Agent multi-instrument wiring. Mission-level invariant, not a
 * configurable value: no instrument may ever carry more than one open position at a time (see
 * universe-scanner.ts's own selection logic, which enforces this identically). Portfolio-wide
 * capacity remains the caller's own `portfolioRiskConfig.portfolioMaxOpenPositions`, reused
 * as-is below — never a second, independently-configured ceiling. */
const MAX_OPEN_POSITIONS_PER_INSTRUMENT = 1;

export interface ResolvedHermesRuntimeWiring {
  /** The "primary" instrument — TradingRuntimeDeps.instrument's own value. Always
   * `dependencies.hermes.instrumentUniverse[0]` when Hermes multi-instrument mode is active (so the
   * documented "instrument should equal instruments[0]" invariant — see trading-runtime.ts's own
   * TradingRuntimeDeps.instruments doc comment — is guaranteed by construction, never merely hoped
   * for), else `dependencies.symbol` unchanged. */
  instrument: string;
  /** TradingRuntimeDeps.instruments — undefined for the pre-existing single-instrument path. */
  instruments: string[] | undefined;
  /** TradingRuntimeDeps.universeScan — undefined for the pre-existing single-instrument path.
   * Reuses `dependencies.marketHoursPolicy` (the SAME instance TradingRuntimeDeps.marketHoursPolicy
   * receives) as the equity market-hours policy — never a second, separately-constructed policy. */
  universeScan: TradingRuntimeUniverseScanDeps | undefined;
}

/**
 * Pure — takes the already-resolved RuntimeDependencies bundle (broker, market data provider,
 * lifecycle store, audit trail are all reused from it, never duplicated here) and shapes exactly
 * the three TradingRuntimeDeps fields that differ between the single-instrument and Hermes
 * multi-instrument paths. `dependencies.hermes` alone decides which path this returns — no other
 * input, no I/O, no strategy re-selection. Called once by market-runtime.ts, immediately before
 * constructing TradingRuntime.
 */
export function buildHermesRuntimeWiring(dependencies: RuntimeDependencies): ResolvedHermesRuntimeWiring {
  const { hermes } = dependencies;
  if (!hermes) {
    return { instrument: dependencies.symbol, instruments: undefined, universeScan: undefined };
  }

  return {
    instrument: hermes.instrumentUniverse[0]!,
    instruments: hermes.instrumentUniverse,
    universeScan: {
      hermesAgentStrategy: hermes.strategyInstance,
      hermesAdapterConfig: hermes.hermesAdapterConfig,
      hermesCliRunner: hermes.hermesCliRunner,
      maxProposalsPerScan: hermes.maxProposalsPerScan,
      maxOpenPositions: dependencies.portfolioRiskConfig.portfolioMaxOpenPositions,
      maxOpenPositionsPerInstrument: MAX_OPEN_POSITIONS_PER_INSTRUMENT,
      equityMarketHoursPolicy: dependencies.marketHoursPolicy,
    },
  };
}
