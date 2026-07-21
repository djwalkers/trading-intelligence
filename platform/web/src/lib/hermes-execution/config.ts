import "server-only";
import * as path from "node:path";
import { parseBoolean, parseEnum, parseInteger, ConfigError } from "@/lib/config/env";

// Kept as its own small config module (mirrors server-config.ts's shape/caching pattern, reuses
// its parsing primitives) rather than folded into ServerConfig — this whole feature is meant to
// stay a cleanly isolated, independently removable pipeline (see docs/execution-mvp-phase-1.md).

export const SUPPORTED_EXECUTION_MODES = ["paper"] as const;
export type ExecutionMode = (typeof SUPPORTED_EXECUTION_MODES)[number];

// Deliberately only these four. There is no "hyperliquid-live", "trading212-live", "etoro-live", or
// any other mainnet/live value anywhere in this union — mainnet/live support does not exist
// structurally, not just by runtime rejection (see docs/hyperliquid-testnet-adapter-phase-1.md,
// docs/trading212-demo-adapter-phase-1.md, and docs/etoro-demo-adapter-phase-1.md's Safety
// Boundaries).
export const SUPPORTED_BROKER_PROVIDERS = ["local", "hyperliquid-testnet", "trading212-demo", "etoro-demo"] as const;
export type BrokerProvider = (typeof SUPPORTED_BROKER_PROVIDERS)[number];

// The only value this type can ever hold. There is no "live"/"real" variant anywhere in this
// codebase — matching BrokerProvider's own "no live value exists structurally" pattern, layered
// with an extra explicit gate (ETORO_ENV) that Hyperliquid/Trading212 don't need since demo-only
// is already baked into their own hard-coded base URLs.
export const SUPPORTED_ETORO_ENVS = ["demo"] as const;
export type EtoroEnv = (typeof SUPPORTED_ETORO_ENVS)[number];

// Milestone 5 — Live Market Data Integration. Selects which MarketDataProvider (market-data/)
// backs the Milestone 2-4 pipeline (market-decide.ts and anything else that builds a
// MarketDecisionContext). Deliberately prefixed HERMES_, not reusing the existing, unrelated
// NEXT_PUBLIC_MARKET_DATA_PROVIDER (a client-exposed display label for a totally different market
// data widget — see src/lib/config/client-config.ts) — same words, unrelated concepts, kept
// unambiguous by name. Defaults to "mock" so tests and any run without explicit configuration stay
// deterministic; there is no "mainnet"/"live-unverified" value, matching this pipeline's existing
// fail-closed convention for BrokerProvider/EtoroEnv above.
export const SUPPORTED_MARKET_DATA_PROVIDERS = ["mock", "live"] as const;
export type MarketDataProviderType = (typeof SUPPORTED_MARKET_DATA_PROVIDERS)[number];

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface HyperliquidTestnetConfig {
  privateKey: string | undefined;
  accountAddress: string | undefined;
  /** Defaults to false. Must be explicitly "true" for HyperliquidTestnetBroker to ever submit a
   * real (testnet) order — a second, independent gate on top of `brokerProvider`. */
  executionEnabled: boolean;
  /** Upper bound (USD notional) the adapter will ever size a single test order to. */
  maxTestOrderValueUsd: number;
  /** The perp this adapter's smoke test trades. Kept small and liquid by default. */
  testInstrument: string;
}

export interface Trading212DemoConfig {
  apiKey: string | undefined;
  /** Per Trading212's current official API auth docs (docs.trading212.com/api/section/
   * authentication): credentials are an API Key + API Secret pair, sent as an HTTP Basic
   * Authorization header (`Basic base64(apiKey:apiSecret)`) — not a single raw key. */
  apiSecret: string | undefined;
  /** Defaults to false. Must be explicitly "true" for Trading212DemoBroker to ever submit a real
   * (demo) order — a second, independent gate on top of `brokerProvider`, mirroring Hyperliquid's. */
  executionEnabled: boolean;
  /** The equity ticker (Trading212's own identifier, e.g. "AAPL_US_EQ") the smoke test trades. */
  testInstrument: string;
  /** The quantity the smoke test buys/sells. Trading212's real metadata response (confirmed
   * against the live API — see docs/trading212-demo-adapter-phase-1.md) has no minimum-order-
   * quantity field despite the OpenAPI spec documenting one, so this is an explicit, validated
   * value rather than something derived from instrument metadata. Must be a positive finite
   * number — config-build fails closed otherwise. */
  testOrderQuantity: number;
}

export interface EtoroDemoConfig {
  /** Must be explicitly "demo" whenever BROKER_PROVIDER=etoro-demo — never inferred from missing
   * configuration. Undefined means "not set", a distinct state from an invalid non-"demo" value
   * (which fails closed at config-build time regardless of which provider is active). */
  env: EtoroEnv | undefined;
  apiKey: string | undefined;
  userKey: string | undefined;
  /** A human-readable symbol or search term (e.g. "BTC") — resolved through eToro's own
   * instrument-search endpoint at runtime, never a hard-coded numeric instrumentId. */
  testInstrument: string;
  /** eToro's public API documents no confirmed minimum-order-size signal to derive a safe default
   * from (see docs/etoro-demo-adapter-phase-1.md) — required explicitly, never defaulted or
   * guessed, unlike Trading212's testOrderQuantity which does have a documented-safe default. */
  testAmount: number | undefined;
}

export interface HermesExecutionConfig {
  /** Absolute filesystem path to the Hermes Lab strategy-registry/ directory. Undefined means
   * "not configured" — a distinct, clearly-reported state from "configured but empty." */
  registryPath: string | undefined;
  /** Only "paper" is supported in this phase. Any other value fails closed at config-build time
   * rather than silently falling back — there is no live mode to fall back to. */
  executionMode: ExecutionMode;
  /** Defaults to false — the DEMO_ONLY strategy must never load unless this is explicitly true. */
  demoExecutionModeEnabled: boolean;
  paperStartingCash: number;
  /** Feeds RiskEngineConfig.strategyMaxOpenPositions (risk-engine.ts) — the older, per-strategy
   * pipeline's cap. Distinct from PortfolioRiskConfig.portfolioMaxOpenPositions
   * (portfolio-risk-engine.ts), which is configured separately and not sourced from here. */
  strategyMaxOpenPositions: number;
  /** Defaults to "local". Only "local", "hyperliquid-testnet", "trading212-demo", and
   * "etoro-demo" are valid; anything else (including any attempt at a mainnet/live value) fails
   * closed at config-build time. */
  brokerProvider: BrokerProvider;
  /** Defaults to "mock". Selects between MockMarketDataProvider and LiveMarketDataProvider
   * (market-data/) for the Milestone 2-4 pipeline. Only "mock" and "live" are valid. */
  marketDataProvider: MarketDataProviderType;
  hyperliquid: HyperliquidTestnetConfig;
  trading212: Trading212DemoConfig;
  etoro: EtoroDemoConfig;
}

interface RawHermesExecutionEnv {
  HERMES_STRATEGY_REGISTRY_PATH: string | undefined;
  EXECUTION_MODE: string | undefined;
  DEMO_EXECUTION_MODE: string | undefined;
  HERMES_PAPER_STARTING_CASH: string | undefined;
  HERMES_MAX_OPEN_POSITIONS: string | undefined;
  BROKER_PROVIDER: string | undefined;
  HERMES_MARKET_DATA_PROVIDER: string | undefined;
  HYPERLIQUID_TESTNET_PRIVATE_KEY: string | undefined;
  HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: string | undefined;
  HYPERLIQUID_TESTNET_EXECUTION_ENABLED: string | undefined;
  HYPERLIQUID_TESTNET_MAX_ORDER_VALUE_USD: string | undefined;
  HYPERLIQUID_TESTNET_INSTRUMENT: string | undefined;
  TRADING212_API_KEY: string | undefined;
  TRADING212_API_SECRET: string | undefined;
  TRADING212_DEMO_EXECUTION_ENABLED: string | undefined;
  TRADING212_DEMO_INSTRUMENT: string | undefined;
  TRADING212_DEMO_TEST_QUANTITY: string | undefined;
  ETORO_ENV: string | undefined;
  ETORO_API_KEY: string | undefined;
  ETORO_USER_KEY: string | undefined;
  ETORO_DEMO_TEST_INSTRUMENT: string | undefined;
  ETORO_DEMO_TEST_AMOUNT: string | undefined;
}

const DEFAULT_PAPER_STARTING_CASH = 10_000;
const DEFAULT_STRATEGY_MAX_OPEN_POSITIONS = 5;
// Hyperliquid enforces a $10 minimum order notional on perps; $15 gives headroom over that floor
// while staying the "smallest practical test size" for a smoke test, not a real trading amount.
const DEFAULT_MAX_TEST_ORDER_VALUE_USD = 15;
const DEFAULT_TEST_INSTRUMENT = "BTC";
// AAPL is virtually certain to exist and stay listed on Trading212's demo environment — chosen for
// the same "always available" reason BTC was chosen as Hyperliquid's default test instrument.
const DEFAULT_TRADING212_TEST_INSTRUMENT = "AAPL_US_EQ";
// Trading212's real metadata response has no minimum-order-quantity field to derive this from
// (confirmed against the live API); 1 share is a small, always-safe default for a liquid US equity.
const DEFAULT_TRADING212_TEST_ORDER_QUANTITY = 1;
// BTC is a crypto CFD on eToro — generally tradable around the clock, unlike an equity CFD that
// inherits its underlying exchange's market hours (see docs/etoro-demo-adapter-phase-1.md).
// Resolved through eToro's own instrument-search endpoint at runtime, never used as a hard-coded
// instrumentId.
const DEFAULT_ETORO_TEST_INSTRUMENT = "BTC";

export function buildHermesExecutionConfig(
  env: RawHermesExecutionEnv = {
    HERMES_STRATEGY_REGISTRY_PATH: process.env.HERMES_STRATEGY_REGISTRY_PATH,
    EXECUTION_MODE: process.env.EXECUTION_MODE,
    DEMO_EXECUTION_MODE: process.env.DEMO_EXECUTION_MODE,
    HERMES_PAPER_STARTING_CASH: process.env.HERMES_PAPER_STARTING_CASH,
    HERMES_MAX_OPEN_POSITIONS: process.env.HERMES_MAX_OPEN_POSITIONS,
    BROKER_PROVIDER: process.env.BROKER_PROVIDER,
    HERMES_MARKET_DATA_PROVIDER: process.env.HERMES_MARKET_DATA_PROVIDER,
    HYPERLIQUID_TESTNET_PRIVATE_KEY: process.env.HYPERLIQUID_TESTNET_PRIVATE_KEY,
    HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: process.env.HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS,
    HYPERLIQUID_TESTNET_EXECUTION_ENABLED: process.env.HYPERLIQUID_TESTNET_EXECUTION_ENABLED,
    HYPERLIQUID_TESTNET_MAX_ORDER_VALUE_USD: process.env.HYPERLIQUID_TESTNET_MAX_ORDER_VALUE_USD,
    HYPERLIQUID_TESTNET_INSTRUMENT: process.env.HYPERLIQUID_TESTNET_INSTRUMENT,
    TRADING212_API_KEY: process.env.TRADING212_API_KEY,
    TRADING212_API_SECRET: process.env.TRADING212_API_SECRET,
    TRADING212_DEMO_EXECUTION_ENABLED: process.env.TRADING212_DEMO_EXECUTION_ENABLED,
    TRADING212_DEMO_INSTRUMENT: process.env.TRADING212_DEMO_INSTRUMENT,
    TRADING212_DEMO_TEST_QUANTITY: process.env.TRADING212_DEMO_TEST_QUANTITY,
    ETORO_ENV: process.env.ETORO_ENV,
    ETORO_API_KEY: process.env.ETORO_API_KEY,
    ETORO_USER_KEY: process.env.ETORO_USER_KEY,
    ETORO_DEMO_TEST_INSTRUMENT: process.env.ETORO_DEMO_TEST_INSTRUMENT,
    ETORO_DEMO_TEST_AMOUNT: process.env.ETORO_DEMO_TEST_AMOUNT,
  },
): HermesExecutionConfig {
  const registryPath = env.HERMES_STRATEGY_REGISTRY_PATH
    ? path.resolve(env.HERMES_STRATEGY_REGISTRY_PATH)
    : undefined;

  // "paper" is the fallback when unset ("execution defaults to paper mode") but any other value —
  // including a future "live" — must fail closed with a clear ConfigError, never fall through.
  const executionMode = parseEnum(env.EXECUTION_MODE, SUPPORTED_EXECUTION_MODES, "paper");

  const demoExecutionModeEnabled = parseBoolean(env.DEMO_EXECUTION_MODE, false);

  const paperStartingCash = parseInteger(
    env.HERMES_PAPER_STARTING_CASH,
    DEFAULT_PAPER_STARTING_CASH,
    { min: 1 },
  );

  const strategyMaxOpenPositions = parseInteger(
    env.HERMES_MAX_OPEN_POSITIONS,
    DEFAULT_STRATEGY_MAX_OPEN_POSITIONS,
    { min: 1 },
  );

  // Unsupported providers (including any typo or an eventual "mainnet") fail closed here — there
  // is no fallback branch anywhere downstream that would silently treat an unrecognised value as
  // "local".
  const brokerProvider = parseEnum(env.BROKER_PROVIDER, SUPPORTED_BROKER_PROVIDERS, "local");

  // Unsupported values (including any typo) fail closed here, same convention as brokerProvider
  // above — there is no fallback branch anywhere downstream that treats an unrecognised value as
  // "mock".
  const marketDataProvider = parseEnum(env.HERMES_MARKET_DATA_PROVIDER, SUPPORTED_MARKET_DATA_PROVIDERS, "mock");

  const privateKey = env.HYPERLIQUID_TESTNET_PRIVATE_KEY || undefined;
  if (privateKey && !PRIVATE_KEY_PATTERN.test(privateKey)) {
    throw new ConfigError(
      "HYPERLIQUID_TESTNET_PRIVATE_KEY is set but is not a well-formed 0x-prefixed 32-byte private key.",
    );
  }

  const accountAddress = env.HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS || undefined;
  if (accountAddress && !ADDRESS_PATTERN.test(accountAddress)) {
    throw new ConfigError(
      "HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS is set but is not a well-formed 0x-prefixed 20-byte address.",
    );
  }

  const executionEnabled = parseBoolean(env.HYPERLIQUID_TESTNET_EXECUTION_ENABLED, false);

  const maxTestOrderValueUsd = parseInteger(
    env.HYPERLIQUID_TESTNET_MAX_ORDER_VALUE_USD,
    DEFAULT_MAX_TEST_ORDER_VALUE_USD,
    { min: 10 }, // below Hyperliquid's own $10 minimum order notional, a test order could never be placed at all
  );

  const testInstrument = env.HYPERLIQUID_TESTNET_INSTRUMENT || DEFAULT_TEST_INSTRUMENT;

  // Missing testnet credentials must fail clearly, but only when the testnet provider is actually
  // selected — requiring them unconditionally would make plain local-mode runs (the default)
  // demand Hyperliquid setup they don't need.
  if (brokerProvider === "hyperliquid-testnet" && (!privateKey || !accountAddress)) {
    throw new ConfigError(
      "BROKER_PROVIDER=hyperliquid-testnet requires both HYPERLIQUID_TESTNET_PRIVATE_KEY and " +
        "HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS to be set.",
    );
  }

  // Trading212's public API (per its current official auth docs) uses an API Key + API Secret
  // pair via HTTP Basic auth — neither has a fixed format Trading212 documents, so only presence
  // is validated here, same as Hyperliquid's key/address pairing below.
  const trading212ApiKey = env.TRADING212_API_KEY || undefined;
  const trading212ApiSecret = env.TRADING212_API_SECRET || undefined;
  const trading212ExecutionEnabled = parseBoolean(env.TRADING212_DEMO_EXECUTION_ENABLED, false);
  const trading212TestInstrument = env.TRADING212_DEMO_INSTRUMENT || DEFAULT_TRADING212_TEST_INSTRUMENT;

  // No parseInteger-equivalent for fractional values exists in @/lib/config/env, and a test order
  // quantity is legitimately fractional (e.g. "0.5" shares) — parsed inline, same fail-closed
  // convention as parseBoolean/parseInteger above.
  let trading212TestOrderQuantity = DEFAULT_TRADING212_TEST_ORDER_QUANTITY;
  if (env.TRADING212_DEMO_TEST_QUANTITY !== undefined && env.TRADING212_DEMO_TEST_QUANTITY !== "") {
    const parsed = Number(env.TRADING212_DEMO_TEST_QUANTITY);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ConfigError(
        `TRADING212_DEMO_TEST_QUANTITY must be a positive finite number, received "${env.TRADING212_DEMO_TEST_QUANTITY}".`,
      );
    }
    trading212TestOrderQuantity = parsed;
  }

  if (brokerProvider === "trading212-demo" && (!trading212ApiKey || !trading212ApiSecret)) {
    throw new ConfigError(
      "BROKER_PROVIDER=trading212-demo requires both TRADING212_API_KEY and TRADING212_API_SECRET to be set.",
    );
  }

  // ETORO_ENV, if set at all, must be exactly "demo" — regardless of which broker provider is
  // currently active (same defense-in-depth convention as the private-key/address format checks
  // above: a malformed/unexpected value fails closed immediately, not only when it would matter).
  // Never inferred from missing configuration: an unset ETORO_ENV is a distinct "not configured"
  // state, not silently treated as "demo".
  const etoroEnvRaw = env.ETORO_ENV || undefined;
  if (etoroEnvRaw !== undefined && !(SUPPORTED_ETORO_ENVS as readonly string[]).includes(etoroEnvRaw)) {
    throw new ConfigError(
      `ETORO_ENV must be exactly "demo" if set — there is no live/real value. Received "${etoroEnvRaw}".`,
    );
  }
  const etoroEnv = etoroEnvRaw as EtoroEnv | undefined;

  const etoroApiKey = env.ETORO_API_KEY || undefined;
  const etoroUserKey = env.ETORO_USER_KEY || undefined;
  const etoroTestInstrument = env.ETORO_DEMO_TEST_INSTRUMENT || DEFAULT_ETORO_TEST_INSTRUMENT;

  // No default: eToro's public API documents no confirmed minimum-order-size signal to derive one
  // from safely (unlike Trading212's testOrderQuantity), so this must always be explicit.
  let etoroTestAmount: number | undefined;
  if (env.ETORO_DEMO_TEST_AMOUNT !== undefined && env.ETORO_DEMO_TEST_AMOUNT !== "") {
    const parsed = Number(env.ETORO_DEMO_TEST_AMOUNT);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ConfigError(
        `ETORO_DEMO_TEST_AMOUNT must be a positive finite number, received "${env.ETORO_DEMO_TEST_AMOUNT}".`,
      );
    }
    etoroTestAmount = parsed;
  }

  if (brokerProvider === "etoro-demo") {
    if (etoroEnv !== "demo") {
      throw new ConfigError("BROKER_PROVIDER=etoro-demo requires ETORO_ENV=demo to be set explicitly.");
    }
    if (!etoroApiKey || !etoroUserKey) {
      throw new ConfigError("BROKER_PROVIDER=etoro-demo requires both ETORO_API_KEY and ETORO_USER_KEY to be set.");
    }
    if (etoroTestAmount === undefined) {
      throw new ConfigError(
        "BROKER_PROVIDER=etoro-demo requires ETORO_DEMO_TEST_AMOUNT to be set explicitly — eToro's API " +
          "documents no confirmed minimum-order-size signal to derive a safe default from.",
      );
    }
  }

  return {
    registryPath,
    executionMode,
    demoExecutionModeEnabled,
    paperStartingCash,
    strategyMaxOpenPositions,
    brokerProvider,
    marketDataProvider,
    hyperliquid: {
      privateKey,
      accountAddress,
      executionEnabled,
      maxTestOrderValueUsd,
      testInstrument,
    },
    trading212: {
      apiKey: trading212ApiKey,
      apiSecret: trading212ApiSecret,
      executionEnabled: trading212ExecutionEnabled,
      testInstrument: trading212TestInstrument,
      testOrderQuantity: trading212TestOrderQuantity,
    },
    etoro: {
      env: etoroEnv,
      apiKey: etoroApiKey,
      userKey: etoroUserKey,
      testInstrument: etoroTestInstrument,
      testAmount: etoroTestAmount,
    },
  };
}

let cached: HermesExecutionConfig | null = null;
let cachedError: ConfigError | null = null;

export function getHermesExecutionConfig(): HermesExecutionConfig {
  if (cachedError) throw cachedError;
  if (!cached) {
    try {
      cached = buildHermesExecutionConfig();
    } catch (error) {
      if (error instanceof ConfigError) cachedError = error;
      throw error;
    }
  }
  return cached;
}

/** Test-only escape hatch — the CLI and app both use the cached singleton above. */
export function resetHermesExecutionConfigCacheForTests(): void {
  cached = null;
  cachedError = null;
}
