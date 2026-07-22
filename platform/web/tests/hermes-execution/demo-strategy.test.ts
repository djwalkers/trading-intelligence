import { describe, expect, it } from "vitest";
import { getDemoStrategy, DEMO_STRATEGY_ID } from "@/lib/hermes-execution/demo-strategy";
import { buildHermesExecutionConfig } from "@/lib/hermes-execution/config";

describe("getDemoStrategy", () => {
  it("is disabled by default — returns null when demoExecutionModeEnabled is false", () => {
    expect(getDemoStrategy(false)).toBeNull();
  });

  it("loads only when demo mode is explicitly enabled", () => {
    const strategy = getDemoStrategy(true);
    expect(strategy).not.toBeNull();
    expect(strategy?.strategyId).toBe(DEMO_STRATEGY_ID);
    expect(strategy?.sourceType).toBe("DEMO_ONLY");
    expect(strategy?.demoLabel).toMatch(/DEMO_ONLY/);
  });

  it("is visibly marked DEMO_ONLY and cannot be mistaken for HERMES_APPROVED", () => {
    const strategy = getDemoStrategy(true);
    expect(strategy?.sourceType).not.toBe("HERMES_APPROVED");
    expect(strategy?.demoLabel).toBeDefined();
  });
});

describe("HermesExecutionConfig — demo mode defaults", () => {
  const EMPTY = {
    HERMES_STRATEGY_REGISTRY_PATH: undefined,
    EXECUTION_MODE: undefined,
    DEMO_EXECUTION_MODE: undefined,
    HERMES_PAPER_STARTING_CASH: undefined,
    HERMES_MAX_OPEN_POSITIONS: undefined,
    BROKER_PROVIDER: undefined,
    HERMES_MARKET_DATA_PROVIDER: undefined,
    HERMES_MARKET_TIMEFRAME: undefined,
    HERMES_MARKET_CANDLE_COUNT: undefined,
    HERMES_MARKET_MAX_CANDLE_AGE_SECONDS: undefined,
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

  it("defaults DEMO_EXECUTION_MODE to false when unset", () => {
    expect(buildHermesExecutionConfig(EMPTY).demoExecutionModeEnabled).toBe(false);
  });

  it("defaults EXECUTION_MODE to paper when unset", () => {
    expect(buildHermesExecutionConfig(EMPTY).executionMode).toBe("paper");
  });

  it("fails closed on an unsupported EXECUTION_MODE", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, EXECUTION_MODE: "live" })).toThrow();
  });

  it("enables demo mode only when explicitly set to true", () => {
    expect(buildHermesExecutionConfig({ ...EMPTY, DEMO_EXECUTION_MODE: "true" }).demoExecutionModeEnabled).toBe(true);
    expect(buildHermesExecutionConfig({ ...EMPTY, DEMO_EXECUTION_MODE: "false" }).demoExecutionModeEnabled).toBe(false);
  });
});
