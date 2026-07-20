import "server-only";
import { LocalPaperBroker, type PaperBroker } from "./paper-broker";
import { JsonFilePaperBrokerStore } from "./json-file-paper-broker-store";
import { HyperliquidTestnetBroker } from "./hyperliquid/hyperliquid-testnet-broker";
import { Trading212DemoBroker } from "./trading212/trading212-demo-broker";
import { EtoroDemoBroker } from "./etoro/etoro-demo-broker";
import { SUPPORTED_BROKER_PROVIDERS, type BrokerProvider, type HermesExecutionConfig } from "./config";
import type { AuditTrail } from "./audit-trail";

export interface BrokerFactoryOptions {
  /** Explicit provider selection — always overrides `config.brokerProvider` (the BROKER_PROVIDER
   * environment default) when supplied. This is how each smoke test pins its own broker
   * regardless of whatever a shared .env.local's BROKER_PROVIDER currently says, while any caller
   * that omits this (the execution runner, or `BrokerFactory.create()` with no options) keeps
   * today's environment-driven default unchanged. */
  provider?: BrokerProvider;
  /** Only meaningful for the local broker — see LocalPaperBroker.create. Defaults to false. */
  resetState?: boolean;
}

interface ProviderContext {
  config: HermesExecutionConfig;
  auditTrail: AuditTrail;
  executionRunId: string;
  resetState: boolean;
}

type ProviderConstructor = (ctx: ProviderContext) => Promise<PaperBroker>;

// The one and only place a broker-provider name is mapped to a concrete implementation. Adding a
// future broker (e.g. "ibkr-paper", "alpaca-paper", "kraken") means adding one entry here — no
// other switch/if-chain over BrokerProvider should ever need to exist anywhere else in the project.
// Every entry re-validates its own provider-specific requirements independently of whether it was
// reached via the BROKER_PROVIDER environment default or an explicit `{ provider }` override —
// there is no "trust the caller already checked" path.
const PROVIDER_CONSTRUCTORS: Record<BrokerProvider, ProviderConstructor> = {
  local: async ({ config, resetState }) => {
    const store = new JsonFilePaperBrokerStore();
    return LocalPaperBroker.create(store, config.paperStartingCash, { resetState });
  },

  "hyperliquid-testnet": async ({ config, auditTrail, executionRunId }) => {
    if (!config.hyperliquid.executionEnabled) {
      throw new Error(
        "BROKER_PROVIDER=hyperliquid-testnet requires HYPERLIQUID_TESTNET_EXECUTION_ENABLED=true.",
      );
    }
    if (!config.hyperliquid.privateKey || !config.hyperliquid.accountAddress) {
      throw new Error(
        "BROKER_PROVIDER=hyperliquid-testnet requires both HYPERLIQUID_TESTNET_PRIVATE_KEY and " +
          "HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS to be set.",
      );
    }
    const broker = new HyperliquidTestnetBroker({ config: config.hyperliquid, auditTrail, executionRunId });
    await broker.connect();
    return broker;
  },

  "trading212-demo": async ({ config, auditTrail, executionRunId }) => {
    if (!config.trading212.executionEnabled) {
      throw new Error("BROKER_PROVIDER=trading212-demo requires TRADING212_DEMO_EXECUTION_ENABLED=true.");
    }
    if (!config.trading212.apiKey || !config.trading212.apiSecret) {
      throw new Error(
        "BROKER_PROVIDER=trading212-demo requires both TRADING212_API_KEY and TRADING212_API_SECRET to be set.",
      );
    }
    const broker = new Trading212DemoBroker({ config: config.trading212, auditTrail, executionRunId });
    await broker.connect();
    return broker;
  },

  "etoro-demo": async ({ config, auditTrail, executionRunId }) => {
    if (config.etoro.env !== "demo") {
      throw new Error("BROKER_PROVIDER=etoro-demo requires ETORO_ENV=demo to be set explicitly.");
    }
    if (!config.etoro.apiKey || !config.etoro.userKey) {
      throw new Error("BROKER_PROVIDER=etoro-demo requires both ETORO_API_KEY and ETORO_USER_KEY to be set.");
    }
    const broker = new EtoroDemoBroker({ config: config.etoro, auditTrail, executionRunId });
    await broker.connect();
    return broker;
  },
};

/**
 * The single place broker selection happens — everything upstream (execution runner, signal
 * engine, risk engine, smoke tests) only ever sees the shared `PaperBroker` interface.
 *
 * `BrokerFactory.create(config, auditTrail, executionRunId)` — no `provider` supplied — uses
 * `config.brokerProvider` (i.e. the `BROKER_PROVIDER` environment variable) exactly as before.
 * `BrokerFactory.create(config, auditTrail, executionRunId, { provider: "etoro-demo" })` always
 * builds that provider regardless of `BROKER_PROVIDER` — this is what lets every broker's
 * credentials live in `.env.local` permanently (`BROKER_PROVIDER` only selects the *application's*
 * default) while each smoke test pins its own broker without editing the environment.
 *
 * Never falls back: an unrecognised provider throws a descriptive error listing every supported
 * one, rather than silently defaulting to `local` or anything else.
 */
export const BrokerFactory = {
  async create(
    config: HermesExecutionConfig,
    auditTrail: AuditTrail,
    executionRunId: string,
    options: BrokerFactoryOptions = {},
  ): Promise<PaperBroker> {
    const provider = options.provider ?? config.brokerProvider;
    const construct = PROVIDER_CONSTRUCTORS[provider];
    if (!construct) {
      throw new Error(
        `Unsupported broker provider "${provider}" — supported providers: ${SUPPORTED_BROKER_PROVIDERS.join(", ")}.`,
      );
    }
    return construct({ config, auditTrail, executionRunId, resetState: options.resetState ?? false });
  },
};
