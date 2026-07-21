import { FileSystemRegistryClient } from "../registry-client";
import { loadEnabledStrategies } from "../strategy-loader";
import { BrokerFactory } from "../broker-factory";
import { MarketDataProviderFactory } from "../market-data/market-data-provider-factory";
import { MarketHoursPolicyFactory } from "../runtime/market-hours-policy-factory";
import { TradeLifecycleService } from "../trade-lifecycle/trade-lifecycle-service";
import { InMemoryTradeLifecycleStore } from "../trade-lifecycle/trade-lifecycle-store";
import type { AuditTrail } from "../audit-trail";
import type { BrokerProvider, HermesExecutionConfig, RuntimeMode } from "../config";
import type { MarketDataProvider } from "../market-data/market-data-provider";
import type { MarketHoursPolicy } from "../runtime/market-hours-policy";
import type { PaperBroker } from "../paper-broker";
import type { PortfolioRiskConfig } from "../portfolio-risk-engine";
import type { InternalStrategy } from "../types";
import { BROKER_CAPABILITIES } from "./broker-capabilities";
import { validateStartup, type StartupValidationProblem } from "./startup-validation";

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
}

export interface RuntimeDependencies {
  strategy: InternalStrategy;
  broker: PaperBroker;
  marketDataProvider: MarketDataProvider;
  marketHoursPolicy: MarketHoursPolicy;
  lifecycleService: TradeLifecycleService;
  symbol: string;
  quantity: number;
  portfolioRiskConfig: PortfolioRiskConfig;
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
      live: capabilities.canSupplyLiveRates ? { rateSource: broker as unknown as RateSourceBroker } : undefined,
    });
  } catch (error) {
    return { ok: false, problems: [{ field: "marketDataProvider", message: toErrorMessage(error) }] };
  }

  const marketHoursPolicy = MarketHoursPolicyFactory.create(config.scheduler.marketHoursPolicy, config.scheduler);

  const lifecycleService = new TradeLifecycleService({
    store: new InMemoryTradeLifecycleStore(),
    auditTrail: options.auditTrail,
    executionRunId: options.executionRunId,
  });

  return {
    ok: true,
    dependencies: {
      strategy: validation.strategy,
      broker,
      marketDataProvider,
      marketHoursPolicy,
      lifecycleService,
      symbol: config.runtimeTrading.symbol,
      quantity: config.runtimeTrading.quantity,
      portfolioRiskConfig: options.portfolioRiskConfig,
    },
  };
}
