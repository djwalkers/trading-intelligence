import type { BrokerProvider, HermesExecutionConfig, MarketDataProviderType, MarketHoursPolicyType, RuntimeMode } from "../config";
import type { InternalStrategy, StrategySourceType } from "../types";

// Milestone 8 — Deployment-Ready Runtime Configuration. A plain, flat, JSON-serialisable object —
// deliberately field-by-field constructed (never `{...config}` or any other wholesale spread of a
// config/broker-secrets-bearing object) so a credential can never end up in here by accident, only
// by a reviewer explicitly adding a new field that names one. "This summary will later be useful
// to Telegram and VPS diagnostics" — this shape is the contract those future consumers rely on;
// keep additions here as deliberate as the choice to omit apiKey/userKey/apiSecret/privateKey/
// accountAddress/token below.

export interface RedactedStartupSummary {
  runtimeMode: RuntimeMode;
  brokerProvider: BrokerProvider;
  /** Whether every env var broker-capabilities.ts lists as required for the SELECTED broker is
   * present — never the values themselves. */
  brokerCredentialsConfigured: boolean;
  marketDataProvider: MarketDataProviderType;
  strategyId: string;
  strategyVersion: number;
  strategySourceType: StrategySourceType;
  symbol: string;
  quantity: number;
  maxQuantity: number | undefined;
  schedulerEnabled: boolean;
  schedulerIntervalMs: number;
  immediateFirstRun: boolean;
  marketHoursPolicy: MarketHoursPolicyType;
  marketHoursTimezone: string;
}

/** Presence-only check against the already-parsed config (never re-reads raw process.env) — "are
 * the fields this broker needs non-undefined," not "what are they." Hand-written per provider
 * rather than driven off broker-capabilities.ts's requiredCredentialEnvVars list: that list names
 * *env var* names, and mapping an env var name back to which config field to check is not
 * mechanically derivable (e.g. HYPERLIQUID_TESTNET_PRIVATE_KEY -> config.hyperliquid.privateKey) —
 * a second lookup table would be less honest than just checking the fields directly here. */
function areBrokerCredentialsConfigured(config: HermesExecutionConfig, provider: BrokerProvider): boolean {
  switch (provider) {
    case "local":
      return true; // no credentials required
    case "hyperliquid-testnet":
      return config.hyperliquid.privateKey !== undefined && config.hyperliquid.accountAddress !== undefined;
    case "trading212-demo":
      return config.trading212.apiKey !== undefined && config.trading212.apiSecret !== undefined;
    case "etoro-demo":
      return config.etoro.apiKey !== undefined && config.etoro.userKey !== undefined;
  }
}

export function buildRedactedStartupSummary(config: HermesExecutionConfig, strategy: InternalStrategy): RedactedStartupSummary {
  return {
    runtimeMode: config.runtimeTrading.mode,
    brokerProvider: config.brokerProvider,
    brokerCredentialsConfigured: areBrokerCredentialsConfigured(config, config.brokerProvider),
    marketDataProvider: config.marketDataProvider,
    strategyId: strategy.strategyId,
    strategyVersion: strategy.version,
    strategySourceType: strategy.sourceType,
    symbol: config.runtimeTrading.symbol,
    quantity: config.runtimeTrading.quantity,
    maxQuantity: config.runtimeTrading.maxQuantity,
    schedulerEnabled: config.scheduler.enabled,
    schedulerIntervalMs: config.scheduler.intervalMs,
    immediateFirstRun: config.scheduler.immediateFirstRun,
    marketHoursPolicy: config.scheduler.marketHoursPolicy,
    marketHoursTimezone: config.scheduler.sessionTimezone,
  };
}
