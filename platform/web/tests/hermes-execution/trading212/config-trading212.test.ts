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

describe("BROKER_PROVIDER=trading212-demo is a supported, non-default option", () => {
  it("is included in the supported set alongside local and hyperliquid-testnet", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "trading212-demo",
      TRADING212_API_KEY: "k",
      TRADING212_API_SECRET: "s",
    });
    expect(config.brokerProvider).toBe("trading212-demo");
  });

  it("stays local by default even when Trading212 vars are set but BROKER_PROVIDER isn't", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      TRADING212_API_KEY: "k",
      TRADING212_API_SECRET: "s",
      TRADING212_DEMO_EXECUTION_ENABLED: "true",
    });
    expect(config.brokerProvider).toBe("local");
  });

  it("has no live value: BROKER_PROVIDER=trading212-live fails closed", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, BROKER_PROVIDER: "trading212-live" })).toThrow(ConfigError);
    expect(() => buildHermesExecutionConfig({ ...EMPTY, BROKER_PROVIDER: "trading212" })).toThrow(ConfigError);
  });
});

describe("TRADING212_API_KEY / TRADING212_API_SECRET — missing credentials fail clearly", () => {
  // Per Trading212's current official auth docs (docs.trading212.com/api/section/authentication):
  // credentials are an API Key + API Secret pair (HTTP Basic auth), not a single key.
  it("throws a clear ConfigError when BROKER_PROVIDER=trading212-demo but neither is set", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, BROKER_PROVIDER: "trading212-demo" })).toThrow(
      /TRADING212_API_KEY and TRADING212_API_SECRET/,
    );
  });

  it("throws when only the API key is set", () => {
    expect(() =>
      buildHermesExecutionConfig({ ...EMPTY, BROKER_PROVIDER: "trading212-demo", TRADING212_API_KEY: "k" }),
    ).toThrow(ConfigError);
  });

  it("throws when only the API secret is set", () => {
    expect(() =>
      buildHermesExecutionConfig({ ...EMPTY, BROKER_PROVIDER: "trading212-demo", TRADING212_API_SECRET: "s" }),
    ).toThrow(ConfigError);
  });

  it("does not require Trading212 credentials when BROKER_PROVIDER is local", () => {
    expect(() => buildHermesExecutionConfig(EMPTY)).not.toThrow();
  });

  it("succeeds once both key and secret are provided", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "trading212-demo",
      TRADING212_API_KEY: "k",
      TRADING212_API_SECRET: "s",
    });
    expect(config.trading212.apiKey).toBe("k");
    expect(config.trading212.apiSecret).toBe("s");
  });
});

describe("TRADING212_DEMO_EXECUTION_ENABLED", () => {
  it("defaults to false", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "trading212-demo",
      TRADING212_API_KEY: "k",
      TRADING212_API_SECRET: "s",
    });
    expect(config.trading212.executionEnabled).toBe(false);
  });

  it("is true only when explicitly set to true", () => {
    const config = buildHermesExecutionConfig({
      ...EMPTY,
      BROKER_PROVIDER: "trading212-demo",
      TRADING212_API_KEY: "k",
      TRADING212_API_SECRET: "s",
      TRADING212_DEMO_EXECUTION_ENABLED: "true",
    });
    expect(config.trading212.executionEnabled).toBe(true);
  });
});

describe("TRADING212_DEMO_INSTRUMENT", () => {
  it("defaults to a well-known ticker", () => {
    expect(buildHermesExecutionConfig(EMPTY).trading212.testInstrument).toBe("AAPL_US_EQ");
  });

  it("is overridable", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, TRADING212_DEMO_INSTRUMENT: "MSFT_US_EQ" });
    expect(config.trading212.testInstrument).toBe("MSFT_US_EQ");
  });
});

describe("TRADING212_DEMO_TEST_QUANTITY", () => {
  // Regression coverage: Trading212's real metadata response has no minimum-order-quantity field
  // (confirmed against the live API), so this config value replaced deriving the smoke test's
  // order size from instrument metadata — it must always resolve to a valid, positive number.
  it("defaults to 1", () => {
    expect(buildHermesExecutionConfig(EMPTY).trading212.testOrderQuantity).toBe(1);
  });

  it("is overridable, including fractional quantities", () => {
    const config = buildHermesExecutionConfig({ ...EMPTY, TRADING212_DEMO_TEST_QUANTITY: "0.5" });
    expect(config.trading212.testOrderQuantity).toBe(0.5);
  });

  it("fails closed on a non-numeric value", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, TRADING212_DEMO_TEST_QUANTITY: "not-a-number" })).toThrow(
      ConfigError,
    );
  });

  it("fails closed on zero", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, TRADING212_DEMO_TEST_QUANTITY: "0" })).toThrow(ConfigError);
  });

  it("fails closed on a negative value", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, TRADING212_DEMO_TEST_QUANTITY: "-1" })).toThrow(ConfigError);
  });

  it("fails closed on NaN/Infinity spellings", () => {
    expect(() => buildHermesExecutionConfig({ ...EMPTY, TRADING212_DEMO_TEST_QUANTITY: "NaN" })).toThrow(ConfigError);
    expect(() => buildHermesExecutionConfig({ ...EMPTY, TRADING212_DEMO_TEST_QUANTITY: "Infinity" })).toThrow(
      ConfigError,
    );
  });
});
