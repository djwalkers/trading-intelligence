import type { BrokerProvider, RuntimeMode } from "../config";

// Milestone 8 — Deployment-Ready Runtime Configuration. A static, declarative capability table —
// not a method added to each broker class. Capabilities here are inherent, fixed properties of
// each broker *type* (which runtime modes it can ever run under, whether it needs a symbol-
// resolution step before use, whether it can supply live rates), never instance state, so a plain
// lookup table declares them just as validly as a method would, without touching any of the four
// existing broker implementation files (paper-broker.ts, hyperliquid-testnet-broker.ts,
// trading212-demo-broker.ts, etoro-demo-broker.ts stay completely unmodified by this milestone).

export interface BrokerCapabilities {
  provider: BrokerProvider;
  /** Every runtime mode this broker may be selected under. Exactly one entry each today — a
   * broker's own name already encodes its mode ("etoro-demo", "trading212-demo",
   * "hyperliquid-testnet") except "local", which maps to "paper". */
  supportedRuntimeModes: readonly RuntimeMode[];
  /** True only for EtoroDemoBroker — the only adapter that requires an explicit
   * resolveInstrument() call (translating a human-readable symbol into its own internal
   * instrumentId) before placeMarketOrder()/getRate() will work. Hyperliquid/Trading212 resolve
   * symbols internally, automatically, inside their own connect()/placeMarketOrder(); LocalPaperBroker
   * needs no resolution step at all. */
  requiresSymbolResolution: boolean;
  /** True only for EtoroDemoBroker — the only adapter with a getRate() method, i.e. the only one
   * that structurally satisfies LiveMarketDataProvider's RateSource interface
   * (market-data/live-market-data-provider.ts). HERMES_MARKET_DATA_PROVIDER=live is only ever
   * compatible with a broker where this is true. */
  canSupplyLiveRates: boolean;
  /** Env var names (never values) this broker requires to construct — for the redacted startup
   * summary's "credentials configured: yes/no" reporting only. Presence is already enforced,
   * unchanged, by config.ts's own existing per-broker checks at config-build time; this list is not
   * a second enforcement mechanism, purely descriptive. */
  requiredCredentialEnvVars: readonly string[];
}

export const BROKER_CAPABILITIES: Record<BrokerProvider, BrokerCapabilities> = {
  local: {
    provider: "local",
    supportedRuntimeModes: ["paper"],
    requiresSymbolResolution: false,
    canSupplyLiveRates: false,
    requiredCredentialEnvVars: [],
  },
  "hyperliquid-testnet": {
    provider: "hyperliquid-testnet",
    supportedRuntimeModes: ["testnet"],
    requiresSymbolResolution: false,
    canSupplyLiveRates: false,
    requiredCredentialEnvVars: ["HYPERLIQUID_TESTNET_PRIVATE_KEY", "HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS"],
  },
  "trading212-demo": {
    provider: "trading212-demo",
    supportedRuntimeModes: ["demo"],
    requiresSymbolResolution: false,
    canSupplyLiveRates: false,
    requiredCredentialEnvVars: ["TRADING212_API_KEY", "TRADING212_API_SECRET"],
  },
  "etoro-demo": {
    provider: "etoro-demo",
    supportedRuntimeModes: ["demo"],
    requiresSymbolResolution: true,
    canSupplyLiveRates: true,
    requiredCredentialEnvVars: ["ETORO_API_KEY", "ETORO_USER_KEY"],
  },
};

/** Every broker provider whose capabilities currently declare canSupplyLiveRates — used only to
 * compose a helpful error message when an incompatible combination is rejected. */
export function brokersWithLiveRateSupport(): BrokerProvider[] {
  return Object.values(BROKER_CAPABILITIES)
    .filter((capabilities) => capabilities.canSupplyLiveRates)
    .map((capabilities) => capabilities.provider);
}
