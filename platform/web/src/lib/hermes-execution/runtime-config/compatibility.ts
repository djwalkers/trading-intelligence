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
