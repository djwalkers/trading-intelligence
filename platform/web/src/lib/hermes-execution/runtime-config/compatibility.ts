import type { BrokerProvider, MarketDataProviderType, RuntimeMode } from "../config";
import { BROKER_CAPABILITIES, brokersWithLiveRateSupport } from "./broker-capabilities";

// Milestone 8 — Deployment-Ready Runtime Configuration. Pure, static compatibility checks — no I/O,
// no broker construction, no network call. This is exactly the check the mission calls for
// happening "during startup," never discovered "on the first trading cycle": everything here can
// be (and is, by startup-validation.ts) evaluated before any broker is ever connected to.

export interface CompatibilityProblem {
  field: string;
  message: string;
}

/** The selected broker must declare support for the selected runtime mode — e.g.
 * BROKER_PROVIDER=local with HERMES_RUNTIME_MODE=demo is rejected; each broker supports exactly
 * one mode today (see broker-capabilities.ts). */
export function checkModeCompatibility(brokerProvider: BrokerProvider, runtimeMode: RuntimeMode): CompatibilityProblem | undefined {
  const capabilities = BROKER_CAPABILITIES[brokerProvider];
  if (capabilities.supportedRuntimeModes.includes(runtimeMode)) return undefined;
  return {
    field: "runtimeMode",
    message:
      `Broker "${brokerProvider}" does not support runtime mode "${runtimeMode}" — supported mode(s) for ` +
      `"${brokerProvider}": ${capabilities.supportedRuntimeModes.join(", ")}.`,
  };
}

/** HERMES_MARKET_DATA_PROVIDER=live requires a broker that can actually supply a RateSource — see
 * broker-capabilities.ts's canSupplyLiveRates. Rejecting this here means LiveMarketDataProvider is
 * never even constructed for an incompatible broker, let alone started against one — "do not start
 * the scheduler and only discover the incompatibility on the first trading cycle." */
export function checkMarketDataCompatibility(
  brokerProvider: BrokerProvider,
  marketDataProvider: MarketDataProviderType,
): CompatibilityProblem | undefined {
  if (marketDataProvider !== "live") return undefined;
  const capabilities = BROKER_CAPABILITIES[brokerProvider];
  if (capabilities.canSupplyLiveRates) return undefined;
  return {
    field: "marketDataProvider",
    message:
      `HERMES_MARKET_DATA_PROVIDER=live requires a broker capable of supplying live rates; "${brokerProvider}" is not. ` +
      `Broker(s) that support live rates: ${brokersWithLiveRateSupport().join(", ") || "(none)"}.`,
  };
}

/**
 * Prototype V1 — a deliberate, temporary, milestone-scoped exclusion, not a permanent capability
 * declaration (that's why this lives here as its own explicit check rather than in
 * broker-capabilities.ts's supportedRuntimeModes, which correctly still lists "demo" as a mode
 * trading212-demo is structurally compatible with — the adapter's mode-pairing isn't broken, its
 * real-world reliability right now is).
 *
 * Confirmed via live testing (see the Prototype V1 mission report): the adapter connects
 * successfully and can open a position, but order-fill polling failed with an HTTP 404 partway
 * through, leaving a real demo position unmanaged (closed manually afterward, outside this
 * pipeline). Until that's investigated and fixed, Trading212 is excluded from this prototype
 * regardless of requested mode — remove this single check once repaired, no other change needed.
 */
export function checkPrototypeV1BrokerSupport(brokerProvider: BrokerProvider): CompatibilityProblem | undefined {
  if (brokerProvider !== "trading212-demo") return undefined;
  return {
    field: "brokerProvider",
    message:
      'Trading212 is not supported for Prototype V1 — live testing confirmed the adapter\'s order-fill ' +
      "polling can fail (HTTP 404) after a real position is opened, leaving it unmanaged. Select a " +
      'different BROKER_PROVIDER ("local", "hyperliquid-testnet", or "etoro-demo") until this is fixed.',
  };
}
