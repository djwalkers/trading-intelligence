import { describe, expect, it } from "vitest";
import { buildRedactedStartupSummary } from "@/lib/hermes-execution/runtime-config/startup-summary";
import { buildHermesExecutionConfig } from "@/lib/hermes-execution/config";
import type { InternalStrategy } from "@/lib/hermes-execution/types";

const EMPTY = {
  HERMES_STRATEGY_REGISTRY_PATH: undefined,
  EXECUTION_MODE: undefined,
  DEMO_EXECUTION_MODE: undefined,
  HERMES_PAPER_STARTING_CASH: undefined,
  HERMES_MAX_OPEN_POSITIONS: undefined,
  BROKER_PROVIDER: undefined,
  HERMES_MARKET_DATA_PROVIDER: undefined,
  HERMES_SCHEDULER_ENABLED: undefined,
  HERMES_SCHEDULER_INTERVAL_MS: undefined,
  HERMES_SCHEDULER_IMMEDIATE_FIRST_RUN: undefined,
  HERMES_MARKET_HOURS_POLICY: undefined,
  HERMES_MARKET_HOURS_TIMEZONE: undefined,
  HERMES_MARKET_HOURS_SESSION_START: undefined,
  HERMES_MARKET_HOURS_SESSION_END: undefined,
  HERMES_TRADING_SYMBOL: undefined,
  HERMES_TRADE_QUANTITY: undefined,
  HERMES_MAX_TRADE_QUANTITY: undefined,
  HERMES_STRATEGY_ID: undefined,
  HERMES_RUNTIME_MODE: undefined,
  HERMES_RUNTIME_SHUTDOWN_TIMEOUT_MS: undefined,
  HERMES_TELEGRAM_ENABLED: undefined,
  HERMES_TELEGRAM_BOT_TOKEN: undefined,
  HERMES_TELEGRAM_ALLOWED_CHAT_ID: undefined,
  HYPERLIQUID_TESTNET_PRIVATE_KEY: undefined,
  HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: undefined,
  HYPERLIQUID_TESTNET_EXECUTION_ENABLED: undefined,
  HYPERLIQUID_TESTNET_MAX_ORDER_VALUE_USD: undefined,
  HYPERLIQUID_TESTNET_INSTRUMENT: undefined,
  TRADING212_API_KEY: undefined,
  TRADING212_API_SECRET: undefined,
  TRADING212_DEMO_EXECUTION_ENABLED: undefined,
  TRADING212_DEMO_INSTRUMENT: undefined,
  TRADING212_DEMO_TEST_QUANTITY: undefined,
  ETORO_ENV: undefined,
  ETORO_API_KEY: undefined,
  ETORO_USER_KEY: undefined,
  ETORO_DEMO_TEST_INSTRUMENT: undefined,
  ETORO_DEMO_TEST_AMOUNT: undefined,
  ETORO_HTTP_TIMEOUT_MS: undefined,
};

const SECRET_PRIVATE_KEY = `0x${"1".repeat(64)}`;
const SECRET_ADDRESS = `0x${"2".repeat(40)}`;

const STRATEGY: InternalStrategy = {
  strategyId: "STRAT-0001",
  version: 3,
  sourceType: "HERMES_APPROVED",
  enabled: true,
  instrument: "BTC",
  timeframe: "1h",
  entryRules: [],
  exitRules: [],
  riskRules: { maxPositionValue: 100 },
};

describe("buildRedactedStartupSummary — shape", () => {
  it("includes the expected fields for a default local/paper/mock configuration", () => {
    const config = buildHermesExecutionConfig(EMPTY);
    const summary = buildRedactedStartupSummary(config, STRATEGY);
    expect(summary).toEqual({
      runtimeMode: "paper",
      brokerProvider: "local",
      brokerCredentialsConfigured: true, // local needs none
      marketDataProvider: "mock",
      strategyId: "STRAT-0001",
      strategyVersion: 3,
      strategySourceType: "HERMES_APPROVED",
      symbol: "BTC",
      quantity: 10,
      maxQuantity: undefined,
      schedulerEnabled: false,
      schedulerIntervalMs: 60_000,
      immediateFirstRun: true,
      marketHoursPolicy: "always-open",
      marketHoursTimezone: "America/New_York",
      telegramConfigured: false,
    });
  });

  it("reports brokerCredentialsConfigured: false when a selected broker's credentials are missing", () => {
    // buildHermesExecutionConfig itself already refuses to construct a config with
    // BROKER_PROVIDER=hyperliquid-testnet and no credentials (fails closed at config-build time,
    // unchanged existing behaviour) — that combination is unreachable via the real builder. To
    // exercise areBrokerCredentialsConfigured's false branch directly, hand-construct a
    // HermesExecutionConfig-shaped object bypassing the builder, the same way this suite's own
    // fixtures elsewhere construct plain data shapes without going through a factory.
    const config = buildHermesExecutionConfig(EMPTY);
    const tampered = { ...config, brokerProvider: "hyperliquid-testnet" as const };
    const summary = buildRedactedStartupSummary(tampered, STRATEGY);
    expect(summary.brokerCredentialsConfigured).toBe(false);
  });

  it("reports brokerCredentialsConfigured: true once hyperliquid credentials are set", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "hyperliquid-testnet",
      HYPERLIQUID_TESTNET_PRIVATE_KEY: SECRET_PRIVATE_KEY,
      HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: SECRET_ADDRESS,
    });
    const summary = buildRedactedStartupSummary(config, STRATEGY);
    expect(summary.brokerCredentialsConfigured).toBe(true);
  });

  it("reports telegramConfigured: true once Telegram is enabled with a token and chat id", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_TELEGRAM_ENABLED: "true",
      HERMES_TELEGRAM_BOT_TOKEN: "super-secret-telegram-bot-token",
      HERMES_TELEGRAM_ALLOWED_CHAT_ID: "555",
    });
    const summary = buildRedactedStartupSummary(config, STRATEGY);
    expect(summary.telegramConfigured).toBe(true);
  });
});

describe("buildRedactedStartupSummary — no secrets", () => {
  it("the serialised summary never contains a configured secret value", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "hyperliquid-testnet",
      HYPERLIQUID_TESTNET_PRIVATE_KEY: SECRET_PRIVATE_KEY,
      HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: SECRET_ADDRESS,
      ETORO_API_KEY: "super-secret-etoro-key",
      ETORO_USER_KEY: "super-secret-etoro-user-key",
      TRADING212_API_KEY: "super-secret-t212-key",
      TRADING212_API_SECRET: "super-secret-t212-secret",
      HERMES_TELEGRAM_ENABLED: "true",
      HERMES_TELEGRAM_BOT_TOKEN: "super-secret-telegram-bot-token",
      HERMES_TELEGRAM_ALLOWED_CHAT_ID: "555",
    });
    const summary = buildRedactedStartupSummary(config, STRATEGY);
    const serialised = JSON.stringify(summary);

    expect(serialised).not.toContain(SECRET_PRIVATE_KEY);
    expect(serialised).not.toContain(SECRET_ADDRESS);
    expect(serialised).not.toContain("super-secret-etoro-key");
    expect(serialised).not.toContain("super-secret-etoro-user-key");
    expect(serialised).not.toContain("super-secret-t212-key");
    expect(serialised).not.toContain("super-secret-t212-secret");
    expect(serialised).not.toContain("super-secret-telegram-bot-token");
  });

  it("has no key on the summary object named like a credential field", () => {
    const config = buildHermesExecutionConfig(EMPTY);
    const summary = buildRedactedStartupSummary(config, STRATEGY);
    const forbiddenKeyPattern = /key|secret|token|password|privateKey|userKey|apiKey/i;
    for (const key of Object.keys(summary)) {
      expect(key).not.toMatch(forbiddenKeyPattern);
    }
  });
});
