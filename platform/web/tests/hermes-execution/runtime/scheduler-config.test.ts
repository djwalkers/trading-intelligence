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

describe("buildHermesExecutionConfig — scheduler defaults", () => {
  it("defaults to disabled, a 1-minute interval, immediate first run, and always-open hours", () => {
    const config = buildHermesExecutionConfig(EMPTY);
    expect(config.scheduler).toEqual({
      enabled: false,
      intervalMs: 60_000,
      immediateFirstRun: true,
      marketHoursPolicy: "always-open",
      sessionTimezone: "America/New_York",
      sessionStart: "09:30",
      sessionEnd: "16:00",
      shutdownTimeoutMs: 30_000,
    });
  });
});

describe("buildHermesExecutionConfig — scheduler overrides", () => {
  it("honours HERMES_SCHEDULER_ENABLED=true", () => {
    expect(buildHermesExecutionConfig({ ...EMPTY, HERMES_SCHEDULER_ENABLED: "true" }).scheduler.enabled).toBe(true);
  });

  it("honours a custom HERMES_SCHEDULER_INTERVAL_MS", () => {
    expect(buildHermesExecutionConfig({ ...EMPTY, HERMES_SCHEDULER_INTERVAL_MS: "120000" }).scheduler.intervalMs).toBe(120_000);
  });

  it("honours HERMES_SCHEDULER_IMMEDIATE_FIRST_RUN=false", () => {
    expect(
      buildHermesExecutionConfig({ ...EMPTY, HERMES_SCHEDULER_IMMEDIATE_FIRST_RUN: "false" }).scheduler.immediateFirstRun,
    ).toBe(false);
  });

  it("honours HERMES_MARKET_HOURS_POLICY=weekday-session with custom session fields", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_MARKET_HOURS_POLICY: "weekday-session",
      HERMES_MARKET_HOURS_TIMEZONE: "Europe/London",
      HERMES_MARKET_HOURS_SESSION_START: "08:00",
      HERMES_MARKET_HOURS_SESSION_END: "16:30",
    });
    expect(config.scheduler.marketHoursPolicy).toBe("weekday-session");
    expect(config.scheduler.sessionTimezone).toBe("Europe/London");
    expect(config.scheduler.sessionStart).toBe("08:00");
    expect(config.scheduler.sessionEnd).toBe("16:30");
  });
});

describe("buildHermesExecutionConfig — scheduler validation", () => {
  it("rejects an interval below the minimum (5000ms)", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_SCHEDULER_INTERVAL_MS: "1000" })).toThrow(/>= 5000/);
  });

  it("rejects a non-integer interval", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_SCHEDULER_INTERVAL_MS: "abc" })).toThrow(/integer/);
  });

  it("rejects an unsupported market hours policy value", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_HOURS_POLICY: "holiday-aware" })).toThrow(
      /always-open, weekday-session/,
    );
  });

  it("rejects a malformed session start time", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_HOURS_SESSION_START: "9:30" })).toThrow(
      /HERMES_MARKET_HOURS_SESSION_START/,
    );
  });

  it("rejects a malformed session end time", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_HOURS_SESSION_END: "16:75" })).toThrow(
      /HERMES_MARKET_HOURS_SESSION_END/,
    );
  });

  it("rejects a session start not strictly before session end", () => {
    expect(() =>
      buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_HOURS_SESSION_START: "16:00", HERMES_MARKET_HOURS_SESSION_END: "09:30" }),
    ).toThrow(/strictly before/);
  });

  it("rejects an invalid IANA timezone", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_MARKET_HOURS_TIMEZONE: "Not/A_Zone" })).toThrow(
      /valid IANA timezone/,
    );
  });

  it("rejects a malformed HERMES_SCHEDULER_ENABLED value", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_SCHEDULER_ENABLED: "maybe" })).toThrow(/boolean-like/);
  });
});
