import { SUPPORTED_MARKET_DATA_PROVIDERS, type MarketDataProviderType } from "../config";
import { MockMarketDataProvider, type MockMarketDataProviderOptions } from "./mock-market-data-provider";
import { LiveMarketDataProvider, type RateSource } from "./live-market-data-provider";
import type { MarketDataProvider } from "./market-data-provider";

// Milestone 5 — Live Market Data Integration. Mirrors broker-factory.ts's own
// "one place a provider name maps to a concrete implementation" pattern exactly — the same
// override-beats-config convention, the same "never falls back to a default on an unrecognised
// value" guarantee.

export interface MarketDataProviderFactoryOptions {
  /** Explicit provider-type selection — always overrides `providerType` when supplied, same
   * override convention as BrokerFactoryOptions.provider. */
  type?: MarketDataProviderType;
  mock?: MockMarketDataProviderOptions;
  /** Required when the resolved type is "live" — the narrow quote source LiveMarketDataProvider
   * wraps (e.g. a connected broker's own getRate, which satisfies RateSource structurally). */
  live?: { rateSource: RateSource };
}

/**
 * The single place market-data-provider selection happens — everything upstream (the CLI,
 * MarketIntelligenceBuilder's caller) only ever sees the shared `MarketDataProvider` interface.
 * Changing which provider is active is a configuration change (`HERMES_MARKET_DATA_PROVIDER`, or an
 * explicit `{ type }` override) only — no business logic anywhere downstream needs to change.
 */
export const MarketDataProviderFactory = {
  create(providerType: MarketDataProviderType, options: MarketDataProviderFactoryOptions = {}): MarketDataProvider {
    const type = options.type ?? providerType;

    if (type === "mock") {
      return new MockMarketDataProvider(options.mock);
    }

    if (type === "live") {
      if (!options.live?.rateSource) {
        throw new Error(
          'MarketDataProviderFactory.create("live") requires options.live.rateSource — a connected quote source.',
        );
      }
      return new LiveMarketDataProvider(options.live.rateSource);
    }

    throw new Error(
      `Unsupported market data provider "${type as string}" — supported providers: ${SUPPORTED_MARKET_DATA_PROVIDERS.join(", ")}.`,
    );
  },
};
