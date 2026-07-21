import { describe, expect, it } from "vitest";
import { buildHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { ConfigError } from "@/lib/config/env";

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
};

const VALID_KEY = `0x${"1".repeat(64)}`;
const VALID_ADDRESS = `0x${"2".repeat(40)}`;

describe("BROKER_PROVIDER — local paper mode remains the default", () => {
  it("defaults to local when unset", () => {
    expect(buildHermesExecutionConfig(EMPTY).brokerProvider).toBe("local");
  });

  it("stays local even when Hyperliquid vars are set but BROKER_PROVIDER isn't", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HYPERLIQUID_TESTNET_PRIVATE_KEY: VALID_KEY,
      HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: VALID_ADDRESS,
      HYPERLIQUID_TESTNET_EXECUTION_ENABLED: "true",
    });
    expect(config.brokerProvider).toBe("local");
  });
});

describe("BROKER_PROVIDER — mainnet configuration is rejected", () => {
  it("has no mainnet value in its supported set at all", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, BROKER_PROVIDER: "hyperliquid-mainnet" })).toThrow(
      ConfigError,
    );
    expect(() => buildHermesExecutionConfig({ ...EMPTY, BROKER_PROVIDER: "mainnet" })).toThrow(ConfigError);
    expect(() => buildHermesExecutionConfig({ ...EMPTY, BROKER_PROVIDER: "live" })).toThrow(ConfigError);
  });

  it("fails closed on any unrecognised provider rather than falling back to local", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, BROKER_PROVIDER: "typo-provider" })).toThrow(ConfigError);
  });
});

describe("BROKER_PROVIDER=hyperliquid-testnet — missing credentials fail clearly", () => {
  it("throws when both credentials are missing", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, BROKER_PROVIDER: "hyperliquid-testnet" })).toThrow(
      /requires both HYPERLIQUID_TESTNET_PRIVATE_KEY and HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS/,
    );
  });

  it("throws when only the private key is set", () => {
    expect(() =>
      buildHermesExecutionConfig({
        ...EMPTY,
        BROKER_PROVIDER: "hyperliquid-testnet",
        HYPERLIQUID_TESTNET_PRIVATE_KEY: VALID_KEY,
      }),
    ).toThrow(ConfigError);
  });

  it("throws when only the account address is set", () => {
    expect(() =>
      buildHermesExecutionConfig({
        ...EMPTY,
        BROKER_PROVIDER: "hyperliquid-testnet",
        HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: VALID_ADDRESS,
      }),
    ).toThrow(ConfigError);
  });

  it("succeeds when both credentials are well-formed", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "hyperliquid-testnet",
      HYPERLIQUID_TESTNET_PRIVATE_KEY: VALID_KEY,
      HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: VALID_ADDRESS,
    });
    expect(config.brokerProvider).toBe("hyperliquid-testnet");
    expect(config.hyperliquid.privateKey).toBe(VALID_KEY);
  });

  it("rejects a malformed private key without ever echoing the value in the error message", () => {
    const badKey = "not-a-real-key";
    try {
      buildHermesExecutionConfig({
        ...EMPTY,
        BROKER_PROVIDER: "hyperliquid-testnet",
        HYPERLIQUID_TESTNET_PRIVATE_KEY: badKey,
        HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: VALID_ADDRESS,
      });
      throw new Error("expected buildHermesExecutionConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain(badKey);
    }
  });

  it("rejects a malformed account address", () => {
    expect(() =>
      buildHermesExecutionConfig({
        ...EMPTY,
        BROKER_PROVIDER: "hyperliquid-testnet",
        HYPERLIQUID_TESTNET_PRIVATE_KEY: VALID_KEY,
        HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: "not-an-address",
      }),
    ).toThrow(ConfigError);
  });
});

describe("HYPERLIQUID_TESTNET_EXECUTION_ENABLED", () => {
  it("defaults to false", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "hyperliquid-testnet",
      HYPERLIQUID_TESTNET_PRIVATE_KEY: VALID_KEY,
      HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: VALID_ADDRESS,
    });
    expect(config.hyperliquid.executionEnabled).toBe(false);
  });

  it("is true only when explicitly set to true", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "hyperliquid-testnet",
      HYPERLIQUID_TESTNET_PRIVATE_KEY: VALID_KEY,
      HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: VALID_ADDRESS,
      HYPERLIQUID_TESTNET_EXECUTION_ENABLED: "true",
    });
    expect(config.hyperliquid.executionEnabled).toBe(true);
  });
});

describe("HYPERLIQUID_TESTNET_MAX_ORDER_VALUE_USD — smallest practical test size", () => {
  it("defaults to a small value above Hyperliquid's $10 minimum order notional", () => {
    const config = buildHermesExecutionConfig(EMPTY);
    expect(config.hyperliquid.maxTestOrderValueUsd).toBeGreaterThanOrEqual(10);
    expect(config.hyperliquid.maxTestOrderValueUsd).toBeLessThan(100);
  });

  it("rejects a value below the $10 floor", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HYPERLIQUID_TESTNET_MAX_ORDER_VALUE_USD: "5" })).toThrow();
  });
});
