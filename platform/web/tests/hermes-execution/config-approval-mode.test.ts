import { describe, expect, it } from "vitest";
import { buildHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { ConfigError } from "@/lib/config/env";

// Restart-Resilient Autonomy Phase — Phase 5 (AUTO_DEMO approval mode), config-level fail-closed
// behaviour.
//
// Covers required scenarios:
//  14. AUTO_LIVE fails configuration startup.
//  15. Unknown approval mode fails closed.
//  16. MANUAL mode remains unchanged (the default, and explicitly).

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
};

describe("HERMES_APPROVAL_MODE — MANUAL (scenario 16)", () => {
  it("defaults to MANUAL when unset", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY });
    expect(config.approvalMode).toBe("MANUAL");
  });

  it("accepts MANUAL explicitly", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_APPROVAL_MODE: "MANUAL" });
    expect(config.approvalMode).toBe("MANUAL");
  });
});

describe("HERMES_APPROVAL_MODE — AUTO_DEMO", () => {
  it("accepts AUTO_DEMO", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_APPROVAL_MODE: "AUTO_DEMO" });
    expect(config.approvalMode).toBe("AUTO_DEMO");
  });
});

describe("HERMES_APPROVAL_MODE — AUTO_LIVE fails configuration startup (scenario 14)", () => {
  it("throws a ConfigError, never silently downgrading to MANUAL or AUTO_DEMO", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_APPROVAL_MODE: "AUTO_LIVE" })).toThrow(ConfigError);
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_APPROVAL_MODE: "AUTO_LIVE" })).toThrow(/not supported/i);
  });
});

describe("HERMES_APPROVAL_MODE — unknown values fail closed (scenario 15)", () => {
  it("throws for an unrecognised approval mode string", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_APPROVAL_MODE: "SEMI_AUTO" })).toThrow(ConfigError);
  });

  it("throws for a lowercase near-miss (case-sensitive)", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_APPROVAL_MODE: "auto_demo" })).toThrow(ConfigError);
  });
});

describe("HERMES_AUTO_DEMO_MIN_CONFIDENCE", () => {
  it("defaults to 0.75", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY });
    expect(config.autoDemoMinConfidence).toBe(0.75);
  });

  it("accepts an explicit value in [0, 1]", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_AUTO_DEMO_MIN_CONFIDENCE: "0.9" });
    expect(config.autoDemoMinConfidence).toBe(0.9);
  });

  it("rejects a value outside [0, 1]", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_AUTO_DEMO_MIN_CONFIDENCE: "1.5" })).toThrow(ConfigError);
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_AUTO_DEMO_MIN_CONFIDENCE: "-0.1" })).toThrow(ConfigError);
  });
});

describe("HERMES_KILL_SWITCH_ENABLED", () => {
  it("defaults to false", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY });
    expect(config.killSwitchEnabled).toBe(false);
  });

  it("parses true", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_KILL_SWITCH_ENABLED: "true" });
    expect(config.killSwitchEnabled).toBe(true);
  });
});

describe("HERMES_MAX_HOLDING_DURATION_MS", () => {
  it("defaults to undefined (no ceiling configured)", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY });
    expect(config.maxHoldingDurationMs).toBeUndefined();
  });

  it("accepts an explicit positive integer", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_MAX_HOLDING_DURATION_MS: "3600000" });
    expect(config.maxHoldingDurationMs).toBe(3_600_000);
  });
});

// Deployment safety review (final hardening pass): the floor was raised from 1ms to 60,000ms — a
// value below that would let lifecycle-recovery.ts treat every pre-OPEN record as stale almost
// immediately, far too aggressive for a threshold meant to bound a plausible crash-window. The
// 5-minute default is unchanged.
describe("HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS", () => {
  it("defaults to 300,000ms (5 minutes) when unset", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY });
    expect(config.recoveryThresholdMs).toBe(300_000);
  });

  it("accepts the new floor value of exactly 60,000ms", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS: "60000" });
    expect(config.recoveryThresholdMs).toBe(60_000);
  });

  it("accepts a value above the floor", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS: "600000" });
    expect(config.recoveryThresholdMs).toBe(600_000);
  });

  it("rejects a value below the new 60,000ms floor, including the old 1ms floor", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS: "1" })).toThrow(ConfigError);
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS: "1000" })).toThrow(ConfigError);
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS: "59999" })).toThrow(ConfigError);
  });

  it("rejects zero and negative values", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS: "0" })).toThrow(ConfigError);
    expect(() => buildHermesExecutionConfig({ ...EMPTY, HERMES_LIFECYCLE_RECOVERY_THRESHOLD_MS: "-1" })).toThrow(ConfigError);
  });
});
