import "server-only";
import * as path from "node:path";
import { parseBoolean, parseEnum, parseInteger, ConfigError } from "@/lib/config/env";
import { HERMES_AGENT_STRATEGY_ID } from "./hermes-agent/hermes-agent-strategy";
import {
  MIN_REQUIRED_CANDLES,
  SUPPORTED_MARKET_TIMEFRAMES,
  TIMEFRAME_DURATIONS_MS,
  type MarketTimeframe,
} from "./market-data/candle-validation";
import {
  DEFAULT_EQUITY_SESSION_TIMEZONE,
  DEFAULT_EQUITY_SESSION_START,
  DEFAULT_EQUITY_SESSION_END,
} from "./market-session-defaults";

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

// Restart-Resilient Autonomy Phase. "AUTO_LIVE" exists as a type member (matching the shape the
// mission itself specifies) but is deliberately rejected unconditionally at config-build time below
// — see the ConfigError thrown right after this is parsed. There is no environment, flag, or
// combination of settings anywhere in this codebase that can make AUTO_LIVE actually take effect;
// it remains a reserved, structurally-present-but-functionally-disabled value until live trading is
// separately implemented and reviewed.
export const SUPPORTED_APPROVAL_MODES = ["MANUAL", "AUTO_DEMO", "AUTO_LIVE"] as const;
export type ExecutionApprovalMode = (typeof SUPPORTED_APPROVAL_MODES)[number];

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
  /** Prototype 1.0 — official Hermes Agent decision integration. Always a real, named strategy id
   * — never undefined. Defaults to HERMES_AGENT_STRATEGY_ID ("HERMES-AGENT") when
   * HERMES_STRATEGY_ID is unset, making the official Hermes Agent the explicit, typed decision
   * authority by construction rather than by "first HERMES_APPROVED strategy wins" ordering.
   * DEMO-0001 remains selectable only via an explicit HERMES_STRATEGY_ID=DEMO-0001 override (with
   * DEMO_EXECUTION_MODE=true). Any value — the default or an explicit override — that does not
   * name a currently-loaded, enabled strategy fails startup validation closed (see
   * runtime-config/strategy-selection.ts), never silently falling back to a different one. */
  strategyId: string;
  mode: RuntimeMode;
}

// Prototype V1 — minimum direct Telegram integration (no MCP server, no conversational AI — see
// telegram/telegram-bot.ts). Fails closed exactly like every other optional-but-paired feature in
// this file (Hyperliquid/Trading212/eToro credentials): enabled without both the token and the
// allowed chat id is a config-build-time error, never a silently-disabled bot.
//
// Telegram alert-activation design fix. This config covers ONLY the interactive, two-way Telegram
// command bot (/status /positions /trades ...), which genuinely needs its own direct Telegram Bot
// API credentials (long-polling as a specific bot identity, replying only to one allowed chat).
// Outbound alert notifications (trade opened/closed, exits, ...) are a completely separate concern
// routed through the already-configured Hermes Agent gateway (`hermes send`) — see
// HermesAgentConfig.telegramGatewayAlertsEnabled below — and must never require these credentials.
export interface TelegramConfig {
  enabled: boolean;
  /** Never logged, printed, or included in any redacted summary — see
   * runtime-config/startup-summary.ts, which reports only `directTelegramConfigured: boolean`. */
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
  /** Restart-Resilient Autonomy Phase. See ExecutionApprovalMode's own doc comment; defaults to
   * "MANUAL" (today's existing, unchanged workflow). */
  approvalMode: ExecutionApprovalMode;
  /** Only consulted when approvalMode is "AUTO_DEMO" — the minimum MarketDecision.confidence a
   * fresh BUY/SELL decision must have before it is auto-approved (never auto-executed directly;
   * still goes through the exact same TradeCandidate persistence + execution path a human approval
   * would). Defaults to 0.75. */
  autoDemoMinConfidence: number;
  /** Emergency manual kill switch (Phase 3 exit trigger) — when true, every reconciled open position
   * is closed on the next cycle regardless of any other exit condition, and no new entry candidate
   * is ever created while it remains true. Defaults to false. Deliberately env-driven (not a runtime
   * API/toggle) so it can never be flipped by anything other than an operator editing configuration. */
  killSwitchEnabled: boolean;
  /** Optional maximum holding duration (ms) exit trigger — undefined means "no ceiling configured"
   * (today's existing behaviour: a position is held indefinitely absent another exit trigger). */
  maxHoldingDurationMs: number | undefined;
  /** Restart-Resilient Autonomy Phase — crash-window recovery (deployment safety review). How long
   * (ms) a lifecycle record may sit at DECISION_CREATED/APPROVED/EXECUTION_SUBMITTED/
   * EXECUTION_RECONCILIATION_REQUIRED, measured from its own updatedAt, before the recovery sweep
   * (runtime/lifecycle-recovery.ts) acts on it. Defaults to 5 minutes — comfortably longer than any
   * single cycle's own broker round-trips (HTTP timeouts default to 10s; the scheduler interval
   * defaults to 60s), so a record genuinely still mid-execution is never mistaken for abandoned,
   * while still recovering promptly after a real crash. */
  recoveryThresholdMs: number;
  /** Hardening pass — opposing-signal exit stability. Minimum time (ms) a position must have been
   * held before an OPPOSING_SIGNAL exit is even considered — stop-loss, take-profit, kill-switch,
   * strategy-disabled, and max-holding exits are NEVER delayed by this (see
   * runtime/opposing-signal-stability.ts). Defaults to 5 minutes. 0 disables the minimum-hold gate
   * (every other gate — consecutive confirmation — still applies). */
  opposingExitMinHoldMs: number;
  /** Hardening pass — opposing-signal exit stability. How many CONSECUTIVE cycles Hermes must
   * keep confirming an opposing signal before the exit is allowed to fire, once the minimum hold
   * period has also elapsed — a single reversal-then-back-to-HOLD scan never closes a position.
   * Defaults to 2. Must be >= 1 (1 behaves like the pre-hardening immediate-exit behaviour, once
   * the minimum hold period has separately elapsed). */
  opposingExitRequiredConfirmations: number;
  /** Prototype 1.0 — official Hermes Agent decision integration. Configuration for the Hermes CLI
   * adapter and the multi-instrument universe scan — see hermes-agent/hermes-agent-adapter.ts and
   * runtime/universe-scanner.ts. Never contains a credential; the CLI itself reads its own
   * provider/API-key configuration from `~/.hermes/`, entirely outside this app's config. */
  hermesAgent: HermesAgentConfig;
}

/** Prototype 1.0 — official Hermes Agent decision integration. */
export interface HermesAgentConfig {
  /** Absolute path to the installed Hermes Agent CLI binary. Defaults to the confirmed VPS
   * installation path; never a bare command name (this app never relies on PATH resolution for a
   * subprocess it spawns). */
  cliPath: string;
  /** Bounded wall-clock time (ms) the adapter waits for one `hermes -z` one-shot call before
   * treating it as a timeout (a fail-closed HOLD result, never a hang). A real LLM round-trip is
   * seconds, not milliseconds — the default gives real headroom over that without risking an
   * indefinitely stuck scheduler cycle. */
  decisionTimeoutMs: number;
  /** Maximum bytes of stdout the adapter will buffer from one `hermes -z` call before aborting it
   * as oversized — a defensive bound against a runaway or misbehaving process, never a limit
   * expected to bind in normal operation (a JSON proposal list is a few hundred bytes). */
  maxStdoutBytes: number;
  /** The configured multi-instrument market universe — uppercase, deduplicated, in configured
   * order. Defaults to the Prototype 1.0 universe (BTC, ETH, SOL, AAPL, MSFT, NVDA). */
  instrumentUniverse: string[];
  /** Maximum number of ranked proposals the universe scanner will select and turn into trade
   * candidates per scan, regardless of how many eligible BUY/SELL proposals Hermes returns. */
  maxProposalsPerScan: number;
  /** The confirmed Hermes gateway messaging target this app's outbound notifications are sent to
   * via `hermes send --to "<target>"` — never a bot token or chat id this app manages itself; the
   * gateway's own already-configured credentials are what actually deliver the message. */
  telegramTarget: string;
  /** Bounded wall-clock time (ms) the Telegram bridge waits for one `hermes send` call before
   * treating it as failed — a notification is best-effort and must never block or delay a trading
   * cycle (see hermes-gateway-alert-sender.ts). */
  telegramSendTimeoutMs: number;
  /** Telegram alert-activation design fix. Independently gates ONLY the outbound alert path
   * (TelegramAlertingAuditTrail + HermesGatewayAlertSender, wired in market-runtime.ts) — deliberately
   * NEVER coupled to TelegramConfig.enabled/botToken/allowedChatId: this path never talks to the
   * direct Telegram Bot API at all, only spawns `hermes send`, which reuses the Hermes gateway's own
   * already-configured credentials. Defaults to false — outbound gateway alerts are opt-in, exactly
   * like every other optional integration in this file. */
  telegramGatewayAlertsEnabled: boolean;
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
  HERMES_APPROVAL_MODE: string | undefined;
  HERMES_AUTO_DEMO_MIN_CONFIDENCE: string | undefined;
  HERMES_KILL_SWITCH_ENABLED: string | undefined;
  HERMES_MAX_HOLDING_DURATION_MS: string | undefined;
  HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS: string | undefined;
  HERMES_AGENT_CLI_PATH: string | undefined;
  HERMES_AGENT_DECISION_TIMEOUT_MS: string | undefined;
  HERMES_AGENT_MAX_STDOUT_BYTES: string | undefined;
  HERMES_INSTRUMENT_UNIVERSE: string | undefined;
  HERMES_MAX_PROPOSALS_PER_SCAN: string | undefined;
  HERMES_TELEGRAM_GATEWAY_TARGET: string | undefined;
  HERMES_TELEGRAM_GATEWAY_SEND_TIMEOUT_MS: string | undefined;
  HERMES_TELEGRAM_GATEWAY_ALERTS_ENABLED: string | undefined;
  HERMES_OPPOSING_EXIT_MIN_HOLD_MS: string | undefined;
  HERMES_OPPOSING_EXIT_CONFIRMATIONS: string | undefined;
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
// A standard US equities regular session — a reasonable default for "a simple policy suitable for
// equities," not a claim about any specific listed instrument this pipeline currently trades (which
// is BTC, an always-open market — see SUPPORTED_MARKET_HOURS_POLICIES's own comment). Remediation
// pass (finding M5): sourced from the shared ../market-session-defaults.ts module, the same defaults
// candle-validation.ts's own DEFAULT_EQUITY_MARKET_HOURS_POLICY falls back to.
const DEFAULT_SESSION_TIMEZONE = DEFAULT_EQUITY_SESSION_TIMEZONE;
const DEFAULT_SESSION_START = DEFAULT_EQUITY_SESSION_START;
const DEFAULT_SESSION_END = DEFAULT_EQUITY_SESSION_END;
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
const DEFAULT_LIFECYCLE_RECOVERY_THRESHOLD_MS = 5 * 60_000;
const MIN_HTTP_TIMEOUT_MS = 1_000; // a floor, not a recommendation — see the field's own doc comment

// Prototype 1.0 — official Hermes Agent decision integration. Confirmed live on the VPS: the
// installed CLI path, and the gateway's own confirmed messaging target.
const DEFAULT_HERMES_AGENT_CLI_PATH = "/home/andy/.local/bin/hermes";
// A real one-shot LLM call through Nous Portal is seconds, not milliseconds; 60s gives genuine
// headroom over that without letting a stuck/hung subprocess block a scheduler cycle indefinitely.
const DEFAULT_HERMES_AGENT_DECISION_TIMEOUT_MS = 60_000;
const MIN_HERMES_AGENT_DECISION_TIMEOUT_MS = 1_000;
// A ranked-proposal JSON response (six instruments, bounded reasoning arrays) is a few hundred
// bytes to a few KB — 64KB is generous headroom while still bounding a runaway/misbehaving process.
const DEFAULT_HERMES_AGENT_MAX_STDOUT_BYTES = 65_536;
const MIN_HERMES_AGENT_MAX_STDOUT_BYTES = 1_024;
const DEFAULT_INSTRUMENT_UNIVERSE = ["BTC", "ETH", "SOL", "AAPL", "MSFT", "NVDA"];
const DEFAULT_MAX_PROPOSALS_PER_SCAN = 2;
const MIN_MAX_PROPOSALS_PER_SCAN = 1;
// Confirmed live: the Hermes gateway's own configured messaging target for this operator.
const DEFAULT_HERMES_TELEGRAM_GATEWAY_TARGET = "telegram:Andrew Walker";
const DEFAULT_HERMES_TELEGRAM_GATEWAY_SEND_TIMEOUT_MS = 15_000;
const MIN_HERMES_TELEGRAM_GATEWAY_SEND_TIMEOUT_MS = 1_000;

// Hardening pass — opposing-signal exit stability.
const DEFAULT_OPPOSING_EXIT_MIN_HOLD_MS = 5 * 60_000;
const DEFAULT_OPPOSING_EXIT_REQUIRED_CONFIRMATIONS = 2;
// Remediation pass (senior review finding M2) — safe floors: no configuration path may restore the
// pre-hardening immediate-opposing-exit behaviour (see this block's own call site below).
const MIN_OPPOSING_EXIT_MIN_HOLD_MS = 60_000;
const MIN_OPPOSING_EXIT_REQUIRED_CONFIRMATIONS = 2;

// Restart-Resilient Autonomy Phase.
const DEFAULT_AUTO_DEMO_MIN_CONFIDENCE = 0.75;

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
    HERMES_APPROVAL_MODE: process.env.HERMES_APPROVAL_MODE,
    HERMES_AUTO_DEMO_MIN_CONFIDENCE: process.env.HERMES_AUTO_DEMO_MIN_CONFIDENCE,
    HERMES_KILL_SWITCH_ENABLED: process.env.HERMES_KILL_SWITCH_ENABLED,
    HERMES_MAX_HOLDING_DURATION_MS: process.env.HERMES_MAX_HOLDING_DURATION_MS,
    HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS: process.env.HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS,
    HERMES_AGENT_CLI_PATH: process.env.HERMES_AGENT_CLI_PATH,
    HERMES_AGENT_DECISION_TIMEOUT_MS: process.env.HERMES_AGENT_DECISION_TIMEOUT_MS,
    HERMES_AGENT_MAX_STDOUT_BYTES: process.env.HERMES_AGENT_MAX_STDOUT_BYTES,
    HERMES_INSTRUMENT_UNIVERSE: process.env.HERMES_INSTRUMENT_UNIVERSE,
    HERMES_MAX_PROPOSALS_PER_SCAN: process.env.HERMES_MAX_PROPOSALS_PER_SCAN,
    HERMES_TELEGRAM_GATEWAY_TARGET: process.env.HERMES_TELEGRAM_GATEWAY_TARGET,
    HERMES_TELEGRAM_GATEWAY_SEND_TIMEOUT_MS: process.env.HERMES_TELEGRAM_GATEWAY_SEND_TIMEOUT_MS,
    HERMES_TELEGRAM_GATEWAY_ALERTS_ENABLED: process.env.HERMES_TELEGRAM_GATEWAY_ALERTS_ENABLED,
    HERMES_OPPOSING_EXIT_MIN_HOLD_MS: process.env.HERMES_OPPOSING_EXIT_MIN_HOLD_MS,
    HERMES_OPPOSING_EXIT_CONFIRMATIONS: process.env.HERMES_OPPOSING_EXIT_CONFIRMATIONS,
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

  // Prototype 1.0 — official Hermes Agent decision integration. Explicit strategy selection: this
  // now ALWAYS resolves to a real, named strategyId — never undefined — so
  // runtime-config/strategy-selection.ts's exact-match branch is the only path Prototype 1.0's own
  // runtime ever takes; its "prefer the first loaded HERMES_APPROVED strategy" fallback (for an
  // undefined strategyId) is unreachable in normal operation and exists only as a defensive
  // fallback for other, non-runtime callers of selectStrategy() that might not go through this
  // config. Defaults to the official Hermes Agent (HERMES_AGENT_STRATEGY_ID) — DEMO-0001 remains
  // selectable only by explicitly setting HERMES_STRATEGY_ID=DEMO-0001 (with
  // DEMO_EXECUTION_MODE=true). Presence/format only here — whether this ID actually names a known,
  // enabled strategy can only be checked once the registry has been read (see
  // runtime-config/strategy-selection.ts); no single required format applies (a Hermes-approved id
  // looks like "STRAT-0001", the demo strategy's id is "DEMO-0001" — this file does not police
  // that shape).
  const strategyId = env.HERMES_STRATEGY_ID?.trim() || HERMES_AGENT_STRATEGY_ID;

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

  // Restart-Resilient Autonomy Phase. Same fail-closed convention as brokerProvider/marketDataProvider
  // above: an unrecognised value throws immediately via parseEnum. AUTO_LIVE is a structurally valid
  // enum member (matching ExecutionApprovalMode's own type) but is explicitly, unconditionally
  // rejected right below — there is no environment or code path that can ever make it take effect.
  const approvalMode = parseEnum(env.HERMES_APPROVAL_MODE, SUPPORTED_APPROVAL_MODES, "MANUAL");
  if (approvalMode === "AUTO_LIVE") {
    throw new ConfigError(
      "HERMES_APPROVAL_MODE=AUTO_LIVE is not supported — live trading is not implemented anywhere in " +
        "this codebase. Only MANUAL (the default) and AUTO_DEMO are currently valid.",
    );
  }

  let autoDemoMinConfidence = DEFAULT_AUTO_DEMO_MIN_CONFIDENCE;
  if (env.HERMES_AUTO_DEMO_MIN_CONFIDENCE !== undefined && env.HERMES_AUTO_DEMO_MIN_CONFIDENCE !== "") {
    const parsed = Number(env.HERMES_AUTO_DEMO_MIN_CONFIDENCE);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      throw new ConfigError(
        `HERMES_AUTO_DEMO_MIN_CONFIDENCE must be a number between 0 and 1, received "${env.HERMES_AUTO_DEMO_MIN_CONFIDENCE}".`,
      );
    }
    autoDemoMinConfidence = parsed;
  }

  const killSwitchEnabled = parseBoolean(env.HERMES_KILL_SWITCH_ENABLED, false);

  let maxHoldingDurationMs: number | undefined;
  if (env.HERMES_MAX_HOLDING_DURATION_MS !== undefined && env.HERMES_MAX_HOLDING_DURATION_MS !== "") {
    maxHoldingDurationMs = parseInteger(env.HERMES_MAX_HOLDING_DURATION_MS, 0, { min: 1 });
  }

  // Deployment safety review (final hardening pass): a floor of 1ms let this be misconfigured to an
  // effectively-zero threshold, causing lifecycle-recovery.ts to treat every pre-OPEN record as
  // stale on the very next cycle — far too aggressive for a value meant to bound "how long a crash
  // window may plausibly still be in flight." 60 seconds is the practical minimum for a single
  // broker round-trip plus scheduler jitter; the 5-minute default is unchanged.
  const recoveryThresholdMs = parseInteger(
    env.HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS,
    DEFAULT_LIFECYCLE_RECOVERY_THRESHOLD_MS,
    { min: 60_000 },
  );

  // Prototype 1.0 — official Hermes Agent decision integration.
  const hermesAgentCliPath = (env.HERMES_AGENT_CLI_PATH || DEFAULT_HERMES_AGENT_CLI_PATH).trim();
  if (hermesAgentCliPath.length === 0) {
    throw new ConfigError("HERMES_AGENT_CLI_PATH must not be empty (or whitespace-only) if set.");
  }

  const hermesAgentDecisionTimeoutMs = parseInteger(
    env.HERMES_AGENT_DECISION_TIMEOUT_MS,
    DEFAULT_HERMES_AGENT_DECISION_TIMEOUT_MS,
    { min: MIN_HERMES_AGENT_DECISION_TIMEOUT_MS },
  );

  const hermesAgentMaxStdoutBytes = parseInteger(
    env.HERMES_AGENT_MAX_STDOUT_BYTES,
    DEFAULT_HERMES_AGENT_MAX_STDOUT_BYTES,
    { min: MIN_HERMES_AGENT_MAX_STDOUT_BYTES },
  );

  // Comma-separated, uppercased, trimmed, deduplicated (first occurrence wins), same character
  // grammar as HERMES_TRADING_SYMBOL above — an empty or whitespace-only entry is rejected rather
  // than silently dropped, since a typo'd separator ("BTC,,ETH") should fail closed, not shrink
  // the configured universe silently.
  let instrumentUniverse: string[];
  if (env.HERMES_INSTRUMENT_UNIVERSE !== undefined && env.HERMES_INSTRUMENT_UNIVERSE !== "") {
    const rawEntries = env.HERMES_INSTRUMENT_UNIVERSE.split(",").map((entry) => entry.trim());
    if (rawEntries.some((entry) => entry.length === 0)) {
      throw new ConfigError(
        `HERMES_INSTRUMENT_UNIVERSE "${env.HERMES_INSTRUMENT_UNIVERSE}" contains an empty entry — check for a stray or trailing comma.`,
      );
    }
    const upper = rawEntries.map((entry) => entry.toUpperCase());
    for (const entry of upper) {
      if (!SYMBOL_PATTERN.test(entry)) {
        throw new ConfigError(
          `HERMES_INSTRUMENT_UNIVERSE entry "${entry}" contains unsupported characters — expected letters, digits, ".", "_", or "-" only.`,
        );
      }
    }
    instrumentUniverse = [...new Set(upper)];
  } else {
    instrumentUniverse = [...DEFAULT_INSTRUMENT_UNIVERSE];
  }

  const maxProposalsPerScan = parseInteger(env.HERMES_MAX_PROPOSALS_PER_SCAN, DEFAULT_MAX_PROPOSALS_PER_SCAN, {
    min: MIN_MAX_PROPOSALS_PER_SCAN,
  });

  const hermesTelegramGatewayTarget = (env.HERMES_TELEGRAM_GATEWAY_TARGET || DEFAULT_HERMES_TELEGRAM_GATEWAY_TARGET).trim();
  if (hermesTelegramGatewayTarget.length === 0) {
    throw new ConfigError("HERMES_TELEGRAM_GATEWAY_TARGET must not be empty (or whitespace-only) if set.");
  }

  const hermesTelegramGatewaySendTimeoutMs = parseInteger(
    env.HERMES_TELEGRAM_GATEWAY_SEND_TIMEOUT_MS,
    DEFAULT_HERMES_TELEGRAM_GATEWAY_SEND_TIMEOUT_MS,
    { min: MIN_HERMES_TELEGRAM_GATEWAY_SEND_TIMEOUT_MS },
  );

  // Telegram alert-activation design fix. Deliberately independent of telegramEnabled/botToken/
  // allowedChatId above — this flag alone decides whether outbound gateway alerts are wired up;
  // never paired-validated with any direct Telegram Bot API credential, since this path never uses
  // one. Defaults to false (opt-in).
  const hermesTelegramGatewayAlertsEnabled = parseBoolean(env.HERMES_TELEGRAM_GATEWAY_ALERTS_ENABLED, false);

  // Hardening pass — opposing-signal exit stability. Wrapped so an invalid value fails with a
  // message naming the actual offending env var, rather than parseInteger's own generic
  // "Expected an integer..." — "invalid values must fail clearly at startup" is this feature's own
  // explicit requirement.
  //
  // Remediation pass (senior review finding M2) — safe configuration floors. This gate exists to
  // prevent a real position from being closed on the strength of a single reversed scan; a value
  // below these floors would defeat that purpose entirely (0ms hold / 1 confirmation is exactly the
  // immediate-exit behaviour this whole feature was built to replace). There is deliberately no
  // production environment override path that can go below these floors — the minimum is enforced
  // here, in code, not by a config flag.
  let opposingExitMinHoldMs: number;
  try {
    opposingExitMinHoldMs = parseInteger(env.HERMES_OPPOSING_EXIT_MIN_HOLD_MS, DEFAULT_OPPOSING_EXIT_MIN_HOLD_MS, {
      min: MIN_OPPOSING_EXIT_MIN_HOLD_MS,
    });
  } catch (error) {
    throw new ConfigError(
      `HERMES_OPPOSING_EXIT_MIN_HOLD_MS is invalid: must be an integer >= ${MIN_OPPOSING_EXIT_MIN_HOLD_MS} (ms). ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let opposingExitRequiredConfirmations: number;
  try {
    opposingExitRequiredConfirmations = parseInteger(
      env.HERMES_OPPOSING_EXIT_CONFIRMATIONS,
      DEFAULT_OPPOSING_EXIT_REQUIRED_CONFIRMATIONS,
      { min: MIN_OPPOSING_EXIT_REQUIRED_CONFIRMATIONS },
    );
  } catch (error) {
    throw new ConfigError(
      `HERMES_OPPOSING_EXIT_CONFIRMATIONS is invalid: must be an integer >= ${MIN_OPPOSING_EXIT_REQUIRED_CONFIRMATIONS}. ${error instanceof Error ? error.message : String(error)}`,
    );
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
    approvalMode,
    autoDemoMinConfidence,
    killSwitchEnabled,
    maxHoldingDurationMs,
    recoveryThresholdMs,
    opposingExitMinHoldMs,
    opposingExitRequiredConfirmations,
    hermesAgent: {
      cliPath: hermesAgentCliPath,
      decisionTimeoutMs: hermesAgentDecisionTimeoutMs,
      maxStdoutBytes: hermesAgentMaxStdoutBytes,
      instrumentUniverse,
      maxProposalsPerScan,
      telegramTarget: hermesTelegramGatewayTarget,
      telegramSendTimeoutMs: hermesTelegramGatewaySendTimeoutMs,
      telegramGatewayAlertsEnabled: hermesTelegramGatewayAlertsEnabled,
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
