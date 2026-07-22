import "server-only";
import * as path from "node:path";
import { parseBoolean, parseEnum, parseInteger, ConfigError } from "@/lib/config/env";
import {
  MIN_REQUIRED_CANDLES,
  SUPPORTED_MARKET_TIMEFRAMES,
  TIMEFRAME_DURATIONS_MS,
  type MarketTimeframe,
} from "./market-data/candle-validation";

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

// Phase 2A — Real Historical Candles for Live Market Data. Raw config only for the historical-
// candle side of the live pipeline (LiveMarketDataProvider/EtoroDemoBroker.getHistoricalCandles) —
// distinct from `marketDataProvider` above (which only selects mock vs. live). Named `marketData`,
// not `marketDataProvider2` or similar, since `config.marketData.timeframe` reads naturally
// alongside `config.marketDataProvider`. Meaningless (but still always parsed/validated — same
// defense-in-depth convention as ETORO_ENV/HERMES_MARKET_HOURS_* above) when marketDataProvider is
// "mock", which continues to use generateSyntheticCandles unconditionally.
export interface LiveMarketDataConfig {
  /** Which granularity LiveMarketDataProvider requests from its historical-candle source. See
   * candle-validation.ts's own SUPPORTED_MARKET_TIMEFRAMES doc comment for why this list matches
   * eToro's supported intervals specifically. Defaults to "1h". */
  timeframe: MarketTimeframe;
  /** How many candles to request per fetch. Enforced >= MIN_REQUIRED_CANDLES (candle-validation.ts)
   * here too — the same floor LiveMarketDataProvider's own validation enforces at fetch time — so
   * a misconfiguration fails at startup, not on the runtime's first live trading cycle. Defaults
   * to 200. */
  candleCount: number;
  /** Upper bound (seconds) on how old the latest historical candle may be before
   * LiveMarketDataProvider rejects the fetch as stale. No single fixed default is sensible across
   * every supported timeframe (a 1-minute feed going stale after 2 hours is a real problem; a
   * 1-week feed is not) — unset, this is derived from `timeframe` (2x its own duration, floored at
   * 300s); set explicitly, that value is used as-is regardless of timeframe. */
  maxCandleAgeSeconds: number;
}

// Milestone 7 — 24/7 Scheduler & Runtime Control. "always-open" (the default — correct for the
// BTC-via-eToro instrument this pipeline actually trades today) and "weekday-session" (a simple
// configurable single-session-per-day policy — see runtime/market-hours-policy.ts for exactly what
// it does and doesn't handle). No "exchange-calendar" or holiday-aware value exists — explicitly
// out of this milestone's scope.
export const SUPPORTED_MARKET_HOURS_POLICIES = ["always-open", "weekday-session"] as const;
export type MarketHoursPolicyType = (typeof SUPPORTED_MARKET_HOURS_POLICIES)[number];

// Milestone 8 — Deployment-Ready Runtime Configuration. Matches BrokerProvider/EtoroEnv's own
// "there is no live value structurally" pattern exactly — "live" is not a member of this type at
// all, not merely rejected at runtime. A live mode remains conceptually unsupported in this
// milestone: no broker in BROKER_CAPABILITIES (runtime-config/broker-capabilities.ts) declares
// support for it, and there is no code path — env value, default, or fallback — that could ever
// produce one. "testnet" and "demo" are named to match this codebase's own existing terminology
// (HYPERLIQUID_TESTNET_*, ETORO_ENV=demo, TRADING212_DEMO_*) rather than inventing new vocabulary.
export const SUPPORTED_RUNTIME_MODES = ["paper", "demo", "testnet"] as const;
export type RuntimeMode = (typeof SUPPORTED_RUNTIME_MODES)[number];

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
  /** Prototype V1 — Reliability Fix. Bounded timeout (ms) applied to every individual HTTP request
   * EtoroClient makes. Confirmed via live testing that an unbounded request can otherwise hang a
   * trading cycle — and, transitively, TradingRuntime.stop() — indefinitely (see
   * runtime/trading-runtime.ts's own shutdownTimeoutMs for the second, independent bound). Defaults
   * to 10000 (10s) — comfortably more than a single real eToro API round-trip normally takes, while
   * still bounded rather than infinite. */
  httpTimeoutMs: number;
}

// Milestone 7 — 24/7 Scheduler & Runtime Control. Raw config only — turning this into a live
// MarketHoursPolicy object is runtime/market-hours-policy-factory.ts's job, not config.ts's (same
// "config holds primitives, a *Factory builds the live object" split as BrokerProvider/
// MarketDataProviderType above).
export interface TradingSchedulerConfig {
  /** Defaults to false — the continuous runtime never starts on its own; opting in requires
   * explicit configuration, matching this pipeline's existing "nothing runs unless explicitly
   * enabled" convention (DEMO_EXECUTION_MODE, HYPERLIQUID_TESTNET_EXECUTION_ENABLED, ...). */
  enabled: boolean;
  /** Milliseconds between the start of one scheduled cycle attempt and the next. Enforced >=
   * MIN_SCHEDULER_INTERVAL_MS at config-build time — "a sensible minimum interval to avoid
   * accidental tight loops." */
  intervalMs: number;
  /** Defaults to true — the continuous runtime evaluates once immediately on start() rather than
   * waiting a full intervalMs for its first cycle. */
  immediateFirstRun: boolean;
  marketHoursPolicy: MarketHoursPolicyType;
  /** Only meaningful when marketHoursPolicy is "weekday-session" — still always parsed/validated
   * (same defense-in-depth convention as ETORO_ENV's format check above, checked regardless of
   * whether the value would currently matter). */
  sessionTimezone: string;
  /** 24-hour "HH:MM", local to sessionTimezone. */
  sessionStart: string;
  sessionEnd: string;
  /** Prototype V1 — Reliability Fix. Upper bound (ms) TradingRuntime.stop() will ever wait for an
   * in-flight cycle before proceeding to STOPPED anyway — confirmed via live testing (a real eToro
   * connection, overlapping ticks) that graceful shutdown could otherwise hang indefinitely.
   * Defaults to 30000 (30s) — comfortably longer than EtoroDemoBroker's own internal
   * reconciliation/close-verification polling window (25s), so a legitimate in-flight eToro
   * open/close is never abandoned prematurely under normal conditions. */
  shutdownTimeoutMs: number;
}

// Milestone 8 — Deployment-Ready Runtime Configuration. The remaining previously hard-coded
// runtime trading inputs (Mission 7's market-runtime.ts had `const INSTRUMENT = "BTC"` and
// `const AMOUNT = 10` directly in source) — now validated configuration instead. Order *side* is
// deliberately NOT a field here: it is never independently configured. MarketDecisionEngine's own
// decision output entirely determines it (BUY opens a long position, SELL closes it) — there is no
// short-entry support anywhere in this pipeline to configure a side for (see
// MarketDecisionAction/SignalAction's own "ENTER_SHORT reserved, never produced" precedent). Adding
// a settable "order side" env var would configure something that doesn't exist yet; this is the
// "strategy-controlled side convention" half of the mission's own "order side or strategy-
// controlled side convention" phrasing.
export interface RuntimeTradingConfig {
  /** Normalized (trimmed, uppercased) — see buildHermesExecutionConfig's own validation. */
  symbol: string;
  quantity: number;
  /** Optional safety ceiling. Undefined means "no ceiling configured" — a distinct state from a
   * ceiling of 0 (which would be rejected as invalid), matching this file's established
   * "undefined means not configured" convention throughout. */
  maxQuantity: number | undefined;
  /** Undefined means "not configured" — the runtime falls back to today's existing behaviour
   * (first HERMES_APPROVED strategy, else the DEMO_ONLY strategy) exactly as before this
   * milestone. Set explicitly, an unknown or disabled strategy ID fails startup validation (see
   * runtime-config/strategy-selection.ts) rather than silently falling back. */
  strategyId: string | undefined;
  mode: RuntimeMode;
}

// Prototype V1 — minimum direct Telegram integration (no MCP server, no conversational AI — see
// telegram/telegram-bot.ts). Fails closed exactly like every other optional-but-paired feature in
// this file (Hyperliquid/Trading212/eToro credentials): enabled without both the token and the
// allowed chat id is a config-build-time error, never a silently-disabled bot.
export interface TelegramConfig {
  enabled: boolean;
  /** Never logged, printed, or included in any redacted summary — see
   * runtime-config/startup-summary.ts, which reports only `telegramConfigured: boolean`. */
  botToken: string | undefined;
  /** The one chat/user id the bot will ever respond to or accept commands from — every other
   * sender's message is silently ignored (see telegram/telegram-bot.ts's own authorization check).
   * Stored as a string (not parsed as a number) since Telegram chat ids for group chats are
   * negative and exact string comparison is simpler and just as correct as numeric comparison. */
  allowedChatId: string | undefined;
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
  /** Phase 2A — timeframe/candleCount/maxCandleAgeSeconds for the live historical-candle path
   * only; MockMarketDataProvider ignores this entirely (see LiveMarketDataConfig's own doc
   * comment). */
  marketData: LiveMarketDataConfig;
  scheduler: TradingSchedulerConfig;
  runtimeTrading: RuntimeTradingConfig;
  telegram: TelegramConfig;
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
  HERMES_MARKET_TIMEFRAME: string | undefined;
  HERMES_MARKET_CANDLE_COUNT: string | undefined;
  HERMES_MARKET_MAX_CANDLE_AGE_SECONDS: string | undefined;
  HERMES_SCHEDULER_ENABLED: string | undefined;
  HERMES_SCHEDULER_INTERVAL_MS: string | undefined;
  HERMES_SCHEDULER_IMMEDIATE_FIRST_RUN: string | undefined;
  HERMES_MARKET_HOURS_POLICY: string | undefined;
  HERMES_MARKET_HOURS_TIMEZONE: string | undefined;
  HERMES_MARKET_HOURS_SESSION_START: string | undefined;
  HERMES_MARKET_HOURS_SESSION_END: string | undefined;
  HERMES_TRADING_SYMBOL: string | undefined;
  HERMES_TRADE_QUANTITY: string | undefined;
  HERMES_MAX_TRADE_QUANTITY: string | undefined;
  HERMES_STRATEGY_ID: string | undefined;
  HERMES_RUNTIME_MODE: string | undefined;
  HERMES_RUNTIME_SHUTDOWN_TIMEOUT_MS: string | undefined;
  HERMES_TELEGRAM_ENABLED: string | undefined;
  HERMES_TELEGRAM_BOT_TOKEN: string | undefined;
  HERMES_TELEGRAM_ALLOWED_CHAT_ID: string | undefined;
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
  ETORO_HTTP_TIMEOUT_MS: string | undefined;
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

// Milestone 7 — 24/7 Scheduler & Runtime Control.
const DEFAULT_SCHEDULER_INTERVAL_MS = 60_000; // 1 minute
// A hard floor, not itself configurable — "set a sensible minimum interval to avoid accidental
// tight loops" (e.g. a stray "60" meant as seconds, misread as milliseconds, would otherwise arm a
// 60ms loop hammering the market data provider and broker).
const MIN_SCHEDULER_INTERVAL_MS = 5_000;
const DEFAULT_SESSION_TIMEZONE = "America/New_York";
// A standard US equities regular session — a reasonable default for "a simple policy suitable for
// equities," not a claim about any specific listed instrument this pipeline currently trades (which
// is BTC, an always-open market — see SUPPORTED_MARKET_HOURS_POLICIES's own comment).
const DEFAULT_SESSION_START = "09:30";
const DEFAULT_SESSION_END = "16:00";
const HHMM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Milestone 8 — Deployment-Ready Runtime Configuration. Same BTC/10-unit defaults Mission 7's
// market-runtime.ts previously hard-coded — preserved exactly, now as configuration.
const DEFAULT_TRADING_SYMBOL = "BTC";
const DEFAULT_TRADE_QUANTITY = 10;
// Existing convention this file's other instrument identifiers already follow implicitly
// (market-session.ts's own CRYPTO_SYMBOLS.has(instrument.toUpperCase())) — uppercase tickers, no
// embedded whitespace. Permissive rather than a strict per-exchange ticker grammar: "avoid
// implementing a universal symbol-normalization system unless required by existing adapters," and
// none of the four existing adapters require more than this.
const SYMBOL_PATTERN = /^[A-Z0-9._-]+$/;

// Prototype V1 — Reliability Fix.
const DEFAULT_ETORO_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const MIN_HTTP_TIMEOUT_MS = 1_000; // a floor, not a recommendation — see the field's own doc comment

// Phase 2A — Real Historical Candles for Live Market Data.
const DEFAULT_MARKET_TIMEFRAME: MarketTimeframe = "1h";
const DEFAULT_MARKET_CANDLE_COUNT = 200;
// A floor, not a recommendation — see LiveMarketDataConfig.maxCandleAgeSeconds's own doc comment
// for why no single default duration is derived from this alone; it only bounds how aggressive an
// explicit HERMES_MARKET_MAX_CANDLE_AGE_SECONDS may be, on both the derived-default and the
// explicit-override paths.
const MIN_MAX_CANDLE_AGE_SECONDS = 300;

export function buildHermesExecutionConfig(
  env: RawHermesExecutionEnv = {
    HERMES_STRATEGY_REGISTRY_PATH: process.env.HERMES_STRATEGY_REGISTRY_PATH,
    EXECUTION_MODE: process.env.EXECUTION_MODE,
    DEMO_EXECUTION_MODE: process.env.DEMO_EXECUTION_MODE,
    HERMES_PAPER_STARTING_CASH: process.env.HERMES_PAPER_STARTING_CASH,
    HERMES_MAX_OPEN_POSITIONS: process.env.HERMES_MAX_OPEN_POSITIONS,
    BROKER_PROVIDER: process.env.BROKER_PROVIDER,
    HERMES_MARKET_DATA_PROVIDER: process.env.HERMES_MARKET_DATA_PROVIDER,
    HERMES_MARKET_TIMEFRAME: process.env.HERMES_MARKET_TIMEFRAME,
    HERMES_MARKET_CANDLE_COUNT: process.env.HERMES_MARKET_CANDLE_COUNT,
    HERMES_MARKET_MAX_CANDLE_AGE_SECONDS: process.env.HERMES_MARKET_MAX_CANDLE_AGE_SECONDS,
    HERMES_SCHEDULER_ENABLED: process.env.HERMES_SCHEDULER_ENABLED,
    HERMES_SCHEDULER_INTERVAL_MS: process.env.HERMES_SCHEDULER_INTERVAL_MS,
    HERMES_SCHEDULER_IMMEDIATE_FIRST_RUN: process.env.HERMES_SCHEDULER_IMMEDIATE_FIRST_RUN,
    HERMES_MARKET_HOURS_POLICY: process.env.HERMES_MARKET_HOURS_POLICY,
    HERMES_MARKET_HOURS_TIMEZONE: process.env.HERMES_MARKET_HOURS_TIMEZONE,
    HERMES_MARKET_HOURS_SESSION_START: process.env.HERMES_MARKET_HOURS_SESSION_START,
    HERMES_MARKET_HOURS_SESSION_END: process.env.HERMES_MARKET_HOURS_SESSION_END,
    HERMES_TRADING_SYMBOL: process.env.HERMES_TRADING_SYMBOL,
    HERMES_TRADE_QUANTITY: process.env.HERMES_TRADE_QUANTITY,
    HERMES_MAX_TRADE_QUANTITY: process.env.HERMES_MAX_TRADE_QUANTITY,
    HERMES_STRATEGY_ID: process.env.HERMES_STRATEGY_ID,
    HERMES_RUNTIME_MODE: process.env.HERMES_RUNTIME_MODE,
    HERMES_RUNTIME_SHUTDOWN_TIMEOUT_MS: process.env.HERMES_RUNTIME_SHUTDOWN_TIMEOUT_MS,
    HERMES_TELEGRAM_ENABLED: process.env.HERMES_TELEGRAM_ENABLED,
    HERMES_TELEGRAM_BOT_TOKEN: process.env.HERMES_TELEGRAM_BOT_TOKEN,
    HERMES_TELEGRAM_ALLOWED_CHAT_ID: process.env.HERMES_TELEGRAM_ALLOWED_CHAT_ID,
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
    ETORO_HTTP_TIMEOUT_MS: process.env.ETORO_HTTP_TIMEOUT_MS,
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

  // Phase 2A — Real Historical Candles for Live Market Data. Always parsed/validated regardless of
  // whether marketDataProvider is currently "live" — same defense-in-depth convention as every
  // other format check in this file (ETORO_ENV, HERMES_MARKET_HOURS_*, ...).
  const marketTimeframe = parseEnum(env.HERMES_MARKET_TIMEFRAME, SUPPORTED_MARKET_TIMEFRAMES, DEFAULT_MARKET_TIMEFRAME);

  const marketCandleCount = parseInteger(env.HERMES_MARKET_CANDLE_COUNT, DEFAULT_MARKET_CANDLE_COUNT, {
    min: MIN_REQUIRED_CANDLES,
  });

  // No single fixed default is sensible across every supported timeframe — see this field's own
  // doc comment on LiveMarketDataConfig. Unset, derive 2x the selected timeframe's own duration,
  // floored at MIN_MAX_CANDLE_AGE_SECONDS; set explicitly, that value is used as-is (still floored
  // — an explicit 10s staleness bound on hourly candles would reject every fetch outright).
  const derivedMaxCandleAgeSeconds = Math.max(
    MIN_MAX_CANDLE_AGE_SECONDS,
    Math.round((TIMEFRAME_DURATIONS_MS[marketTimeframe] * 2) / 1000),
  );
  const marketMaxCandleAgeSeconds = parseInteger(
    env.HERMES_MARKET_MAX_CANDLE_AGE_SECONDS,
    derivedMaxCandleAgeSeconds,
    { min: MIN_MAX_CANDLE_AGE_SECONDS },
  );

  // Milestone 7 — 24/7 Scheduler & Runtime Control.
  const schedulerEnabled = parseBoolean(env.HERMES_SCHEDULER_ENABLED, false);
  const schedulerIntervalMs = parseInteger(
    env.HERMES_SCHEDULER_INTERVAL_MS,
    DEFAULT_SCHEDULER_INTERVAL_MS,
    { min: MIN_SCHEDULER_INTERVAL_MS },
  );
  const schedulerImmediateFirstRun = parseBoolean(env.HERMES_SCHEDULER_IMMEDIATE_FIRST_RUN, true);
  const marketHoursPolicy = parseEnum(env.HERMES_MARKET_HOURS_POLICY, SUPPORTED_MARKET_HOURS_POLICIES, "always-open");

  const sessionTimezone = env.HERMES_MARKET_HOURS_TIMEZONE || DEFAULT_SESSION_TIMEZONE;
  // Fails fast on a malformed IANA name at config-build time, regardless of whether
  // marketHoursPolicy is currently "weekday-session" — same defense-in-depth convention as
  // ETORO_ENV's format check, which validates whenever a value is present, not only when active.
  try {
    const _validateTimezone = new Intl.DateTimeFormat("en-US", { timeZone: sessionTimezone });
    void _validateTimezone;
  } catch {
    throw new ConfigError(`HERMES_MARKET_HOURS_TIMEZONE is not a valid IANA timezone name: "${sessionTimezone}".`);
  }

  const sessionStart = env.HERMES_MARKET_HOURS_SESSION_START || DEFAULT_SESSION_START;
  const sessionEnd = env.HERMES_MARKET_HOURS_SESSION_END || DEFAULT_SESSION_END;
  if (!HHMM_PATTERN.test(sessionStart)) {
    throw new ConfigError(`HERMES_MARKET_HOURS_SESSION_START must be a 24-hour "HH:MM" time, received "${sessionStart}".`);
  }
  if (!HHMM_PATTERN.test(sessionEnd)) {
    throw new ConfigError(`HERMES_MARKET_HOURS_SESSION_END must be a 24-hour "HH:MM" time, received "${sessionEnd}".`);
  }
  if (sessionStart >= sessionEnd) {
    // "HH:MM" 24-hour strings compare correctly lexicographically — no overnight-spanning session
    // is supported (matches WeekdaySessionMarketHoursPolicy's own constructor check).
    throw new ConfigError(
      `HERMES_MARKET_HOURS_SESSION_START ("${sessionStart}") must be strictly before HERMES_MARKET_HOURS_SESSION_END ("${sessionEnd}").`,
    );
  }

  // Milestone 8 — Deployment-Ready Runtime Configuration.
  const runtimeMode = parseEnum(env.HERMES_RUNTIME_MODE, SUPPORTED_RUNTIME_MODES, "paper");

  // Prototype V1 — Reliability Fix.
  const shutdownTimeoutMs = parseInteger(
    env.HERMES_RUNTIME_SHUTDOWN_TIMEOUT_MS,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    { min: MIN_HTTP_TIMEOUT_MS },
  );

  const tradingSymbolRaw = (env.HERMES_TRADING_SYMBOL || DEFAULT_TRADING_SYMBOL).trim();
  if (tradingSymbolRaw.length === 0) {
    throw new ConfigError("HERMES_TRADING_SYMBOL must not be empty (or whitespace-only) if set.");
  }
  const tradingSymbol = tradingSymbolRaw.toUpperCase();
  if (!SYMBOL_PATTERN.test(tradingSymbol)) {
    throw new ConfigError(
      `HERMES_TRADING_SYMBOL "${env.HERMES_TRADING_SYMBOL}" contains unsupported characters — expected letters, digits, ".", "_", or "-" only.`,
    );
  }

  // No parseInteger-equivalent for fractional values, same reasoning as trading212TestOrderQuantity
  // below — a trade quantity is legitimately fractional for some brokers (e.g. CFD notional amounts).
  let tradeQuantity = DEFAULT_TRADE_QUANTITY;
  if (env.HERMES_TRADE_QUANTITY !== undefined && env.HERMES_TRADE_QUANTITY !== "") {
    const parsed = Number(env.HERMES_TRADE_QUANTITY);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ConfigError(`HERMES_TRADE_QUANTITY must be a positive finite number, received "${env.HERMES_TRADE_QUANTITY}".`);
    }
    tradeQuantity = parsed;
  }

  let maxTradeQuantity: number | undefined;
  if (env.HERMES_MAX_TRADE_QUANTITY !== undefined && env.HERMES_MAX_TRADE_QUANTITY !== "") {
    const parsed = Number(env.HERMES_MAX_TRADE_QUANTITY);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ConfigError(
        `HERMES_MAX_TRADE_QUANTITY must be a positive finite number, received "${env.HERMES_MAX_TRADE_QUANTITY}".`,
      );
    }
    maxTradeQuantity = parsed;
  }
  if (maxTradeQuantity !== undefined && tradeQuantity > maxTradeQuantity) {
    throw new ConfigError(
      `HERMES_TRADE_QUANTITY (${tradeQuantity}) exceeds HERMES_MAX_TRADE_QUANTITY (${maxTradeQuantity}).`,
    );
  }

  // Presence/format only — whether this ID actually names a known, enabled strategy can only be
  // checked once the registry has been read (see runtime-config/strategy-selection.ts); no single
  // required format applies (a Hermes-approved id looks like "STRAT-0001", the demo strategy's id
  // is "DEMO-0001" — this file does not police that shape).
  const strategyId = env.HERMES_STRATEGY_ID?.trim() || undefined;

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

  // Prototype V1 — Reliability Fix. Always parsed/validated regardless of whether etoro-demo is
  // the currently selected broker — same defense-in-depth convention as every other format check
  // in this file.
  const etoroHttpTimeoutMs = parseInteger(
    env.ETORO_HTTP_TIMEOUT_MS,
    DEFAULT_ETORO_HTTP_TIMEOUT_MS,
    { min: MIN_HTTP_TIMEOUT_MS },
  );

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

  // Prototype V1 — minimum direct Telegram integration. Fails closed exactly like
  // BROKER_PROVIDER=etoro-demo/trading212-demo/hyperliquid-testnet above: enabled without both
  // required values is a config-build-time error, never a silently no-op bot.
  const telegramEnabled = parseBoolean(env.HERMES_TELEGRAM_ENABLED, false);
  const telegramBotToken = env.HERMES_TELEGRAM_BOT_TOKEN || undefined;
  const telegramAllowedChatId = env.HERMES_TELEGRAM_ALLOWED_CHAT_ID || undefined;
  if (telegramEnabled) {
    if (!telegramBotToken) {
      throw new ConfigError("HERMES_TELEGRAM_ENABLED=true requires HERMES_TELEGRAM_BOT_TOKEN to be set.");
    }
    if (!telegramAllowedChatId) {
      throw new ConfigError("HERMES_TELEGRAM_ENABLED=true requires HERMES_TELEGRAM_ALLOWED_CHAT_ID to be set.");
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
    marketData: {
      timeframe: marketTimeframe,
      candleCount: marketCandleCount,
      maxCandleAgeSeconds: marketMaxCandleAgeSeconds,
    },
    scheduler: {
      enabled: schedulerEnabled,
      intervalMs: schedulerIntervalMs,
      immediateFirstRun: schedulerImmediateFirstRun,
      marketHoursPolicy,
      sessionTimezone,
      sessionStart,
      sessionEnd,
      shutdownTimeoutMs,
    },
    runtimeTrading: {
      symbol: tradingSymbol,
      quantity: tradeQuantity,
      maxQuantity: maxTradeQuantity,
      strategyId,
      mode: runtimeMode,
    },
    telegram: {
      enabled: telegramEnabled,
      botToken: telegramBotToken,
      allowedChatId: telegramAllowedChatId,
    },
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
      httpTimeoutMs: etoroHttpTimeoutMs,
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
