import { describe, expect, it } from "vitest";
import { buildHermesExecutionConfig } from "@/lib/hermes-execution/config";

// Phase 2A — Real Historical Candles for Live Market Data.

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

describe("buildHermesExecutionConfig — marketData defaults", () => {
  it("defaults to timeframe '1h', candleCount 200, and a derived 2x-timeframe maxCandleAgeSeconds", () => {
    const config = buildHermesExecutionConfig(EMPTY);
    expect(config.marketData).toEqual({
      timeframe: "1h",
      candleCount: 200,
      maxCandleAgeSeconds: 7_200, // 2 * 3600s
    });
  });
});

describe("buildHermesExecutionConfig — HERMES_MARKET_TIMEFRAME", () => {
  it("honours every supported timeframe", () => {
    for (const timeframe of ["1m", "5m", "10m", "15m", "30m", "1h", "4h", "1d", "1w"]) {
      expect(buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_TIMEFRAME: timeframe }).marketData.timeframe).toBe(
        timeframe,
      );
    }
  });

  it("fails closed on an unsupported timeframe rather than silently falling back to '1h'", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_TIMEFRAME: "2h" })).toThrow(/1m.*1w|1h/);
  });

  it("changing the timeframe changes the derived default maxCandleAgeSeconds", () => {
    const oneMinute = buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_TIMEFRAME: "1m" });
    // 2 * 60s = 120s would be below the 300s floor, so the floor applies instead.
    expect(oneMinute.marketData.maxCandleAgeSeconds).toBe(300);

    const oneDay = buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_TIMEFRAME: "1d" });
    expect(oneDay.marketData.maxCandleAgeSeconds).toBe(2 * 24 * 3_600);
  });
});

describe("buildHermesExecutionConfig — HERMES_MARKET_CANDLE_COUNT", () => {
  it("honours a custom candle count", () => {
    expect(buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_CANDLE_COUNT: "500" }).marketData.candleCount).toBe(500);
  });

  it("rejects a value below the MIN_REQUIRED_CANDLES floor (50) rather than silently raising it", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_CANDLE_COUNT: "10" })).toThrow(/>= 50/);
  });

  it("accepts a count exactly at the floor", () => {
    expect(buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_CANDLE_COUNT: "50" }).marketData.candleCount).toBe(50);
  });

  it("rejects a non-integer count", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_CANDLE_COUNT: "60.5" })).toThrow(/integer/);
  });
});

describe("buildHermesExecutionConfig — HERMES_MARKET_MAX_CANDLE_AGE_SECONDS", () => {
  it("honours an explicit override regardless of timeframe", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_MARKET_TIMEFRAME: "1d",
      HERMES_MARKET_MAX_CANDLE_AGE_SECONDS: "600",
    });
    expect(config.marketData.maxCandleAgeSeconds).toBe(600);
  });

  it("rejects an explicit value below the 300s floor", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_MAX_CANDLE_AGE_SECONDS: "60" })).toThrow(/>= 300/);
  });
});
