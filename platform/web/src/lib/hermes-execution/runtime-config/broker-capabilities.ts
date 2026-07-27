import type { BrokerProvider, RuntimeMode } from "../config";
import type { OrderSizingMode } from "../types";

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
  /** Broker Sizing Semantic Fix. How this broker's own `OrderRequest.quantity`/
   * `PaperPosition.quantity` must be interpreted to get a notional value — see
   * order-sizing.ts's own `calculateNotional` and types.ts's own `OrderSizingMode` doc comment.
   * Only "etoro-demo" is "NOTIONAL" (its own documented CFD "amount" semantics); every other broker
   * here is the standard "UNITS" (asset/share/contract count) a paper/testnet/demo equity-style
   * broker uses. */
  orderSizingMode: OrderSizingMode;
}

export const BROKER_CAPABILITIES: Record<BrokerProvider, BrokerCapabilities> = {
  local: {
    provider: "local",
    supportedRuntimeModes: ["paper"],
    requiresSymbolResolution: false,
    canSupplyLiveRates: false,
    requiredCredentialEnvVars: [],
    orderSizingMode: "UNITS",
  },
  "hyperliquid-testnet": {
    provider: "hyperliquid-testnet",
    supportedRuntimeModes: ["testnet"],
    requiresSymbolResolution: false,
    canSupplyLiveRates: false,
    requiredCredentialEnvVars: ["HYPERLIQUID_TESTNET_PRIVATE_KEY", "HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS"],
    orderSizingMode: "UNITS",
  },
  "trading212-demo": {
    provider: "trading212-demo",
    supportedRuntimeModes: ["demo"],
    requiresSymbolResolution: false,
    canSupplyLiveRates: false,
    requiredCredentialEnvVars: ["TRADING212_API_KEY", "TRADING212_API_SECRET"],
    orderSizingMode: "UNITS",
  },
  "etoro-demo": {
    provider: "etoro-demo",
    supportedRuntimeModes: ["demo"],
    requiresSymbolResolution: true,
    canSupplyLiveRates: true,
    requiredCredentialEnvVars: ["ETORO_API_KEY", "ETORO_USER_KEY"],
    orderSizingMode: "NOTIONAL",
  },
};

/** Every broker provider whose capabilities currently declare canSupplyLiveRates — used only to
 * compose a helpful error message when an incompatible combination is rejected. */
export function brokersWithLiveRateSupport(): BrokerProvider[] {
  return Object.values(BROKER_CAPABILITIES)
    .filter((capabilities) => capabilities.canSupplyLiveRates)
    .map((capabilities) => capabilities.provider);
}

/** Restart-Resilient Autonomy Phase — AUTO_DEMO gate. A broker's capabilities "demonstrably prove"
 * it is demo/paper/testnet only when EVERY runtime mode it could ever be selected under is one of
 * those three — i.e. it declares no live-capable mode at all. Every broker in BROKER_CAPABILITIES
 * today satisfies this trivially (there is no "live" RuntimeMode value anywhere in this codebase —
 * see config.ts's own SUPPORTED_RUNTIME_MODES doc comment), but this is still checked explicitly,
 * against the broker's own declared data, never assumed — a future broker capability that ever
 * added a live-capable mode would immediately and correctly fail this check without any change
 * needed here. Takes a plain `BrokerCapabilities` (not a `BrokerProvider` lookup) specifically so
 * tests can exercise a synthetic, hypothetical "live-capable" broker without one needing to exist in
 * BROKER_CAPABILITIES for real. */
const DEMO_LIKE_RUNTIME_MODES: readonly RuntimeMode[] = ["demo", "paper", "testnet"];

export function isAutoDemoEligible(capabilities: BrokerCapabilities): boolean {
  return (
    capabilities.supportedRuntimeModes.length > 0 &&
    capabilities.supportedRuntimeModes.every((mode) => (DEMO_LIKE_RUNTIME_MODES as readonly string[]).includes(mode))
  );
}
