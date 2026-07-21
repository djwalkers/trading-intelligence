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

describe("BROKER_PROVIDER=etoro-demo is a supported, non-default option", () => {
  it("is included in the supported set alongside the other providers", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "etoro-demo",
      ETORO_ENV: "demo",
      ETORO_API_KEY: "k",
      ETORO_USER_KEY: "u",
      ETORO_DEMO_TEST_AMOUNT: "50",
    });
    expect(config.brokerProvider).toBe("etoro-demo");
  });

  it("stays local by default even when eToro vars are set but BROKER_PROVIDER isn't", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      ETORO_ENV: "demo",
      ETORO_API_KEY: "k",
      ETORO_USER_KEY: "u",
      ETORO_DEMO_TEST_AMOUNT: "50",
    });
    expect(config.brokerProvider).toBe("local");
  });

  it("has no live value: BROKER_PROVIDER=etoro-live fails closed", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, BROKER_PROVIDER: "etoro-live" })).toThrow(ConfigError);
    expect(() => buildHermesExecutionConfig({ ...EMPTY, BROKER_PROVIDER: "etoro" })).toThrow(ConfigError);
  });
});

describe("ETORO_ENV — never inferred, never anything but exactly \"demo\"", () => {
  it("defaults to undefined ('not configured') when unset", () => {
    expect(buildHermesExecutionConfig(EMPTY).etoro.env).toBeUndefined();
  });

  it("fails closed if set to anything other than \"demo\", regardless of which provider is active", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, ETORO_ENV: "live" })).toThrow(ConfigError);
    expect(() => buildHermesExecutionConfig({ ...EMPTY, ETORO_ENV: "real" })).toThrow(ConfigError);
    expect(() => buildHermesExecutionConfig({ ...EMPTY, ETORO_ENV: "production" })).toThrow(ConfigError);
  });

  it("throws a clear ConfigError when BROKER_PROVIDER=etoro-demo but ETORO_ENV is unset", () => {
    expect(() =>
      buildHermesExecutionConfig({
        ...EMPTY,
        BROKER_PROVIDER: "etoro-demo",
        ETORO_API_KEY: "k",
        ETORO_USER_KEY: "u",
        ETORO_DEMO_TEST_AMOUNT: "50",
      }),
    ).toThrow(/ETORO_ENV=demo/);
  });

  it("accepts exactly \"demo\"", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "etoro-demo",
      ETORO_ENV: "demo",
      ETORO_API_KEY: "k",
      ETORO_USER_KEY: "u",
      ETORO_DEMO_TEST_AMOUNT: "50",
    });
    expect(config.etoro.env).toBe("demo");
  });
});

describe("ETORO_API_KEY / ETORO_USER_KEY — missing credentials fail clearly", () => {
  it("throws a clear ConfigError when BROKER_PROVIDER=etoro-demo but neither is set", () => {
    expect(() =>
      buildHermesExecutionConfig({ ...EMPTY, BROKER_PROVIDER: "etoro-demo", ETORO_ENV: "demo", ETORO_DEMO_TEST_AMOUNT: "50" }),
    ).toThrow(/ETORO_API_KEY and ETORO_USER_KEY/);
  });

  it("throws when only the API key is set", () => {
    expect(() =>
      buildHermesExecutionConfig({
        ...EMPTY,
        BROKER_PROVIDER: "etoro-demo",
        ETORO_ENV: "demo",
        ETORO_API_KEY: "k",
        ETORO_DEMO_TEST_AMOUNT: "50",
      }),
    ).toThrow(ConfigError);
  });

  it("throws when only the user key is set", () => {
    expect(() =>
      buildHermesExecutionConfig({
        ...EMPTY,
        BROKER_PROVIDER: "etoro-demo",
        ETORO_ENV: "demo",
        ETORO_USER_KEY: "u",
        ETORO_DEMO_TEST_AMOUNT: "50",
      }),
    ).toThrow(ConfigError);
  });

  it("does not require eToro credentials when BROKER_PROVIDER is local", () => {
    expect(() => buildHermesExecutionConfig(EMPTY)).not.toThrow();
  });

  it("succeeds once both keys are provided", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "etoro-demo",
      ETORO_ENV: "demo",
      ETORO_API_KEY: "k",
      ETORO_USER_KEY: "u",
      ETORO_DEMO_TEST_AMOUNT: "50",
    });
    expect(config.etoro.apiKey).toBe("k");
    expect(config.etoro.userKey).toBe("u");
  });
});

describe("ETORO_DEMO_TEST_INSTRUMENT", () => {
  it("defaults to a well-known, always-tradable search term", () => {
    expect(buildHermesExecutionConfig(EMPTY).etoro.testInstrument).toBe("BTC");
  });

  it("is overridable", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, ETORO_DEMO_TEST_INSTRUMENT: "AAPL" });
    expect(config.etoro.testInstrument).toBe("AAPL");
  });
});

describe("ETORO_DEMO_TEST_AMOUNT — no safe default exists, must be explicit", () => {
  // Regression coverage: unlike Trading212's testOrderQuantity, eToro's public API documents no
  // confirmed minimum-order-size signal (see docs/etoro-demo-adapter-phase-1.md) — a default here
  // would be a guess, not a documented-safe value, so none is provided.
  it("is undefined when unset and BROKER_PROVIDER is not etoro-demo", () => {
    expect(buildHermesExecutionConfig(EMPTY).etoro.testAmount).toBeUndefined();
  });

  it("throws a clear ConfigError when BROKER_PROVIDER=etoro-demo but the amount is unset", () => {
    expect(() =>
      buildHermesExecutionConfig({ ...EMPTY, BROKER_PROVIDER: "etoro-demo", ETORO_ENV: "demo", ETORO_API_KEY: "k", ETORO_USER_KEY: "u" }),
    ).toThrow(/ETORO_DEMO_TEST_AMOUNT/);
  });

  it("is overridable, including fractional amounts", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, ETORO_DEMO_TEST_AMOUNT: "12.5" });
    expect(config.etoro.testAmount).toBe(12.5);
  });

  it("fails closed on a non-numeric value", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, ETORO_DEMO_TEST_AMOUNT: "not-a-number" })).toThrow(ConfigError);
  });

  it("fails closed on zero", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, ETORO_DEMO_TEST_AMOUNT: "0" })).toThrow(ConfigError);
  });

  it("fails closed on a negative value", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, ETORO_DEMO_TEST_AMOUNT: "-10" })).toThrow(ConfigError);
  });

  it("fails closed on NaN/Infinity spellings", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, ETORO_DEMO_TEST_AMOUNT: "NaN" })).toThrow(ConfigError);
    expect(() => buildHermesExecutionConfig({ ...EMPTY, ETORO_DEMO_TEST_AMOUNT: "Infinity" })).toThrow(ConfigError);
  });
});
