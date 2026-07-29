import { describe, expect, it } from "vitest";
import { buildHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { ConfigError } from "@/lib/config/env";

// Prototype 1.0 — official Hermes Agent decision integration. Config-level tests for the new
// hermesAgent.* fields — safe defaults (CLI path, universe, maxProposals) and fail-closed
// validation for every override.

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
  HERMES_APPROVAL_MODE: undefined,
  HERMES_AUTO_DEMO_MIN_CONFIDENCE: undefined,
  HERMES_KILL_SWITCH_ENABLED: undefined,
  HERMES_MAX_HOLDING_DURATION_MS: undefined,
  HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS: undefined,
  HERMES_AGENT_CLI_PATH: undefined,
  HERMES_AGENT_DECISION_TIMEOUT_MS: undefined,
  HERMES_AGENT_MAX_STDOUT_BYTES: undefined,
  HERMES_INSTRUMENT_UNIVERSE: undefined,
  HERMES_MAX_PROPOSALS_PER_SCAN: undefined,
  HERMES_TELEGRAM_GATEWAY_TARGET: undefined,
  HERMES_TELEGRAM_GATEWAY_SEND_TIMEOUT_MS: undefined,
  HERMES_OPPOSING_EXIT_MIN_HOLD_MS: undefined,
  HERMES_OPPOSING_EXIT_CONFIRMATIONS: undefined,
};

describe("hermesAgent config — safe defaults", () => {
  it("defaults cliPath to the confirmed VPS installation path", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY });
    expect(config.hermesAgent.cliPath).toBe("/home/andy/.local/bin/hermes");
  });

  it("defaults the universe to BTC, ETH, SOL, AAPL, MSFT, NVDA", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY });
    expect(config.hermesAgent.instrumentUniverse).toEqual(["BTC", "ETH", "SOL", "AAPL", "MSFT", "NVDA"]);
  });

  it("defaults maxProposalsPerScan to 2", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY });
    expect(config.hermesAgent.maxProposalsPerScan).toBe(2);
  });

  it("defaults the telegram target to the confirmed gateway target", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY });
    expect(config.hermesAgent.telegramTarget).toBe("telegram:Andrew Walker");
  });

  it("defaults decisionTimeoutMs to 60000 and maxStdoutBytes to 65536", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY });
    expect(config.hermesAgent.decisionTimeoutMs).toBe(60_000);
    expect(config.hermesAgent.maxStdoutBytes).toBe(65_536);
  });

  it("MANUAL remains the default approval mode alongside the new Hermes config", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY });
    expect(config.approvalMode).toBe("MANUAL");
  });
});

describe("hermesAgent config — HERMES_INSTRUMENT_UNIVERSE overrides", () => {
  it("accepts a custom comma-separated universe, uppercased and deduplicated", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_INSTRUMENT_UNIVERSE: "btc, eth, btc" });
    expect(config.hermesAgent.instrumentUniverse).toEqual(["BTC", "ETH"]);
  });

  it("rejects an empty entry from a stray comma", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_INSTRUMENT_UNIVERSE: "BTC,,ETH" })).toThrow(ConfigError);
  });

  it("rejects an entry with unsupported characters", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_INSTRUMENT_UNIVERSE: "BTC,ETH$" })).toThrow(ConfigError);
  });
});

describe("hermesAgent config — bounds", () => {
  it("rejects a decision timeout below the floor", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_AGENT_DECISION_TIMEOUT_MS: "500" })).toThrow(ConfigError);
  });

  it("rejects a maxStdoutBytes below the floor", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_AGENT_MAX_STDOUT_BYTES: "10" })).toThrow(ConfigError);
  });

  it("rejects maxProposalsPerScan below 1", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_MAX_PROPOSALS_PER_SCAN: "0" })).toThrow(ConfigError);
  });

  it("rejects an empty HERMES_AGENT_CLI_PATH", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_AGENT_CLI_PATH: "   " })).toThrow(ConfigError);
  });

  it("rejects an empty HERMES_TELEGRAM_GATEWAY_TARGET", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_TELEGRAM_GATEWAY_TARGET: "   " })).toThrow(ConfigError);
  });

  it("accepts an explicit override for every hermesAgent field", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      HERMES_AGENT_CLI_PATH: "/custom/path/hermes",
      HERMES_AGENT_DECISION_TIMEOUT_MS: "30000",
      HERMES_AGENT_MAX_STDOUT_BYTES: "8192",
      HERMES_INSTRUMENT_UNIVERSE: "BTC,ETH",
      HERMES_MAX_PROPOSALS_PER_SCAN: "1",
      HERMES_TELEGRAM_GATEWAY_TARGET: "telegram:Custom",
      HERMES_TELEGRAM_GATEWAY_SEND_TIMEOUT_MS: "5000",
    });
    expect(config.hermesAgent).toEqual({
      cliPath: "/custom/path/hermes",
      decisionTimeoutMs: 30_000,
      maxStdoutBytes: 8192,
      instrumentUniverse: ["BTC", "ETH"],
      maxProposalsPerScan: 1,
      telegramTarget: "telegram:Custom",
      telegramSendTimeoutMs: 5000,
    });
  });
});
