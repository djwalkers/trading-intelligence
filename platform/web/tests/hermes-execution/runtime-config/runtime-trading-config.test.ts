import { describe, expect, it } from "vitest";
import { buildHermesExecutionConfig } from "@/lib/hermes-execution/config";

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

describe("buildHermesExecutionConfig — runtimeTrading defaults", () => {
  it("defaults to symbol BTC, quantity 10, no max quantity, no strategyId, and mode paper", () => {
    const config = buildHermesExecutionConfig(EMPTY);
    expect(config.runtimeTrading).toEqual({
      symbol: "BTC",
      quantity: 10,
      maxQuantity: undefined,
      strategyId: undefined,
      mode: "paper",
    });
  });
});

describe("buildHermesExecutionConfig — symbol parsing and validation", () => {
  it("normalizes a lowercase symbol to uppercase", () => {
    expect(buildHermesExecutionConfig({ ...EMPTY, HERMES_TRADING_SYMBOL: "eth" }).runtimeTrading.symbol).toBe("ETH");
  });

  it("trims surrounding whitespace", () => {
    expect(buildHermesExecutionConfig({ ...EMPTY, HERMES_TRADING_SYMBOL: "  eth  " }).runtimeTrading.symbol).toBe("ETH");
  });

  it("accepts dots, underscores, and hyphens (e.g. Trading212-style tickers)", () => {
    expect(buildHermesExecutionConfig({ ...EMPTY, HERMES_TRADING_SYMBOL: "AAPL_US_EQ" }).runtimeTrading.symbol).toBe(
      "AAPL_US_EQ",
    );
  });

  it("rejects a whitespace-only symbol", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_TRADING_SYMBOL: "   " })).toThrow(/must not be empty/);
  });

  it("rejects a symbol containing unsupported characters", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_TRADING_SYMBOL: "BTC/USD" })).toThrow(
      /unsupported characters/,
    );
  });
});

describe("buildHermesExecutionConfig — quantity parsing and validation", () => {
  it("honours a custom HERMES_TRADE_QUANTITY", () => {
    expect(buildHermesExecutionConfig({ ...EMPTY, HERMES_TRADE_QUANTITY: "25" }).runtimeTrading.quantity).toBe(25);
  });

  it("accepts a fractional quantity", () => {
    expect(buildHermesExecutionConfig({ ...EMPTY, HERMES_TRADE_QUANTITY: "0.5" }).runtimeTrading.quantity).toBe(0.5);
  });

  it("rejects a zero quantity", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_TRADE_QUANTITY: "0" })).toThrow(/positive finite number/);
  });

  it("rejects a negative quantity", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_TRADE_QUANTITY: "-5" })).toThrow(/positive finite number/);
  });

  it("rejects a non-numeric quantity", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_TRADE_QUANTITY: "abc" })).toThrow(/positive finite number/);
  });

  it("rejects Infinity", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_TRADE_QUANTITY: "Infinity" })).toThrow(
      /positive finite number/,
    );
  });
});

describe("buildHermesExecutionConfig — max quantity safety ceiling", () => {
  it("is undefined (no ceiling) by default", () => {
    expect(buildHermesExecutionConfig(EMPTY).runtimeTrading.maxQuantity).toBeUndefined();
  });

  it("honours a configured ceiling above the quantity", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_TRADE_QUANTITY: "5", HERMES_MAX_TRADE_QUANTITY: "100" });
    expect(config.runtimeTrading.maxQuantity).toBe(100);
  });

  it("rejects a quantity exceeding the configured ceiling", () => {
    expect(() =>
      buildHermesExecutionConfig({ ...EMPTY, HERMES_TRADE_QUANTITY: "150", HERMES_MAX_TRADE_QUANTITY: "100" }),
    ).toThrow(/exceeds HERMES_MAX_TRADE_QUANTITY/);
  });

  it("allows quantity exactly equal to the ceiling", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_TRADE_QUANTITY: "100", HERMES_MAX_TRADE_QUANTITY: "100" });
    expect(config.runtimeTrading.quantity).toBe(100);
  });

  it("rejects an invalid ceiling value", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_MAX_TRADE_QUANTITY: "-1" })).toThrow(
      /positive finite number/,
    );
  });
});

describe("buildHermesExecutionConfig — strategyId", () => {
  it("is undefined by default (preserves existing auto-select behaviour)", () => {
    expect(buildHermesExecutionConfig(EMPTY).runtimeTrading.strategyId).toBeUndefined();
  });

  it("passes through a configured strategy id verbatim (trimmed)", () => {
    expect(buildHermesExecutionConfig({ ...EMPTY, HERMES_STRATEGY_ID: "  STRAT-0042  " }).runtimeTrading.strategyId).toBe(
      "STRAT-0042",
    );
  });
});

describe("buildHermesExecutionConfig — runtime mode fails closed", () => {
  it("defaults to paper — the safest mode", () => {
    expect(buildHermesExecutionConfig(EMPTY).runtimeTrading.mode).toBe("paper");
  });

  it("honours demo and testnet", () => {
    expect(buildHermesExecutionConfig({ ...EMPTY, HERMES_RUNTIME_MODE: "demo" }).runtimeTrading.mode).toBe("demo");
    expect(buildHermesExecutionConfig({ ...EMPTY, HERMES_RUNTIME_MODE: "testnet" }).runtimeTrading.mode).toBe("testnet");
  });

  it("explicitly rejects 'live' — there is no live value structurally", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_RUNTIME_MODE: "live" })).toThrow(/paper, demo, testnet/);
  });

  it("rejects an unrecognised mode", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_RUNTIME_MODE: "sandbox" })).toThrow(/paper, demo, testnet/);
  });
});
